// 路径: src/main/services/ProjectPayloadAssembler.ts
// 从 ProjectService.assembleFullPayload 提取为独立纯函数
// 职责：将 DB 原始数据加工为前端可直接消费的结构化数据
// 纯数据变换，仅依赖 shared 层纯函数工具（normalizeScriptParagraph），可独立单测

import { normalizeScriptParagraph } from '../../shared/utils/normalizeScriptParagraph';

/**
 * 组装完整项目载荷：将 DB 原始数据加工为前端可直接消费的结构化数据
 * 替代前端 hydrateProjectData 中的 JSON 解析、状态推导、数据合并逻辑
 *
 * @param rawData  DB 查询返回的原始数据（已 hydratePaths 处理）
 * @param projectId 项目 ID
 * @returns 结构化的 FullProjectPayload
 */
export function assembleProjectPayload(rawData: any, projectId: string): any {
  if (!rawData) return null;

  // 1. 解析 metadata 中可能为 JSON 字符串的字段
  const parseJson = (val: any) => {
    if (typeof val === 'string' && val.trim().length > 0) {
      try { return JSON.parse(val); } catch { return val; }
    }
    return val;
  };

  /**
   * 迁移旧版保留原声字段为统一数值（0~0.8）。
   * 旧版枚举 cover/keep_key/original_main → 0 / 0.15 / 0.55；缺失字段补默认 0.15；数字直接 clamp 到 [0, 0.8]。
   * 无法识别的非法值抛错暴露（不静默降级），符合"错就错"原则。
   */
  const normalizeRetainRatio = (v: unknown): number => {
    if (typeof v === 'number') return Math.max(0, Math.min(0.8, v));
    if (v === undefined || v === null) return 0.15;
    if (v === 'cover') return 0;
    if (v === 'keep_key') return 0.15;
    if (v === 'original_main') return 0.55;
    throw new Error(`[ProjectPayloadAssembler] pipelineParams.originalAudioStrategy 非法值: ${JSON.stringify(v)}`);
  };

  /**
   * 迁移旧版双参数（narrationDensity 枚举 + originalAudioStrategy 枚举/数值）→ 新版单一 narrationRatio（解说占比 0~1）。
   * 旧版实际填充率 = 密度基础系数(满1.0/标准0.85/留白0.6) × 原声折扣(1 - 保留原声比例)，合并后即解说占比。
   * - narrationRatio 已存在（新版）→ 直接 clamp 到 [0, 1]
   * - 缺失字段按旧默认值推导（密度 standard 0.85 / 原声保留 0.15）
   */
  const normalizeNarrationRatio = (raw: any): number => {
    if (typeof raw?.narrationRatio === 'number') return Math.max(0, Math.min(1, raw.narrationRatio));
    const baseFill = raw?.narrationDensity === 'full' ? 1.0
                   : raw?.narrationDensity === 'sparse' ? 0.6
                   : 0.85; // standard 或缺失
    const retainRatio = normalizeRetainRatio(raw?.originalAudioStrategy);
    return Math.max(0, Math.min(1, baseFill * (1 - retainRatio)));
  };

  /** 归一化项目级 pipelineParams：旧版双参数迁移为单一 narrationRatio，防止前端计算 NaN 与概念冲突 */
  const normalizePipelineParams = (raw: any): any => {
    if (!raw || typeof raw !== 'object') return raw;
    const next: any = { ...raw };
    next.narrationRatio = normalizeNarrationRatio(raw);
    // 移除旧版字段（已被 narrationRatio 取代，避免残留污染前端）
    delete next.narrationDensity;
    delete next.originalAudioStrategy;
    return next;
  };

  const subStepStatuses: Record<string, string> = parseJson(rawData.subStepStatuses) || {};
  const subStepProgresses: Record<string, number> = parseJson(rawData.subStepProgresses) || {};
  // 读取子步骤耗时记录（重进项目后仍可展示上次执行耗时）
  const subStepTimings: Record<string, any> = parseJson(rawData.subStepTimings) || {};
  const stepStatuses: string[] = parseJson(rawData.stepStatuses) || ['idle', 'idle', 'idle', 'idle', 'idle'];
  const stepCompleted: boolean[] = parseJson(rawData.stepCompleted) || [false, false, false, false, false];

  // 2. 归一化 subStepStatuses：running → idle（上次加载时无活跃管线，残留 running 一律视为过期）
  const normalizedSubSteps: Record<string, string> = { ...subStepStatuses };
  for (const key of Object.keys(normalizedSubSteps)) {
    if (normalizedSubSteps[key] === 'running') {
      normalizedSubSteps[key] = 'idle';
    }
  }

  // 3. 推导 step1 总状态（与前端 deriveStep1Status 逻辑一致）
  const STEP1_KEYS = ['frames', 'audio', 'whisper', 'faces'];
  const step1Values = STEP1_KEYS.map(k => normalizedSubSteps[k]).filter(v => v !== undefined && v !== null);
  if (step1Values.length > 0) {
    const allCompleted = step1Values.length === 4 && step1Values.every(v => v === 'completed');
    const hasFailed = step1Values.some(v => v === 'failed');
    const derivedStatus = allCompleted ? 'completed' : (hasFailed ? 'failed' : 'idle');
    const derivedCompleted = allCompleted;
    const hasStarted = step1Values.some(v => v === 'completed' || v === 'failed');
    const currentS0 = stepStatuses[0] || 'idle';
    const step1Active = currentS0 === 'running' || currentS0 === 'completed' || currentS0 === 'failed';
    if ((hasStarted || step1Active) && (currentS0 !== derivedStatus || stepCompleted[0] !== derivedCompleted)) {
      stepStatuses[0] = derivedStatus;
      stepCompleted[0] = derivedCompleted;
    }
  }

  // 4. 计算 currentStep
  let currentStep = 1;
  const savedStep = rawData.currentStep;
  if (savedStep && typeof savedStep === 'number') {
    currentStep = savedStep;
  } else {
    const lastCompletedIdx = stepCompleted.lastIndexOf(true);
    if (lastCompletedIdx >= 0 && lastCompletedIdx < stepCompleted.length - 1) {
      currentStep = lastCompletedIdx + 2;
    } else if (lastCompletedIdx === stepCompleted.length - 1) {
      currentStep = stepCompleted.length;
    }
  }

  // 5. 提取视频/音频/ASR 字段
  const videoPath = rawData.videoPath || rawData.video_path || '';
  const vocalPath = rawData.vocalPath || '';
  const backgroundPath = rawData.backgroundPath || '';
  const asrLines = Array.isArray(rawData.asrLines) ? rawData.asrLines : [];

  // 6. 从 mediaItems 提取 framePaths + 生成音频 mediaItems
  let mediaItems = Array.isArray(rawData.mediaItems) ? rawData.mediaItems : [];
  let framePaths: string[] = [];
  // 🎬 帧真实时间戳（源坐标，与 framePaths 顺序对齐）：DB media_assets.frames_time_ms 落库读取
  let frameTimeMs: number[] = [];
  const videoItems = mediaItems.filter((m: any) => m.type === 'video');

  /**
   * 补全帧路径为渲染可用格式：
   * hydratePaths 会把 DB 中的 magic://{projectId}/ 转成相对路径（nodes/...），
   * 但渲染 img 需要完整 magic URL（getSafeMediaUrl 无法把项目内相对路径解析成有效地址）。
   * 相对路径 → magic://{projectId}/{相对路径}；绝对路径 / 已有协议直接透传。
   */
  const toMagicFrameUrl = (p: string): string => {
    if (!p) return '';
    if (p.startsWith('magic://') || p.startsWith('http://') || p.startsWith('https://') || p.startsWith('data:') || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return p;
    return `magic://${projectId}/${p}`;
  };

  videoItems.forEach((media: any) => {
    if (media.frames && Array.isArray(media.frames) && media.frames.length > 0) {
      const frames = media.frames
        .map((frame: any) => typeof frame === 'string' ? frame : (frame.path || frame.filePath || frame.thumbnail || ''))
        .filter(Boolean)
        .map(toMagicFrameUrl);
      framePaths = [...framePaths, ...frames];
      // 🎬 帧真实时间戳（源坐标）：与 frames 顺序对齐，首个视频素材的时间戳作为全片时间轴
      if (Array.isArray(media.framesTimeMs) && media.framesTimeMs.length > 0) {
        frameTimeMs = media.framesTimeMs.map((t: any) => Math.round(Number(t) || 0));
      }
    }
  });

  // 降级：DB 无 frames 时从 metadata.framePaths 恢复
  if (framePaths.length === 0) {
    const metaFrames = rawData.framePaths;
    if (metaFrames && Array.isArray(metaFrames) && metaFrames.length > 0) {
      framePaths = metaFrames.map(toMagicFrameUrl);
    }
  }

  // 生成音频 mediaItems（分离人声、背景音、提取音频）
  const existingAudioTypes = new Set(
    mediaItems.filter((m: any) => m.type === 'audio').map((m: any) => m.sourceType)
  );
  const newAudioItems: any[] = [];
  videoItems.forEach((media: any) => {
    if (media.extractedVocals && !existingAudioTypes.has('vocals')) {
      newAudioItems.push({
        id: `${media.id}_vocals`, type: 'audio', sourceType: 'vocals',
        fileName: '分离人声', name: '分离人声',
        filePath: media.extractedVocals, projectId, mediaId: media.id,
        createdAt: new Date().toISOString(),
      });
    }
    if (media.extractedBgm && !existingAudioTypes.has('bgm')) {
      newAudioItems.push({
        id: `${media.id}_bgm`, type: 'audio', sourceType: 'bgm',
        fileName: '分离背景音', name: '分离背景音',
        filePath: media.extractedBgm, extractedBgm: media.extractedBgm, projectId, mediaId: media.id,
        createdAt: new Date().toISOString(),
      });
    }
    if (media.extractedAudio && !media.extractedVocals && !media.extractedBgm && !existingAudioTypes.has('extracted')) {
      newAudioItems.push({
        id: `${media.id}_extracted`, type: 'audio', sourceType: 'extracted',
        fileName: '提取音频', name: '提取音频',
        filePath: media.extractedAudio, projectId, mediaId: media.id,
        createdAt: new Date().toISOString(),
      });
    }
  });
  if (newAudioItems.length > 0) {
    mediaItems = [...mediaItems, ...newAudioItems];
  }

  // 有视频路径但无 mediaItems 时自动构建
  if (videoPath && mediaItems.length === 0) {
    mediaItems = [{ id: 'main-video-source', name: '原始导入多媒体文件', filePath: videoPath, path: videoPath, type: 'video' }];
  }

  const frameCount = rawData.frameCount || framePaths.length || 0;

  // 7. 组装最终 payload
  return {
    id: projectId,
    name: rawData.projectName || '',
    mediaItems,
    roles: rawData.roles || [],
    shots: rawData.shots || [],
    aiShots: rawData.aiShots || [],
    // 提取数据
    videoPath,
    vocalPath,
    backgroundPath,
    asrLines,
    framePaths,
    frameTimeMs,
    frameCount,
    audioSeparated: !!rawData.audioSeparated,
    // 管线状态（已解析、已归一化、已推导）
    subStepStatuses: normalizedSubSteps,
    subStepProgresses,
    subStepTimings,
    stepStatuses,
    stepCompleted,
    currentStep,
    // 各步骤数据
    pipelineParams: normalizePipelineParams(rawData.pipelineParams),
    extractionConfig: rawData.extractionConfig,
    vlmFrames: Array.isArray(rawData.vlmFrames) ? rawData.vlmFrames : [],
    // 解说段落唯一持久化入口：经 Normalizer 工厂统一净化为判别联合契约
    // （补齐 type / 毫秒时间轴 / 原声段 audioSource 结构体，历史三代数据形态在此收敛）
    scriptParagraphs: Array.isArray(rawData.scriptParagraphs)
      ? rawData.scriptParagraphs.map((p: unknown) => normalizeScriptParagraph(p))
      : [],
    scriptStyle: rawData.scriptStyle,
    speechRate: rawData.speechRate,
    ttsResults: Array.isArray(rawData.ttsResults) ? rawData.ttsResults : [],
    ttsEngine: rawData.ttsEngine,
    ttsVoiceId: rawData.ttsVoiceId,
    videoChunks: Array.isArray(rawData.videoChunks) ? rawData.videoChunks : [],
    // 步骤5 匹配结果 + BGM 节拍（metadata 持久化，重启恢复）
    matchResults: Array.isArray(rawData.matchResults) ? rawData.matchResults : [],
    activeBgm: rawData.activeBgm || null,
    beatTimestamps: Array.isArray(rawData.beatTimestamps) ? rawData.beatTimestamps : [],
    deepRecommendation: rawData.deepRecommendation || null,
    // Canvas
    canvasData: rawData.canvasData,
    // 分镜模式('original' | 'ai'):存于 metadata,需回传给前端 hydrate 恢复
    storyboardMode: rawData.storyboardMode === 'ai' ? 'ai' : 'original',
  };
}