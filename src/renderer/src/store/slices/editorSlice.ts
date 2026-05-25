// 📁 路径: src/renderer/src/store/slices/editorSlice.ts
// 编辑器核心状态切片 - 步骤工作区/管线执行/ASR/VLM/文案/TTS/匹配
import type { StateCreator } from 'zustand';
import type { EditorSlice } from '../storeTypes';

/** 创建编辑器切片 */
export const createEditorSlice: StateCreator<EditorSlice, [], [], EditorSlice> = (set, _get) => ({
  // ===== 步骤状态 =====
  currentStep: 1,
  isAutoMode: false, // 默认手动模式
  stepCompleted: [false, false, false, false, false],

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

  // ===== 管线操作 =====
  setPipelineRunning: (running) => set({ pipelineRunning: running }),
  setPipelineProgress: (progress, node) => set({ pipelineProgress: progress, pipelineNode: node || '' }),
  setPipelineError: (error) => set({ pipelineError: error, pipelineRunning: false }),
  resetPipeline: () => set({ pipelineRunning: false, pipelineProgress: 0, pipelineNode: '', pipelineError: null }),

  // ===== ASR操作 =====
  setAsrLines: (lines) => set({ asrLines: lines }),
  updateAsrLine: (index, text) =>
    set((s) => {
      const lines = [...s.asrLines];
      if (lines[index]) lines[index] = { ...lines[index], text };
      return { asrLines: lines };
    }),
  setFrameCount: (count) => set({ frameCount: count }),
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
