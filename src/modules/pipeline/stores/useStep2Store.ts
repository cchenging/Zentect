/**
 * useStep2Store — 步骤2「视觉描述」局部 Store
 *
 * @description
 * 从 editorSlice 中提取步骤2专属状态：vlmFrames 及相关操作。
 * VLM 分析结果包含帧 URL、描述文本、编辑状态等信息。
 *
 * 迁移阶段：阶段一 — 基础设施（无行为变更）
 */

import { create } from 'zustand';
import type { VlmFrame } from '../../../shared/types/entities/editor';

export interface Step2Store {
  // 步骤2专属数据
  vlmFrames: VlmFrame[];

  // VLM 操作
  setVlmFrames: (frames: VlmFrame[]) => void;
  updateVlmDescription: (index: number, description: string) => void;
  setVlmEditing: (index: number, editing: boolean) => void;
}

export const useStep2Store = create<Step2Store>()((set) => ({
  vlmFrames: [],

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
}));
