// 路径: src/main/services/ProjectPayloadAssembler.ts
// 从 ProjectService.assembleFullPayload 提取为独立纯函数
// 职责：将 DB 原始数据加工为前端可直接消费的结构化数据
// 纯数据变换，无外部依赖，可独立单测

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
  const videoItems = mediaItems.filter((m: any) => m.type === 'video');

  videoItems.forEach((media: any) => {
    if (media.frames && Array.isArray(media.frames) && media.frames.length > 0) {
      const frames = media.frames
        .map((frame: any) => typeof frame === 'string' ? frame : (frame.path || frame.filePath || frame.thumbnail || ''))
        .filter(Boolean);
      framePaths = [...framePaths, ...frames];
    }
  });

  // 降级：DB 无 frames 时从 metadata.framePaths 恢复
  if (framePaths.length === 0) {
    const metaFrames = rawData.framePaths;
    if (metaFrames && Array.isArray(metaFrames) && metaFrames.length > 0) {
      framePaths = metaFrames;
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
        filePath: media.extractedBgm, projectId, mediaId: media.id,
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
    pipelineParams: rawData.pipelineParams,
    extractionConfig: rawData.extractionConfig,
    vlmFrames: Array.isArray(rawData.vlmFrames) ? rawData.vlmFrames : [],
    scriptParagraphs: Array.isArray(rawData.scriptParagraphs) ? rawData.scriptParagraphs : [],
    scriptStyle: rawData.scriptStyle,
    speechRate: rawData.speechRate,
    ttsResults: Array.isArray(rawData.ttsResults) ? rawData.ttsResults : [],
    ttsEngine: rawData.ttsEngine,
    ttsVoiceId: rawData.ttsVoiceId,
    videoChunks: Array.isArray(rawData.videoChunks) ? rawData.videoChunks : [],
    // Canvas
    canvasData: rawData.canvasData,
  };
}