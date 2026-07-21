/**
 * useStep1Store — 步骤1「素材分析」局部 Store
 *
 * @description
 * 从 editorSlice 和 uiSlice 中提取步骤1专属状态。
 * - asrLines / frameCount / audioSeparated：来自 editorSlice
 * - extractionConfig：来自 uiSlice（完全服务于 step1 的抽帧/音频/Whisper/人脸配置）
 *
 * 迁移阶段：阶段一 — 基础设施（无行为变更）
 * 旧字段在 editorSlice/uiSlice 中保留 @deprecated 标记，不直接删除。
 */

import { create } from 'zustand';
import type { AsrLine } from '../../../shared/types/entities/editor';
import type { VlmFrame } from '../../../shared/types/entities/editor';

export interface ExtractionConfig {
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
  audio: { enabled: boolean };
  whisper: { enabled: boolean; engine: 'sensevoice' | 'whisper-v3' };
  faces: { enabled: boolean; engine: 'insightface' | 'mediapipe' };
}

export interface Step1Store {
  // 步骤1专属数据
  asrLines: AsrLine[];
  frameCount: number;
  audioSeparated: boolean;

  // 抽帧/分析配置（从 uiSlice 迁入）
  extractionConfig: ExtractionConfig;

  // 子步骤状态（步骤1有4个子步骤：frames / audio / whisper / faces）
  subStepStatuses: Record<string, string>;
  subStepProgresses: Record<string, number>;

  // ASR 操作
  setAsrLines: (lines: AsrLine[]) => void;
  updateAsrLine: (index: number, text: string) => void;
  setFrameCount: (count: number) => void;
  setAudioSeparated: (separated: boolean) => void;

  // 配置操作
  updateExtractionConfig: (config: Partial<ExtractionConfig>) => void;

  // 子步骤操作
  setSubStepStatus: (key: string, status: string) => void;
  setSubStepProgress: (key: string, progress: number) => void;
  setAllSubStepsCompleted: () => void;
}

const DEFAULT_EXTRACTION_CONFIG: ExtractionConfig = {
  targetLanguage: 'zh-CN',
  frames: {
    enabled: true,
    mode: 'VLM_OPTIMIZED',
    sceneThreshold: 0.28,
    quality: 3,
    fps: 2,
    scale: 1024,
    minFrameInterval: 4,
  },
  audio: { enabled: true },
  whisper: { enabled: true, engine: 'sensevoice' },
  faces: { enabled: true, engine: 'insightface' },
};

export const useStep1Store = create<Step1Store>()((set) => ({
  asrLines: [],
  frameCount: 0,
  audioSeparated: false,

  extractionConfig: DEFAULT_EXTRACTION_CONFIG,

  subStepStatuses: { frames: 'idle', audio: 'idle', whisper: 'idle', faces: 'idle' },
  subStepProgresses: { frames: 0, audio: 0, whisper: 0, faces: 0 },

  setAsrLines: (lines) => set({ asrLines: lines }),
  updateAsrLine: (index, text) =>
    set((s) => {
      const lines = [...s.asrLines];
      if (lines[index]) lines[index] = { ...lines[index], text };
      return { asrLines: lines };
    }),
  setFrameCount: (count) => set({ frameCount: count }),
  setAudioSeparated: (separated) => set({ audioSeparated: separated }),

  updateExtractionConfig: (config) =>
    set((s) => ({
      extractionConfig: { ...s.extractionConfig, ...config } as ExtractionConfig,
    })),

  setSubStepStatus: (key, status) =>
    set((s) => ({
      subStepStatuses: { ...s.subStepStatuses, [key]: status },
    })),
  setSubStepProgress: (key, progress) =>
    set((s) => ({
      subStepProgresses: { ...s.subStepProgresses, [key]: progress },
    })),
  setAllSubStepsCompleted: () =>
    set({
      subStepStatuses: { frames: 'completed', audio: 'completed', whisper: 'completed', faces: 'completed' },
      subStepProgresses: { frames: 100, audio: 100, whisper: 100, faces: 100 },
    }),
}));
