// 📁 路径：src/renderer/src/store/slices/dataSlice.ts
import type { StateCreator } from 'zustand';
import type { EditorState, DataSlice } from '../storeTypes';
import type { Shot } from '../../../../shared/types';
import type { NodeStatusType } from '../constants';
import { AppNotifier } from '../../core/AppNotifier';
import { API } from '../../api';

export const createDataSlice: StateCreator<EditorState, [], [], DataSlice> = (set, get) => ({
  projectId: null,
  projectPath: '',
  projectName: '加载中...',
  mediaItems: [],
  shots: [],
  roles: [], aiShots: [], characterRelations: [],
  storyboardMode: 'original', pastSnapshots: [], futureSnapshots: [],

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
  },

  removeShot: (id) => {
    get().saveSnapshot();
    set((state) => ({ shots: state.shots.filter(shot => shot.id !== id), selectedItemId: state.selectedItemId === id ? null : state.selectedItemId }));
  },

  setAiShots: (shots) => { get().saveSnapshot(); set({ aiShots: shots }); },
  updateAiShot: (id, updates) => { get().saveSnapshot(); set((state) => ({ aiShots: state.aiShots.map(shot => shot.id === id ? { ...shot, ...updates } : shot) })); },
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

  resetProjectState: () => set({
    projectId: null, projectName: '加载中...',
    mediaItems: [], roles: [], shots: [], characterRelations: [],
    activePlaySource: null, isPlaying: false, currentTime: 0, videoDuration: 0, duration: 0,
    selectedItemId: null, selectedItemType: null,
    storyboardMode: 'original', aiShots: []
  }),

  hydrateProjectData: (data) => set((state) => ({ ...state, ...data })),

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

  // 💥 彻底重构的方法：引入悲观锁(Pessimistic Lock)、全量异常闭环与 finally 保底
  importNodeMedia: async (nodeId: string) => {
    const state = get();
    if (!state.projectId) return AppNotifier.warn('系统异常：未找到当前工程 ID');

    // 🛡️ 防御 1：并发锁机制
    const targetNode = state.nodes.find(n => n.id === nodeId);
    if (targetNode?.data?.status === 'processing') {
      console.warn('[Store] 节点已被锁定，拦截重复的唤起弹窗请求');
      return;
    }

    // 🛡️ 防御 2：追踪最终状态是否已设置，防止 finally 覆盖正确结果
    let finalized = false;
    const finalize = (status: NodeStatusType) => {
      finalized = true;
      get().updateNodeStatus(nodeId, status);
    };

    try {
      get().updateNodeStatus(nodeId, 'processing');

      const paths = await API.system.openMediaDialog();

      if (!paths || paths.length === 0) {
        finalize('idle');
        return;
      }

      const newItems = await API.media.import(state.projectId, paths);

      if (newItems && newItems.length > 0) {
        const importedMedia = newItems[0];
        get().addMediaItems(newItems);
        get().updateNodeData(nodeId, { mediaId: importedMedia.id, label: importedMedia.name });
        finalize('success');
        get().setActivePlaySource(importedMedia);
        AppNotifier.success('资产导入并解析成功');
      } else {
        finalize('idle');
      }
    } catch (error: any) {
      console.error('[Media Import Error]:', error);
      finalize('error');
      AppNotifier.error(`导入失败: ${error.message || '未知异常'}`);
    } finally {
      // 🛡️ 防御 6：终极兜底 — 无论任何异常路径都不会让节点永久卡死在 processing
      if (!finalized) {
        get().updateNodeStatus(nodeId, 'idle');
      }
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
