/**
 * useStep3Store — 步骤3「解说文案」局部 Store
 *
 * @description
 * 从 editorSlice 中提取步骤3专属状态：scriptParagraphs / scriptStyle / speechRate 及操作。
 * pipelineParams 也服务于步骤3（控制文案生成的 R/S/T/P 参数），一并迁入。
 *
 * 迁移阶段：阶段一 — 基础设施（无行为变更）
 */

import { create } from 'zustand';
import type { ScriptParagraph } from '../../../../shared/types/entities/editor';

export interface PipelineParams {
  R: number;
  S: number;
  T: number;
  P: number;
}

export interface Step3Store {
  // 步骤3专属数据
  scriptParagraphs: ScriptParagraph[];
  scriptStyle: string;
  speechRate: number;
  pipelineParams: PipelineParams;

  // 文案操作
  setScriptParagraphs: (paragraphs: ScriptParagraph[]) => void;
  updateScriptParagraph: (id: string, text: string) => void;
  setScriptStyle: (style: string) => void;
  setSpeechRate: (rate: number) => void;
  setPipelineParams: (params: PipelineParams) => void;
}

export const useStep3Store = create<Step3Store>()((set) => ({
  scriptParagraphs: [],
  scriptStyle: '赛博现实主义',
  speechRate: 4.5,
  pipelineParams: { R: 70, S: 50, T: 80, P: 60 },

  setScriptParagraphs: (paragraphs) => set({ scriptParagraphs: paragraphs }),
  updateScriptParagraph: (id, text) =>
    set((s) => ({
      scriptParagraphs: s.scriptParagraphs.map((p: any) =>
        p.id === id ? { ...p, text } : p
      ),
    })),
  setScriptStyle: (style) => set({ scriptStyle: style }),
  setSpeechRate: (rate) => set({ speechRate: rate }),
  setPipelineParams: (params) => set({ pipelineParams: params }),
}));
