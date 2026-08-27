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
import { AppNotifier } from '@renderer/core/AppNotifier';
import { API } from '@renderer/api';
import { usePipelineStore } from '@renderer/store/usePipelineStore';
import { useStep1Store } from '../../pipeline/stores/useStep1Store';
import { useStep2Store } from '../../pipeline/stores/useStep2Store';
import { useStep3Store } from '../../pipeline/stores/useStep3Store';
import { useStep4Store } from '../../pipeline/stores/useStep4Store';
import { useStep5Store } from '../../pipeline/stores/useStep5Store';
import { useEditorNavStore } from './useEditorNavStore';

/**
 * 🛑 根因级修复：framePaths 契约守门员
 * 历史多个写入点（管线结果映射、usePipelineExecutor、DB hydrate 持久化）可能混入
 * 非字符串项（object 项 / null / undefined），导致渲染时 getSafeMediaUrl().trim() 崩溃。
 * 所有写入口统一经此归一，保证 store 内 framePaths 恒为合法 string[]：
 *  - 字符串项：trim 去首尾空白
 *  - 对象项：提取 path/filePath/url/thumbnail（兼容旧版把 frames 对象数组误塞入 framePaths）
 *  - 其它（null/undefined/数字/布尔）：丢弃
 */
const normalizeFramePaths = (list: unknown): string[] => {
  if (!Array.isArray(list)) return [];
  return (list as any[])
    .map((fp) => {
      if (typeof fp === 'string') return fp.trim();
      if (fp && typeof fp === 'object') {
        const raw = fp.path ?? fp.filePath ?? fp.url ?? fp.thumbnail ?? '';
        return typeof raw === 'string' ? raw.trim() : '';
      }
      return '';
    })
    .filter((fp) => fp.length > 0);
};

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
  /** 🎬 帧真实时间戳（源坐标，原视频绝对时间，与 framePaths 顺序对齐）；step2 用它匹配 ASR 台词 */
  frameTimeMs: number[];
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

  // 🔧 修复 TS2339：hydration 时动态访问的运行时字段（不在接口定义中但 hydration 函数会读取）
  subStepStatuses?: Record<string, string>;
  subStepProgresses?: Record<string, number>;
  stepStatuses?: string[];
  stepCompleted?: boolean[];
  currentStep?: number;

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
  /** 🎭 P0.5+ 删除角色 */
  deleteRole: (id: string) => void;

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
  /** 全量 hydrate:项目切换/初次进场时调用,无条件设置所有字段(空就是空) */
  hydrateProjectData: (projectData: any) => void;
  /** 增量 merge:管线执行中部分结果回写时调用,只更新传入的字段,不影响其他字段 */
  mergePartialUpdate: (partial: any) => void;
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
    frameTimeMs: [],
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

  updateRole: (id, updates) => {
    set((s) => ({
      roles: s.roles.map((role) =>
        role.id === id ? { ...role, ...updates } : role
      ),
    }));
    // 🎭 P0.5+ 持久化到 DB（仅更新允许的字段，fire-and-forget）
    const { name, pronoun, description, avatar, tier } = updates as any;
    const fields: any = {};
    if (name !== undefined) fields.name = name;
    if (pronoun !== undefined) fields.pronoun = pronoun;
    if (description !== undefined) fields.description = description;
    if (avatar !== undefined) fields.avatar = avatar;
    if (tier !== undefined) fields.tier = tier;
    if (Object.keys(fields).length > 0) {
      API.roles.update(id, fields).catch(() => {
        // 持久化失败不阻断 UI，用户可在重试中恢复
      });
    }
  },

  mergeRoles: (sourceRoleId, targetRoleId) => {
    get().saveSnapshot();
    const state = get();
    if (sourceRoleId === targetRoleId) return;
    const sourceRole = state.roles.find((r) => r.id === sourceRoleId);
    const targetRole = state.roles.find((r) => r.id === targetRoleId);
    if (!sourceRole || !targetRole) return;

    set((s) => {
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

    // 🎭 P0.5+ 持久化到 DB
    if (state.projectId) {
      API.roles.merge(sourceRoleId, targetRoleId, state.projectId).catch(() => {});
    }
  },

  unmergeRole: (sourceRoleId, targetRoleId) => {
    get().saveSnapshot();
    const state = get();
    const targetRole = state.roles.find((r) => r.id === targetRoleId);
    if (!targetRole || !targetRole.mergedRoles) return;
    const sourceRole = targetRole.mergedRoles.find((r: any) => r.id === sourceRoleId);
    if (!sourceRole) return;

    set((s) => {
      const newMergedRoles = targetRole.mergedRoles!.filter((r: any) => r.id !== sourceRoleId);
      const newTargetRole = { ...targetRole, mergedRoles: newMergedRoles };
      const newRoles = s.roles.map((r) =>
        r.id === targetRoleId ? newTargetRole : r
      );
      newRoles.push(sourceRole as any);
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

    // 🎭 P0.5+ 持久化到 DB
    API.roles.unmerge(sourceRoleId, targetRoleId).catch(() => {});
  },

  /**
   * 🎭 P0.5+ 删除角色：从前端状态移除 + 持久化到 DB
   */
  deleteRole: (id) => {
    get().saveSnapshot();
    const state = get();
    set((s) => ({
      roles: s.roles.filter((r) => r.id !== id),
      shots: s.shots.map((shot) =>
        shot.roleId === id
          ? { ...shot, roleId: undefined, originalRoleId: shot.originalRoleId || id }
          : shot
      ),
    }));
    if (state.projectId) {
      API.roles.delete(id, state.projectId).catch(() => {});
    }
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
      // 🛑 根因修复：统一经 normalizeFramePaths 归一，杜绝非字符串项进入 store
      const nextFramePaths = normalizeFramePaths(data.framePaths ?? s.extractedData.framePaths);
      // 🎬 帧真实时间戳：显式传入时归一为 number[]，否则保留原值
      const nextFrameTimeMs = Array.isArray(data.frameTimeMs)
        ? data.frameTimeMs.map((t: any) => Math.round(Number(t) || 0))
        : s.extractedData.frameTimeMs;
      return {
        extractedData: { ...s.extractedData, ...data, framePaths: nextFramePaths, frameTimeMs: nextFrameTimeMs },
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

  resetProjectState: () => {
    set(() => ({
      projectId: null, projectName: '加载中...',
      mediaItems: [], roles: [], shots: [], characterRelations: [],
      storyboardMode: 'original', aiShots: [],
      canvasData: null, pastSnapshots: [], futureSnapshots: [],
      extractedData: { videoPath: '', vocalPath: '', backgroundPath: '', asrLines: [], frameCount: 0, framePaths: [], frameTimeMs: [] },
    }));
  },

  hydrateProjectData: (projectData) => {
    const state = get();
    if (!projectData) return;

    const d = projectData as any;

    // 🛑 原则 1&2 重构：全量 hydrate 无条件设置,空就是空
    // 旧版 bug:if (asrLines.length > 0) 之类条件导致新项目空数据不覆盖旧项目数据
    // 修复:hydrate 只负责全量设置;partial 增量走 mergePartialUpdate 独立方法
    const mediaItems = Array.isArray(d.mediaItems) ? d.mediaItems : [];
    const asrLines = Array.isArray(d.asrLines) ? d.asrLines : [];
    // 🛑 根因修复：DB 历史脏数据（对象项/非字符串）经 hydrate 进 store 前统一归一，
    //   否则重进项目时旧数据直接污染渲染
    const framePaths = normalizeFramePaths(d.framePaths);
    // 🛑 统一数据源：framePaths 为真相源，frameCount 优先由其长度派生，避免 DB 中
    //   frameCount 与 framePaths 不一致（如旧版 TEST_FRAME_LIMIT 残留 frameCount=10 而 framePaths=84）
    //   导致步骤1 与成果素材显示不同的帧数。d.frameCount 仅作旧数据兼容回退。
    const frameCount = framePaths.length || d.frameCount || 0;

    // ── PipelineStore ──
    const ps = usePipelineStore.getState();
    const stepStatuses: string[] = d.stepStatuses || ['idle', 'idle', 'idle', 'idle', 'idle'];
    const stepCompleted: boolean[] = d.stepCompleted || [false, false, false, false, false];
    const subStepStatuses: Record<string, string> = d.subStepStatuses || {};

    /** 💥 修复步骤1卡死：根据 subStepStatuses 重新推导 stepStatuses[0]
     *  根因：useExtractionHandler 中 setStepStatus 和 saveData 时序问题，
     *        导致 DB 中 subStepStatuses 全 completed 但 stepStatuses[0] 仍为 idle。
     *        StepPanel 要求 stepStatuses[0]==='completed' 才能进入步骤2，导致卡死。
     *  修复：hydrate 时根据子步骤状态推导步骤1总状态，不盲信 DB 的 stepStatuses。 */
    const STEP1_KEYS = ['frames', 'audio', 'whisper', 'faces'];
    const step1Values = STEP1_KEYS.map(k => subStepStatuses[k]).filter(v => v !== undefined && v !== null);
    if (step1Values.length > 0) {
      const allCompleted = step1Values.length === STEP1_KEYS.length && step1Values.every(v => v === 'completed');
      const hasFailed = step1Values.some(v => v === 'failed');
      if (allCompleted) {
        stepStatuses[0] = 'completed';
        stepCompleted[0] = true;
      } else if (hasFailed) {
        stepStatuses[0] = 'failed';
        stepCompleted[0] = false;
      } else {
        stepStatuses[0] = 'idle';
        stepCompleted[0] = false;
      }
    }

    for (let i = 1; i <= 5; i++) {
      if (typeof ps.setStepStatus === 'function') ps.setStepStatus(i, (stepStatuses[i - 1] as any) || 'idle');
      if (typeof ps.setStepCompleted === 'function') ps.setStepCompleted(i, !!stepCompleted[i - 1]);
    }
    if (typeof ps.setSubStepStatus === 'function') {
      // 🛑 原则 1：无条件设置。先重置所有已知子步骤为 idle,再用 DB 值覆盖
      // 旧版 bug:d.subStepStatuses 为 {} 时循环不执行 → 旧项目状态泄漏到新项目
      const ALL_SUB_STEP_KEYS = ['frames', 'audio', 'whisper', 'faces'];
      for (const key of ALL_SUB_STEP_KEYS) {
        ps.setSubStepStatus(key, 'idle');
      }
      for (const [key, status] of Object.entries(subStepStatuses)) {
        ps.setSubStepStatus(key, (status || 'idle') as any);
      }
    }
    const subStepProgresses: Record<string, number> = d.subStepProgresses || {};
    if (typeof ps.setSubStepProgress === 'function') {
      // 🛑 原则 1：无条件重置进度为 0,再用 DB 值覆盖
      const ALL_SUB_STEP_KEYS = ['frames', 'audio', 'whisper', 'faces'];
      for (const key of ALL_SUB_STEP_KEYS) {
        ps.setSubStepProgress(key, 0);
      }
      for (const [key, progress] of Object.entries(subStepProgresses)) {
        ps.setSubStepProgress(key, typeof progress === 'number' ? progress : 0);
      }
    }
    // 恢复子步骤耗时记录（重进项目后仍可查看上次执行耗时）
    if (d.subStepTimings && typeof d.subStepTimings === 'object'
        && typeof ps.setSubStepTimings === 'function') {
      ps.setSubStepTimings(d.subStepTimings as Record<string, any>);
    }
    if (d.pipelineParams && typeof ps.setPipelineParams === 'function') ps.setPipelineParams(d.pipelineParams as any);
    if (d.extractionConfig !== undefined && typeof ps.setExtractionConfig === 'function') ps.setExtractionConfig(d.extractionConfig as any);

    // ── Step1Store ──
    const s1 = useStep1Store.getState();
    // 🛑 原则 1：无条件设置,空就是空(新项目无 ASR/帧数据)
    if (typeof s1.setAsrLines === 'function') s1.setAsrLines(asrLines);
    if (typeof s1.setFrameCount === 'function') s1.setFrameCount(frameCount);
    if (typeof s1.setAudioSeparated === 'function') s1.setAudioSeparated(!!d.audioSeparated);
    const videoMedia = mediaItems.find((m: any) => m.type === 'video');
    if (typeof s1.setVocalsIsFallback === 'function' && videoMedia?.vocalsIsFallback !== undefined) {
      s1.setVocalsIsFallback(!!videoMedia.vocalsIsFallback);
    }
    if (typeof s1.setSubStepProgress === 'function') {
      for (const [key, progress] of Object.entries(subStepProgresses)) {
        s1.setSubStepProgress(key, typeof progress === 'number' ? progress : 0);
      }
    }
    if (d.extractionConfig && typeof s1.updateExtractionConfig === 'function') s1.updateExtractionConfig(d.extractionConfig as any);

    // ── Step2Store ──
    // 🛑 原则 1：无条件设置。partial 增量走 mergePartialUpdate,不进 hydrate
    const s2 = useStep2Store.getState();
    if (typeof s2.setVlmFrames === 'function') {
      s2.setVlmFrames(Array.isArray(d.vlmFrames) ? d.vlmFrames : []);
    }

    // ── Step3Store ──
    const s3 = useStep3Store.getState();
    if (typeof s3.setScriptParagraphs === 'function') {
      s3.setScriptParagraphs(Array.isArray(d.scriptParagraphs) ? d.scriptParagraphs : []);
    }
    if (typeof s3.setScriptStyle === 'function') s3.setScriptStyle((d.scriptStyle as string) || '');
    if (typeof s3.setSpeechRate === 'function') s3.setSpeechRate(Number(d.speechRate) || 4.5);
    if (d.pipelineParams && typeof s3.setPipelineParams === 'function') s3.setPipelineParams(d.pipelineParams as any);

    // ── Step4Store ──
    const s4 = useStep4Store.getState();
    if (typeof s4.setTtsResults === 'function') {
      // hydrate 防御：过滤旧项目脏数据
      // 1. 试听临时文件（tts_preview_ 前缀，保存到 os.tmpdir()）不应出现在 ttsResults 中
      //    旧版本 bug 可能导致试听文件被误持久化，重进项目后临时文件已被系统清理
      // 2. 失效路径标记为 _failed，让 UI 显示"失败"而非"已完成"，提示用户重新合成
      const rawTtsResults = Array.isArray(d.ttsResults) ? d.ttsResults : [];
      const sanitizedTtsResults = rawTtsResults.map((r: any) => {
        const audioUrl = r?.audioUrl || '';
        // 试听临时文件前缀：直接标记失败（旧版本 bug 残留）
        if (audioUrl.includes('tts_preview_')) {
          return { ...r, audioUrl: '', _failed: true, _error: '试听临时文件已失效，请重新合成' };
        }
        // 旧版本无前缀的临时文件路径（指向 Temp 目录）：标记失败
        if (audioUrl.includes('/Temp/') || audioUrl.includes('\\Temp\\') || audioUrl.includes('/tmp/')) {
          return { ...r, audioUrl: '', _failed: true, _error: '临时文件已失效，请重新合成' };
        }
        return r;
      });
      s4.setTtsResults(sanitizedTtsResults);
    }
    // ttsEngine 是引擎选择偏好：项目未保存（新项目/旧数据）时保持默认 'edge'，而非设为 '' 导致 UI 无选中
    // 不设 '' 是为了避免「UI 显示无引擎但合成 fallback 到设置默认引擎」的显示/执行不一致
    if (typeof s4.setTtsEngine === 'function') s4.setTtsEngine((d.ttsEngine as string) || 'edge');
    if (typeof s4.setTtsVoiceId === 'function') s4.setTtsVoiceId((d.ttsVoiceId as string) || '');

    // ── Step5Store ──
    const s5 = useStep5Store.getState();
    if (typeof s5.setVideoChunks === 'function') {
      s5.setVideoChunks(Array.isArray(d.videoChunks) ? d.videoChunks : []);
    }

    // ── EditorNavStore ──
    const nav = useEditorNavStore.getState();
    if (typeof nav.setCurrentStep === 'function') nav.setCurrentStep(d.currentStep || 1);

    // ── ProjectStore 核心字段 ──
    set(() => ({
      projectId: d.id || state.projectId,
      projectName: d.name || state.projectName,
      mediaItems,
      shots: Array.isArray(d.shots) ? d.shots : [],
      aiShots: Array.isArray(d.aiShots) ? d.aiShots : [],
      roles: Array.isArray(d.roles) ? d.roles : [],
      canvasData: d.canvasData !== undefined ? d.canvasData : null,
      // 🛑 原则 1:无条件恢复 storyboardMode(存于 metadata,DB 是真相源)
      // 旧版 bug:saveData 保存了但 hydrate 没恢复 → 切回项目时 AI 模式丢失
      storyboardMode: d.storyboardMode === 'ai' ? 'ai' : 'original',
      extractedData: {
        videoPath: d.videoPath || '',
        vocalPath: d.vocalPath || '',
        backgroundPath: d.backgroundPath || '',
        asrLines,
        framePaths,
        frameCount,
        // 🎬 帧真实时间戳（源坐标，与 framePaths 顺序对齐）：重进项目时从 DB 落库数据恢复
        frameTimeMs: Array.isArray(d.frameTimeMs) ? d.frameTimeMs.map((t: any) => Math.round(Number(t) || 0)) : [],
      }
    }));
  },

  /**
   * 增量 merge:管线执行中部分结果回写时调用
   * 只更新传入的字段,不影响其他字段(用于 useExtractionHandler 的 partial payload)
   * 🛑 原则 2:与 hydrateProjectData 语义独立,不混用
   */
  mergePartialUpdate: (partial) => {
    const d = partial as any;
    const state = get();

    // 只更新传入的字段
    const updates: any = {};
    if (Array.isArray(d.shots)) updates.shots = d.shots;
    if (Array.isArray(d.aiShots)) updates.aiShots = d.aiShots;
    if (Array.isArray(d.roles)) updates.roles = d.roles;
    if (Array.isArray(d.mediaItems)) updates.mediaItems = d.mediaItems;
    if (d.canvasData !== undefined) updates.canvasData = d.canvasData;

    if (Object.keys(updates).length > 0) {
      set(updates);
    }

    // 💥 防御性兜底：调用方传了 mediaItems 但未传 framePaths 时，从 mediaItems[].frames 派生。
    //   修复 IPCBridge 旧版（仅传 mediaItems）导致"关键帧显示不出来/不刷新"的问题。
    let derivedFramePaths: string[] | undefined = undefined;
    if (d.framePaths === undefined && Array.isArray(d.mediaItems)) {
      const collected: string[] = [];
      d.mediaItems.forEach((m: any) => {
        if (m?.type === 'video' && Array.isArray(m.frames) && m.frames.length > 0) {
          m.frames.forEach((f: any) => {
            const raw = typeof f === 'string' ? f : (f?.path ?? f?.filePath ?? f?.url ?? f?.thumbnail ?? '');
            if (typeof raw === 'string' && raw.trim().length > 0) collected.push(raw.trim());
          });
        }
      });
      if (collected.length > 0) derivedFramePaths = collected;
    }

    // extractedData 增量合并
    const hasExplicitExtracted = (
      d.asrLines !== undefined || d.framePaths !== undefined || d.frameCount !== undefined
      || d.videoPath !== undefined || d.vocalPath !== undefined || d.backgroundPath !== undefined
    );
    if (hasExplicitExtracted || derivedFramePaths !== undefined) {
      const cur = state.extractedData;
      // framePaths 优先级：显式传入 d.framePaths → 派生 derivedFramePaths → 当前 cur.framePaths
      const finalFramePaths = d.framePaths !== undefined
        ? normalizeFramePaths(d.framePaths)
        : (derivedFramePaths !== undefined ? normalizeFramePaths(derivedFramePaths) : cur.framePaths);
      const finalFrameCount = d.frameCount !== undefined
        ? d.frameCount
        : (d.framePaths !== undefined || derivedFramePaths !== undefined ? finalFramePaths.length : cur.frameCount);
      set({
        extractedData: {
          videoPath: d.videoPath !== undefined ? d.videoPath : cur.videoPath,
          vocalPath: d.vocalPath !== undefined ? d.vocalPath : cur.vocalPath,
          backgroundPath: d.backgroundPath !== undefined ? d.backgroundPath : cur.backgroundPath,
          asrLines: d.asrLines !== undefined ? d.asrLines : cur.asrLines,
          framePaths: finalFramePaths,
          frameCount: finalFrameCount,
          // 🎬 帧真实时间戳：显式传入时归一为 number[]，否则保留当前值
          frameTimeMs: Array.isArray(d.frameTimeMs)
            ? d.frameTimeMs.map((t: any) => Math.round(Number(t) || 0))
            : cur.frameTimeMs,
        }
      });
    }

    // Step1Store 增量:asrLines
    if (Array.isArray(d.asrLines) && d.asrLines.length > 0) {
      const s1 = useStep1Store.getState();
      if (typeof s1.setAsrLines === 'function') s1.setAsrLines(d.asrLines);
    }
    // Step2Store 增量:vlmFrames
    if (Array.isArray(d.vlmFrames)) {
      const s2 = useStep2Store.getState();
      if (typeof s2.setVlmFrames === 'function') s2.setVlmFrames(d.vlmFrames);
    }
    // Step3Store 增量:scriptParagraphs
    if (Array.isArray(d.scriptParagraphs)) {
      const s3 = useStep3Store.getState();
      if (typeof s3.setScriptParagraphs === 'function') s3.setScriptParagraphs(d.scriptParagraphs);
    }
    // Step4Store 增量:ttsResults
    if (Array.isArray(d.ttsResults)) {
      const s4 = useStep4Store.getState();
      if (typeof s4.setTtsResults === 'function') s4.setTtsResults(d.ttsResults);
    }
    // Step5Store 增量:videoChunks
    if (Array.isArray(d.videoChunks)) {
      const s5 = useStep5Store.getState();
      if (typeof s5.setVideoChunks === 'function') s5.setVideoChunks(d.videoChunks);
    }
  },

}));
