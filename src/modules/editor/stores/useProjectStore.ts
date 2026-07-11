/**
 * useProjectStore — 项目核心数据独立 Store
 *
 * @description
 * 从 dataSlice 中提取的项目核心数据：媒体素材、角色、镜头、撤销/重做等。
 * dataSlice 原是全局 Store 中最复杂的 Slice（668 行），独立后成为项目生命周期内的核心数据源。
 *
 * 跨 Store 引用：迁移过渡期通过 useStore.getState() 访问尚在全局 Store 中的字段，
 * 待阶段三消费者迁移完成后切换为 useXxxStore.getState()。
 *
 * 迁移阶段：阶段一 — 基础设施（无行为变更）
 */

import { create } from 'zustand';
import type { MediaItem, Shot, Role } from '../../../shared/types';
import { AppNotifier } from '../../../renderer/src/core/AppNotifier';
import { API } from '../../../renderer/src/api';

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
  /** @deprecated 阶段三迁移到 useProjectStore 后启用完整重置逻辑 */
  resetProjectState: () => void;
  /** @deprecated 阶段三迁移到 useProjectStore 后启用完整注水逻辑 */
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
  addMediaItems: (items) => set((s) => ({ mediaItems: [...s.mediaItems, ...items] })),
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

  /** @deprecated 阶段三迁移后启用完整重置逻辑，包括跨 Store 状态清理 */
  resetProjectState: () =>
    set(() => ({
      projectId: null,
      projectName: '加载中...',
      mediaItems: [],
      roles: [],
      shots: [],
      characterRelations: [],
      storyboardMode: 'original',
      aiShots: [],
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
    })),

  /** @deprecated 阶段三迁移后启用完整注水逻辑，包括 extractionConfig / vlmFrames 等步骤数据恢复 */
  hydrateProjectData: (projectData) =>
    set((s) => {
      if (!projectData) return s;
      const raw = projectData as any;

      let parsed: any = {};
      if (typeof raw.metadata === 'string' && raw.metadata.trim().length > 0) {
        try { parsed = JSON.parse(raw.metadata); } catch { parsed = {}; }
      } else if (raw.metadata && typeof raw.metadata === 'object') {
        parsed = raw.metadata;
      }

      const video = raw.videoPath || raw.video_path || parsed.videoPath || '';

      let mediaItems = raw.mediaItems || s.mediaItems;
      if (video && (!mediaItems || mediaItems.length === 0)) {
        mediaItems = [
          {
            id: 'main-video-source',
            name: '原始导入多媒体文件',
            filePath: video,
            path: video,
            type: 'video',
          },
        ];
      }

      let framePaths: string[] = [];
      const videoItems = mediaItems.filter((m: any) => m.type === 'video');
      videoItems.forEach((media: any) => {
        if (media.frames && Array.isArray(media.frames) && media.frames.length > 0) {
          const frames = media.frames
            .map((frame: any) =>
              typeof frame === 'string'
                ? frame
                : frame.path || frame.filePath || frame.thumbnail || ''
            )
            .filter(Boolean);
          framePaths = [...framePaths, ...frames];
        }
      });

      if (framePaths.length === 0) {
        const metaFramePaths = raw.framePaths || parsed.framePaths;
        if (metaFramePaths && Array.isArray(metaFramePaths) && metaFramePaths.length > 0) {
          framePaths = metaFramePaths;
        }
      }

      return {
        projectId: raw.id || s.projectId,
        projectName: raw.name || s.projectName,
        mediaItems,
        shots: raw.shots || parsed.shots || s.shots,
        aiShots: raw.aiShots || parsed.aiShots || s.aiShots,
        roles: raw.roles || parsed.roles || s.roles,
        extractedData: {
          videoPath: video,
          vocalPath: raw.vocalPath || parsed.vocalPath || '',
          backgroundPath: raw.backgroundPath || parsed.backgroundPath || '',
          asrLines: (raw.asrLines || parsed.asrLines || s.extractedData.asrLines || []),
          framePaths:
            framePaths.length > 0
              ? framePaths
              : s.extractedData?.framePaths || [],
          frameCount:
            raw.frameCount ||
            parsed.frameCount ||
            framePaths.length ||
            s.extractedData?.framePaths?.length ||
            0,
        },
      };
    }),
}));
