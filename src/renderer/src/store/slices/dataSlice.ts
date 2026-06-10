// 📁 路径：src/renderer/src/store/slices/dataSlice.ts
import type { StateCreator } from 'zustand';
import type { EditorState, DataSlice } from '../storeTypes';
import type { Shot } from '../../../../shared/types';
import { AppNotifier } from '../../core/AppNotifier';
import { API } from '../../api';

/** 💥 工业级减法：防抖影子保存器，防止主进程磁盘 I/O 被高频更新锁死 */
let shadowSaveTimer: any = null;
const debouncedShadowSave = (projectId: string, getShots: () => any, getAiShots: () => any) => {
  if (shadowSaveTimer) clearTimeout(shadowSaveTimer);
  shadowSaveTimer = setTimeout(() => {
    if (typeof window !== 'undefined' && window.api?.ipc?.invoke) {
      const snapshot = { shots: getShots(), aiShots: getAiShots() };
      window.api.ipc.invoke(
        'DRAFT_SHADOW_SAVE',
        { projectId, draftJson: JSON.stringify(snapshot) }
      ).catch(() => {});
    }
  }, 300);
};

export const createDataSlice: StateCreator<EditorState, [], [], DataSlice> = (set, get) => ({
  projectId: null,
  projectPath: '',
  projectName: '加载中...',
  mediaItems: [],
  shots: [],
  roles: [], aiShots: [], characterRelations: [],
  storyboardMode: 'original', canvasData: null, pastSnapshots: [], futureSnapshots: [],

  /** 💥 合并后的单职责核心资产区：完全承载音轨路径与 ASR 文本流契约 */
  extractedData: {
    videoPath: '',
    vocalPath: '',
    backgroundPath: '',
    asrLines: [],
    frameCount: 0,
    framePaths: []
  },

  saveSnapshot: () => {
    const state = get();
    const snapshot = { shots: JSON.parse(JSON.stringify(state.shots)), aiShots: JSON.parse(JSON.stringify(state.aiShots)) };
    set({ pastSnapshots: [...state.pastSnapshots, snapshot].slice(-30), futureSnapshots: [] });
  },

  undo: () => {
    const state = get();
    if (state.pastSnapshots.length === 0) return;
    const previous = state.pastSnapshots[state.pastSnapshots.length - 1];
    const currentSnapshot = { shots: JSON.parse(JSON.stringify(state.shots)), aiShots: JSON.parse(JSON.stringify(state.aiShots)) };
    set({ shots: previous.shots, aiShots: previous.aiShots, pastSnapshots: state.pastSnapshots.slice(0, -1), futureSnapshots: [currentSnapshot, ...state.futureSnapshots] });
    AppNotifier.info('已撤销 (Undo)');
  },

  redo: () => {
    const state = get();
    if (state.futureSnapshots.length === 0) return;
    const next = state.futureSnapshots[0];
    const currentSnapshot = { shots: JSON.parse(JSON.stringify(state.shots)), aiShots: JSON.parse(JSON.stringify(state.aiShots)) };
    set({ shots: next.shots, aiShots: next.aiShots, pastSnapshots: [...state.pastSnapshots, currentSnapshot], futureSnapshots: state.futureSnapshots.slice(1) });
    AppNotifier.info('已重做 (Redo)');
  },

  setProjectMeta: (id, name) => set({ projectId: id, projectName: name }),
  setStoryboardMode: (mode) => set({ storyboardMode: mode }),

  addMediaItem: (item) => set((state) => ({ mediaItems: [...state.mediaItems, item] })),
  addMediaItems: (items) => set((state) => ({ mediaItems: [...state.mediaItems, ...items] })),
  setMediaItems: (items) => set({ mediaItems: items }),
  updateMediaItem: (id, updates) => set((state) => ({ mediaItems: state.mediaItems.map(item => item.id === id ? { ...item, ...updates } : item) })),

  removeMediaItem: (id: string) => {
    get().saveSnapshot();
    set((state) => ({
      mediaItems: state.mediaItems.filter(item => item.id !== id),
      shots: state.shots.filter(shot => shot.mediaId !== id),
      aiShots: state.aiShots.filter(shot => shot.mediaId !== id),
      roles: state.roles.filter(role => !role.id.startsWith(id)),
      selectedItemId: state.selectedItemId === id ? null : state.selectedItemId,
      activePlaySource: state.activePlaySource?.id === id ? null : state.activePlaySource
    }));
  },

  updateShot: (id, payload) => {
    get().saveSnapshot();
    set((state) => ({ shots: state.shots.map(s => s.id === id ? { ...s, ...payload } : s), aiShots: state.aiShots.map(s => s.id === id ? { ...s, ...payload } : s) }));

    const projectId = get().projectId;
    if (projectId) {
      debouncedShadowSave(projectId, () => get().shots, () => get().aiShots);
    }
  },

  removeShot: (id) => {
    get().saveSnapshot();
    set((state) => ({ shots: state.shots.filter(shot => shot.id !== id), selectedItemId: state.selectedItemId === id ? null : state.selectedItemId }));
  },

  /** 在故事板末尾添加空白镜头卡片 */
  addBlankShot: () => {
    get().saveSnapshot();
    const newShot: Shot = {
      id: `shot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      mediaId: '',
      imagePath: '',
      text: '',
      start: 0,
      end: 0,
      duration: 5,
      type: 'blank',
    };
    set((state) => ({ shots: [...state.shots, newShot] }));
  },

  /** 通过索引移动镜头位置（拖拽排序） */
  moveShotByIndex: (fromIndex, toIndex) => {
    get().saveSnapshot();
    set((state) => {
      const newShots = [...state.shots];
      const [moved] = newShots.splice(fromIndex, 1);
      newShots.splice(toIndex, 0, moved);
      return { shots: newShots };
    });
  },

  setAiShots: (shots) => { get().saveSnapshot(); set({ aiShots: shots }); },
  updateAiShot: (id, updates) => {
    get().saveSnapshot();
    set((state) => ({ aiShots: state.aiShots.map(shot => shot.id === id ? { ...shot, ...updates } : shot) }));

    const projectId = get().projectId;
    if (projectId) {
      debouncedShadowSave(projectId, () => get().shots, () => get().aiShots);
    }
  },
  insertOriginalShot: (newShot) => { get().saveSnapshot(); set((state) => ({ shots: [...state.shots, newShot].sort((a, b) => a.start - b.start) })); },
  updateRole: (id, updates) => set((state) => ({ roles: state.roles.map(role => role.id === id ? { ...role, ...updates } : role) })),

  mergeRoles: (sourceRoleId, targetRoleId) => {
    get().saveSnapshot();
    set((state) => {
      if (sourceRoleId === targetRoleId) return state;
      const sourceRole = state.roles.find(r => r.id === sourceRoleId);
      const targetRole = state.roles.find(r => r.id === targetRoleId);
      if (!sourceRole || !targetRole) return state;

      const newShots = state.shots.map(shot => shot.roleId === sourceRoleId ? { ...shot, roleId: targetRoleId, originalRoleId: shot.originalRoleId || sourceRoleId } : shot);
      const newAiShots = state.aiShots.map(shot => shot.roleId === sourceRoleId ? { ...shot, roleId: targetRoleId, originalRoleId: shot.originalRoleId || sourceRoleId } : shot);

      const newTargetRole = { ...targetRole, mergedRoles: [...(targetRole.mergedRoles || []), sourceRole] };
      const newRoles = state.roles.filter(r => r.id !== sourceRoleId).map(r => r.id === targetRoleId ? newTargetRole : r);
      const newSelectedId = state.selectedItemId === sourceRoleId ? targetRoleId : state.selectedItemId;

      return { shots: newShots, aiShots: newAiShots, roles: newRoles, selectedItemId: newSelectedId };
    });
  },

  unmergeRole: (sourceRoleId, targetRoleId) => {
    get().saveSnapshot();
    set((state) => {
      const targetRole = state.roles.find(r => r.id === targetRoleId);
      if (!targetRole || !targetRole.mergedRoles) return state;
      const sourceRole = targetRole.mergedRoles.find(r => r.id === sourceRoleId);
      if (!sourceRole) return state;

      const newMergedRoles = targetRole.mergedRoles.filter(r => r.id !== sourceRoleId);
      const newTargetRole = { ...targetRole, mergedRoles: newMergedRoles };

      const newRoles = state.roles.map(r => r.id === targetRoleId ? newTargetRole : r);
      newRoles.push(sourceRole);

      const newShots = state.shots.map(shot => (shot.roleId === targetRoleId && shot.originalRoleId === sourceRoleId) ? { ...shot, roleId: sourceRoleId } : shot);
      const newAiShots = state.aiShots.map(shot => (shot.roleId === targetRoleId && shot.originalRoleId === sourceRoleId) ? { ...shot, roleId: sourceRoleId } : shot);

      return { roles: newRoles, shots: newShots, aiShots: newAiShots };
    });
  },

  applyAudioDomino: (shotId, audioPath, rawAudioDuration, strategy, target = 'shots') => {
    get().saveSnapshot();
    set((state) => {
      const targetArray = target === 'aiShots' ? [...state.aiShots] : [...state.shots];
      const targetIndex = targetArray.findIndex(s => s.id === shotId);
      if (targetIndex === -1) return state;

      const targetShot = targetArray[targetIndex];
      const originalDuration = targetShot.end - targetShot.start;

      let audioDuration = Number(rawAudioDuration);
      if (isNaN(audioDuration) || !isFinite(audioDuration) || audioDuration <= 0) {
        audioDuration = Math.max(originalDuration, 2);
      }

      targetArray[targetIndex] = { ...targetShot, audioPath, audioDuration, alignStrategy: strategy };

      if (strategy !== 'cut' && audioDuration > originalDuration) {
        const delta = audioDuration - originalDuration;
        targetArray[targetIndex].end += delta;
        for (let i = targetIndex + 1; i < targetArray.length; i++) {
          targetArray[i].start += delta;
          targetArray[i].end += delta;
        }
      }

      let newVideoDuration = targetArray[targetArray.length - 1].end;
      if (isNaN(newVideoDuration) || !isFinite(newVideoDuration)) newVideoDuration = state.videoDuration;

      return target === 'aiShots' ? { aiShots: targetArray, videoDuration: newVideoDuration } : { shots: targetArray, videoDuration: newVideoDuration };
    });
  },

  /** 重置项目状态，清除所有业务数据及撤销/重做历史 */
  resetProjectState: () => set(() => ({
    projectId: null, projectName: '加载中...',
    mediaItems: [], roles: [], shots: [], characterRelations: [],
    activePlaySource: null, isPlaying: false, currentTime: 0, videoDuration: 0, duration: 0,
    selectedItemId: null, selectedItemType: null,
    storyboardMode: 'original', aiShots: [],
    canvasData: null, pastSnapshots: [], futureSnapshots: [],
    extractedData: { videoPath: '', vocalPath: '', backgroundPath: '', asrLines: [], frameCount: 0, framePaths: [] },
    // 重置编辑器步骤和管线状态，防止切换项目后残留旧状态
    currentStep: 1,
    stepCompleted: [false, false, false, false, false],
    stepStatuses: ['idle', 'idle', 'idle', 'idle', 'idle'],
    subStepStatuses: { frames: 'idle', audio: 'idle', whisper: 'idle', faces: 'idle' },
    pipelineRunning: false,
    pipelineProgress: 0,
    pipelineNode: '',
    pipelineError: null,
    asrLines: [],
    frameCount: 0,
    audioSeparated: false,
  })),

  /** 💥 单职责 Action：专门负责重新进入项目或算法完工后的全量反序列化注水 */
  hydrateProjectData: (projectData) => set((state) => {
    if (!projectData) return state;

    const raw = projectData as any;
    let parsed: any = {};
    if (typeof raw.metadata === 'string' && raw.metadata.trim().length > 0) {
      try { parsed = JSON.parse(raw.metadata); } catch { parsed = {}; }
    } else if (raw.metadata && typeof raw.metadata === 'object') {
      parsed = raw.metadata;
    }

    const video = raw.videoPath || raw.video_path || parsed.videoPath || '';
    const vocal = raw.vocalPath || parsed.vocalPath || '';
    const background = raw.backgroundPath || parsed.backgroundPath || '';
    const asr = raw.asrLines || parsed.asrLines || [];
    const frameCount = raw.frameCount || parsed.frameCount || 0;
    const audioSeparated = raw.audioSeparated || parsed.audioSeparated || !!(vocal || background);

    // 如果有视频路径但 mediaItems 为空，自动构建媒体项确保播放器能识别
    let mediaItems = raw.mediaItems || state.mediaItems;
    if (video && (!mediaItems || mediaItems.length === 0)) {
      mediaItems = [{
        id: 'main-video-source',
        name: '原始导入多媒体文件',
        filePath: video,
        path: video,
        type: 'video'
      }];
    }

    // === 从 mediaItems 的视频项或元数据中提取关键帧路径给帧预览网格！ ===
    let framePaths: string[] = [];
    const videoItems = mediaItems.filter((m: any) => m.type === 'video');

    /** 💥 关键修复：始终优先从 mediaItems.frames（DB 最新数据）提取帧路径，
     *  metadata.framePaths 可能是旧策略的残留（如 211 帧），而 DB 已更新为新值（如 13 帧） */
    videoItems.forEach((media: any) => {
      if (media.frames && Array.isArray(media.frames) && media.frames.length > 0) {
        const frames = media.frames.map((frame: any) =>
          typeof frame === 'string' ? frame : (frame.path || frame.filePath || frame.thumbnail || '')
        ).filter(Boolean);
        framePaths = [...framePaths, ...frames];
      }
    });

    console.log('====== [HYDRATE 帧路径诊断] ======', {
      videoItemsCount: videoItems.length,
      firstVideoFrames: videoItems[0]?.frames?.slice?.(0, 3),
      framePathsCount: framePaths.length,
      framePathsSample: framePaths.slice(0, 3),
      metaFramePaths: (raw.framePaths || parsed.framePaths)?.slice?.(0, 3),
    });

    /** 降级：如果 DB 中没有 frames，再从 metadata.framePaths 恢复 */
    if (framePaths.length === 0) {
      const metaFramePaths = raw.framePaths || parsed.framePaths;
      if (metaFramePaths && Array.isArray(metaFramePaths) && metaFramePaths.length > 0) {
        framePaths = metaFramePaths;
      }
    }

    const existingAudioTypes = new Set(
      mediaItems
        .filter((m: any) => m.type === 'audio')
        .map((m: any) => m.sourceType)
    );
    const newItems: any[] = [];

    videoItems.forEach((media: any) => {
      // 生成音频项
      if (media.extractedVocals && !existingAudioTypes.has('vocals')) {
        newItems.push({
          id: crypto.randomUUID ? crypto.randomUUID() : `${media.id}_vocals_${Date.now()}`,
          type: 'audio',
          sourceType: 'vocals',
          fileName: '分离人声',
          name: '分离人声',
          filePath: media.extractedVocals,
          projectId: raw.id || state.projectId,
          mediaId: media.id,
          createdAt: new Date().toISOString(),
        });
      }

      if (media.extractedBgm && !existingAudioTypes.has('bgm')) {
        newItems.push({
          id: crypto.randomUUID ? crypto.randomUUID() : `${media.id}_bgm_${Date.now()}`,
          type: 'audio',
          sourceType: 'bgm',
          fileName: '分离背景音',
          name: '分离背景音',
          filePath: media.extractedBgm,
          projectId: raw.id || state.projectId,
          mediaId: media.id,
          createdAt: new Date().toISOString(),
        });
      }

      if (media.extractedAudio && !media.extractedVocals && !media.extractedBgm && !existingAudioTypes.has('extracted')) {
        newItems.push({
          id: crypto.randomUUID ? crypto.randomUUID() : `${media.id}_extracted_${Date.now()}`,
          type: 'audio',
          sourceType: 'extracted',
          fileName: '提取音频',
          name: '提取音频',
          filePath: media.extractedAudio,
          projectId: raw.id || state.projectId,
          mediaId: media.id,
          createdAt: new Date().toISOString(),
        });
      }
    });

    // 添加新生成的音频项
    if (newItems.length > 0) {
      mediaItems = [...mediaItems, ...newItems];
    }

    // 从 metadata 恢复子步骤状态
    /** 💥 关键修复：raw 顶层已包含 metadata 展开的字段，优先从 raw 读取 */
    let subStepStatuses = state.subStepStatuses;
    let subStepProgresses = state.subStepProgresses;
    let stepStatuses = state.stepStatuses;
    let stepCompleted = state.stepCompleted;

    const rawSubStepStatuses = raw.subStepStatuses || parsed.subStepStatuses;
    if (rawSubStepStatuses) {
      try {
        subStepStatuses = typeof rawSubStepStatuses === 'string'
          ? JSON.parse(rawSubStepStatuses)
          : rawSubStepStatuses;
      } catch {}
    }

    const rawSubStepProgresses = raw.subStepProgresses || parsed.subStepProgresses;
    if (rawSubStepProgresses) {
      try {
        subStepProgresses = typeof rawSubStepProgresses === 'string'
          ? JSON.parse(rawSubStepProgresses)
          : rawSubStepProgresses;
      } catch {}
    }

    const rawStepStatuses = raw.stepStatuses || parsed.stepStatuses;
    if (rawStepStatuses) {
      try {
        stepStatuses = typeof rawStepStatuses === 'string'
          ? JSON.parse(rawStepStatuses)
          : rawStepStatuses;
      } catch {}
    }

    const rawStepCompleted = raw.stepCompleted || parsed.stepCompleted;
    if (rawStepCompleted) {
      try {
        stepCompleted = typeof rawStepCompleted === 'string'
          ? JSON.parse(rawStepCompleted)
          : rawStepCompleted;
      } catch {}
    }

    /** 💥 从 metadata 恢复 extractionConfig，确保重进项目后抽帧参数不丢失 */
    const savedExtractionConfig = raw.extractionConfig || parsed.extractionConfig;

    /** 💥 从 metadata 恢复 vlmFrames，确保重进项目后步骤2画面描述数据不丢失 */
    const savedVlmFrames = raw.vlmFrames || parsed.vlmFrames;

    /** 💥 从 metadata 恢复步骤3解说文案数据，确保重进项目后文案不丢失 */
    const savedScriptParagraphs = raw.scriptParagraphs || parsed.scriptParagraphs;
    const savedScriptStyle = raw.scriptStyle || parsed.scriptStyle;
    const savedSpeechRate = raw.speechRate || parsed.speechRate;
    const savedPipelineParams = raw.pipelineParams || parsed.pipelineParams;

    /** 💥 从 metadata 恢复步骤4配音结果，确保重进项目后配音数据不丢失 */
    const savedTtsResults = raw.ttsResults || parsed.ttsResults;
    const savedTtsEngine = raw.ttsEngine || parsed.ttsEngine;
    const savedTtsVoiceId = raw.ttsVoiceId || parsed.ttsVoiceId;

    /** 💥 自动修正状态不一致：如果 subStepStatuses 全是 completed 但 stepStatuses[0] 还是 running 且 stepCompleted[0] 是 false */
    if (
      subStepStatuses &&
      typeof subStepStatuses === 'object' &&
      subStepStatuses.frames === 'completed' &&
      subStepStatuses.audio === 'completed' &&
      subStepStatuses.whisper === 'completed' &&
      subStepStatuses.faces === 'completed' &&
      Array.isArray(stepStatuses) &&
      stepStatuses[0] === 'running' &&
      Array.isArray(stepCompleted) &&
      stepCompleted[0] === false
    ) {
      stepStatuses = [...stepStatuses];
      stepStatuses[0] = 'completed';
      stepCompleted = [...stepCompleted];
      stepCompleted[0] = true;
    }

    /** 💥 防御 extractionConfig 为 undefined 的情况：深度合并时确保基础结构存在 */
    const baseConfig = state.extractionConfig || {
      targetLanguage: 'zh-CN',
      frames: { enabled: true, mode: 'VLM_OPTIMIZED', sceneThreshold: 0.28, quality: 3, fps: 2, scale: 1024 },
      audio: { enabled: true, engine: 'mdx-net' },
      whisper: { enabled: true, engine: 'sensevoice' },
      faces: { enabled: true, engine: 'insightface' },
    };

    return {
      projectId: raw.id || state.projectId,
      projectName: raw.name || state.projectName,
      /** 💥 恢复当前步骤：根据已完成的步骤数推算，确保重进后能继续下一步 */
      currentStep: (() => {
        const saved = raw.currentStep || parsed.currentStep;
        if (saved && typeof saved === 'number') return saved;
        /** 如果没有保存 currentStep，根据 stepCompleted 推算 */
        const completed = stepCompleted || state.stepCompleted;
        if (Array.isArray(completed)) {
          const lastCompletedIdx = completed.lastIndexOf(true);
          if (lastCompletedIdx >= 0 && lastCompletedIdx < completed.length - 1) return lastCompletedIdx + 2;
          if (lastCompletedIdx === completed.length - 1) return completed.length;
        }
        return state.currentStep;
      })(),
      mediaItems,
      shots: raw.shots || parsed.shots || state.shots,
      aiShots: raw.aiShots || parsed.aiShots || state.aiShots,
      roles: raw.roles || parsed.roles || state.roles,
      asrLines: (() => {
          /** 💥 关键修复：空数组 [] 不应覆盖 store 中已有的 asrLines（如从 shots 提取的台词） */
          const lines = (Array.isArray(asr) && asr.length > 0) ? asr : state.asrLines;
          return lines.map((l: any) => l.originalText === undefined ? { ...l, originalText: l.text || '' } : l);
        })(),
      frameCount,
      audioSeparated,
      subStepStatuses,
      subStepProgresses,
      stepStatuses,
      stepCompleted,
      /** 💥 恢复抽帧配置：优先用持久化数据，否则保留 store 默认值，
       *  确保所有子字段（frames/audio/whisper/faces）都有默认值，防止 undefined 导致运行时报错 */
      extractionConfig: savedExtractionConfig
        ? {
            ...baseConfig,
            ...savedExtractionConfig,
            frames: { ...baseConfig.frames, ...(savedExtractionConfig.frames || {}) },
            audio: { ...baseConfig.audio, ...(savedExtractionConfig.audio || {}) },
            whisper: { ...baseConfig.whisper, ...(savedExtractionConfig.whisper || {}) },
            faces: { ...baseConfig.faces, ...(savedExtractionConfig.faces || {}) },
          }
        : baseConfig,
      /** 💥 恢复 VLM 画面描述数据：空数组不覆盖已有数据 */
      vlmFrames: (Array.isArray(savedVlmFrames) && savedVlmFrames.length > 0)
        ? savedVlmFrames
        : state.vlmFrames,
      /** 💥 恢复步骤3解说文案数据：空数组不覆盖已有数据 */
      scriptParagraphs: (Array.isArray(savedScriptParagraphs) && savedScriptParagraphs.length > 0)
        ? savedScriptParagraphs
        : state.scriptParagraphs,
      scriptStyle: savedScriptStyle || state.scriptStyle,
      speechRate: savedSpeechRate || state.speechRate,
      pipelineParams: savedPipelineParams || state.pipelineParams,
      /** 💥 恢复步骤4配音结果：空数组不覆盖已有数据 */
      ttsResults: (Array.isArray(savedTtsResults) && savedTtsResults.length > 0)
        ? savedTtsResults
        : state.ttsResults,
      ttsEngine: savedTtsEngine || state.ttsEngine,
      ttsVoiceId: savedTtsVoiceId || state.ttsVoiceId,
      extractedData: {
        videoPath: video,
        vocalPath: vocal,
        backgroundPath: background,
        asrLines: (Array.isArray(asr) && asr.length > 0) ? asr : state.extractedData.asrLines,
        /** 💥 关键修复：如果本次从 mediaItems 提取不到帧路径，保留 store 中已有的 framePaths，
         *  防止第一次 hydrate（DB 原始数据无 frames）清空第二次 hydrate（metadata 含 frames）的结果 */
        framePaths: framePaths.length > 0 ? framePaths : (state.extractedData?.framePaths || []),
        frameCount: frameCount || framePaths.length || (state.extractedData?.framePaths?.length || 0)
      }
    };
  }),

  /** 单职责 Action：更新音轨或 ASR 增量数据，联动 frameCount 原子更新 */
  setExtractedData: (data) => set((state) => {
    const nextFramePaths = data.framePaths || state.extractedData.framePaths || [];
    return {
      extractedData: { ...state.extractedData, ...data, framePaths: nextFramePaths },
      /** 响应式联动：framePaths 变化时自动更新 frameCount */
      frameCount: data.frameCount ?? nextFramePaths.length,
    };
  }),

  reorderShot: (id: string, droppedTimeX: number) => {
    get().saveSnapshot();
    const state = get();
    const isAiMode = state.storyboardMode === 'ai';
    const currentShots = isAiMode ? [...state.aiShots] : [...state.shots];

    if (id === 'FORCE_DOMINO_TRIGGER') {
      let currentCursor = 0;
      const finalShots = currentShots.map(shot => {
        const dur = shot.end - shot.start;
        const newShot = { ...shot, start: currentCursor, end: currentCursor + dur };
        currentCursor += dur;
        return newShot;
      });
      if (isAiMode) set({ aiShots: finalShots }); else set({ shots: finalShots });
      return;
    }

    const targetIndex = currentShots.findIndex(s => s.id === id);
    if (targetIndex === -1) return;
    const [targetShot] = currentShots.splice(targetIndex, 1);

    const duration = targetShot.end - targetShot.start;
    targetShot.start = droppedTimeX;
    targetShot.end = droppedTimeX + duration;

    currentShots.push(targetShot);
    currentShots.sort((a, b) => a.start - b.start);

    if (isAiMode) set({ aiShots: currentShots }); else set({ shots: currentShots });
  },

  addShotFromMedia: (media: any, droppedTimeX: number) => {
    get().saveSnapshot();
    const state = get();
    const isAiMode = state.storyboardMode === 'ai';
    const currentShots = isAiMode ? [...state.aiShots] : [...state.shots];

    let defaultDuration = 3;
    if (media.duration && typeof media.duration === 'number') {
      defaultDuration = media.duration;
    } else if (media.type === 'image') {
      defaultDuration = 5;
    }

    const newShot: any = {
      id: `shot_${crypto.randomUUID().substring(0, 8)}`,
      mediaId: media.id,
      start: droppedTimeX,
      end: droppedTimeX + defaultDuration,
      originalText: isAiMode && media.narrationScript ? media.narrationScript[0]?.narration || '' : '',
      aiText: isAiMode && media.narrationScript ? media.narrationScript[0]?.narration || '' : '',
      roleId: state.roles.length > 0 ? state.roles[0].id : 'default',
      coverPath: media.coverPath || '',
    };

    currentShots.push(newShot);

    if (isAiMode) set({ aiShots: currentShots });
    else set({ shots: currentShots });

    get().reorderShot(newShot.id, droppedTimeX);
    AppNotifier.success(`[${media.name}] 成功空投至轨道！`);
  },

  addExtractedAssets: (newShots = [], newRoles = []) => set((state) => {
    const existingShotIds = new Set(state.shots.map(s => s.id));
    const existingRoleIds = new Set(state.roles.map(r => r.id));
    const uniqueNewShots = newShots.filter(s => !existingShotIds.has(s.id)).map(s => ({ ...s }));
    const uniqueNewRoles = newRoles.filter(r => !existingRoleIds.has(r.id)).map(r => ({ ...r }));

    return {
      shots: [...state.shots, ...uniqueNewShots],
      roles: [...state.roles, ...uniqueNewRoles]
    };
  }),

  replaceExtractedAssets: (mediaId: string, newShots: any[] = [], newRoles: any[] = []) => set((state) => {
    const cleanShots = state.shots.filter(s => s.mediaId !== mediaId);
    const cleanRoles = state.roles.filter(r => r.mediaId !== mediaId);
    const stampedShots = newShots.map(s => ({ ...s, mediaId }));
    const stampedRoles = newRoles.map(r => ({ ...r, mediaId }));

    return {
      shots: [...cleanShots, ...stampedShots],
      roles: [...cleanRoles, ...stampedRoles]
    };
  }),

  /**
   * 导入媒体资产到当前工程
   * 已移除画布节点系统依赖，不再操作 nodes/updateNodeStatus/updateNodeData
   */
  importNodeMedia: async (_nodeId?: string) => {
    const state = get();
    if (!state.projectId) return AppNotifier.warn('系统异常：未找到当前工程 ID');
    try {
      const paths = await API.system.openMediaDialog();
      if (!paths || paths.length === 0) return;
      const newItems = await API.media.import(state.projectId, paths);
      if (newItems && newItems.length > 0) {
        get().addMediaItems(newItems);
        get().setActivePlaySource(newItems[0]);
        AppNotifier.success('资产导入并解析成功');
      }
    } catch (error: any) {
      console.error('[Media Import Error]:', error);
      AppNotifier.error(`导入失败: ${error.message || '未知异常'}`);
    }
  },

  splitShot: (splitTime: number) => {
    const state = get();
    const isAiMode = state.storyboardMode === 'ai';
    const currentShots = isAiMode ? [...state.aiShots] : [...state.shots];

    const targetIndex = currentShots.findIndex(s => splitTime > s.start && splitTime < s.end);
    if (targetIndex === -1) return AppNotifier.warn('当前游标位置处于真空区，无片段可切割');

    get().saveSnapshot();

    const targetShot = currentShots[targetIndex];
    const sourceOffset = targetShot.matchedStart != null ? targetShot.matchedStart : targetShot.start;

    const newShotA: Shot = { ...targetShot, end: splitTime, matchedStart: sourceOffset };
    const newShotB: Shot = {
      ...targetShot,
      id: `shot_${crypto.randomUUID().substring(0, 8)}`,
      start: splitTime,
      matchedStart: sourceOffset + (splitTime - targetShot.start),
      aiText: '', originalText: '', audioPath: '', audioDuration: 0
    };

    currentShots.splice(targetIndex, 1, newShotA, newShotB);

    if (isAiMode) set({ aiShots: currentShots });
    else set({ shots: currentShots });

    AppNotifier.success('✂️ 剃刀切割完成');
  },
});
