// 📁 路径: src/renderer/src/store/slices/uiSlice.ts
import type { StateCreator } from 'zustand';
import { API } from '../../api';
import { AppNotifier } from '../../core/AppNotifier';
import type { EditorState, UISlice } from '../storeTypes';

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
    extractionConfig: {
      targetLanguage: string;
      frames: { enabled: boolean; mode: 'fps' | 'scene'; value: number; };
      audio: { enabled: boolean; engine: 'mdx-net' | 'spleeter'; };
      whisper: { enabled: boolean; engine: 'sensevoice' | 'whisper-v3'; };
      faces: { enabled: boolean; engine: 'insightface' | 'mediapipe'; };
    };

    toggleLeftPanel: () => void;
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
  }
}

export const createUISlice: StateCreator<EditorState, [], [], UISlice> = (set, get) => ({
  theme: 'dark',
  leftTab: 'workflow',
  leftPanelOpen: true,
  leftPanelWidth: 260,
  selectedItemId: null,
  selectedItemType: null,
  projectRatio: '16/9',
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
    frames: { enabled: true, mode: 'scene', value: 0.3 },
    audio: { enabled: true, engine: 'mdx-net' },
    whisper: { enabled: true, engine: 'sensevoice' },
    faces: { enabled: true, engine: 'insightface' }
  },

  toggleTheme: () => set((state) => ({ theme: state.theme === 'dark' ? 'light' : 'dark' })),

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

  clearSelection: () => set({
    selectedItemId: null, selectedItemType: null, activePlaySource: null,
    isPlaying: false, currentTime: 0, videoDuration: 0
  }),

  setProjectRatio: (ratio) => set({ projectRatio: ratio }),
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

      const projectId = get().projectId;
      if (!projectId) {
        AppNotifier.error('项目ID不存在');
        set({ workflowState: 'idle' });
        return;
      }

      const newItems = await API.media.import(projectId, paths);
      get().addMediaItems(newItems);
      
      if (newItems.length > 0) {
         get().selectItem(newItems[0].id, 'media');
         get().setActivePlaySource(newItems[0]);
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
