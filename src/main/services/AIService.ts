// &#x1F4C1; 新建文件: src/main/services/AIService.ts
import { AIEngine } from '../engine/AIEngine';
import { healthCheckService } from '../engine/HealthCheckService';
import { ttsEngine } from '../engine/TTSEngine';
import { mediaProcessingService } from '../engine/MediaProcessingService';
import { AIDaemon } from '../core/AIDaemon';
import { ChatHistoryRepository } from '../database/repositories/ChatHistoryRepository';
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../modules/infra/logger/LogConstants';
import { IPC_CHANNELS } from '../../modules/infra/ipc/IpcConstants';
import { LLMFactory } from '../engine/adapters/LLMFactory';
import { MediaRepository } from '../database/repositories/MediaRepository';
import { PipelinePayload } from '../../shared/types';
import { PipelineEngine } from '../engine/PipelineEngine';
import { AppError, ErrorCode } from '../../modules/infra/error/AppError';
import { MultiChannelPipeline } from '../core/MultiChannelPipeline';
import { ProviderManager } from '../engine/config/ProviderManager';
import * as fs from 'fs';
import * as path from 'path';
import { PathManager } from '../utils/pathManager';

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

      // 💥 OPT-5: 使用 MultiChannelPipeline 包裹 LLM 调用，主通道失败自动切换备用通道
      const reply = await MultiChannelPipeline.executeWithFailover(
        // 主通道
        () => {
          const primaryConfig = ProviderManager.getLLMConfig('chat');
          const adapter = LLMFactory.createFromConfig(primaryConfig);
          return adapter.chat(messages, primaryConfig.model, primaryConfig.temperature);
        },
        // 备用通道（降级到 proxy 通道）
        () => {
          const fallbackConfig = ProviderManager.getLLMConfig('chat', 'proxy');
          const adapter = LLMFactory.createFromConfig(fallbackConfig);
          return adapter.chat(messages, fallbackConfig.model, fallbackConfig.temperature);
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

      // 💥 OPT-5: 使用 MultiChannelPipeline 包裹 LLM 调用
      const script = await MultiChannelPipeline.executeWithFailover(
        () => {
          const primaryConfig = ProviderManager.getLLMConfig('script');
          const adapter = LLMFactory.createFromConfig(primaryConfig);
          return adapter.chat(messages, primaryConfig.model, primaryConfig.temperature);
        },
        () => {
          const fallbackConfig = ProviderManager.getLLMConfig('script', 'proxy');
          const adapter = LLMFactory.createFromConfig(fallbackConfig);
          return adapter.chat(messages, fallbackConfig.model, fallbackConfig.temperature);
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
      if (!config.apiKey) throw new Error("API Key 不能为空，请先填写");
      const adapter = LLMFactory.create(config.provider, config.apiKey, config.baseURL);
      await adapter.testConnection();
      return '连接成功，通道握手正常';
    }

    return await healthCheckService.testNetwork(type as 'doubao_tts' | 'openai_like', config);
  }

  public async testTTS(provider: string) {
    try {
      await AIEngine.generateTTS('测试语音', provider as 'doubao' | 'fish' | 'edge' | 'sovits' | 'moss');
      return 'success';
    } catch (e: any) {
      return `连接失败: ${e.message}`;
    }
  }

  public async runSingleTTS(_projectId: string, shot: any) {
    const provider = shot.provider || 'edge';
    return await AIEngine.generateTTS(shot.text, provider as 'doubao' | 'fish' | 'edge' | 'sovits' | 'moss');
  }

  public async runGlobalTTS(_projectId: string, shots: any[]) {
    const results: Array<{ shot: any; audioPath?: any; error?: string }> = [];
    for (const shot of shots) {
      try {
        const provider = shot.provider || shot.voiceId || 'edge';
        const result = await ttsEngine.generateTTS(shot.text || '', provider as 'doubao' | 'fish' | 'edge' | 'sovits' | 'moss');
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

  public async isolateVocalsLocally(projectId: string, shotId: string) {
    return await AIEngine.isolateVocalsLocally(projectId, shotId);
  }

  public async extractFramesLocally(mediaId: string, strategy: 'keyframe' | 'fps' | 'uniform' = 'keyframe', fps: number = 1) {
    const mediaRepo = new MediaRepository();
    const media = await mediaRepo.findById(mediaId);
    if (!media?.filePath) throw new AppError(ErrorCode.FS_FILE_NOT_FOUND, `媒体文件 ${mediaId} 不存在`);
    return await AIEngine.extractFramesLocally(media.filePath, PathManager.getProjectDir(mediaId), strategy, fps);
  }

  public async agentStreamChat(sender: Electron.WebContents, projectId: string, prompt: string, context: any, history: Array<{ role: string; content: string }>, provider?: string) {
    await AIEngine.agentStreamChat(sender, projectId, prompt, context, history, provider);
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
    const { scriptShots, ttsDurations, bgmInfo, mediaPath, mediaId } = payload;
    AppLogger.info(LOG_TAGS.AI_AGENT, `[AIService] 启动 Layer-5 多维松弛代价矩阵解算程序`);

    try {
      /** 步1：触发本地听觉原子算子，对背景音执行 STFT 低频重音能量追踪 */
      let bgmBeats: number[] = [];
      if (bgmInfo && fs.existsSync(bgmInfo.filePath)) {
        AppLogger.info(LOG_TAGS.AI_AGENT, `[音频算子] 异步提取 BGM 重低音能量起音阵列`);
        const beatResponse = await AIDaemon.getInstance().post('/api/audio/detect_beats', {
          file_path: bgmInfo.filePath,
        });
        const beatData = beatResponse?.data || beatResponse;
        bgmBeats = beatData.beatGridMs || beatData.onsetMs || [];
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

      /** 步3：组装多维约束负载并调起 KM 求解器 */
      const queries = scriptShots.map((s: any, i: number) => {
        const ttsResult = ttsDurations[i] || ttsDurations.find((t: any) => t.shotId === (s.shotId || s.id));
        return {
          shotId: s.shotId || s.id || `para_${i}`,
          text: s.text || s.content || s.narration || '',
          audioDurationMs: ttsResult?.duration ? Math.round(ttsResult.duration * 1000) : 0,
        };
      }).filter(q => q.text.trim().length > 0);

      const solverResult = await AIDaemon.getInstance().post('/api/solver/kuhn_munkres_match', {
        queries,
        videoChunks,
        bgmBeats: bgmBeats.map((b: number) => b / 1000), // 毫秒转秒
        alpha: 0.6,
        beta: 0.3,
        gamma: 0.1,
      });

      if (!solverResult?.success) {
        throw new AppError(ErrorCode.AI_SERVICE_OFFLINE, '后端排他性全局对齐决策引擎求解失败');
      }

      /** 步4：封装高契约数据结构回传 */
      return {
        type: 'match',
        success: true,
        matches: (solverResult.results || []).map((r: any) => ({
          shotId: r.shotId,
          mediaType: 'video_chunk',
          mediaId: r.chunkId || '',
          score: r.confidence || 0,
          thumbnail: r.coverPath || '',
          chunkData: r.chunkData || null,
          audioDurationMs: r.audioDurationMs || 0,
          videoTimelineStartMs: r.videoTimelineStartMs || 0,
          videoTimelineEndMs: r.videoTimelineEndMs || 0,
          appliedSpeedFactor: r.appliedSpeedFactor || 1.0,
          confirmed: (r.confidence || 0) >= 0.88,
        })),
        videoChunks,
        bgmBeats,
      };
    } catch (error: any) {
      AppLogger.error(LOG_TAGS.AI_AGENT, `[Layer-5] 智能视听匹配管线发生致命崩溃`, error);
      throw error;
    }
  }
}
