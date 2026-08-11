// 📁 路径: src/renderer/src/store/slices/uiSlice.ts
//
// 🔧 启动性能修复（关键）：
//   原顶部 `import { useProjectStore }` 和 `import { usePlayerStore }`
//   会同步拉入整个 @modules/editor 模块树（含 timeline/canvas/player + 5 个 step stores），
//   通过 useStore → AppSidebar/AppLayout/App.tsx 同步加载链进入首屏 bundle，
//   导致 vite dev 首次编译耗时 100+ 秒。
//   修复：改为 type-only import + 动态 import()，让 editor 模块成为按需编译的 chunk。
import type { StateCreator } from 'zustand';
import { API } from '../../api';
import { AppNotifier } from '../../core/AppNotifier';
import type { EditorState, UISlice } from '../storeTypes';

// 🔧 类型只读导入：编译期擦除，不会触发运行时加载
// 动态 import() 返回的是模块命名空间，需通过 .useProjectStore / .usePlayerStore 访问实际的 zustand store
type ProjectStoreModuleT = typeof import('@modules/editor/stores/useProjectStore');
type PlayerStoreModuleT = typeof import('@modules/editor/stores/usePlayerStore');

// 🔧 模块级缓存：首次调用动态 import，后续同步访问已加载的模块
let _projectStoreMod: ProjectStoreModuleT | null = null;
let _playerStoreMod: PlayerStoreModuleT | null = null;

/** 懒加载 useProjectStore（首次调用触发动态 import，后续返回缓存） */
const getProjectStore = async () => {
  if (!_projectStoreMod) {
    try {
      _projectStoreMod = await import('@modules/editor/stores/useProjectStore');
    } catch (err) {
      console.error('[uiSlice] 动态加载 useProjectStore 失败:', err);
    }
  }
  return _projectStoreMod;
};

/** 懒加载 usePlayerStore（首次调用触发动态 import，后续返回缓存） */
const getPlayerStore = async () => {
  if (!_playerStoreMod) {
    try {
      _playerStoreMod = await import('@modules/editor/stores/usePlayerStore');
    } catch (err) {
      console.error('[uiSlice] 动态加载 usePlayerStore 失败:', err);
    }
  }
  return _playerStoreMod;
};

// 🔧 修复 ReferenceError：方法内部不能引用方法名本身
// 使用模块级 timer 变量替代 (fn as any).__timer，避免作用域解析失败
let setModeTimer: ReturnType<typeof setTimeout> | null = null;
let setParticleStyleTimer: ReturnType<typeof setTimeout> | null = null;
let setSkinTimer: ReturnType<typeof setTimeout> | null = null;
let setScaleTimer: ReturnType<typeof setTimeout> | null = null;

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
        /** P0 · 已收拢为 AUTO_ADAPTIVE | UNIFORM_FPS；保留 string 兼容历史反序列化 */
        mode: 'AUTO_ADAPTIVE' | 'UNIFORM_FPS' | string;
        /** P0 · 抽帧密度预设（与 step3 解说 density 语义区分，单独字段） */
        frameDensityPreset?: 'sparse' | 'standard' | 'dense';
        sceneThreshold: number;
        quality: number;
        scale: number;
        fps: number;
        minFrameInterval?: number;
        timePoint?: number;
        /**
         * @deprecated P0 · step3 解说密度已迁出抽帧配置；保留仅兼容老 JSON
         */
        density?: 'sparse' | 'standard' | 'dense' | string;
      };
      audio: { enabled: boolean; engine: 'demucs' | 'mdx' | 'auto'; };
      whisper: { enabled: boolean; engine: 'sensevoice' | 'faster-whisper' | 'auto'; };
      faces: {
        enabled: boolean;
        engine: 'insightface' | 'mediapipe';
        /** 🎭 P0.5+ 余弦相似度阈值（可选，默认 0.70） */
        cosineThreshold?: number;
      };
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
    // P0 · 抽帧契约收拢：2 枚举 + frameDensityPreset 默认档
    frames: {
      enabled: true,
      mode: 'AUTO_ADAPTIVE',
      frameDensityPreset: 'standard',
      sceneThreshold: 0.25,
      quality: 3,
      fps: 2,
      scale: 1024,
      minFrameInterval: 3.5,
    },
    audio: { enabled: true, engine: 'auto' },
    whisper: { enabled: true, engine: 'sensevoice' },
    faces: { enabled: true, engine: 'insightface' }
  },

  setMode: (mode) => {
    set({ mode });
    document.documentElement.dataset.mode = mode;
    if (setModeTimer) clearTimeout(setModeTimer);
    setModeTimer = setTimeout(() => {
      API.system.setSetting('mode', mode).catch(() => {});
    }, 300);
  },
  setParticleStyle: (style) => {
    set({ particleStyle: style });
    document.documentElement.dataset.particleStyle = style;
    if (setParticleStyleTimer) clearTimeout(setParticleStyleTimer);
    setParticleStyleTimer = setTimeout(() => {
      API.system.setSetting('particleStyle', style).catch(() => {});
    }, 300);
  },
  setSkin: (skin) => {
    set({ skin });
    document.documentElement.dataset.skin = skin;
    if (setSkinTimer) clearTimeout(setSkinTimer);
    setSkinTimer = setTimeout(() => {
      API.system.setSetting('skin', skin).catch(() => {});
    }, 300);
  },
  setScale: (scale) => {
    set({ scale });
    document.documentElement.dataset.scale = scale;
    if (setScaleTimer) clearTimeout(setScaleTimer);
    setScaleTimer = setTimeout(() => {
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
    // 🔧 动态加载 playerStore，避免同步拉入 editor 模块
    getPlayerStore().then((mod) => {
      mod?.usePlayerStore.getState().resetState();
    }).catch(() => {});
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

      // 🔧 动态加载 projectStore，避免同步拉入 editor 模块
      const projectStore = await getProjectStore();
      const projectId = projectStore?.useProjectStore.getState().projectId;
      if (!projectId) {
        AppNotifier.error('项目ID不存在');
        set({ workflowState: 'idle' });
        return;
      }

      const newItems = await API.media.import(projectId, paths);
      projectStore?.useProjectStore.getState().addMediaItems(newItems);

      if (newItems.length > 0) {
         get().selectItem(newItems[0].id, 'media');
         // 🔧 动态加载 playerStore
         const playerStore = await getPlayerStore();
         playerStore?.usePlayerStore.getState().setActivePlaySource(newItems[0]);
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
