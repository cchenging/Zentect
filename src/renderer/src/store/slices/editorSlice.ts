// 📁 路径: src/renderer/src/store/slices/editorSlice.ts
// 编辑器核心状态切片 - 阶段四清理，已迁移至各独立 Store
// 保留 hydrationStatus 作为编辑器加载状态
import type { StateCreator } from 'zustand';
import type { EditorSlice } from '../storeTypes';

/**
 * 创建编辑器切片
 * 
 * 阶段四后仅保留 hydrationStatus。
 * 以下字段已迁移至独立 Store：
 * - currentStep / isAutoMode → useEditorNavStore
 * - stepStatuses / stepCompleted / pipelineRunning 等管线状态 → usePipelineStore
 * - asrLines / frameCount / audioSeparated → useStep1Store
 * - vlmFrames → useStep2Store
 * - scriptParagraphs / scriptStyle / speechRate → useStep3Store
 * - ttsEngine / ttsVoiceId / ttsResults → useStep4Store
 * - matchResults / activeBgm / beatTimestamps / videoChunks → useStep5Store
 */
export const createEditorSlice: StateCreator<EditorSlice, [], [], EditorSlice> = (set, _get) => ({
  // ===== 水合与项目整体加载状态 =====
  hydrationStatus: 'IDLE',
  setHydrationStatus: (status) => set({ hydrationStatus: status }),
});
