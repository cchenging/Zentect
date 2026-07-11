/**
 * useStep5Store — 步骤5「镜头匹配」局部 Store
 *
 * @description
 * 从 editorSlice 中提取步骤5专属状态：matchResults / activeBgm / beatTimestamps / videoChunks 及操作。
 *
 * 迁移阶段：阶段一 — 基础设施（无行为变更）
 */

import { create } from 'zustand';
import type { MatchResult } from '../../../shared/types/entities/editor';

export interface BgmInfo {
  id: string;
  filePath: string;
  name?: string;
}

export interface Step5Store {
  // 步骤5专属数据
  matchResults: MatchResult[];
  activeBgm: BgmInfo | null;
  beatTimestamps: number[];
  videoChunks: any[];

  // 匹配操作
  setMatchResults: (results: MatchResult[]) => void;
  confirmMatch: (shotId: string) => void;
  replaceMatch: (shotId: string, newMediaId: string) => void;
  setActiveBgm: (bgm: BgmInfo | null) => void;
  setBeatTimestamps: (beats: number[]) => void;
  setVideoChunks: (chunks: any[]) => void;
}

export const useStep5Store = create<Step5Store>()((set) => ({
  matchResults: [],
  activeBgm: null,
  beatTimestamps: [],
  videoChunks: [],

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
}));
