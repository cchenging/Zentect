/**
 * usePipelineStore — 管线状态独立 Store
 * 从 editorSlice 中分拆出来的管线相关状态
 * 包括：步骤执行状态、子步骤状态、管线运行状态、参数配置
 */
import { create } from 'zustand';
import type { StepStatus } from '../../../shared/types/entities/editor';
import type { PipelineParams, ExtractionConfig } from '../../../shared/types/entities/editor';

const INITIAL_STEP_STATUSES: StepStatus[] = ['idle', 'idle', 'idle', 'idle', 'idle'];
const INITIAL_SUB_STEP_STATUSES: Record<string, StepStatus> = {
  frames: 'idle', audio: 'idle', whisper: 'idle', faces: 'idle',
};
const INITIAL_SUB_STEP_PROGRESSES: Record<string, number> = {
  frames: 0, audio: 0, whisper: 0, faces: 0,
};
/** 子步骤耗时初始值（null 表示未记录） */
const INITIAL_SUB_STEP_TIMINGS: Record<string, SubStepTiming | null> = {
  frames: null, audio: null, whisper: null, faces: null,
};

/**
 * 子步骤耗时数据结构
 * - startedAt: 开始时间戳（ms）
 * - finishedAt: 结束时间戳（ms）
 * - durationMs: 耗时（ms），finishedAt - startedAt
 */
export interface SubStepTiming {
  startedAt: number;
  finishedAt: number;
  durationMs: number;
}

export interface PipelineStore {
  // 编辑器加载/水合状态
  hydrationStatus: 'IDLE' | 'LOADING' | 'READY' | 'ERROR';

  // 步骤执行状态
  stepStatuses: StepStatus[];
  stepCompleted: boolean[];
  subStepStatuses: Record<string, StepStatus>;
  subStepProgresses: Record<string, number>;
  /** 子步骤耗时记录（key: frames/audio/whisper/faces） */
  subStepTimings: Record<string, SubStepTiming | null>;

  // 管线运行状态
  pipelineRunning: boolean;
  pipelineProgress: number;
  pipelineNode: string;
  pipelineError: string | null;
  pipelineNodes: unknown[];

  // 参数配置
  pipelineParams: PipelineParams;
  extractionConfig: ExtractionConfig | null;

  // Actions — 编辑器状态
  setHydrationStatus: (status: PipelineStore['hydrationStatus']) => void;

  // Actions — 步骤状态
  setStepStatus: (step: number, status: StepStatus) => void;
  setStepCompleted: (step: number, completed: boolean) => void;
  setSubStepStatus: (key: string, status: StepStatus) => void;
  setSubStepProgress: (key: string, progress: number) => void;
  /** 记录子步骤开始时间 */
  setSubStepStarted: (key: string) => void;
  /** 记录子步骤结束时间并计算耗时 */
  setSubStepFinished: (key: string) => void;
  /** 批量恢复子步骤耗时（水合时使用） */
  setSubStepTimings: (timings: Record<string, SubStepTiming | null>) => void;
  setAllSubStepsCompleted: () => void;
  resetAllStepStatuses: () => void;

  // Actions — 管线运行
  setPipelineRunning: (running: boolean) => void;
  setPipelineProgress: (progress: number, node?: string) => void;
  setPipelineError: (error: string | null) => void;
  resetPipeline: () => void;

  // Actions — 参数
  setPipelineParams: (params: PipelineParams) => void;
  setExtractionConfig: (config: ExtractionConfig | null) => void;

  /** 全量重置(切换项目时调用,清空所有状态到初始值) */
  reset: () => void;
}

export const usePipelineStore = create<PipelineStore>()((set) => ({
  hydrationStatus: 'IDLE',

  stepStatuses: [...INITIAL_STEP_STATUSES],
  stepCompleted: [false, false, false, false, false],
  subStepStatuses: { ...INITIAL_SUB_STEP_STATUSES },
  subStepProgresses: { ...INITIAL_SUB_STEP_PROGRESSES },
  subStepTimings: { ...INITIAL_SUB_STEP_TIMINGS },

  pipelineRunning: false,
  pipelineProgress: 0,
  pipelineNode: '',
  pipelineError: null,
  pipelineNodes: [],

  // SSOT 红线：audioStrategy 三档与 narrationRatio 数值同源绑定（smart_keep ⇔ 0.70），
  // UI 仅暴露三选一按钮，切换时整体提交二者（详见 PipelineParams.audioStrategy 注释）
  pipelineParams: {
    narrativePerspective: 'third',
    audioStrategy: 'smart_keep',
    vibePreset: 'viral',
    narrationRatio: 0.7,
    rhythmMode: 'mixed',
    emotionTone: 'neutral',
    hookIntensity: 0.7,
    targetNarrationDurationSec: 0,
    // 🎯 目标成片篇幅：0 = 自动（沿用视频总长推导）
    targetDurationSec: 0,
  },
  extractionConfig: null,

  setStepStatus: (step, status) =>
    set((s) => {
      const arr = [...s.stepStatuses] as StepStatus[];
      arr[step - 1] = status;
      return { stepStatuses: arr };
    }),
  setStepCompleted: (step, completed) =>
    set((s) => {
      const arr = [...s.stepCompleted];
      arr[step - 1] = completed;
      return { stepCompleted: arr };
    }),
  setSubStepStatus: (key, status) =>
    set((s) => ({ subStepStatuses: { ...s.subStepStatuses, [key]: status } })),
  setSubStepProgress: (key, progress) =>
    set((s) => ({ subStepProgresses: { ...s.subStepProgresses, [key]: progress } })),
  setSubStepStarted: (key) =>
    set((s) => ({
      subStepTimings: {
        ...s.subStepTimings,
        [key]: { startedAt: Date.now(), finishedAt: 0, durationMs: 0 },
      },
    })),
  setSubStepFinished: (key) =>
    set((s) => {
      const timing = s.subStepTimings[key];
      if (!timing || !timing.startedAt) return s;
      const finishedAt = Date.now();
      return {
        subStepTimings: {
          ...s.subStepTimings,
          [key]: { ...timing, finishedAt, durationMs: finishedAt - timing.startedAt },
        },
      };
    }),
  setSubStepTimings: (timings) => set({ subStepTimings: timings }),
  setAllSubStepsCompleted: () =>
    set({
      subStepStatuses: { frames: 'completed', audio: 'completed', whisper: 'completed', faces: 'completed' },
      subStepProgresses: { frames: 100, audio: 100, whisper: 100, faces: 100 },
    }),
  resetAllStepStatuses: () =>
    set({
      stepStatuses: [...INITIAL_STEP_STATUSES],
      subStepStatuses: { ...INITIAL_SUB_STEP_STATUSES },
      subStepProgresses: { ...INITIAL_SUB_STEP_PROGRESSES },
      // 同步重置子步骤耗时，避免残留旧耗时与新状态不一致
      subStepTimings: { ...INITIAL_SUB_STEP_TIMINGS },
    }),

  setHydrationStatus: (status) => set({ hydrationStatus: status }),

  setPipelineRunning: (running) => set({ pipelineRunning: running }),
  setPipelineProgress: (progress, node) => set({ pipelineProgress: progress, pipelineNode: node || '' }),
  setPipelineError: (error) => set({ pipelineError: error, pipelineRunning: false }),
  resetPipeline: () => set({ pipelineRunning: false, pipelineProgress: 0, pipelineNode: '', pipelineError: null }),

  setPipelineParams: (params) => set({ pipelineParams: params }),
  setExtractionConfig: (config) => set({ extractionConfig: config }),

  reset: () => set({
    hydrationStatus: 'IDLE',
    stepStatuses: [...INITIAL_STEP_STATUSES],
    stepCompleted: [false, false, false, false, false],
    subStepStatuses: { ...INITIAL_SUB_STEP_STATUSES },
    subStepProgresses: { ...INITIAL_SUB_STEP_PROGRESSES },
    subStepTimings: { ...INITIAL_SUB_STEP_TIMINGS },
    pipelineRunning: false,
    pipelineProgress: 0,
    pipelineNode: '',
    pipelineError: null,
    pipelineNodes: [],
    pipelineParams: {
    narrativePerspective: 'third',
    // SSOT 红线：audioStrategy 三档与 narrationRatio 数值同源绑定（smart_keep ⇔ 0.70）
    audioStrategy: 'smart_keep',
    vibePreset: 'viral',
    narrationRatio: 0.7,
    rhythmMode: 'mixed',
    emotionTone: 'neutral',
    hookIntensity: 0.7,
    targetNarrationDurationSec: 0,
    // 🎯 目标成片篇幅：0 = 自动（沿用视频总长推导）
    targetDurationSec: 0,
  },
    extractionConfig: null,
  }),
}));