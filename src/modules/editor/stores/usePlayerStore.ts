/**
 * usePlayerStore — 播放器状态独立 Store
 *
 * @description
 * 从 playerSlice 中提取的播放器高频状态。
 * 注：此模块包含高频触发的状态 (currentTime)。
 * 业务组件消费此状态时，必须遵循单一属性选择原则。
 *
 * 迁移阶段：阶段一 — 基础设施（无行为变更）
 */

import { create } from 'zustand';
import type { MediaItem } from '../../../shared/types';

export interface PlayerStore {
  activePlaySource: MediaItem | null;
  isPlaying: boolean;
  currentTime: number;
  videoDuration: number;
  duration: number;
  manualSeekTime: number | null;
  activeScript: string | null;
  activeShots: any[] | null;

  scale: number;
  scrollX: number;
  gpuAcceleration: boolean;

  setActivePlaySource: (source: MediaItem | null) => void;
  setIsPlaying: (playing: boolean) => void;
  setCurrentTime: (time: number) => void;
  setVideoDuration: (duration: number) => void;
  setManualSeekTime: (time: number | null) => void;
  setActiveScript: (content: string | null) => void;
  setActiveShots: (shots: any[] | null) => void;

  play: () => void;
  pause: () => void;
  seek: (time: number) => void;
  setDuration: (duration: number) => void;
  setScale: (scale: number) => void;
  setGpuAcceleration: (enable: boolean) => void;
  setScrollX: (scrollX: number) => void;
  resetState: () => void;
}

export const usePlayerStore = create<PlayerStore>()((set, get) => ({
  activePlaySource: null,
  isPlaying: false,
  currentTime: 0,
  videoDuration: 0,
  duration: 0,
  manualSeekTime: null,
  activeScript: null,
  activeShots: null,
  scale: 100,
  scrollX: 0,
  gpuAcceleration: false,

  setActivePlaySource: (source) => set({ activePlaySource: source }),
  setIsPlaying: (playing) => set({ isPlaying: playing }),
  setCurrentTime: (time) => set({ currentTime: Math.max(0, time) }),
  setVideoDuration: (duration) => set({ videoDuration: duration }),
  setManualSeekTime: (time) => set({ manualSeekTime: time }),
  setActiveScript: (content) => set({ activeScript: content }),
  setActiveShots: (shots) => set({ activeShots: shots }),

  play: () => set({ isPlaying: true }),
  pause: () => set({ isPlaying: false }),
  seek: (time) => {
    const clamped = Math.max(0, Math.min(time, get().duration));
    set({ currentTime: clamped, manualSeekTime: clamped });
  },
  setDuration: (duration) => set({ duration }),
  setScale: (scale) => set({ scale }),
  setGpuAcceleration: (enable) => set({ gpuAcceleration: enable }),
  setScrollX: (scrollX) => set({ scrollX: Math.max(0, scrollX) }),
  resetState: () => set({
    activePlaySource: null,
    isPlaying: false,
    currentTime: 0,
    videoDuration: 0,
    duration: 0,
    manualSeekTime: null,
    activeScript: null,
    activeShots: null,
  }),
}));
