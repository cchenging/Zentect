/**
 * useStep4Store — 步骤4「TTS 配音」局部 Store
 *
 * @description
 * 从 editorSlice 中提取步骤4专属状态：ttsEngine / ttsVoiceId / ttsProgress / ttsResults 及操作。
 *
 * 迁移阶段：阶段一 — 基础设施（无行为变更）
 */

import { create } from 'zustand';
import type { TtsResult } from '../../../shared/types/entities/editor';
import { DEFAULT_TTS_PAUSE_MS, clampPauseMs } from '../../../shared/types/entities/stylePack';

/** 情绪强度档：weak 半幅 / normal 原幅 / strong 1.5 倍（与 main/engine/ttsEmotion 的插值系数一一对应） */
export type TtsEmotionStrength = 'weak' | 'normal' | 'strong';

export interface Step4Store {
  // 步骤4专属数据
  ttsEngine: string;
  ttsVoiceId: string;
  ttsProgress: number;
  ttsResults: TtsResult[];
  /** TTS 合成语速倍率（0.5~2.0）：必须持久化，否则重开项目后输入指纹漂移 */
  speechRate: number;
  /** 句尾停顿（ms，0~400，仅 Edge 生效）：默认值由风格包解析（人格基准 + 浓度偏移） */
  pauseMs: number;
  /** 音色是否已被手选：true = 不再跟随风格包推荐音色，卡片显示「已手选」并可一键恢复跟随 */
  voiceManual: boolean;
  /** 句尾停顿是否已被手调：true = 不再跟随风格包默认值，面板显示「已自定义」并可恢复跟随 */
  pauseManual: boolean;
  /** 🎭 情绪语气：按段落 emotion 微调语速/音高（默认开） */
  emotionProsody: boolean;
  /** 🎭 情绪强度档（默认 normal） */
  emotionStrength: TtsEmotionStrength;
  /** 🔊 响度统一：解说段 TTS 终态音频过 loudnorm（默认开） */
  loudnessNorm: boolean;

  // TTS 操作
  setTtsEngine: (engine: string) => void;
  setTtsVoiceId: (voiceId: string) => void;
  /** 手选音色：写音色同时置 voiceManual=true（停止跟随风格包） */
  selectVoiceManual: (voiceId: string) => void;
  /** 恢复跟随风格包：清手选标记，由 UI 重新按人格映射音色 */
  resetVoiceFollow: () => void;
  setTtsProgress: (progress: number) => void;
  setTtsResults: (results: TtsResult[]) => void;
  setSpeechRate: (rate: number) => void;
  /** 非手调写入（hydrate / 跟随回填）：不改 pauseManual 标记 */
  setPauseMs: (pauseMs: number) => void;
  /** 手调写入（滑杆拖动）：写值同时置 pauseManual=true，停止跟随人格默认值 */
  selectPauseMs: (pauseMs: number) => void;
  /** 恢复跟随风格包默认停顿 */
  resetPauseFollow: () => void;
  /** 情绪语气开关 */
  setEmotionProsody: (enabled: boolean) => void;
  /** 情绪强度档 */
  setEmotionStrength: (strength: TtsEmotionStrength) => void;
  /** 响度统一开关 */
  setLoudnessNorm: (enabled: boolean) => void;

  /** 重置步骤4状态 */
  reset: () => void;
}

export const useStep4Store = create<Step4Store>()((set) => ({
  ttsEngine: 'edge',
  ttsVoiceId: '',
  ttsProgress: 0,
  ttsResults: [],
  speechRate: 1.0,
  pauseMs: DEFAULT_TTS_PAUSE_MS,
  voiceManual: false,
  pauseManual: false,
  emotionProsody: true,
  emotionStrength: 'normal',
  loudnessNorm: true,

  // 切引擎清空音色：不同引擎音色 id 不通用；并恢复「跟随风格包」语义
  setTtsEngine: (engine) => set({ ttsEngine: engine, ttsVoiceId: '', voiceManual: false }),
  setTtsVoiceId: (voiceId) => set({ ttsVoiceId: voiceId }),
  selectVoiceManual: (voiceId) => set({ ttsVoiceId: voiceId, voiceManual: true }),
  resetVoiceFollow: () => set({ voiceManual: false }),
  setTtsProgress: (progress) => set({ ttsProgress: progress }),
  setTtsResults: (results) => set({ ttsResults: results }),
  setSpeechRate: (rate) => set({ speechRate: rate }),
  setPauseMs: (pauseMs) => set({ pauseMs: clampPauseMs(pauseMs) }),
  selectPauseMs: (pauseMs) => set({ pauseMs: clampPauseMs(pauseMs), pauseManual: true }),
  resetPauseFollow: () => set({ pauseManual: false }),
  setEmotionProsody: (enabled) => set({ emotionProsody: enabled }),
  setEmotionStrength: (strength) => set({ emotionStrength: strength }),
  setLoudnessNorm: (enabled) => set({ loudnessNorm: enabled }),

  reset: () => set({
    ttsEngine: 'edge',
    ttsVoiceId: '',
    ttsProgress: 0,
    ttsResults: [],
    speechRate: 1.0,
    pauseMs: DEFAULT_TTS_PAUSE_MS,
    voiceManual: false,
    pauseManual: false,
    emotionProsody: true,
    emotionStrength: 'normal',
    loudnessNorm: true,
  }),
}));
