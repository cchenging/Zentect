/**
 * @deprecated 已迁移至 src/modules/editor/preview/utils/timeFormat.ts
 * 请使用 import { formatTime } from '@/modules/editor/preview'
 */

/** 格式化秒数为 MM:SS 格式，NaN/Infinity 安全防护 */
export const formatTime = (t: number): string => {
  if (!Number.isFinite(t)) return '00:00';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};
