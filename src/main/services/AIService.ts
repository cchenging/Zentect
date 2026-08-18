import { AIEngine } from '../engine/AIEngine';
import { healthCheckService } from '../engine/HealthCheckService';
import { ttsEngine } from '../engine/TTSEngine';
import { AIDaemon } from '../core/AIDaemon';
import { ChatHistoryRepository } from '../database/repositories/ChatHistoryRepository';
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../modules/infra/logger/LogConstants';
import { IPC_CHANNELS } from '../../modules/infra/ipc/IpcConstants';
import { LLMFactory, FactoryResult } from '../engine/adapters/LLMFactory';
import { MediaRepository } from '../database/repositories/MediaRepository';
import { PipelinePayload } from '../../shared/types';
import { PipelineEngine } from '../engine/PipelineEngine';
import { AppError, ErrorCode } from '../../modules/infra/error/AppError';
import { MultiChannelPipeline } from '../core/MultiChannelPipeline';
import * as fs from 'fs';
import * as path from 'path';
import { PathManager } from '../utils/pathManager';
import { musicLibraryService } from './MusicLibraryService';
import { SemanticAnalyzeStrategy } from '../engine/strategies/SemanticAnalyzeStrategy';
import { BgmBeatRepository } from '../database/repositories/BgmBeatRepository';

/** BGM 选曲意图（两段式 Step1 输出） */
interface BgmIntent {
  moodTags: string[];
  bpmMin: number;
  bpmMax: number;
  styleNotes: string;
}

export class AIService {
  private pipelineEngine: PipelineEngine;

  constructor() {
    this.pipelineEngine = new PipelineEngine();
  }

  public async handleChat(payload: any, sender: Electron.WebContents) {
    const { projectId, text, context } = payload;

    await this.saveHistory(projectId, 'user', text);

    try {
      const messages: Array<{ role: string; content: string }> = [
        { role: 'system', content: '你是一个AI视频剪辑助手，回答用户关于视频剪辑的问题。' },
        ...(context ? [{ role: 'user', content: `上下文: ${JSON.stringify(context)}` }] : []),
        { role: 'user', content: text }
      ];

      // 💥 OPT-5: 使用 MultiChannelPipeline 包裹 LLM 调用，主通道失败自动重试
      // 统一走 LLMFactory.createAdapter('chat') 单一配置源（模型映射绑定表优先），
      // 不再走 ProviderManager.getLLMConfig 的 proxy 通道，避免通道不一致。
      const reply = await MultiChannelPipeline.executeWithFailover(
        // 主通道
        () => {
          const { adapter, modelName, temperature } = LLMFactory.createAdapter('chat');
          return adapter.chat(messages, modelName, temperature);
        },
        // 重试通道（同一配置，遇瞬时故障重试一次）
        () => {
          const { adapter, modelName, temperature } = LLMFactory.createAdapter('chat');
          return adapter.chat(messages, modelName, temperature);
        }
      );

      await this.saveHistory(projectId, 'assistant', reply.text || '');
      if (sender && !sender.isDestroyed()) {
        sender.send(IPC_CHANNELS.AI_CHAT_STREAM, { chunk: reply });
      }
      return { text: reply };
    } catch (error: any) {
      AppLogger.error(LOG_TAGS.AI_AGENT, '聊天失败', error);
      throw error;
    }
  }

  public async generateScript(payload: any, sender: Electron.WebContents) {
    const { context } = payload;
    try {
      const systemPrompt = '你是一个短视频剧本专家。请根据用户需求生成JSON格式的分镜脚本数组。';
      const messages: Array<{ role: string; content: string }> = [
        { role: 'system', content: systemPrompt },
        ...(context ? [{ role: 'user', content: `参考信息: ${JSON.stringify(context)}` }] : []),
        { role: 'user', content: payload.prompt || '请生成一个15秒短视频剧本' }
      ];

      // 💥 OPT-5: 使用 MultiChannelPipeline 包裹 LLM 调用，主通道失败自动重试
      // 统一走 LLMFactory.createAdapter('script') 单一配置源，避免通道不一致。
      const script = await MultiChannelPipeline.executeWithFailover(
        () => {
          const { adapter, modelName, temperature } = LLMFactory.createAdapter('script');
          return adapter.chat(messages, modelName, temperature);
        },
        () => {
          const { adapter, modelName, temperature } = LLMFactory.createAdapter('script');
          return adapter.chat(messages, modelName, temperature);
        }
      );

      if (sender && !sender.isDestroyed()) {
        sender.send(IPC_CHANNELS.AI_SCRIPT_PROGRESS, { progress: 100 });
      }
      return { text: script };
    } catch (error: any) {
      AppLogger.error(LOG_TAGS.AI_AGENT, '剧本生成失败', error);
      throw error;
    }
  }

  public async getChatHistory(_projectId: string) {
    return await new ChatHistoryRepository().getHistory(_projectId);
  }

  /**
   * AI 深度 BGM 推荐：两段式——①LLM 生成选曲意图（moodTags + 目标 BPM 区间）
   * ②LLM 依据文案语义生成「全网可搜索歌曲清单」（歌名+歌手+平台），仅展示推荐，
   *    不提供下载/试听，由用户自行在音乐平台搜索获取。
   * 返回结构与前端 BgmRecommendation 对齐：{ toneLabel, toneDesc, tracks:[{name,artist,mood,source,beatFit}] }
   */
  public async recommendBgm(payload: {
    scriptParagraphs: string[];
    emotionTone: string;
    /** P3 多模态：步骤2 画面情绪标签（去重） */
    frameEmotions?: string[];
    /** P3 多模态：步骤2 镜头景别标签（去重） */
    shotTypes?: string[];
    /** P3 多模态：源视频总时长（毫秒），用于推算目标切点密度 */
    videoDurationMs?: number;
  }) {
    const { scriptParagraphs, emotionTone, frameEmotions, shotTypes, videoDurationMs } = payload;
    const scriptText = (scriptParagraphs || []).filter(Boolean).join('\n').slice(0, 8000) || '（无文案）';

    // 💥 关键：与脚本生成走【同一条】配置解析链路 —— LLMFactory.createAdapter('script')
    //    （先查「模型映射」绑定表 ProfileBindingRepository，再回退 settings 模型名路由）。
    //    切勿改用 ProviderManager.getLLMConfig('script')：它读的是 api_profiles 激活的
    //    proxy profile，与脚本生成实际使用的通道不同，会导致"脚本能用、这里却 403"。
    let factory: FactoryResult;
    try {
      factory = LLMFactory.createAdapter('script');
    } catch (e: any) {
      AppLogger.warn(LOG_TAGS.AI_AGENT, `[BGM推荐] 脚本生成通道未配置: ${e?.message}`);
      return { success: false, error: e?.message || '未配置可用的 LLM 通道' };
    }

    // Step1：生成选曲意图（失败不阻断，降级纯生成）
    let intent: BgmIntent | null = null;
    try {
      intent = await this.generateBgmIntent(factory, scriptText, emotionTone, frameEmotions, shotTypes, videoDurationMs);
    } catch (e: any) {
      AppLogger.warn(LOG_TAGS.AI_AGENT, `[BGM推荐] 选曲意图生成失败，降级纯生成: ${e?.message}`);
    }

    // Step2：全网搜索推荐——LLM 依据文案语义生成「可搜索歌曲清单」（歌名+歌手+平台），
    //        仅展示推荐，不提供下载/试听，由用户自行在音乐平台搜索获取。
    if (intent) {
      try {
        const selected = await this.generateWebRecommendation(factory, {
          scriptText,
          emotionTone,
          moodTags: intent.moodTags || [],
          styleNotes: intent.styleNotes || '',
          bpmMin: intent.bpmMin,
          bpmMax: intent.bpmMax,
        });
        if (selected) {
          AppLogger.info(LOG_TAGS.AI_AGENT, `[BGM推荐] 全网推荐完成: ${selected.tracks?.length ?? 0} 首`);
          return { success: true, data: selected };
        }
      } catch (e: any) {
        AppLogger.warn(LOG_TAGS.AI_AGENT, `[BGM推荐] 全网推荐生成失败: ${e?.message}`);
      }
    }

    // Step3：全网推荐生成失败时明确报错，不编造曲目
    AppLogger.warn(LOG_TAGS.AI_AGENT, '[BGM推荐] 全网推荐生成失败');
    return { success: false, error: '全网 BGM 推荐生成失败，请确认 LLM 通道可用后重试' };
  }

  /** P1 一键应用：下载曲库曲目到本地缓存并返回本地 filePath */
  public async downloadBgm(payload: { downloadUrl?: string; libraryId?: string; name?: string }) {
    const { downloadUrl, libraryId, name } = payload || {};
    let url = (downloadUrl || '').trim();
    if (!url && libraryId) {
      try {
        url = (await musicLibraryService.getDownloadUrl(libraryId)).trim();
      } catch (e: any) {
        AppLogger.warn(LOG_TAGS.AI_AGENT, `[BGM下载] 解析下载地址失败: ${e?.message}`);
      }
    }
    if (!url) return { success: false, error: '未获取到可下载的曲目地址' };

    // 本地曲库：downloadUrl 指向随项目分发的本地文件，直接返回路径，无需联网下载
    const isLocalFile =
      /^[A-Za-z]:[\\/]/.test(url) ||
      (url.startsWith('/') && !url.startsWith('//')) ||
      fs.existsSync(url);
    if (isLocalFile) {
      if (!fs.existsSync(url)) return { success: false, error: '本地曲目文件缺失' };
      AppLogger.info(LOG_TAGS.AI_AGENT, `[BGM下载] 命中本地曲库文件: ${url}`);
      return { success: true, filePath: url };
    }

    const bgmDir = path.join(PathManager.getCacheRootPath(), 'bgm');
    fs.mkdirSync(bgmDir, { recursive: true });

    const safeName = (name || libraryId || 'bgm').replace(/[\\/:*?"<>|]/g, '_');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    let res: Response;
    try {
      res = await fetch(url, { method: 'GET', signal: controller.signal });
    } catch (e: any) {
      if (e?.name === 'AbortError') return { success: false, error: '曲目下载超时（60s）' };
      return { success: false, error: `曲目下载失败：${e?.message || e}` };
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) return { success: false, error: `曲目下载失败：HTTP ${res.status}` };

    const ext = this.inferBgmExtension(url, res.headers.get('content-type') || '');
    const filePath = path.join(bgmDir, `${Date.now()}_${safeName}${ext}`);
    try {
      const buffer = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(filePath, buffer);
    } catch (e: any) {
      return { success: false, error: `曲目写入本地失败：${e?.message || e}` };
    }
    AppLogger.info(LOG_TAGS.AI_AGENT, `[BGM下载] 已缓存曲目: ${filePath}`);
    return { success: true, filePath };
  }

  /** 本地曲库全量列表（按 tone 分组），供前端分类分页自选 */
  public async listLocalBgm() {
    try {
      const tracks = musicLibraryService.listAll();
      return { success: true, data: tracks };
    } catch (e: any) {
      AppLogger.warn(LOG_TAGS.AI_AGENT, `[BGM列表] 本地曲库读取失败: ${e?.message}`);
      return { success: false, error: e?.message || '本地曲库读取失败' };
    }
  }

  /** 根据 Content-Type 或 URL 推断 BGM 文件扩展名，默认 .mp3 */
  private inferBgmExtension(url: string, contentType: string): string {
    const ct = (contentType || '').toLowerCase();
    if (ct.includes('mpeg') || ct.includes('mp3')) return '.mp3';
    if (ct.includes('wav')) return '.wav';
    if (ct.includes('mp4') || ct.includes('m4a')) return '.m4a';
    if (ct.includes('ogg')) return '.ogg';
    try {
      const ext = path.extname(new URL(url).pathname).toLowerCase();
      if (/^\.[a-z0-9]{1,5}$/.test(ext)) return ext;
    } catch { /* 忽略非法 URL，走默认 */ }
    return '.mp3';
  }

  /** 选曲意图：由文案情绪推导出的检索条件（两段式 Step1） */
  private async generateBgmIntent(
    factory: FactoryResult,
    scriptText: string,
    emotionTone: string,
    frameEmotions?: string[],
    shotTypes?: string[],
    videoDurationMs?: number,
  ): Promise<BgmIntent | null> {
    const { adapter, modelName, temperature } = factory;
    const systemPrompt =
      '你是短视频背景音乐(BGM)选曲意图分析器。根据文案的情绪基调与内容，推断目标曲目的情绪标签与 BPM 区间。' +
      '你必须只输出一个合法的 JSON 对象，禁止输出任何解释、前后缀或 Markdown 代码块。字段名必须严格如下：\n' +
      '{"moodTags":["情绪标签1","情绪标签2"],"bpmMin":90,"bpmMax":140,"styleNotes":"一句话选曲说明"}';
    // P3 多模态：把步骤2 的画面情绪、镜头景别与视频时长纳入选曲意图，供 LLM 结合画面节奏推断 BPM 区间
    const frameEmotionLine = (frameEmotions || []).length > 0 ? `\n画面情绪分布：${frameEmotions!.join('、')}` : '';
    const shotTypeLine = (shotTypes || []).length > 0 ? `\n镜头景别：${shotTypes!.join('、')}` : '';
    const durationLine = videoDurationMs ? `\n视频总时长：${Math.round(videoDurationMs / 1000)}秒` : '';
    const userPrompt = `情绪基调：${emotionTone}\n解说文案段落：\n${scriptText}${frameEmotionLine}${shotTypeLine}${durationLine}`;
    const reply: any = await adapter.chat(
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      modelName, temperature,
    );
    if (reply && reply.success === false) throw new Error(reply.error || '选曲意图生成失败');
    const parsed = this.parseJsonFromText(reply?.text || '');
    if (!parsed || typeof parsed !== 'object') return null;
    const rawTags = Array.isArray(parsed.moodTags) ? parsed.moodTags : (Array.isArray(parsed.tags) ? parsed.tags : []);
    const moodTags = rawTags.map((t: any) => String(t).trim()).filter(Boolean).slice(0, 5);
    const bpmMin = Number(parsed.bpmMin ?? parsed.targetBpmMin ?? parsed.min ?? 0) || 0;
    const bpmMax = Number(parsed.bpmMax ?? parsed.targetBpmMax ?? parsed.max ?? 0) || 0;
    const styleNotes = String(parsed.styleNotes || parsed.reason || parsed.note || '').trim();
    if (moodTags.length === 0 && !styleNotes) return null;
    return { moodTags, bpmMin, bpmMax, styleNotes };
  }

  /** 全网搜索推荐：LLM 依据文案语义生成「可搜索歌曲清单」（仅展示，用户自行搜索下载） */
  private async generateWebRecommendation(
    factory: FactoryResult,
    context: {
      scriptText: string;
      emotionTone: string;
      moodTags: string[];
      styleNotes: string;
      bpmMin: number;
      bpmMax: number;
    },
  ): Promise<any> {
    const { adapter, modelName, temperature } = factory;
    const systemPrompt =
      '你是短视频背景音乐(BGM)全网选曲推荐器。根据解说文案的情绪基调与内容，推荐 3~5 首全网可搜索到的真实歌曲。' +
      '你必须只输出一个合法的 JSON 对象，禁止输出任何解释、前后缀或 Markdown 代码块。字段名必须严格如下：\n' +
      '{"toneLabel":"推荐风格标签","toneDesc":"一句话选曲理由","tracks":[{"name":"歌名","artist":"歌手","platform":"来源平台","mood":"情绪标签","beatFit":"强/中/弱"}]}\n' +
      '要求：歌名与歌手必须真实准确，来源平台标注可搜索到的平台（如网易云音乐/QQ音乐/酷狗音乐/YouTube Audio Library 等），禁止编造 URL 或下载地址。';
    const contextLine = [
      `情绪基调：${context.emotionTone || '（未指定）'}`,
      context.moodTags.length > 0 ? `选曲情绪标签：${context.moodTags.join('、')}` : '',
      context.styleNotes ? `选曲说明：${context.styleNotes}` : '',
      context.bpmMin > 0 && context.bpmMax > 0 ? `目标 BPM 区间：${context.bpmMin}~${context.bpmMax}` : '',
      `解说文案段落：\n${(context.scriptText || '（无文案）').slice(0, 2000)}`,
    ].filter(Boolean).join('\n');
    const reply: any = await adapter.chat(
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: contextLine }],
      modelName, temperature,
    );
    if (reply && reply.success === false) throw new Error(reply.error || '全网推荐生成失败');
    const parsed = this.parseJsonFromText(reply?.text || '');
    if (!parsed || typeof parsed !== 'object') return null;

    const rawTracks = Array.isArray(parsed.tracks)
      ? parsed.tracks
      : (Array.isArray(parsed.music) ? parsed.music : []);
    const tracks: any[] = [];
    for (const item of rawTracks) {
      const name = String(item?.name || '').trim();
      const artist = String(item?.artist || item?.singer || '').trim();
      if (!name) continue; // 无歌名跳过（LLM 幻觉保护）
      tracks.push({
        name,
        artist: artist || '未知歌手',
        mood: String(item?.mood || item?.tag || '').trim() || '通用',
        source: `全网搜索 · ${String(item?.platform || item?.source || '音乐平台').trim()}`,
        beatFit: String(item?.beatFit || item?.beat || '中').trim(),
      });
    }
    if (tracks.length === 0) return null;
    return {
      toneLabel: String(parsed?.toneLabel || parsed?.tone || '').trim() || 'AI 推荐',
      toneDesc: String(parsed?.toneDesc || parsed?.reason || '').trim() || '依据解说文案语义生成的全网选曲建议，请自行在音乐平台搜索下载',
      tracks,
    };
  }

  /** 从 LLM 自由文本中健壮提取 JSON 对象：整段解析 → 剥 ```json 代码块 → 取首个 { 起 → 清洗尾随噪音 */
  private parseJsonFromText(text: string): any {
    const candidates: string[] = [];
    try { candidates.push(JSON.parse(text)); } catch { /* 继续 */ }
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) {
      try { candidates.push(JSON.parse(fence[1])); } catch {
        try { candidates.push(JSON.parse(fence[1].slice(fence[1].indexOf('{')))); } catch { /* 继续 */ }
      }
    }
    const brace = text.indexOf('{');
    if (brace >= 0) {
      // 从首个 { 向后找配对 }，避免解析到尾随的中文说明文字
      let depth = 0;
      for (let i = brace; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') { depth--; if (depth === 0) { try { candidates.push(JSON.parse(text.slice(brace, i + 1))); } catch { /* 继续 */ } break; } }
      }
    }
    // 返回第一个非空对象候选
    for (const c of candidates) {
      if (c && typeof c === 'object' && !Array.isArray(c)) return c;
      if (Array.isArray(c) && c.length > 0) return c[0];
    }
    return null;
  }

  public async executePipeline(payload: PipelinePayload, sender: Electron.WebContents) {
    return await this.pipelineEngine.execute(payload, sender);
  }

  public abortPipeline() {
    this.pipelineEngine.abort();
    return { success: true, message: '已发送中止信号' };
  }

  public async probePipelineCache(payload: any) {
    return await this.pipelineEngine.probeCache(payload);
  }

  public async getNodeOutput(projectId: string, nodeId: string, type: string) {
    if (!projectId || !nodeId) throw new Error("缺少必要参数");

    /** 统一走 PathManager 标准路径，确保目录自动创建和路径一致性 */
    const outputDir = PathManager.getNodeBaseDir(projectId, nodeId, (type as 'frames' | 'audio' | 'whisper') || 'frames');

    if (!fs.existsSync(outputDir)) return [];

    return fs.readdirSync(outputDir)
      .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
      .map(f => path.join(outputDir, f));
  }

  public async testLLM(provider: string, apiKey: string, baseURL?: string) {
    if (!apiKey) throw new Error("API Key 不能为空，请先填写");

    const adapter = LLMFactory.create(provider, apiKey, baseURL);
    await adapter.testConnection();
    return true;
  }

  public async testNetwork(type: string, config: any) {
    if (type === 'openai_like') {
      // 🔧 修复：用 /models 接口同时完成测试和拉取，废弃用 gpt-3.5-turbo 测试的错误逻辑
      const models = await this.fetchModels(config);
      return `连接成功，共获取 ${models.length} 个可用模型`;
    }

    return await healthCheckService.testNetwork(type as 'doubao_tts' | 'openai_like', config);
  }

  /**
   * 拉取账户可用模型列表（OpenAI 兼容 /models 接口）
   *
   * 主流厂商均支持：
   * - 火山方舟：https://ark.cn-beijing.volces.com/api/v3/models
   * - DeepSeek：https://api.deepseek.com/models
   * - 通义千问：https://dashscope.aliyuncs.com/compatible-mode/v1/models
   * - 腾讯混元：https://api.hunyuan.cloud.tencent.com/v1/models
   * - 自定义：用户填写的 baseURL
   *
   * 失败时抛错（含 HTTP 状态码 + 响应片段），前端 catch 后展示错误
   */
  public async fetchModels(config: { provider?: string; apiKey?: string; baseURL?: string }): Promise<string[]> {
    const apiKey = (config.apiKey || '').trim();
    if (!apiKey) throw new Error('API Key 不能为空');

    let baseURL = (config.baseURL || '').trim();
    if (!baseURL) throw new Error('接口地址不能为空');

    // 清理 baseURL：去掉末尾 /，去掉 /chat/completions 和 /models 后缀（容错）
    baseURL = baseURL
      .replace(/\/chat\/completions\/?$/, '')
      .replace(/\/models\/?$/, '')
      .replace(/\/$/, '');

    const endpoint = `${baseURL}/models`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'application/json',
        },
        signal: controller.signal,
      });
    } catch (e: any) {
      if (e.name === 'AbortError') throw new Error('请求超时（15s），请检查网络或接口地址');
      throw new Error(`网络请求失败：${e.message || e}`);
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) {
      let detail = '';
      try {
        const errBody = await res.text();
        detail = errBody.substring(0, 200);
      } catch {}
      if (res.status === 401) throw new Error(`API Key 鉴权失败（401）${detail ? '：' + detail : ''}`);
      if (res.status === 403) throw new Error(`无访问权限（403）${detail ? '：' + detail : ''}`);
      if (res.status === 404) throw new Error(`接口地址不存在（404），请检查 baseURL${detail ? '：' + detail : ''}`);
      throw new Error(`HTTP ${res.status}${detail ? '：' + detail : ''}`);
    }

    let json: any;
    try {
      json = await res.json();
    } catch {
      throw new Error('响应不是有效 JSON，可能 baseURL 错误（如指向了 HTML 页面）');
    }

    // OpenAI 兼容格式：{ data: [{ id: 'model-name' }, ...] }
    const rawList: any[] = Array.isArray(json?.data) ? json.data : (Array.isArray(json?.models) ? json.models : []);
    if (rawList.length === 0) {
      throw new Error('响应中没有 model 列表（data 数组为空或格式异常）');
    }

    // 提取 model id，去重 + 排序
    const models = rawList
      .map((m: any) => (typeof m === 'string' ? m : (m?.id || m?.name || m?.model)))
      .filter((m: any): m is string => typeof m === 'string' && m.length > 0);
    const unique = Array.from(new Set(models)).sort();
    if (unique.length === 0) throw new Error('未能从响应中解析出任何模型 ID');

    return unique;
  }

  public async testTTS(provider: string) {
    try {
      await AIEngine.generateTTS('测试语音', provider as 'doubao' | 'edge' | 'kokoro');
      return 'success';
    } catch (e: any) {
      return `连接失败: ${e.message}`;
    }
  }

  public async runSingleTTS(projectId: string, shot: any) {
    // 改用 TTSEngine.runSingleTTS：支持 voiceId/speechRate 透传 + 写入项目 L2 缓存目录（非 tmp）
    // 旧实现 AIEngine.generateTTS 只传 text+provider，丢失音色/语速且产物进 tmp 目录无法持久化
    return await ttsEngine.runSingleTTS(projectId, shot);
  }

  public async runGlobalTTS(_projectId: string, shots: any[]) {
    const results: Array<{ shot: any; audioPath?: any; error?: string }> = [];
    for (const shot of shots) {
      try {
        const provider = shot.provider || shot.voiceId || 'edge';
        const result = await ttsEngine.generateTTS(shot.text || '', provider as 'doubao' | 'edge' | 'kokoro');
        results.push({ shot, audioPath: result });
      } catch (e: any) {
        AppLogger.warn(LOG_TAGS.AI_AGENT, `TTS failed for shot ${shot.id}`, e);
        results.push({ shot, error: e.message });
      }
    }
    return results;
  }

  public async generateAiScript(data: any) {
    try {
      const llm = LLMFactory.createFromConfig({ provider: data.llmEngine || 'deepseek-chat', apiKey: '', model: data.llmEngine || 'deepseek-chat', temperature: 0.7 } as any);
      const messages: Array<{ role: string; content: string }> = [
        { role: 'system', content: '你是一个短视频剧本生成专家。请生成JSON格式的分镜脚本。' },
        { role: 'user', content: `主题: ${data.theme || '通用短视频'}\n风格: ${data.scriptStyle || '专业'}\n时长: ${data.targetDuration || '15'}秒` }
      ];
      const script = await llm.chat(messages, 'deepseek-chat', 0.7);
      return { success: true, data: script };
    } catch (e: any) {
      AppLogger.error(LOG_TAGS.AI_AGENT, 'AI剧本生成失败', e);
      return { success: false, error: e.message };
    }
  }

  public async visionSingle(data: any) {
    return await AIDaemon.getInstance().post('/api/vision', data);
  }

  /**
   * 检查 Python 端依赖安装状态（供模型管理页 + 健康检查页展示）
   * 返回结构：
   *   {
   *     deps: { demucs: {installed, version, display_name}, ... },   // 扁平依赖状态（兼容旧版）
   *     modules: {                                                    // V7 模块化分组（新版）
   *       torch:     { ready, missing, display_name, size, shared_by },
   *       demucs:    { ready, missing, display_name, size, needs },
   *       mdx_net:   { ready, missing, display_name, size, needs },
   *       whisper:   { ready, missing, display_name, size, needs },
   *       sensevoice:{ ready, missing, display_name, size, needs },
   *       insightface:{ ready, missing, display_name, size, needs },
   *       clip:      { ready, missing, display_name, size, needs },
   *     },
   *     python_executable
   *   }
   * Python 服务离线时返回 null
   */
  public async checkDeps(): Promise<{
    deps: Record<string, { installed: boolean; version: string | null; display_name: string }>;
    modules: Record<string, {
      ready: boolean;
      missing: string[];
      display_name: string;
      size?: string;
      shared_by?: string[];
      needs?: string[];
    }>;
    python_executable: string;
  } | null> {
    try {
      const daemon = AIDaemon.getInstance();
      if (!daemon.isOnline()) return null;
      const { HttpClient } = await import('../core/HttpClient');
      const port = daemon.getPort();
      // 🔧 修复 TS2554：HttpClient.get 静态方法只接受 url，超时由内部默认 60s 控制
      const res = await HttpClient.get(`http://127.0.0.1:${port}/api/check_deps`);
      return res;
    } catch (e: any) {
      AppLogger.warn(LOG_TAGS.AI_AGENT, `checkDeps 失败: ${e.message}`);
      return null;
    }
  }

  public async emotionSingle(data: any) {
    return await AIDaemon.getInstance().post('/api/emotion', data);
  }

  public async searchSemantics(mediaId: string, query: string) {
    const res = await AIDaemon.getInstance().post('/api/search_semantics', { media_id: mediaId, query: query, top_k: 20 });
    if (!res.success) throw new Error(res.error || '检索引擎返回异常状态');
    return res.results;
  }

  public async getHistory(projectId: string) {
    return new ChatHistoryRepository().getHistory(projectId);
  }

  public async markExecuted(msgId: string) {
    new ChatHistoryRepository().markExecuted(msgId);
    return { success: true };
  }

  public async searchBrollLocally(payload: any) {
    return await AIEngine.searchBrollLocally(payload);
  }

  public async extractFramesLocally(mediaId: string, strategy: 'keyframe' | 'fps' | 'uniform' = 'keyframe', fps: number = 1) {
    const mediaRepo = new MediaRepository();
    const media = await mediaRepo.findById(mediaId);
    if (!media?.filePath) throw new AppError(ErrorCode.FS_FILE_NOT_FOUND, `媒体文件 ${mediaId} 不存在`);
    return await AIEngine.extractFramesLocally(media.filePath, PathManager.getProjectDir(mediaId), strategy, fps);
  }

  public async agentStreamChat(sender: Electron.WebContents, projectId: string, prompt: string, context: any, history: Array<{ role: string; content: string }>) {
    await AIEngine.agentStreamChat(sender, projectId, prompt, context, history);
    return { success: true };
  }

  private async saveHistory(projectId: string, role: 'user' | 'assistant', content: string) {
    const repo = new ChatHistoryRepository();
    await repo.saveMessage(projectId, role, content);
  }

  /**
   * 物理层全栈重构：视听多模态三维一体卡点对齐流水线引擎
   * 步骤1：BGM 低频重音节拍检测
   * 步骤2：获取动态视频切片池
   * 步骤3：KM 全局排他性匹配求解
   */
  public async runSmartVisualMatchPipeline(payload: {
    projectId: string;
    scriptShots: any[];
    ttsDurations: any[];
    bgmInfo: { id: string; filePath: string } | null;
    mediaPath: string;
    mediaId: string;
  }) {
    const { scriptShots, ttsDurations, bgmInfo, mediaPath } = payload;
    AppLogger.info(LOG_TAGS.AI_AGENT, `[AIService] 启动 Layer-5 多维松弛代价矩阵解算程序`);

    /** 🔧 P1 #7：一进入管线先异步预调 daemon，不阻塞参数准备，
     *   detect_beats / detect_scene_chunks / KM 求解到达时 daemon 已热（Python 子进程 + 模型加载） */
    const warmDaemonPromise = AIDaemon.getInstance().ensureWarm();

    try {
      /** 步1：触发本地听觉原子算子，对背景音执行 STFT 低频重音能量追踪
       *   🔧 P1 #6：先查 SQLite BGM 节拍缓存（与 SemanticAnalyzeStrategy 共用同一仓库），
       *   命中秒级复用；文件被替换后 size/mtimeMs 指纹不一致自动失效重算。
       *   🔧 P1 #7：进入 daemon 请求前确保已预热，若 ensureWarm 还在进行则 await 补等（很短） */
      await warmDaemonPromise;
      let bgmBeatsMs: number[] = [];
      let bgmBeatsSec: number[] = [];
      if (bgmInfo && fs.existsSync(bgmInfo.filePath)) {
        AppLogger.info(LOG_TAGS.AI_AGENT, `[音频算子] 异步提取 BGM 重低音能量起音阵列`);
        const bgmBeatRepo = new BgmBeatRepository();
        const cachedBeats = bgmBeatRepo.getValid(bgmInfo.filePath);
        if (cachedBeats && cachedBeats.beatsSec.length > 0) {
          bgmBeatsSec = cachedBeats.beatsSec;
          bgmBeatsMs = bgmBeatsSec.map((s: number) => s * 1000);
          AppLogger.info(LOG_TAGS.AI_AGENT,
            `[AIService] 命中 BGM 节拍 DB 缓存，共 ${bgmBeatsSec.length} 个节拍`);
        } else {
          const beatResponse = await AIDaemon.getInstance().post('/api/audio/detect_beats', {
            file_path: bgmInfo.filePath,
          });
          const beatData = beatResponse?.data || beatResponse;
          bgmBeatsMs = beatData.beatGridMs || beatData.onsetMs || [];
          bgmBeatsSec = bgmBeatsMs.map((ms: number) => ms / 1000);
          const tempo = Number(beatData.tempo) || 0;
          if (bgmBeatsSec.length > 0) {
            bgmBeatRepo.save(bgmInfo.filePath, bgmBeatsSec, tempo);
          }
          AppLogger.info(LOG_TAGS.AI_AGENT,
            `[AIService] BGM 节拍检测完成，共 ${bgmBeatsSec.length} 个节拍，BPM=${tempo}`);
        }
      }

      /** 步2：获取动态视频切片池 */
      const cacheDir = PathManager.getProjectDir(payload.projectId);
      const chunkResponse = await AIDaemon.getInstance().post('/api/video/detect_scene_chunks', {
        file_path: mediaPath,
        output_dir: path.join(cacheDir, 'video_chunks'),
        threshold: 0.3,
        min_chunk_duration_sec: 1.0,
      });
      const videoChunks = chunkResponse?.data || chunkResponse || [];
      if (!Array.isArray(videoChunks) || videoChunks.length === 0) {
        AppLogger.warn(LOG_TAGS.AI_AGENT, `[AIService] 动态视频切片池为空，回退到帧匹配`);
      }

      /** 步3：组装多维约束负载并调起 KM 求解器
       *  ✅ 调用 SemanticAnalyzeStrategy.buildMatchQueries 共享纯函数：
       *    - 避免 N×M .find 的 TTS 查找热点（内部 Map 索引 O(1)）；
       *    - 自动注入情绪/角色/画面意图/时间锚/原声标记多维字段；
       *    - AIService 与 SemanticAnalyzeStrategy 共用实现，防止漂移。 */
      const queries = SemanticAnalyzeStrategy.buildMatchQueries(scriptShots, ttsDurations);

      /** 🔧 P2 #11 方案 A：KM Top-K 预选（与 SemanticAnalyzeStrategy 共用同一 preselectTopK）。
       *   AIService 这条老接口没有"原声段落预匹配"步骤，直接全部 queries 送预选。 */
      const preselect = SemanticAnalyzeStrategy.preselectTopK(queries, videoChunks, {
        logProjectId: payload.projectId ? `[AIService:${payload.projectId}]` : '',
      });
      const kmVideoChunks = preselect.filteredChunks;
      const perQueryTopKForAudit = preselect.perQueryTopK;
      const originalChunksByIdAIS = new Map<string, any>();
      for (const c of videoChunks) originalChunksByIdAIS.set(String(c.id), c);

      const solverResult = await AIDaemon.getInstance().post('/api/solver/kuhn_munkres_match', {
        queries,
        videoChunks: kmVideoChunks,
        /** 🔧 P2 #11 方案B：行级候选白名单 { shotId: chunkId[] }（preselectTopK 输出的 perQueryTopK），
         *   配合方案A 的并集收窄做双层行级稀疏；perQueryTopK 为空则 daemon 忽略，老逻辑全量跑 */
        candidateIds: preselect.perQueryTopK,
        bgmBeats: bgmBeatsSec, // 直接用秒级节拍数组（BgmBeatRepository 统一存的就是 s）
        alpha: 0.6,
        beta: 0.3,
        gamma: 0.1,
      });

      if (!solverResult?.success) {
        throw new AppError(ErrorCode.AI_SERVICE_OFFLINE, '后端排他性全局对齐决策引擎求解失败');
      }

      /** 步4：封装高契约数据结构回传 */
      const rawMatches: any[] = solverResult.results || [];
      const matches = rawMatches.map((r: any) => {
        const chunkId = r.chunkId || r.mediaId || '';
        const fullChunk = originalChunksByIdAIS.get(String(chunkId));
        return {
          shotId: r.shotId,
          mediaType: 'video_chunk' as const,
          mediaId: chunkId,
          score: r.confidence || 0,
          thumbnail: r.coverPath || (fullChunk?.coverPath || ''),
          chunkData: r.chunkData || fullChunk || null,
          audioDurationMs: r.audioDurationMs || 0,
          videoTimelineStartMs: r.videoTimelineStartMs || (fullChunk?.startMs ?? 0),
          videoTimelineEndMs: r.videoTimelineEndMs || (fullChunk?.endMs ?? 0),
          appliedSpeedFactor: r.appliedSpeedFactor || 1.0,
          confirmed: (r.confidence || 0) >= 0.88,
        };
      });
      /** 📊 审计覆盖率（同 SemanticAnalyzeStrategy 逻辑） */
      SemanticAnalyzeStrategy.auditPreselectTopK(perQueryTopKForAudit, matches, payload.projectId ? `AIService:${payload.projectId}` : undefined);

      return {
        type: 'match',
        success: true,
        matches,
        videoChunks,
        bgmBeats: bgmBeatsMs, // 对外保持历史契约：毫秒级数组
      };
    } catch (error: any) {
      AppLogger.error(LOG_TAGS.AI_AGENT, `[Layer-5] 智能视听匹配管线发生致命崩溃`, error);
      throw error;
    }
  }
}
