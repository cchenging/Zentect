import { BaseNodeStrategy, ExecutionContext } from './BaseNodeStrategy';
import { PipelineTask } from '../../../shared/types';
import { AIDaemon } from '../../core/AIDaemon';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '@modules/infra/logger/LogConstants';
import { dehydrateMagicPath } from '../utils/pathUtils';
import { VideoChunkRepository } from '../../database/repositories/VideoChunkRepository';
import { LLMFactory } from '../adapters/LLMFactory';
import * as path from 'path';
import * as fs from 'fs';

/**
 * 镜头匹配策略：三维一体弹性时间轴对齐
 * 维度一：解说词与视频片段的 CLIP 语义相似度
 * 维度二：刚性音频时长与视频片段原长的时差惩罚
 * 维度三：BGM 鼓点磁吸吸附权重
 * 使用匈牙利算法求解全局最优排他性匹配
 */
export class SemanticAnalyzeStrategy extends BaseNodeStrategy {
  readonly nodeType = 'semantic-analyze';

  protected async performTask(
    task: PipelineTask,
    _context: ExecutionContext,
    cacheDir: string,
    onProgress: (p: number, s: string) => void
  ): Promise<any> {
    /** BaseNodeStrategy 将 params 和 mergedInputs 合并为扁平对象，直接从顶层取值 */
    /** 💥 关键修复：mediaPath 可能是 magic:// 协议路径（hydrate 后跨盘符转 magic://local/），
     *  必须脱水为物理路径再传给 daemon，否则 detect_scene_chunks 的 os.path.exists 失败 → 切片池为空 */
    const mediaPath = task.mediaPath ? dehydrateMagicPath(task.mediaPath) : undefined;
    if (!mediaPath) throw new Error('语义分析失败：未找到媒体文件路径');

    /** 从前端注入的参数中获取解说文案段落 */
    const scriptShots: any[] = task.scriptShots || [];
    /** TTS 配音刚性时长数据 */
    const ttsDurations: any[] = task.ttsDurations || [];
    /** ASR 原声时间轴：原声段落（keepOriginalAudio）按原声文本定位原片时间段 */
    const asrLines: any[] = task.asrLines || [];
    /** BGM 信息 */
    const bgmInfo: { id: string; filePath: string } | null = task.bgmInfo
      ? { ...task.bgmInfo, filePath: dehydrateMagicPath(task.bgmInfo.filePath) }
      : null;

    onProgress(5, '正在准备镜头匹配数据...');

    /** 如果没有解说文案，无法匹配 */
    if (scriptShots.length === 0) {
      AppLogger.warn(LOG_TAGS.AI_AGENT, '[镜头匹配] 未找到解说文案，跳过匹配');
      return { matches: [], segments: [] };
    }

    /** 步骤1：检测 BGM 鼓点节拍 */
    let bgmBeats: number[] = [];
    let bgmBpm = 0;
    if (bgmInfo?.filePath && fs.existsSync(bgmInfo.filePath)) {
      onProgress(10, '正在检测 BGM 节拍...');
      try {
        const beatResult = await AIDaemon.getInstance().post('/api/audio/detect_beats', {
          file_path: bgmInfo.filePath,
        });
        const beatData = beatResult?.data || beatResult;
        bgmBeats = (beatData.beatGridMs || beatData.onsetMs || []).map((ms: number) => ms / 1000);
        bgmBpm = Number(beatData.tempo) || 0;
        AppLogger.info(LOG_TAGS.AI_AGENT, `[镜头匹配] BGM 节拍检测完成，共 ${bgmBeats.length} 个节拍，BPM=${bgmBpm}`);
      } catch (e: any) {
        AppLogger.warn(LOG_TAGS.AI_AGENT, `[镜头匹配] BGM 节拍检测失败: ${e.message}，继续无 BGM 模式`);
      }
    }

    /** 步骤2：检测视频场景切片（DB 持久化缓存优先，命中秒级复用，未命中调 daemon 后写库） */
    onProgress(20, '正在检测视频场景切片...');
    let videoChunks: any[] = [];
    try {
      /** 🔧 先查 SQLite 切片缓存：同视频跨会话复用，避免每次 80 秒重切片 */
      const cachedChunks = new VideoChunkRepository().getByMediaId(mediaPath);
      /** 🎨 P1 缓存契约校验：切片须含 colorHistogram（相邻切片色调连续性特征，P1 新增）。
       *  旧版缓存缺该字段，按"错就错"原则视为数据契约不满足，失效重切（不能静默跳过色调维度）。 */
      const cacheUsable = cachedChunks && cachedChunks.length > 0
        && cachedChunks.some((c: any) => Array.isArray(c.colorHistogram) && c.colorHistogram.length > 0);
      if (cacheUsable) {
        videoChunks = cachedChunks;
        AppLogger.info(LOG_TAGS.AI_AGENT, `[镜头匹配] 命中视频切片 DB 缓存，共 ${videoChunks.length} 个切片`);
      } else {
        if (cachedChunks && cachedChunks.length > 0) {
          AppLogger.info(LOG_TAGS.AI_AGENT, `[镜头匹配] 旧版切片缓存缺色调特征（colorHistogram），按契约校验失效，重新切片以启用衔接优化`);
        }
        const chunksDir = path.join(cacheDir, 'video_chunks');
        /** 场景切片是重型视频分析（切片 + 封面 + CLIP 特征 + 运动显著性），默认 60s 超时不够，放宽到 5 分钟 */
        const chunkResult = await AIDaemon.getInstance().post('/api/video/detect_scene_chunks', {
          file_path: mediaPath,
          output_dir: chunksDir,
          threshold: 0.3,
          min_chunk_duration_sec: 1.0,
          /** 用视频路径作为缓存 key：同视频重复匹配走 daemon 的 PROJECT_MATERIAL_POOL，秒级返回 */
          mediaId: mediaPath,
        }, { timeout: 300000 });
        const chunkData = chunkResult?.data || chunkResult;
        videoChunks = Array.isArray(chunkData) ? chunkData : [];
        /** 切片成功后持久化到 SQLite，供后续任意会话复用 */
        if (videoChunks.length > 0) {
          new VideoChunkRepository().save(mediaPath, videoChunks);
        }
        AppLogger.info(LOG_TAGS.AI_AGENT, `[镜头匹配] 场景切片检测完成，共 ${videoChunks.length} 个切片`);
      }
    } catch (e: any) {
      AppLogger.warn(LOG_TAGS.AI_AGENT, `[镜头匹配] 场景切片检测失败: ${e.message}，回退到帧匹配模式`);
    }

    /** 步骤2 逐帧 VLM 描述聚合：按时间轴把帧描述归入切片（chunk.description），
     *  供 daemon 做"文案↔切片描述"文本语义匹配——复用步骤2 已花成本的画面理解，零额外 VLM 调用；
     *  无描述切片退化为纯图像语义。
     *  🎭 P0 意境维度：同步聚合帧情绪/景别为切片情绪标签（chunk.emotion/shotType），
     *  供 daemon 做"文案情绪↔画面情绪"匹配（文案段落 emotion 来自步骤3 LLM 生成，帧 emotion 来自步骤2 VLM 结构化输出）。 */
    const frameDescs: { timeMs: number; description: string; emotion?: string; shotType?: string; characters?: string[] }[] = (task.frameDescriptions || []).map((f: any) => ({
      timeMs: f.timeMs,
      description: f.description,
      emotion: f.emotion,
      shotType: f.shotType,
      /** 🎭 P1 角色组合匹配：读取帧的角色集合（VLM 结构化输出），供切片做角色去重聚合 */
      characters: Array.isArray(f?.downstream?.characters) ? f.downstream.characters
        : (Array.isArray(f?.characters) ? f.characters : undefined),
    }));
    if (frameDescs.length > 0 && videoChunks.length > 0) {
      const sortedDescs = [...frameDescs].sort((a, b) => a.timeMs - b.timeMs);
      for (const chunk of videoChunks) {
        const start = Number(chunk.startMs) || 0;
        const end = Number(chunk.endMs) || start;
        const windowFrames = sortedDescs.filter((f) => f.timeMs >= start - 500 && f.timeMs <= end + 500);
        const descs = windowFrames
          .map((f) => f.description)
          .filter((d, i, arr) => arr.indexOf(d) === i);
        if (descs.length > 0) chunk.description = descs.join('；');
        /** 帧情绪聚合：切片内各帧情绪取最高频者作为切片情绪标签（无情绪帧不参与统计，切片无情绪则不写入） */
        const emotionCounts = new Map<string, number>();
        for (const f of windowFrames) {
          const emo = (f.emotion || '').trim();
          if (emo) emotionCounts.set(emo, (emotionCounts.get(emo) || 0) + 1);
        }
        if (emotionCounts.size > 0) {
          chunk.emotion = [...emotionCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
        }
        /** 帧景别聚合：同样取最高频景别作为切片景别（供意境/衔接匹配） */
        const shotTypeCounts = new Map<string, number>();
        for (const f of windowFrames) {
          const st = (f.shotType || '').trim();
          if (st) shotTypeCounts.set(st, (shotTypeCounts.get(st) || 0) + 1);
        }
        if (shotTypeCounts.size > 0) {
          chunk.shotType = [...shotTypeCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
        }
        /** 🎭 P1 角色组合匹配：切片角色集合 = 时间窗内各帧出现角色的去重并集（任意帧出现即计入），
         *  供 KM 端与 Query 段落的 characters 做契合度匹配（软加成）。无角色帧不影响统计，切片无角色则不写入。 */
        const chunkRoleSet = new Set<string>();
        for (const f of windowFrames) {
          for (const r of (f.characters || [])) {
            if (typeof r === 'string' && r.trim()) chunkRoleSet.add(r.trim());
          }
        }
        if (chunkRoleSet.size > 0) chunk.characters = [...chunkRoleSet];
      }
      const withDesc = videoChunks.filter((c) => (c.description || '').trim().length > 0).length;
      const withEmotion = videoChunks.filter((c) => (c.emotion || '').trim().length > 0).length;
      AppLogger.info(LOG_TAGS.AI_AGENT, `[镜头匹配] 帧描述聚合完成：${withDesc}/${videoChunks.length} 切片带画面描述，${withEmotion}/${videoChunks.length} 切片带情绪标签`);
    }

    /** 步骤3：构建 KM 匹配请求 */
    onProgress(40, `正在匹配 ${scriptShots.length} 段文案与画面...`);

    /** 构造带音频时长的 query 列表 */
    const allQueries = scriptShots.map((s: any, i: number) => {
      /** 从 ttsResults 中查找对应的音频时长 */
      const ttsResult = ttsDurations[i] || ttsDurations.find((t: any) => t.shotId === (s.shotId || s.id));
      const audioDurationMs = ttsResult?.duration ? ttsResult.duration * 1000 : 0;

      return {
        shotId: s.shotId || s.id || `para_${i}`,
        text: s.text || s.content || s.narration || '',
        audioDurationMs,
        /** 🎭 P0 意境维度：段落情绪标签（步骤3 LLM 生成），daemon 端与切片情绪做相容度匹配 */
        emotion: s.emotion || '',
        /** 🎭 P1 角色组合匹配：本段解说词期望出现的人物名集合（步骤3 透传的 chunk 锚定角色），
         *  daemon 端与切片角色集合做契合度匹配（软加成，未命中不惩罚） */
        characters: Array.isArray(s.characters) ? s.characters : [],
        /** 原声段落：不参与语义匹配，按 ASR 时间轴锁定原片时间段 */
        keepOriginalAudio: s.keepOriginalAudio === true,
      };
    }).filter(q => q.text.trim().length > 0);

    /** 🎙️ 原声段落预匹配：文本 ↔ ASR 时间轴 → 锁定原片切片（命中的段落不送 KM，未命中回退语义匹配） */
    const originalMatches = new Map<string, any>();
    for (const q of allQueries.filter((q) => q.keepOriginalAudio)) {
      const loc = SemanticAnalyzeStrategy.locateOriginalClip(q.text, asrLines, videoChunks);
      if (loc) {
        originalMatches.set(q.shotId, { ...q, ...loc });
        AppLogger.info(
          LOG_TAGS.AI_AGENT,
          `[镜头匹配] 原声段落 ${q.shotId} 定位原片 ${loc.videoTimelineStartMs}~${loc.videoTimelineEndMs}ms → 切片 ${loc.chunkId}`,
        );
      } else {
        AppLogger.warn(LOG_TAGS.AI_AGENT, `[镜头匹配] 原声段落 ${q.shotId} 未在 ASR 时间轴命中，回退语义匹配`);
      }
    }
    /** 送 KM 的查询：排除已命中原声段落，避免其干扰全局求解 */
    const kmQueries = allQueries.filter((q) => !(q.keepOriginalAudio && originalMatches.has(q.shotId)));

    if (kmQueries.length === 0) {
      /** 全部段落都是已命中的原声段落：直接组装结果，无需 KM */
      onProgress(100, '原声段落定位完成（无语义匹配段落）');
      const matches = allQueries.map((q) => SemanticAnalyzeStrategy.buildMatchResult(q, originalMatches.get(q.shotId), true));
      return { matches, segments: [], videoChunks, bgmBeats, originalMatchedCount: originalMatches.size };
    }

    /** 步骤4：调用 KM 全局排他性匹配算法 */

    /** 🔑 获取 LLM 翻译凭据：本地 CLIP 是英文模型，中文文案直编语义近随机噪声，
     *  必须先把中文翻译成英文再匹配。未配置 LLM 时明确告警并降级（仅时长+运动生效），不静默。 */
    let llmTranslate: { apiKey: string; baseURL: string; model: string } | null = null;
    try {
      const cfg = LLMFactory.getEffectiveConfig('translate');
      if (cfg.apiKey && cfg.baseURL && cfg.model) {
        llmTranslate = { apiKey: cfg.apiKey, baseURL: cfg.baseURL, model: cfg.model };
        AppLogger.info(LOG_TAGS.AI_AGENT, `[镜头匹配] 已获取 LLM 翻译凭据（${cfg.provider}/${cfg.model}），中文文案将翻译为英文参与 CLIP 语义匹配`);
      } else {
        AppLogger.warn(LOG_TAGS.AI_AGENT, '[镜头匹配] LLM 凭据不完整，中文文案将直接走英文 CLIP，语义匹配效果差');
      }
    } catch (e: any) {
      AppLogger.warn(LOG_TAGS.AI_AGENT, `[镜头匹配] 未获取到 LLM 翻译凭据，语义匹配降级为时长+运动: ${e.message}`);
    }

    /** 🔑 获取 VLM 二次裁决凭据：对低置信度匹配，云端多模态 LLM 直接看候选封面图选最优。
     *  用户 LLM 通道模型不支持识图时，daemon 侧连续失败会自动熔断，不影响匹配结果。 */
    let vlmConfig: { apiKey: string; baseURL: string; model: string } | null = null;
    try {
      const vlm = LLMFactory.getEffectiveConfig('visual');
      if (vlm.apiKey && vlm.baseURL && vlm.model) {
        vlmConfig = { apiKey: vlm.apiKey, baseURL: vlm.baseURL, model: vlm.model };
      }
    } catch {
      // 未配置 LLM 凭据，VLM 重排不可用（低置信段保持 CLIP 匹配结果）
    }

    try {
      const kmResult = await AIDaemon.getInstance().post('/api/solver/kuhn_munkres_match', {
        queries: kmQueries,
        videoChunks,
        bgmBeats,
        bpm: bgmBpm,
        weights: { sem: 0.35, emotion: 0.2, motion: 0.15, duration: 0.25, role: 0.05 },
        /** 🚀 中文→英文翻译链路：开启后 daemon 侧先把文案批量翻译再编码，CLIP 语义匹配才真正生效 */
        translateToEnglish: !!llmTranslate,
        ...(llmTranslate ? {
          llmApiKey: llmTranslate.apiKey,
          llmApiBase: llmTranslate.baseURL,
          llmApiModel: llmTranslate.model,
        } : {}),
        /** 🔍 VLM 二次裁决：低置信度匹配让云端多模态 LLM 直接看候选封面图选最优 */
        ...(vlmConfig ? {
          vlmApiKey: vlmConfig.apiKey,
          vlmApiBase: vlmConfig.baseURL,
          vlmApiModel: vlmConfig.model,
        } : {}),
      }, { timeout: 180000 });

      onProgress(80, '匹配完成，正在整理结果...');

      /** 将匹配结果转换为前端需要的格式（保持 allQueries 原始顺序；原声命中段优先取定位结果） */
      const matchData = kmResult?.results || kmResult?.data || [];
      const matches = allQueries.map((q) => {
        /** 原声段落：命中定位则直接用定位结果 */
        const original = originalMatches.get(q.shotId);
        if (original) {
          return SemanticAnalyzeStrategy.buildMatchResult(q, original, true);
        }
        const matched = matchData.find((m: any) => m.shotId === q.shotId);
        if (matched) {
          return SemanticAnalyzeStrategy.buildMatchResult(q, matched, false);
        }
        /** 未匹配到的段落 */
        return SemanticAnalyzeStrategy.buildMatchResult(q, null, false);
      });

      onProgress(100, '镜头匹配完成');
      return { matches, segments: matchData, videoChunks, bgmBeats, originalMatchedCount: originalMatches.size };
    } catch (e: any) {
      AppLogger.error(LOG_TAGS.AI_AGENT, 'KM 匹配算法失败，回退到 CLIP 帧匹配', e);

      /** 回退：使用原有的 CLIP 帧匹配（原声段落仍保留定位结果） */
      const fallbackQueries = kmQueries;
      const fallback = await this.fallbackFrameMatch(fallbackQueries, cacheDir, onProgress);
      const matches = allQueries.map((q) => {
        const original = originalMatches.get(q.shotId);
        if (original) {
          return SemanticAnalyzeStrategy.buildMatchResult(q, original, true);
        }
        return fallback.matches.find((m: any) => m.shotId === q.shotId) || SemanticAnalyzeStrategy.buildMatchResult(q, null, false);
      });
      return { matches, segments: fallback.segments, videoChunks, bgmBeats, originalMatchedCount: originalMatches.size };
    }
  }

  /**
   * 🎙️ 原声段落定位：把文案中的原声引用文本与 ASR 时间轴做包含匹配，
   * 找到原声在原片中的时间段，再锁定覆盖该时间段的视频切片（切片自带原声轨）。
   * 未命中返回 null，调用方回退语义匹配。
   * @param text 原声引用文本（LLM 填写的原声台词原文）
   * @param asrLines ASR 时间轴 [{ text, startMs, endMs }]
   * @param videoChunks 视频切片池 [{ id, startMs, endMs, coverPath }]
   */
  static locateOriginalClip(
    text: string,
    asrLines: any[],
    videoChunks: any[],
  ): { chunkId: string; coverPath: string; chunkData: any; audioDurationMs: number; videoTimelineStartMs: number; videoTimelineEndMs: number } | null {
    if (!text || !Array.isArray(asrLines) || asrLines.length === 0 || !Array.isArray(videoChunks) || videoChunks.length === 0) {
      return null;
    }
    /** 归一化：去空白 + 去引号，做宽松包含匹配 */
    const norm = (t: string) => (t || '').replace(/\s+/g, '').replace(/[「」『』""''【】()（）]/g, '');
    const qText = norm(text);
    if (!qText) return null;

    /** 1. 在 ASR 时间轴中找与原文最贴近的行（最长包含匹配，避免短句误命中） */
    let best: any = null;
    let bestLen = 0;
    for (const line of asrLines) {
      const lineText = norm(line.text || line.originalText || '');
      if (!lineText) continue;
      if (qText.includes(lineText) || lineText.includes(qText)) {
        if (lineText.length > bestLen) {
          best = line;
          bestLen = lineText.length;
        }
      }
    }
    if (!best) return null;
    const startMs = best.startMs ?? 0;
    const endMs = best.endMs ?? startMs + 3000;
    if (endMs <= startMs) return null;

    /** 2. 找覆盖 [startMs, endMs] 时间窗的切片（优先完整覆盖，其次 ±500ms 容差） */
    const chunk = videoChunks.find((c: any) => c.startMs <= startMs && c.endMs >= endMs)
      || videoChunks.find((c: any) => c.startMs <= startMs + 500 && c.endMs >= endMs - 500);
    if (!chunk) return null;

    return {
      chunkId: chunk.id || '',
      coverPath: chunk.coverPath || '',
      chunkData: chunk,
      audioDurationMs: endMs - startMs,
      videoTimelineStartMs: startMs,
      videoTimelineEndMs: endMs,
    };
  }

  /**
   * 组装单条匹配结果（原声定位 / 语义匹配 / 未匹配 共用出口）
   * @param q query 段落（含 shotId/text/audioDurationMs/keepOriginalAudio）
   * @param matched KM 匹配项或原声定位结果；null 表示未匹配
   * @param isOriginal 是否为已定位的原声段落（原声段落自带原声轨，固定高置信）
   */
  static buildMatchResult(
    q: { shotId: string; text: string; audioDurationMs: number; keepOriginalAudio?: boolean },
    matched: any | null,
    isOriginal: boolean,
  ): any {
    if (matched) {
      return {
        shotId: q.shotId,
        text: q.text,
        keepOriginalAudio: isOriginal,
        mediaType: 'video_chunk' as const,
        mediaId: matched.chunkId || matched.mediaId || '',
        score: isOriginal ? 0.95 : (matched.confidence || 0),
        thumbnail: matched.coverPath || '',
        chunkData: matched.chunkData || null,
        audioDurationMs: matched.audioDurationMs || q.audioDurationMs,
        videoTimelineStartMs: matched.videoTimelineStartMs || 0,
        videoTimelineEndMs: matched.videoTimelineEndMs || 0,
        appliedSpeedFactor: matched.appliedSpeedFactor || 1.0,
        confirmed: isOriginal ? true : (matched.confidence || 0) >= 0.88,
      };
    }
    return {
      shotId: q.shotId,
      text: q.text,
      keepOriginalAudio: isOriginal,
      mediaType: 'video_chunk' as const,
      mediaId: '',
      score: 0,
      thumbnail: '',
      chunkData: null,
      audioDurationMs: q.audioDurationMs,
      videoTimelineStartMs: 0,
      videoTimelineEndMs: 0,
      appliedSpeedFactor: 1.0,
      confirmed: false,
    };
  }

  /** 回退到原有的 CLIP 帧匹配模式 */
  private async fallbackFrameMatch(
    queries: { shotId: string; text: string; audioDurationMs: number; keepOriginalAudio?: boolean }[],
    cacheDir: string,
    onProgress: (p: number, s: string) => void
  ): Promise<any> {
    onProgress(50, '回退到 CLIP 帧匹配模式...');

    /** 查找帧画面目录 */
    let framesDir = cacheDir;
    const altDirs = [
      path.join(cacheDir, '..', 'vision-1', 'frames'),
      path.join(cacheDir, 'frames'),
    ];
    for (const dir of altDirs) {
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir).filter(f => /\.(jpg|jpeg|png|bmp)$/i.test(f));
        if (files.length > 0) {
          framesDir = dir;
          break;
        }
      }
    }

    try {
      const result = await AIDaemon.getInstance().post('/api/match', {
        queries: queries.map(q => ({ shotId: q.shotId, text: q.text })),
        frames_dir: framesDir,
      });

      const matchData = result?.data || [];
      const matches = queries.map(q => {
        const matched = matchData.find((m: any) => m.shotId === q.shotId);
        const matchedFrame = matched?.matchedFrame || '';
        const thumbnail = matchedFrame ? path.join(framesDir, matchedFrame) : '';

        return {
          shotId: q.shotId,
          text: q.text,
          mediaType: 'frame' as const,
          mediaId: matchedFrame || '',
          score: matched ? 0.5 : 0,
          thumbnail,
          chunkData: null,
          audioDurationMs: q.audioDurationMs,
          videoTimelineStartMs: 0,
          videoTimelineEndMs: 0,
          appliedSpeedFactor: 1.0,
          confirmed: false,
        };
      });

      onProgress(100, '帧匹配完成（回退模式）');
      return { matches, segments: matchData };
    } catch (e: any) {
      AppLogger.error(LOG_TAGS.AI_AGENT, '镜头匹配服务调用失败', e);
      throw new Error('镜头匹配服务异常: ' + (e.message || '未知错误'));
    }
  }
}
