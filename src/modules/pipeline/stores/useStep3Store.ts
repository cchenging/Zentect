/**
 * useStep3Store — 步骤3「解说文案」局部 Store
 *
 * 融合方案参数：枚举按钮组 + 连续值协同，替代旧版 R/S/T/P 滑块
 */

import { create } from 'zustand';
import type { ScriptParagraph, PipelineParams } from '../../../shared/types/entities/editor';

export type { PipelineParams } from '../../../shared/types/entities/editor';

/** 默认参数：爆款短视频导向（高钩子/标准密度/关键台词保留/长短交替/客观基调） */
export const DEFAULT_PIPELINE_PARAMS: PipelineParams = {
  narrativePerspective: 'third',
  informationLevel: 'deep',
  narrationDensity: 'standard',
  originalAudioStrategy: 'keep_key',
  rhythmMode: 'mixed',
  emotionTone: 'neutral',
  hookIntensity: 0.7,
  audioVisualWeight: 0.6,
};

export interface Step3Store {
  scriptParagraphs: ScriptParagraph[];
  scriptStyle: string;
  speechRate: number;
  pipelineParams: PipelineParams;

  setScriptParagraphs: (paragraphs: ScriptParagraph[]) => void;
  updateScriptParagraph: (id: string, text: string) => void;
  setScriptStyle: (style: string) => void;
  setSpeechRate: (rate: number) => void;
  setPipelineParams: (params: PipelineParams) => void;

  reset: () => void;
}

export const useStep3Store = create<Step3Store>()((set) => ({
  scriptParagraphs: [],
  scriptStyle: '爆款短视频',
  speechRate: 4.5,
  pipelineParams: { ...DEFAULT_PIPELINE_PARAMS },

  setScriptParagraphs: (paragraphs) => set({ scriptParagraphs: paragraphs }),
  updateScriptParagraph: (id, text) =>
    set((s) => ({
      scriptParagraphs: s.scriptParagraphs.map((p) =>
        p.id === id ? { ...p, text } : p
      ),
    })),
  setScriptStyle: (style) => set({ scriptStyle: style }),
  setSpeechRate: (rate) => set({ speechRate: rate }),
  setPipelineParams: (params) => set({ pipelineParams: params }),

  reset: () => set({
    scriptParagraphs: [],
    scriptStyle: '爆款短视频',
    speechRate: 4.5,
    pipelineParams: { ...DEFAULT_PIPELINE_PARAMS },
  }),
}));
