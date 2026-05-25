import type { StateCreator } from 'zustand';
import type { EditorState, PlayerSlice } from '../storeTypes'; // 💥 修正了错误的来源导入

/**
 * 💥 Player Slice
 * 注：此模块包含高频触发的状态 (currentTime)。
 * 业务组件消费此状态时，必须遵循单一属性选择原则，或使用 useShallow/subscribeWithSelector，严禁全量解构！
 */
export const createPlayerSlice: StateCreator<EditorState, [], [], PlayerSlice> = (set, get) => ({
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
  seek: (time) => set({ currentTime: Math.max(0, Math.min(time, get().duration)) }),
  setDuration: (duration) => set({ duration }),
  setScale: (scale) => set({ scale }),
  setGpuAcceleration: (enable) => set({ gpuAcceleration: enable }),
  setScrollX: (scrollX) => set({ scrollX: Math.max(0, scrollX) }),
});
