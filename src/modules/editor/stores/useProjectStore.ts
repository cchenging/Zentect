/**
 * useProjectStore — 项目核心数据独立 Store
 *
 * @description
 * 项目核心数据 Store：媒体素材、角色、镜头、撤销/重做等。
 * 从原全局 Store 的 dataSlice 独立而来，现为项目生命周期内的核心数据源。
 *
 * 迁移完成阶段：数据已完全独立，全局 Store 不再包含 DataSlice。
 */

import { create } from 'zustand';
import type { MediaItem, Shot, Role } from '../../../shared/types';
import { AppNotifier } from '../../../renderer/src/core/AppNotifier';
import { API } from '../../../renderer/src/api';
import { usePipelineStore } from '../../../renderer/src/store/usePipelineStore';
import { useStep1Store } from '../../pipeline/stores/useStep1Store';
import { useStep2Store } from '../../pipeline/stores/useStep2Store';
import { useStep3Store } from '../../pipeline/stores/useStep3Store';
import { useStep4Store } from '../../pipeline/stores/useStep4Store';
import { useStep5Store } from '../../pipeline/stores/useStep5Store';
import { useEditorNavStore } from './useEditorNavStore';

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

export interface CharacterRelation {
  id?: string;
  sourceRoleId: string;
  targetRoleId: string;
  relationType: string;
  description?: string;
}

export interface ExtractedData {
  videoPath: string;
  vocalPath: string;
  backgroundPath: string;
  asrLines: any[];
  frameCount: number;
  framePaths: string[];
}

export interface HistorySnapshot {
  shots: Shot[];
  aiShots: Shot[];
}

export interface ProjectStore {
  projectId: string | null;
  projectPath: string;
  projectName: string;
  mediaItems: MediaItem[];
  shots: Shot[];
  roles: Role[];
  aiShots: Shot[];
  characterRelations: CharacterRelation[];
  storyboardMode: 'original' | 'ai';
  canvasData: any;

  extractedData: ExtractedData;

  pastSnapshots: HistorySnapshot[];
  futureSnapshots: HistorySnapshot[];

  // 快照
  saveSnapshot: () => void;
  undo: () => void;
  redo: () => void;

  // 项目管理
  setProjectMeta: (id: string, name: string) => void;
  setStoryboardMode: (mode: 'original' | 'ai') => void;

  // 媒体
  addMediaItem: (item: MediaItem) => void;
  addMediaItems: (items: MediaItem[]) => void;
  setMediaItems: (items: MediaItem[]) => void;
  updateMediaItem: (id: string, updates: Partial<MediaItem>) => void;
  removeMediaItem: (id: string) => void;

  // 镜头
  updateShot: (id: string, updates: Partial<Shot>) => void;
  removeShot: (id: string) => void;
  addBlankShot: () => void;
  moveShotByIndex: (fromIndex: number, toIndex: number) => void;
  setAiShots: (shots: Shot[]) => void;
  updateAiShot: (id: string, updates: Partial<Shot>) => void;
  insertOriginalShot: (shot: Shot) => void;

  // 角色
  updateRole: (id: string, updates: Partial<Role>) => void;
  mergeRoles: (sourceRoleId: string, targetRoleId: string) => void;
  unmergeRole: (sourceRoleId: string, targetRoleId: string) => void;

  // 音频多米诺
  applyAudioDomino: (
    shotId: string, audioPath: string, audioDuration: number,
    strategy: 'slow' | 'freeze' | 'cut', target?: 'shots' | 'aiShots'
  ) => void;

  // 轨道操作
  reorderShot: (id: string, droppedTimeX: number) => void;
  addShotFromMedia: (media: any, droppedTimeX: number) => void;
  splitShot: (splitTime: number) => void;

  // 素材导入
  addExtractedAssets: (newShots: any[], newRoles: any[]) => void;
  replaceExtractedAssets: (mediaId: string, newShots: any[], newRoles: any[]) => void;
  setExtractedData: (data: Partial<ExtractedData>) => void;

  importNodeMedia: (nodeId?: string) => Promise<void>;

  // === 以下方法在阶段三迁移后生效 ===
  resetProjectState: () => void;
  hydrateProjectData: (projectData: any) => void;
}

export const useProjectStore = create<ProjectStore>()((set, get) => ({
  projectId: null,
  projectPath: '',
  projectName: '加载中...',
  mediaItems: [],
  shots: [],
  roles: [],
  aiShots: [],
  characterRelations: [],
  storyboardMode: 'original',
  canvasData: null,
  pastSnapshots: [],
  futureSnapshots: [],

  extractedData: {
    videoPath: '',
    vocalPath: '',
    backgroundPath: '',
    asrLines: [],
    frameCount: 0,
    framePaths: [],
  },

  saveSnapshot: () => {
    const state = get();
    const snapshot = {
      shots: JSON.parse(JSON.stringify(state.shots)),
      aiShots: JSON.parse(JSON.stringify(state.aiShots)),
    };
    set({
      pastSnapshots: [...state.pastSnapshots, snapshot].slice(-30),
      futureSnapshots: [],
    });
  },

  undo: () => {
    const state = get();
    if (state.pastSnapshots.length === 0) return;
    const previous = state.pastSnapshots[state.pastSnapshots.length - 1];
    const currentSnapshot = {
      shots: JSON.parse(JSON.stringify(state.shots)),
      aiShots: JSON.parse(JSON.stringify(state.aiShots)),
    };
    set({
      shots: previous.shots,
      aiShots: previous.aiShots,
      pastSnapshots: state.pastSnapshots.slice(0, -1),
      futureSnapshots: [currentSnapshot, ...state.futureSnapshots],
    });
    AppNotifier.info('已撤销 (Undo)');
  },

  redo: () => {
    const state = get();
    if (state.futureSnapshots.length === 0) return;
    const next = state.futureSnapshots[0];
    const currentSnapshot = {
      shots: JSON.parse(JSON.stringify(state.shots)),
      aiShots: JSON.parse(JSON.stringify(state.aiShots)),
    };
    set({
      shots: next.shots,
      aiShots: next.aiShots,
      pastSnapshots: [...state.pastSnapshots, currentSnapshot],
      futureSnapshots: state.futureSnapshots.slice(1),
    });
    AppNotifier.info('已重做 (Redo)');
  },

  setProjectMeta: (id, name) => set({ projectId: id, projectName: name }),
  setStoryboardMode: (mode) => set({ storyboardMode: mode }),

  addMediaItem: (item) => set((s) => ({ mediaItems: [...s.mediaItems, item] })),
  addMediaItems: (items) => set((s) => {
    const existingIds = new Set(s.mediaItems.map((i: any) => i.id));
    const uniqueItems = items.filter((i: any) => !existingIds.has(i.id));
    if (uniqueItems.length === 0) return { mediaItems: s.mediaItems };
    return { mediaItems: [...s.mediaItems, ...uniqueItems] };
  }),
  setMediaItems: (items) => set({ mediaItems: items }),
  updateMediaItem: (id, updates) =>
    set((s) => ({
      mediaItems: s.mediaItems.map((item) =>
        item.id === id ? { ...item, ...updates } : item
      ),
    })),

  /** @deprecated 跨 Slice 级联删除涉及 selectedItemId/activePlaySource，阶段三迁移时通过组合 Store 实现 */
  removeMediaItem: (id: string) => {
    get().saveSnapshot();
    set((s) => ({
      mediaItems: s.mediaItems.filter((item) => item.id !== id),
      shots: s.shots.filter((shot) => shot.mediaId !== id),
      aiShots: s.aiShots.filter((shot) => shot.mediaId !== id),
      roles: s.roles.filter((role) => !role.id.startsWith(id)),
    }));
    // ⚠️ 跨 Store 级联：selectedItemId 和 activePlaySource 在阶段三迁移时通过组合层处理
  },

  updateShot: (id, payload) => {
    get().saveSnapshot();
    set((s) => ({
      shots: s.shots.map((shot) =>
        shot.id === id ? { ...shot, ...payload } : shot
      ),
      aiShots: s.aiShots.map((shot) =>
        shot.id === id ? { ...shot, ...payload } : shot
      ),
    }));
    const projectId = get().projectId;
    if (projectId) {
      debouncedShadowSave(projectId, () => get().shots, () => get().aiShots);
    }
  },

  removeShot: (id) => {
    get().saveSnapshot();
    set((s) => ({
      shots: s.shots.filter((shot) => shot.id !== id),
    }));
  },

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
    set((s) => ({ shots: [...s.shots, newShot] }));
  },

  moveShotByIndex: (fromIndex, toIndex) => {
    get().saveSnapshot();
    set((s) => {
      const newShots = [...s.shots];
      const [moved] = newShots.splice(fromIndex, 1);
      newShots.splice(toIndex, 0, moved);
      return { shots: newShots };
    });
  },

  setAiShots: (shots) => {
    get().saveSnapshot();
    set({ aiShots: shots });
  },

  updateAiShot: (id, updates) => {
    get().saveSnapshot();
    set((s) => ({
      aiShots: s.aiShots.map((shot) =>
        shot.id === id ? { ...shot, ...updates } : shot
      ),
    }));
    const projectId = get().projectId;
    if (projectId) {
      debouncedShadowSave(projectId, () => get().shots, () => get().aiShots);
    }
  },

  insertOriginalShot: (newShot) => {
    get().saveSnapshot();
    set((s) => ({
      shots: [...s.shots, newShot].sort((a, b) => a.start - b.start),
    }));
  },

  updateRole: (id, updates) =>
    set((s) => ({
      roles: s.roles.map((role) =>
        role.id === id ? { ...role, ...updates } : role
      ),
    })),

  mergeRoles: (sourceRoleId, targetRoleId) => {
    get().saveSnapshot();
    set((s) => {
      if (sourceRoleId === targetRoleId) return s;
      const sourceRole = s.roles.find((r) => r.id === sourceRoleId);
      const targetRole = s.roles.find((r) => r.id === targetRoleId);
      if (!sourceRole || !targetRole) return s;
      const newShots = s.shots.map((shot) =>
        shot.roleId === sourceRoleId
          ? { ...shot, roleId: targetRoleId, originalRoleId: shot.originalRoleId || sourceRoleId }
          : shot
      );
      const newAiShots = s.aiShots.map((shot) =>
        shot.roleId === sourceRoleId
          ? { ...shot, roleId: targetRoleId, originalRoleId: shot.originalRoleId || sourceRoleId }
          : shot
      );
      const newTargetRole = {
        ...targetRole,
        mergedRoles: [...(targetRole.mergedRoles || []), sourceRole],
      };
      const newRoles = s.roles
        .filter((r) => r.id !== sourceRoleId)
        .map((r) => (r.id === targetRoleId ? newTargetRole : r));
      return { shots: newShots, aiShots: newAiShots, roles: newRoles };
    });
  },

  unmergeRole: (sourceRoleId, targetRoleId) => {
    get().saveSnapshot();
    set((s) => {
      const targetRole = s.roles.find((r) => r.id === targetRoleId);
      if (!targetRole || !targetRole.mergedRoles) return s;
      const sourceRole = targetRole.mergedRoles.find((r: any) => r.id === sourceRoleId);
      if (!sourceRole) return s;
      const newMergedRoles = targetRole.mergedRoles.filter((r: any) => r.id !== sourceRoleId);
      const newTargetRole = { ...targetRole, mergedRoles: newMergedRoles };
      const newRoles = s.roles.map((r) =>
        r.id === targetRoleId ? newTargetRole : r
      );
      newRoles.push(sourceRole);
      const newShots = s.shots.map((shot) =>
        shot.roleId === targetRoleId && shot.originalRoleId === sourceRoleId
          ? { ...shot, roleId: sourceRoleId }
          : shot
      );
      const newAiShots = s.aiShots.map((shot) =>
        shot.roleId === targetRoleId && shot.originalRoleId === sourceRoleId
          ? { ...shot, roleId: sourceRoleId }
          : shot
      );
      return { roles: newRoles, shots: newShots, aiShots: newAiShots };
    });
  },

  applyAudioDomino: (shotId, audioPath, rawAudioDuration, strategy, target = 'shots') => {
    get().saveSnapshot();
    set((s) => {
      const targetArray =
        target === 'aiShots' ? [...s.aiShots] : [...s.shots];
      const targetIndex = targetArray.findIndex((shot: Shot) => shot.id === shotId);
      if (targetIndex === -1) return s;
      const targetShot = targetArray[targetIndex];
      const originalDuration = targetShot.end - targetShot.start;
      let audioDuration = Number(rawAudioDuration);
      if (isNaN(audioDuration) || !isFinite(audioDuration) || audioDuration <= 0) {
        audioDuration = Math.max(originalDuration, 2);
      }
      targetArray[targetIndex] = {
        ...targetShot,
        audioPath,
        audioDuration,
        alignStrategy: strategy,
      };
      if (strategy !== 'cut' && audioDuration > originalDuration) {
        const delta = audioDuration - originalDuration;
        targetArray[targetIndex].end += delta;
        for (let i = targetIndex + 1; i < targetArray.length; i++) {
          targetArray[i].start += delta;
          targetArray[i].end += delta;
        }
      }
      return target === 'aiShots'
        ? { aiShots: targetArray }
        : { shots: targetArray };
    });
  },

  reorderShot: (id: string, droppedTimeX: number) => {
    get().saveSnapshot();
    const state = get();
    const isAiMode = state.storyboardMode === 'ai';
    const currentShots = isAiMode ? [...state.aiShots] : [...state.shots];

    if (id === 'FORCE_DOMINO_TRIGGER') {
      let currentCursor = 0;
      const finalShots = currentShots.map((shot) => {
        const dur = shot.end - shot.start;
        const newShot = { ...shot, start: currentCursor, end: currentCursor + dur };
        currentCursor += dur;
        return newShot;
      });
      if (isAiMode) set({ aiShots: finalShots });
      else set({ shots: finalShots });
      return;
    }

    const targetIndex = currentShots.findIndex((s) => s.id === id);
    if (targetIndex === -1) return;
    const [targetShot] = currentShots.splice(targetIndex, 1);
    const duration = targetShot.end - targetShot.start;
    targetShot.start = droppedTimeX;
    targetShot.end = droppedTimeX + duration;
    currentShots.push(targetShot);
    currentShots.sort((a, b) => a.start - b.start);
    if (isAiMode) set({ aiShots: currentShots });
    else set({ shots: currentShots });
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
      originalText:
        isAiMode && media.narrationScript
          ? media.narrationScript[0]?.narration || ''
          : '',
      aiText:
        isAiMode && media.narrationScript
          ? media.narrationScript[0]?.narration || ''
          : '',
      roleId: state.roles.length > 0 ? state.roles[0].id : 'default',
      coverPath: media.coverPath || '',
    };

    currentShots.push(newShot);
    if (isAiMode) set({ aiShots: currentShots });
    else set({ shots: currentShots });
    get().reorderShot(newShot.id, droppedTimeX);
    AppNotifier.success(`[${media.name}] 成功空投至轨道！`);
  },

  addExtractedAssets: (newShots = [], newRoles = []) =>
    set((s) => {
      const existingShotIds = new Set(s.shots.map((shot) => shot.id));
      const existingRoleIds = new Set(s.roles.map((r) => r.id));
      const uniqueNewShots = newShots
        .filter((shot: any) => !existingShotIds.has(shot.id))
        .map((s: any) => ({ ...s }));
      const uniqueNewRoles = newRoles
        .filter((r: any) => !existingRoleIds.has(r.id))
        .map((r: any) => ({ ...r }));
      return {
        shots: [...s.shots, ...uniqueNewShots],
        roles: [...s.roles, ...uniqueNewRoles],
      };
    }),

  replaceExtractedAssets: (mediaId: string, newShots: any[] = [], newRoles: any[] = []) =>
    set((s) => {
      const cleanShots = s.shots.filter((shot) => shot.mediaId !== mediaId);
      const cleanRoles = s.roles.filter((r: any) => r.mediaId !== mediaId);
      const stampedShots = newShots.map((s: any) => ({ ...s, mediaId }));
      const stampedRoles = newRoles.map((r: any) => ({ ...r, mediaId }));
      return {
        shots: [...cleanShots, ...stampedShots],
        roles: [...cleanRoles, ...stampedRoles],
      };
    }),

  setExtractedData: (data) =>
    set((s) => {
      const nextFramePaths = data.framePaths || s.extractedData.framePaths || [];
      return {
        extractedData: { ...s.extractedData, ...data, framePaths: nextFramePaths },
        // framePaths 变化时自动更新 frameCount（与 useStep1Store 中的 frameCount 独立）
      };
    }),

  importNodeMedia: async (_nodeId?: string) => {
    const state = get();
    if (!state.projectId) return AppNotifier.warn('系统异常：未找到当前工程 ID');
    try {
      const paths = await API.system.openMediaDialog();
      if (!paths || paths.length === 0) return;
      const newItems = await API.media.import(state.projectId, paths);
      if (newItems && newItems.length > 0) {
        get().addMediaItems(newItems);
        // ⚠️ 跨 Store：setActivePlaySource 在阶段三通过组合层注入
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

    const targetIndex = currentShots.findIndex(
      (s) => splitTime > s.start && splitTime < s.end
    );
    if (targetIndex === -1)
      return AppNotifier.warn('当前游标位置处于真空区，无片段可切割');

    get().saveSnapshot();
    const targetShot = currentShots[targetIndex];
    const sourceOffset =
      targetShot.matchedStart != null ? targetShot.matchedStart : targetShot.start;

    const newShotA: Shot = { ...targetShot, end: splitTime, matchedStart: sourceOffset };
    const newShotB: Shot = {
      ...targetShot,
      id: `shot_${crypto.randomUUID().substring(0, 8)}`,
      start: splitTime,
      matchedStart: sourceOffset + (splitTime - targetShot.start),
      aiText: '',
      originalText: '',
      audioPath: '',
      audioDuration: 0,
    };

    currentShots.splice(targetIndex, 1, newShotA, newShotB);
    if (isAiMode) set({ aiShots: currentShots });
    else set({ shots: currentShots });
    AppNotifier.success('✂️ 剃刀切割完成');
  },

  resetProjectState: () => set(() => ({
    projectId: null, projectName: '加载中...',
    mediaItems: [], roles: [], shots: [], characterRelations: [],
    storyboardMode: 'original', aiShots: [],
    canvasData: null, pastSnapshots: [], futureSnapshots: [],
    extractedData: { videoPath: '', vocalPath: '', backgroundPath: '', asrLines: [], frameCount: 0, framePaths: [] },
  })),

  hydrateProjectData: (projectData) => {
    const state = get();
    if (!projectData) return;

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
    let subStepStatuses: Record<string, string> = state.subStepStatuses || {};
    let subStepProgresses: Record<string, number> = state.subStepProgresses || {};
    let stepStatuses: string[] = state.stepStatuses || ['idle', 'idle', 'idle', 'idle', 'idle'];
    let stepCompleted: boolean[] = state.stepCompleted || [false, false, false, false, false];

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

    /** 💥 自动修正状态不一致：如果 stepStatuses[0] 不是 running，将所有 running 的子步骤状态重置为 idle
     *  场景：管线执行中被中断（崩溃/刷新），DB 残留了 running 子步骤状态，但步骤并未运行 */
    if (
      subStepStatuses &&
      typeof subStepStatuses === 'object' &&
      Array.isArray(stepStatuses) &&
      stepStatuses[0] !== 'running'
    ) {
      const normalized: Record<string, string> = { ...subStepStatuses };
      let changed = false;
      for (const key of Object.keys(normalized)) {
        if (normalized[key] === 'running') {
          normalized[key] = 'idle';
          changed = true;
        }
      }
      if (changed) subStepStatuses = normalized;
    }

    /** 推算当前步骤 */
    const calculatedCurrentStep = (() => {
      const saved = raw.currentStep || parsed.currentStep;
      if (saved && typeof saved === 'number') return saved;
      const completed = stepCompleted || state.stepCompleted;
      if (Array.isArray(completed)) {
        const lastCompletedIdx = completed.lastIndexOf(true);
        if (lastCompletedIdx >= 0 && lastCompletedIdx < completed.length - 1) return lastCompletedIdx + 2;
        if (lastCompletedIdx === completed.length - 1) return completed.length;
      }
      return state.currentStep || 1;
    })();

    // ============ 直写局部 Store ============

    // ── PipelineStore：步骤状态 ──
    const ps = usePipelineStore.getState();
    for (let i = 1; i <= 5; i++) {
      if (typeof ps.setStepStatus === 'function') ps.setStepStatus(i, (stepStatuses[i - 1] as any) || 'idle');
    }
    for (let i = 1; i <= 5; i++) {
      if (typeof ps.setStepCompleted === 'function') ps.setStepCompleted(i, !!stepCompleted[i - 1]);
    }
    if (typeof ps.setSubStepStatus === 'function') {
      for (const [key, status] of Object.entries(subStepStatuses)) {
        ps.setSubStepStatus(key, (status as string) || 'idle');
      }
    }
    if (typeof ps.setSubStepProgress === 'function') {
      for (const [key, progress] of Object.entries(subStepProgresses)) {
        ps.setSubStepProgress(key, typeof progress === 'number' ? progress : 0);
      }
    }
    if (raw.pipelineParams && typeof ps.setPipelineParams === 'function') ps.setPipelineParams(raw.pipelineParams as any);
    if (raw.extractionConfig !== undefined && typeof ps.setExtractionConfig === 'function') ps.setExtractionConfig(raw.extractionConfig as any);

    // ── Step1Store ──
    const s1 = useStep1Store.getState();
    if (typeof s1.setAsrLines === 'function') s1.setAsrLines(asr || []);
    if (typeof s1.setFrameCount === 'function') s1.setFrameCount(Number(raw.frameCount || parsed.frameCount || 0));
    if (typeof s1.setAudioSeparated === 'function') s1.setAudioSeparated(!!raw.audioSeparated);
    if (typeof s1.setSubStepStatus === 'function') {
      for (const [key, status] of Object.entries(subStepStatuses)) {
        s1.setSubStepStatus(key, (status as string) || 'idle');
      }
    }
    if (typeof s1.setSubStepProgress === 'function') {
      for (const [key, progress] of Object.entries(subStepProgresses)) {
        s1.setSubStepProgress(key, typeof progress === 'number' ? progress : 0);
      }
    }
    if (raw.extractionConfig && typeof s1.updateExtractionConfig === 'function') s1.updateExtractionConfig(raw.extractionConfig as any);

    // ── Step2Store ──
    const s2 = useStep2Store.getState();
    if (typeof s2.setVlmFrames === 'function') s2.setVlmFrames(Array.isArray(raw.vlmFrames) ? raw.vlmFrames : []);

    // ── Step3Store ──
    const s3 = useStep3Store.getState();
    if (typeof s3.setScriptParagraphs === 'function') s3.setScriptParagraphs(Array.isArray(raw.scriptParagraphs) ? raw.scriptParagraphs : []);
    if (raw.scriptStyle && typeof s3.setScriptStyle === 'function') s3.setScriptStyle(raw.scriptStyle as string);
    if (raw.speechRate !== undefined && typeof s3.setSpeechRate === 'function') s3.setSpeechRate(Number(raw.speechRate) || 4.5);
    if (raw.pipelineParams && typeof s3.setPipelineParams === 'function') s3.setPipelineParams(raw.pipelineParams as any);

    // ── Step4Store ──
    const s4 = useStep4Store.getState();
    if (typeof s4.setTtsResults === 'function') s4.setTtsResults(Array.isArray(raw.ttsResults) ? raw.ttsResults : []);
    if (raw.ttsEngine && typeof s4.setTtsEngine === 'function') s4.setTtsEngine(raw.ttsEngine as string);
    if (raw.ttsVoiceId !== undefined && typeof s4.setTtsVoiceId === 'function') s4.setTtsVoiceId((raw.ttsVoiceId as string) || '');

    // ── Step5Store ──
    const s5 = useStep5Store.getState();
    if (typeof s5.setVideoChunks === 'function') s5.setVideoChunks(Array.isArray(raw.videoChunks) ? raw.videoChunks : []);

    // ── EditorNavStore ──
    const nav = useEditorNavStore.getState();
    if (typeof nav.setCurrentStep === 'function') nav.setCurrentStep(calculatedCurrentStep);

    // ============ 写回独立 Store（仅保留项目核心字段） ============
    set(() => ({
      projectId: raw.id || state.projectId,
      projectName: raw.name || state.projectName,
      mediaItems,
      shots: raw.shots || parsed.shots || state.shots,
      aiShots: raw.aiShots || parsed.aiShots || state.aiShots,
      roles: raw.roles || parsed.roles || state.roles,
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
    }));
  },

}));
