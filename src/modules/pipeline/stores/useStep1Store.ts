/**
 * useStep1Store — 步骤1「素材分析」局部 Store
 * P0 · 契约收拢：抽帧策略从 4 枚举收拢为 2 枚举（AUTO_ADAPTIVE | UNIFORM_FPS），
 * 新增 frameDensityPreset（抽帧密度预设 SSOT），配合 zustand persist.migrate 做旧数据迁移。
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
// P0 · 抽帧契约唯一真源
import {
  type FrameExtractStrategy as SharedFrameStrategy,
  type DensityPreset as SharedFrameDensityPreset,
  normalizeFrameStrategy,
} from '../../../shared/contracts/capabilities';

/** 音频分离配置（与 step1-material/types.ts 的 AudioConfig 保持一致） */
export interface AudioConfig {
  enabled: boolean;
  /** 'fast': 跳过人声分离，ASR 使用原始音轨（含 BGM）；'quality': 使用 Demucs/MDX-Net 分离人声 */
  separationMode?: 'fast' | 'quality';
  /** quality 模式下可选引擎：'demucs'(重型,高保真) | 'mdx'(轻量,极速) */
  engine?: 'demucs' | 'mdx';
}

export interface ExtractionConfig {
  targetLanguage: string;
  frames: {
    enabled: boolean;
    /** P0 · 2 值枚举：AUTO_ADAPTIVE | UNIFORM_FPS；保留 string 以兼容历史反序列化 */
    mode: SharedFrameStrategy | string;
    /** P0 · 抽帧密度预设（SSOT，framesPerMinute/minFrameInterval/sceneThreshold 的唯一来源）
     *  命名为 frameDensityPreset 避免与 step3 解说密度字段 density 语义冲突
     */
    frameDensityPreset?: SharedFrameDensityPreset;
    sceneThreshold: number;
    fps: number;
    minFrameInterval?: number;
    timePoint?: number;
    /**
     * P2 视觉分析模式（VLM 矩阵策略）
     * - 'auto': 智能自动，根据帧间隔自动选择 2x2/3x3
     * - '2x2': 标准均衡（4帧拼图，省 Token，适合解说/影视/Vlog）
     * - '3x3': 动作捕捉（9帧拼图，适合游戏/运动/快剪）
     * - '1x1': 精细单帧（独立分析，不拼图）
     */
    matrixMode?: 'auto' | '2x2' | '3x3' | '1x1';
    /**
     * @deprecated P0 · step3 解说密度已迁出抽帧配置；保留字段仅兼容旧 JSON
     * 请改用 step3-script 内部的 scriptDensity 配置。
     */
    density?: SharedFrameDensityPreset | string;
  };
  audio: AudioConfig;
  whisper: { enabled: boolean; engine: 'sensevoice' | 'faster-whisper' | 'auto' };
  faces: {
    enabled: boolean;
    engine: 'insightface' | 'mediapipe';
    /** 🎭 P0.5+ 余弦相似度阈值（可选，默认 0.70）
     * HDBSCAN 聚类后用于合并过拆簇 + 分配噪声点
     * 经验值：0.65 宽松 / 0.70 平衡 / 0.75 严格 / 0.82 极严格 */
    cosineThreshold?: number;
  };
}

/**
 * P0 · 旧抽帧配置迁移（migrateFramesConfig）
 * 所有历史 4 策略名 → 归一化为 AUTO_ADAPTIVE | UNIFORM_FPS；
 * 缺失 frameDensityPreset 时 → 根据旧策略名猜测档位或统一回落到 standard。
 * 说明：此函数作为 zustand persist.migrate 的核心，同时暴露以便 step1 管线主动调用。
 * @param rawFrames 持久化 JSON 里的 frames 子对象（任意形状）
 * @returns 符合 P0 契约的 ExtractionConfig['frames']
 */
export function migrateFramesConfig(rawFrames: any): ExtractionConfig['frames'] {
  const baseDefaults = {
    enabled: true,
    mode: 'AUTO_ADAPTIVE' as const,
    sceneThreshold: 0.25,
    fps: 2,
    minFrameInterval: 3.5,
    matrixMode: 'auto' as const,
    frameDensityPreset: 'standard' as const,
  } satisfies ExtractionConfig['frames'];
  if (!rawFrames || typeof rawFrames !== 'object') return baseDefaults;

  // 1) 策略归一化：所有历史别名 → 2 值枚举
  const normalizedMode = normalizeFrameStrategy(rawFrames.mode, baseDefaults.mode);

  // 2) 密度预设猜测：缺失时根据旧策略选档，有显式 frameDensityPreset 直接用
  let densityPreset: SharedFrameDensityPreset = baseDefaults.frameDensityPreset;
  const rawPreset = rawFrames.frameDensityPreset ?? rawFrames.density; // 兼容旧 density 字段
  if (typeof rawPreset === 'string' && ['sparse', 'standard', 'dense'].includes(rawPreset)) {
    densityPreset = rawPreset as SharedFrameDensityPreset;
  } else if (rawFrames.mode && typeof rawFrames.mode === 'string') {
    // 无显式档位 → 基于旧策略名做一次合理映射
    const oldMode = rawFrames.mode.trim().toUpperCase();
    if (oldMode === 'UNIFORM' || oldMode === 'UNIFORM_FPS') {
      densityPreset = 'standard';
    } else if (oldMode === 'VLM_OPTIMIZED' || oldMode === 'FAST_KEYFRAME') {
      densityPreset = 'standard';
    } else if (oldMode === 'PRECISE_SINGLE') {
      // PRECISE_SINGLE 已迁出，统一回落到 standard（定点截图走独立 API）
      densityPreset = 'standard';
    }
  }

  return {
    ...baseDefaults,
    enabled: typeof rawFrames.enabled === 'boolean' ? rawFrames.enabled : baseDefaults.enabled,
    mode: normalizedMode,
    frameDensityPreset: densityPreset,
    sceneThreshold: typeof rawFrames.sceneThreshold === 'number' ? rawFrames.sceneThreshold : baseDefaults.sceneThreshold,
    fps: typeof rawFrames.fps === 'number' ? rawFrames.fps : baseDefaults.fps,
    minFrameInterval: typeof rawFrames.minFrameInterval === 'number' ? rawFrames.minFrameInterval : baseDefaults.minFrameInterval,
    timePoint: typeof rawFrames.timePoint === 'number' ? rawFrames.timePoint : undefined,
    matrixMode: rawFrames.matrixMode ?? baseDefaults.matrixMode,
    // @deprecated 保留 density 原样避免老数据反序列化崩溃
    density: typeof rawFrames.density === 'string' ? rawFrames.density : undefined,
  };
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

  /** 重置运行时数据(保留 extractionConfig 持久化配置) */
  reset: () => void;
}

const DEFAULT_EXTRACTION_CONFIG: ExtractionConfig = {
  targetLanguage: 'zh-CN',
  frames: {
    enabled: true,
    mode: 'AUTO_ADAPTIVE', // P0 · 新枚举默认
    frameDensityPreset: 'standard', // P0 · 默认标准档
    sceneThreshold: 0.25,
    fps: 2,
    minFrameInterval: 3.5,
    matrixMode: 'auto',
  },
  audio: { enabled: true, separationMode: 'quality', engine: 'mdx' },
  whisper: { enabled: true, engine: 'auto' },
  faces: { enabled: true, engine: 'insightface' },
};

/** persist 部分白名单：只持久化配置，不持久化运行时数据/进度 */
const PERSIST_PARTIAL = (state: Step1Store) => ({
  extractionConfig: state.extractionConfig,
});

/**
 * P0 · zustand persist 版本号 + 迁移钩子
 * - version 0: 旧数据（4 枚举）；version 1: 新 2 枚举 + frameDensityPreset
 * - migrate：仅需处理 0 → 1（历史 4 策略 → 2 策略 + standard 密度档）
 */
const PERSIST_VERSION = 1;

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

      reset: () => set({
        asrLines: [],
        frameCount: 0,
        audioSeparated: false,
        vocalsIsFallback: false,
        subStepProgresses: { frames: 0, audio: 0, whisper: 0, faces: 0 },
        // extractionConfig 是 persist 持久化配置,不重置
      }),
    }),
    {
      name: 'zentect-step1-store',
      version: PERSIST_VERSION,
      // 只持久化配置部分，避免运行时数据污染
      partialize: PERSIST_PARTIAL,
      // P0 · 历史数据迁移：旧策略归一化 + frameDensityPreset 补齐
      migrate: (persistedState: any, version: number) => {
        if (version === 0 && persistedState && typeof persistedState === 'object') {
          const extractionConfig = (persistedState as any).extractionConfig;
          if (extractionConfig && extractionConfig.frames) {
            extractionConfig.frames = migrateFramesConfig(extractionConfig.frames);
          }
          // 迁移后 version 会被 zustand 自动更新为当前 PERSIST_VERSION
        }
        return persistedState;
      },
    }
  )
);
