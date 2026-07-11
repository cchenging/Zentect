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

export interface Step4Store {
  // 步骤4专属数据
  ttsEngine: string;
  ttsVoiceId: string;
  ttsProgress: number;
  ttsResults: TtsResult[];

  // TTS 操作
  setTtsEngine: (engine: string) => void;
  setTtsVoiceId: (voiceId: string) => void;
  setTtsProgress: (progress: number) => void;
  setTtsResults: (results: TtsResult[]) => void;
}

export const useStep4Store = create<Step4Store>()((set) => ({
  ttsEngine: 'edge',
  ttsVoiceId: '',
  ttsProgress: 0,
  ttsResults: [],

  setTtsEngine: (engine) => set({ ttsEngine: engine, ttsVoiceId: '' }),
  setTtsVoiceId: (voiceId) => set({ ttsVoiceId: voiceId }),
  setTtsProgress: (progress) => set({ ttsProgress: progress }),
  setTtsResults: (results) => set({ ttsResults: results }),
}));
