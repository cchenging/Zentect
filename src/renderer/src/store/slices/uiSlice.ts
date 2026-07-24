// 📁 路径: src/renderer/src/store/slices/uiSlice.ts
import type { StateCreator } from 'zustand';
import { API } from '../../api';
import { AppNotifier } from '../../core/AppNotifier';
import type { EditorState, UISlice } from '../storeTypes';
import { useProjectStore } from '@modules/editor/stores/useProjectStore';
import { usePlayerStore } from '@modules/editor/stores/usePlayerStore';

// 💥 我们为 UISlice 补充缺失的 saveStatus 方法，补齐类型拼图。
declare module '../storeTypes' {
  interface UISlice {
    leftPanelOpen: boolean;
    leftPanelWidth: number;
    workflowState: 'idle' | 'processing' | 'finetuning';
    pipelineMessage: string;
    isSidebarExpanded: boolean;
    isInspectorOpen: boolean;
    saveStatus: 'idle' | 'saving' | 'saved';
    lastSavedTime: string;
    isSettingsOpen: boolean;
    mode: 'dark' | 'light' | 'system';
    skin: string;
    scale: string;
    particleStyle: string;
    /**
     * @deprecated 已迁移至 useStep1Store.extractionConfig，请使用 useStep1Store
     */
    extractionConfig: {
      targetLanguage: string;
      frames: {
        enabled: boolean;
        mode: 'VLM_OPTIMIZED' | 'UNIFORM_FPS' | 'FAST_KEYFRAME' | 'PRECISE_SINGLE';
        sceneThreshold: number;
        quality: number;
        scale: number;
        fps: number;
        minFrameInterval?: number;
        timePoint?: number;
      };
      audio: { enabled: boolean; engine: 'mdx-net' | 'spleeter'; };
      whisper: { enabled: boolean; engine: 'sensevoice' | 'whisper-v3'; };
      faces: { enabled: boolean; engine: 'insightface' | 'mediapipe'; };
    };

    toggleLeftPanel: () => void;
    /**
     * @deprecated 已迁移至 useStep1Store.updateExtractionConfig，请使用 useStep1Store
     */
    updateExtractionConfig: (config: Partial<UISlice['extractionConfig']>) => void;
    setWorkflowState: (state: 'idle' | 'processing' | 'finetuning') => void;
    setPipelineMessage: (message: string) => void;
    handleImportAndStart: () => Promise<void>;
    setSidebarExpanded: (isExpanded: boolean) => void;
    toggleSidebar: () => void;
    setInspectorOpen: (isOpen: boolean) => void;
    toggleInspector: () => void;
    setSaveStatus: (status: 'idle' | 'saving' | 'saved', time?: string) => void;
    setSettingsOpen: (open: boolean) => void;
    editorMode: 'simple' | 'pro';
    setEditorMode: (mode: 'simple' | 'pro') => void;
    toggleEditorMode: () => void;
    setMode: (mode: 'dark' | 'light' | 'system') => void;
    cycleMode: () => void;
    setParticleStyle: (style: string) => void;
    setSkin: (skin: string) => void;
    setScale: (scale: string) => void;
    hydrateUI: () => Promise<void>;
  }
}

export const createUISlice: StateCreator<EditorState, [], [], UISlice> = (set, get) => ({
  mode: 'dark' as 'dark' | 'light' | 'system',
  skin: 'v3',
  scale: 'default',
  particleStyle: 'auto',
  leftTab: 'workflow',
  leftPanelOpen: true,
  leftPanelWidth: 260,
  selectedItemId: null,
  selectedItemType: null,
  projectRatio: '16/9',
  videoFps: 30,
  canvasZoom: 100,
  isCanvasFit: true,
  isFullscreen: false,
  globalFocusMode: 'timeline',

  activeRoleFilter: null,
  semanticSearchResults: null,

  workflowState: 'idle',
  pipelineMessage: '准备就绪',

  isSidebarExpanded: false,
  isInspectorOpen: false,

  saveStatus: 'idle',
  lastSavedTime: '',
  isSettingsOpen: false,
  editorMode: 'simple',

  extractionConfig: {
    targetLanguage: 'zh-CN',
    frames: { enabled: true, mode: 'VLM_OPTIMIZED', sceneThreshold: 0.28, quality: 3, fps: 2, scale: 1024, minFrameInterval: 4 },
    audio: { enabled: true, engine: 'mdx-net' },
    whisper: { enabled: true, engine: 'sensevoice' },
    faces: { enabled: true, engine: 'insightface' }
  },

  setMode: (mode) => {
    set({ mode });
    document.documentElement.dataset.mode = mode;
    clearTimeout((setMode as any).__timer);
    (setMode as any).__timer = setTimeout(() => {
      API.system.setSetting('mode', mode).catch(() => {});
    }, 300);
  },
  setParticleStyle: (style) => {
    set({ particleStyle: style });
    document.documentElement.dataset.particleStyle = style;
    clearTimeout((setParticleStyle as any).__timer);
    (setParticleStyle as any).__timer = setTimeout(() => {
      API.system.setSetting('particleStyle', style).catch(() => {});
    }, 300);
  },
  setSkin: (skin) => {
    set({ skin });
    document.documentElement.dataset.skin = skin;
    clearTimeout((setSkin as any).__timer);
    (setSkin as any).__timer = setTimeout(() => {
      API.system.setSetting('skin', skin).catch(() => {});
    }, 300);
  },
  setScale: (scale) => {
    set({ scale });
    document.documentElement.dataset.scale = scale;
    clearTimeout((setScale as any).__timer);
    (setScale as any).__timer = setTimeout(() => {
      API.system.setSetting('scale', scale).catch(() => {});
    }, 300);
  },
  cycleMode: () => {
    const cycle: Record<string, 'dark' | 'light' | 'system'> = {
      dark: 'light',
      light: 'system',
      system: 'dark',
    };
    get().setMode(cycle[get().mode] || 'dark');
  },
  hydrateUI: async () => {
    try {
      const mode = await API.system.getSetting('mode', 'dark');
      const skin = await API.system.getSetting('skin', 'v3');
      const scale = await API.system.getSetting('scale', 'default');
      const particleStyle = await API.system.getSetting('particleStyle', 'auto');
      set({ mode: mode as 'dark' | 'light' | 'system', skin, scale, particleStyle });
      document.documentElement.dataset.mode = mode as string;
      document.documentElement.dataset.skin = skin as string;
      document.documentElement.dataset.scale = scale as string;
      document.documentElement.dataset.particleStyle = particleStyle as string;
    } catch { /* 静默回退默认值 */ }
  },

  setLeftTab: (tab) => set({
    leftTab: tab,
    leftPanelOpen: true,
    selectedItemId: null,
    selectedItemType: null
  }),

  toggleLeftPanel: () => set((state) => ({ leftPanelOpen: !state.leftPanelOpen })),

  selectItem: (id, type) => set((state) => ({
    selectedItemId: id,
    selectedItemType: type,
    globalFocusMode: type === 'media' ? 'media' : (type === 'shot' ? 'timeline' : state.globalFocusMode)
  })),

  clearSelection: () => {
    set({ selectedItemId: null, selectedItemType: null });
    usePlayerStore.getState().resetState();
  },

  setProjectRatio: (ratio) => set({ projectRatio: ratio }),
  setVideoFps: (fps) => set({ videoFps: fps }),
  setCanvasZoom: (zoom) => set({ canvasZoom: zoom }),
  setIsCanvasFit: (isFit) => set({ isCanvasFit: isFit }),
  setIsFullscreen: (isFull) => set({ isFullscreen: isFull }),
  setGlobalFocusMode: (mode) => set({ globalFocusMode: mode }),

  setActiveRoleFilter: (clusterId) => set({ activeRoleFilter: clusterId }),
  setSemanticSearchResults: (results) => set({ semanticSearchResults: results }),

  updateExtractionConfig: (config) => set((state) => ({
    extractionConfig: { ...state.extractionConfig, ...config }
  })),

  setWorkflowState: (state) => set({ workflowState: state }),
  setPipelineMessage: (message) => set({ pipelineMessage: message }),

  handleImportAndStart: async () => {
    const state = get();

    if (state.workflowState === 'processing') {
      return AppNotifier.warn('当前正在执行任务，请勿重复操作');
    }

    try {
      set({ workflowState: 'processing', pipelineMessage: '正在唤起资源管理器...' });

      const paths = await API.system.openMediaDialog();

      if (!paths || paths.length === 0) {
        set({ workflowState: 'idle', pipelineMessage: '已取消操作' });
        return;
      }

      set({ pipelineMessage: '正在抽取音频与关键帧...' });

      const projectId = useProjectStore.getState().projectId;
      if (!projectId) {
        AppNotifier.error('项目ID不存在');
        set({ workflowState: 'idle' });
        return;
      }

      const newItems = await API.media.import(projectId, paths);
      useProjectStore.getState().addMediaItems(newItems);
      
      if (newItems.length > 0) {
         get().selectItem(newItems[0].id, 'media');
         usePlayerStore.getState().setActivePlaySource(newItems[0]);
      }

      set({ workflowState: 'finetuning', pipelineMessage: '导入完成' });
    } catch (e: any) {
      AppNotifier.error(e.message || '导入失败');
      // 🛡️ 崩溃时释放锁
      set({ workflowState: 'idle', pipelineMessage: '导入发生异常' });
    }
  },

  setSidebarExpanded: (isExpanded) => set({ isSidebarExpanded: isExpanded }),
  toggleSidebar: () => set((state) => ({ isSidebarExpanded: !state.isSidebarExpanded })),
  setInspectorOpen: (isOpen) => set({ isInspectorOpen: isOpen }),
  toggleInspector: () => set((state) => ({ isInspectorOpen: !state.isInspectorOpen })),

  setSaveStatus: (status, time) => set({
    saveStatus: status,
    ...(time && { lastSavedTime: time })
  }),

  setSettingsOpen: (open) => set({ isSettingsOpen: open }),

  setEditorMode: (mode) => set({ editorMode: mode }),
  toggleEditorMode: () => set((state) => ({
    editorMode: state.editorMode === 'simple' ? 'pro' : 'simple'
  })),
});
