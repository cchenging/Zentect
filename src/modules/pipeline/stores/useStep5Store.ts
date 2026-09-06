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

/** 步骤5 匹配诊断（后端随节点结果返回的根因提示：切片池空 / KM 全未命中 / 原声定位失败等） */
export interface Step5MatchDiagnostics {
  /** 用户可读的根因提示（空数组 = 无异常） */
  warnings: string[];
  totalQueries?: number;
  matchedCount?: number;
  chunkCount?: number;
  matchSegmentCount?: number;
  originalQueryCount?: number;
  originalMatchedCount?: number;
}

export interface Step5Store {
  // 步骤5专属数据
  matchResults: MatchResult[];
  activeBgm: BgmInfo | null;
  beatTimestamps: number[];
  videoChunks: any[];
  /** AI 深度 BGM 推荐结果：提升到 store 并随快照落盘，刷新/切步/重开项目不丢失 */
  deepRecommendation: BgmRecommendation | null;
  /** 最近一次匹配的诊断信息（新一次匹配开始/完成时更新；无异常为 warnings:[]） */
  matchDiagnostics: Step5MatchDiagnostics | null;

  // 匹配操作
  setMatchResults: (results: MatchResult[]) => void;
  confirmMatch: (shotId: string) => void;
  replaceMatch: (shotId: string, newMediaId: string) => void;
  setActiveBgm: (bgm: BgmInfo | null) => void;
  setBeatTimestamps: (beats: number[]) => void;
  setVideoChunks: (chunks: any[]) => void;
  setDeepRecommendation: (recommendation: BgmRecommendation | null) => void;
  setMatchDiagnostics: (diag: Step5MatchDiagnostics | null) => void;

  /** 重置步骤5状态 */
  reset: () => void;
}

export const useStep5Store = create<Step5Store>()((set) => ({
  matchResults: [],
  activeBgm: null,
  beatTimestamps: [],
  videoChunks: [],
  deepRecommendation: null,
  matchDiagnostics: null,

  setMatchResults: (results) => set({ matchResults: results }),
  confirmMatch: (shotId: string) =>
    set((s) => ({
      matchResults: s.matchResults.map((m: any) =>
        /** ✅ 身份键统一：消费端一律读 id（出生处即段落唯一主键），删除 shotId 双门 */
        m.id === shotId ? { ...m, confirmed: true } : m
      ),
    })),
  replaceMatch: (shotId, newMediaId) =>
    set((s) => ({
      matchResults: s.matchResults.map((m: any) =>
        m.id === shotId ? { ...m, mediaId: newMediaId, confirmed: false } : m
      ),
    })),
  setActiveBgm: (bgm) => set({ activeBgm: bgm }),
  setBeatTimestamps: (beats) => set({ beatTimestamps: beats }),
  setVideoChunks: (chunks) => set({ videoChunks: chunks }),
  setDeepRecommendation: (recommendation) => set({ deepRecommendation: recommendation }),
  setMatchDiagnostics: (diag) => set({ matchDiagnostics: diag }),

  reset: () => set({
    matchResults: [],
    activeBgm: null,
    beatTimestamps: [],
    videoChunks: [],
    deepRecommendation: null,
    matchDiagnostics: null,
  }),
}));
