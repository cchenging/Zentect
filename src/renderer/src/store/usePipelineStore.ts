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

export interface PipelineStore {
  // 编辑器加载/水合状态
  hydrationStatus: 'IDLE' | 'LOADING' | 'READY' | 'ERROR';

  // 步骤执行状态
  stepStatuses: StepStatus[];
  stepCompleted: boolean[];
  subStepStatuses: Record<string, StepStatus>;
  subStepProgresses: Record<string, number>;

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
}

export const usePipelineStore = create<PipelineStore>()((set) => ({
  hydrationStatus: 'IDLE',

  stepStatuses: [...INITIAL_STEP_STATUSES],
  stepCompleted: [false, false, false, false, false],
  subStepStatuses: { ...INITIAL_SUB_STEP_STATUSES },
  subStepProgresses: { ...INITIAL_SUB_STEP_PROGRESSES },

  pipelineRunning: false,
  pipelineProgress: 0,
  pipelineNode: '',
  pipelineError: null,
  pipelineNodes: [],

  pipelineParams: { R: 70, S: 50, T: 80, P: 60 },
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
    }),

  setHydrationStatus: (status) => set({ hydrationStatus: status }),

  setPipelineRunning: (running) => set({ pipelineRunning: running }),
  setPipelineProgress: (progress, node) => set({ pipelineProgress: progress, pipelineNode: node || '' }),
  setPipelineError: (error) => set({ pipelineError: error, pipelineRunning: false }),
  resetPipeline: () => set({ pipelineRunning: false, pipelineProgress: 0, pipelineNode: '', pipelineError: null }),

  setPipelineParams: (params) => set({ pipelineParams: params }),
  setExtractionConfig: (config) => set({ extractionConfig: config }),
}));