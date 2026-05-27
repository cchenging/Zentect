// 📁 路径：src/renderer/src/store/constants.ts

export const NODE_STATUS = {
  IDLE: 'idle',
  PROCESSING: 'processing',
  SUCCESS: 'success',
  ERROR: 'error'
} as const;
export type NodeStatusType = typeof NODE_STATUS[keyof typeof NODE_STATUS];

export const HYDRATION_STATUS = {
  IDLE: 'IDLE',
  LOADING: 'LOADING',
  READY: 'READY',
  ERROR: 'ERROR'
} as const;
export type HydrationStatusType = typeof HYDRATION_STATUS[keyof typeof HYDRATION_STATUS];
