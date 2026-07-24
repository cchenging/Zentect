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
import { persist } from 'zustand/middleware';
import type { AsrLine } from '../../../shared/types/entities/editor';
import type { VlmFrame } from '../../../shared/types/entities/editor';

/** 音频分离配置（与 step1-material/types.ts 的 AudioConfig 保持一致） */
export interface AudioConfig {
  enabled: boolean;
  /** 'fast': 跳过人声分离，ASR 使用原始音轨（含 BGM）；'quality': 使用 Demucs/MDX-Net 分离人声 */
  separationMode?: 'fast' | 'quality';
  /** quality 模式下可选引擎：'demucs'(重型,高保真) | 'mdx'(轻量,极速) | 'auto'(Python 默认顺序) */
  engine?: 'demucs' | 'mdx' | 'auto';
}

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
  audio: AudioConfig;
  whisper: { enabled: boolean; engine: 'sensevoice' | 'whisper-v3' };
  faces: { enabled: boolean; engine: 'insightface' | 'mediapipe' };
}

export interface Step1Store {
  // 步骤1专属数据
  asrLines: AsrLine[];
  frameCount: number;
  audioSeparated: boolean;
  /** 人声分离是否降级到原始音轨（true=分离失败，ASR 使用含 BGM 的原始音轨） */
  vocalsIsFallback: boolean;

  // 抽帧/分析配置（从 uiSlice 迁入）
  extractionConfig: ExtractionConfig;

  // 子步骤进度（步骤1有4个子步骤：frames / audio / whisper / faces）
  // subStepStatuses 已迁移至 usePipelineStore，单一数据源
  subStepProgresses: Record<string, number>;

  // ASR 操作
  setAsrLines: (lines: AsrLine[]) => void;
  updateAsrLine: (index: number, text: string) => void;
  setFrameCount: (count: number) => void;
  setAudioSeparated: (separated: boolean) => void;
  setVocalsIsFallback: (fallback: boolean) => void;

  // 配置操作
  updateExtractionConfig: (config: Partial<ExtractionConfig>) => void;

  // 子步骤进度操作
  // setSubStepStatus / setAllSubStepsCompleted 已迁移至 usePipelineStore
  setSubStepProgress: (key: string, progress: number) => void;
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
  audio: { enabled: true, separationMode: 'quality', engine: 'auto' },
  whisper: { enabled: true, engine: 'sensevoice' },
  faces: { enabled: true, engine: 'insightface' },
};

/** persist 部分白名单：只持久化配置，不持久化运行时数据/进度 */
const PERSIST_PARTIAL = (state: Step1Store) => ({
  extractionConfig: state.extractionConfig,
});

export const useStep1Store = create<Step1Store>()(
  persist(
    (set) => ({
      asrLines: [],
      frameCount: 0,
      audioSeparated: false,
      vocalsIsFallback: false,

      extractionConfig: DEFAULT_EXTRACTION_CONFIG,

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
      setVocalsIsFallback: (fallback) => set({ vocalsIsFallback: fallback }),

      updateExtractionConfig: (config) =>
        set((s) => ({
          extractionConfig: { ...s.extractionConfig, ...config } as ExtractionConfig,
        })),

      setSubStepProgress: (key, progress) =>
        set((s) => ({
          subStepProgresses: { ...s.subStepProgresses, [key]: progress },
        })),
    }),
    {
      name: 'zentect-step1-store',
      // 只持久化配置部分，避免运行时数据污染
      partialize: PERSIST_PARTIAL,
    }
  )
);
