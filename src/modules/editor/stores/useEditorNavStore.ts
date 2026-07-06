/**
 * useEditorNavStore — 编辑器导航状态独立 Store
 *
 * @description
 * 从 editorSlice 中提取编辑器外壳导航状态：currentStep / isAutoMode。
 * 这两个字段是 Editor Shell 的纯导航状态，不应与管线执行态混在一起。
 *
 * 迁移阶段：阶段一 — 基础设施（无行为变更）
 */

import { create } from 'zustand';

export interface EditorNavStore {
  currentStep: number;
  isAutoMode: boolean;

  setCurrentStep: (step: number) => void;
  setIsAutoMode: (auto: boolean) => void;
}

export const useEditorNavStore = create<EditorNavStore>()((set) => ({
  currentStep: 1,
  isAutoMode: false,

  setCurrentStep: (step) => set({ currentStep: step }),
  setIsAutoMode: (auto) => set({ isAutoMode: auto }),
}));
