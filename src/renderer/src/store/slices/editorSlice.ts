// 📁 路径: src/renderer/src/store/slices/editorSlice.ts
// 编辑器核心状态切片 - 步骤工作区/管线执行/ASR/VLM/文案/TTS/匹配
import type { StateCreator } from 'zustand';
import type { EditorSlice, StepStatus } from '../storeTypes';

/** 初始步骤状态 */
const INITIAL_STEP_STATUSES: StepStatus[] = ['idle', 'idle', 'idle', 'idle', 'idle'];
const INITIAL_SUB_STEP_STATUSES: Record<string, StepStatus> = {
  frames: 'idle',
  audio: 'idle',
  whisper: 'idle',
  faces: 'idle',
};
const INITIAL_SUB_STEP_PROGRESSES: Record<string, number> = {
  frames: 0,
  audio: 0,
  whisper: 0,
  faces: 0,
};

/** 创建编辑器切片 */
export const createEditorSlice: StateCreator<EditorSlice, [], [], EditorSlice> = (set, _get) => ({
  // ===== 水合与项目整体加载状态 =====
  hydrationStatus: 'IDLE',
  setHydrationStatus: (status) => set({ hydrationStatus: status }),

  // ===== 步骤状态 =====
  currentStep: 1,
  isAutoMode: false, // 默认手动模式
  stepCompleted: [false, false, false, false, false],
  stepStatuses: [...INITIAL_STEP_STATUSES],
  subStepStatuses: { ...INITIAL_SUB_STEP_STATUSES },
  subStepProgresses: { ...INITIAL_SUB_STEP_PROGRESSES },

  // ===== 管线执行状态 =====
  pipelineRunning: false,
  pipelineProgress: 0,
  pipelineNode: '',
  pipelineError: null,
  pipelineNodes: [], // 节点状态时间轴

  // ===== 步骤1: 素材分析 =====
  asrLines: [], // ASR识别结果
  frameCount: 0, // 抽帧数量
  audioSeparated: false, // 音频是否已分离

  // ===== 步骤2: 画面描述 =====
  vlmFrames: [], // VLM分析结果 [{url, description, editing}]

  // ===== 步骤3: 解说文案 =====
  scriptParagraphs: [], // 文案段落 [{id, text, editing}]
  scriptStyle: '赛博现实主义', // 文案风格
  pipelineParams: { R: 70, S: 50, T: 80, P: 60 }, // R/S/T/P参数

  // ===== 步骤4: 配音合成 =====
  ttsEngine: 'edge', // TTS引擎
  ttsProgress: 0, // TTS合成进度
  ttsResults: [], // TTS合成结果 [{shotId, audioUrl, duration}]

  // ===== 步骤5: 镜头匹配 =====
  matchResults: [], // 匹配结果 [{shotId, mediaId, score, thumbnail, confirmed}]

  // ===== 步骤操作 =====
  setCurrentStep: (step) => set({ currentStep: step }),
  setIsAutoMode: (auto) => set({ isAutoMode: auto }),
  setStepCompleted: (step, completed) =>
    set((s) => {
      const arr = [...s.stepCompleted];
      arr[step - 1] = completed;
      return { stepCompleted: arr };
    }),

  /** 设置主步骤执行状态 */
  setStepStatus: (step, status) =>
    set((s) => {
      const arr = [...s.stepStatuses] as StepStatus[];
      arr[step - 1] = status;
      return { stepStatuses: arr };
    }),

  /** 设置子步骤执行状态 */
  setSubStepStatus: (key, status) =>
    set((s) => ({
      subStepStatuses: { ...s.subStepStatuses, [key]: status },
    })),

  /** 设置子步骤独立进度 */
  setSubStepProgress: (key, progress) =>
    set((s) => ({
      subStepProgresses: { ...s.subStepProgresses, [key]: progress },
    })),

  /** 批量设置子步骤状态（用于完成时一次性标记所有） */
  setAllSubStepsCompleted: () =>
    set((s) => ({
      subStepStatuses: { frames: 'completed', audio: 'completed', whisper: 'completed', faces: 'completed' },
      subStepProgresses: { frames: 100, audio: 100, whisper: 100, faces: 100 },
    })),

  /** 重置所有步骤状态 */
  resetAllStepStatuses: () =>
    set({
      stepStatuses: [...INITIAL_STEP_STATUSES],
      subStepStatuses: { ...INITIAL_SUB_STEP_STATUSES },
      subStepProgresses: { ...INITIAL_SUB_STEP_PROGRESSES },
    }),

  // ===== 管线操作 =====
  setPipelineRunning: (running) => set({ pipelineRunning: running }),
  setPipelineProgress: (progress, node) => set({ pipelineProgress: progress, pipelineNode: node || '' }),
  setPipelineError: (error) => set({ pipelineError: error, pipelineRunning: false }),
  resetPipeline: () => set({ pipelineRunning: false, pipelineProgress: 0, pipelineNode: '', pipelineError: null }),

  // ===== ASR操作 =====
  setAsrLines: (lines) => set((s) => {
    if (typeof s.setExtractedData === 'function') {
      s.setExtractedData({ asrLines: lines });
    }
    return { asrLines: lines };
  }),
  updateAsrLine: (index, text) =>
    set((s) => {
      const lines = [...s.asrLines];
      if (lines[index]) lines[index] = { ...lines[index], text };
      if (typeof s.setExtractedData === 'function') {
        s.setExtractedData({ asrLines: lines });
      }
      return { asrLines: lines };
    }),
  setFrameCount: (count) => set((s) => {
    if (typeof s.setExtractedData === 'function') {
      s.setExtractedData({ frameCount: count });
    }
    return { frameCount: count };
  }),
  setAudioSeparated: (separated) => set({ audioSeparated: separated }),

  // ===== VLM操作 =====
  setVlmFrames: (frames) => set({ vlmFrames: frames }),
  updateVlmDescription: (index, description) =>
    set((s) => {
      const frames = [...s.vlmFrames];
      if (frames[index]) frames[index] = { ...frames[index], description, editing: false };
      return { vlmFrames: frames };
    }),
  setVlmEditing: (index, editing) =>
    set((s) => {
      const frames = [...s.vlmFrames];
      if (frames[index]) frames[index] = { ...frames[index], editing };
      return { vlmFrames: frames };
    }),

  // ===== 文案操作 =====
  setScriptParagraphs: (paragraphs) => set({ scriptParagraphs: paragraphs }),
  updateScriptParagraph: (id, text) =>
    set((s) => ({
      scriptParagraphs: s.scriptParagraphs.map((p: any) => p.id === id ? { ...p, text } : p),
    })),
  setScriptStyle: (style) => set({ scriptStyle: style }),
  setPipelineParams: (params) => set({ pipelineParams: params }),

  // ===== TTS操作 =====
  setTtsEngine: (engine) => set({ ttsEngine: engine }),
  setTtsProgress: (progress) => set({ ttsProgress: progress }),
  setTtsResults: (results) => set({ ttsResults: results }),

  // ===== 匹配操作 =====
  setMatchResults: (results) => set({ matchResults: results }),
  confirmMatch: (shotId) =>
    set((s) => ({
      matchResults: s.matchResults.map((m: any) => m.shotId === shotId ? { ...m, confirmed: true } : m),
    })),
  replaceMatch: (shotId, newMediaId) =>
    set((s) => ({
      matchResults: s.matchResults.map((m: any) => m.shotId === shotId ? { ...m, mediaId: newMediaId, confirmed: false } : m),
    })),
});
