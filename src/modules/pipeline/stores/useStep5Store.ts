/**
 * useStep5Store — 步骤5「镜头匹配」局部 Store
 *
 * @description
 * 从 editorSlice 中提取步骤5专属状态：matchResults / activeBgm / beatTimestamps / videoChunks 及操作。
 *
 * 迁移阶段：阶段一 — 基础设施（无行为变更）
 */

import { create } from 'zustand';
import type { BgmInfo, MatchResult } from '../../../shared/types/entities/editor';

/** BGM 推荐曲目 */
export interface BgmTrack {
  name: string;
  artist: string;
  mood: string;
  source: string;
  beatFit: string;
  bpm?: number;
  durationMs?: number;
  previewUrl?: string;
  downloadUrl?: string;
  libraryId?: string;
}

/** BGM 个性化推荐结果（LLM 依据文案语义生成） */
export interface BgmRecommendation {
  toneLabel: string;
  toneDesc: string;
  tracks: BgmTrack[];
}

export interface Step5Store {
  // 步骤5专属数据
  matchResults: MatchResult[];
  activeBgm: BgmInfo | null;
  beatTimestamps: number[];
  videoChunks: any[];
  /** AI 深度 BGM 推荐结果：提升到 store 并随快照落盘，刷新/切步/重开项目不丢失 */
  deepRecommendation: BgmRecommendation | null;

  // 匹配操作
  setMatchResults: (results: MatchResult[]) => void;
  confirmMatch: (shotId: string) => void;
  replaceMatch: (shotId: string, newMediaId: string) => void;
  setActiveBgm: (bgm: BgmInfo | null) => void;
  setBeatTimestamps: (beats: number[]) => void;
  setVideoChunks: (chunks: any[]) => void;
  setDeepRecommendation: (recommendation: BgmRecommendation | null) => void;

  /** 重置步骤5状态 */
  reset: () => void;
}

export const useStep5Store = create<Step5Store>()((set) => ({
  matchResults: [],
  activeBgm: null,
  beatTimestamps: [],
  videoChunks: [],
  deepRecommendation: null,

  setMatchResults: (results) => set({ matchResults: results }),
  confirmMatch: (shotId) =>
    set((s) => ({
      matchResults: s.matchResults.map((m: any) =>
        m.shotId === shotId ? { ...m, confirmed: true } : m
      ),
    })),
  replaceMatch: (shotId, newMediaId) =>
    set((s) => ({
      matchResults: s.matchResults.map((m: any) =>
        m.shotId === shotId ? { ...m, mediaId: newMediaId, confirmed: false } : m
      ),
    })),
  setActiveBgm: (bgm) => set({ activeBgm: bgm }),
  setBeatTimestamps: (beats) => set({ beatTimestamps: beats }),
  setVideoChunks: (chunks) => set({ videoChunks: chunks }),
  setDeepRecommendation: (recommendation) => set({ deepRecommendation: recommendation }),

  reset: () => set({
    matchResults: [],
    activeBgm: null,
    beatTimestamps: [],
    videoChunks: [],
    deepRecommendation: null,
  }),
}));
