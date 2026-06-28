// 📁 路径：src/main/engine/media/FrameWindowBuilder.ts
// 🚀 帧滑动窗口构建器：为 VLM 分析提供多帧上下文窗口

export interface FrameWindowItem {
  /** 帧文件路径 */
  filePath: string;
  /** 帧在视频中的绝对时间（毫秒） */
  timeMs: number;
  /** 帧在总帧列表中的索引 */
  index: number;
}

/**
 * 构建多帧滑动窗口，为 VLM 提供前后帧画面上下文
 * @param allFrames 所有帧文件路径数组
 * @param frameTimeMs 当前帧的绝对时间（毫秒）
 * @param frameIdx 当前帧在 allFrames 中的索引
 * @param windowRadius 窗口半径（向前/后取多少帧），默认 2
 * @returns 窗口内的帧信息数组，至少包含当前帧
 */
export function buildFrameWindow(
  allFrames: string[],
  frameTimeMs: number,
  frameIdx: number,
  windowRadius: number = 2,
): FrameWindowItem[] {
  if (!allFrames || allFrames.length === 0) {
    return [];
  }

  const startIdx = Math.max(0, frameIdx - windowRadius);
  const endIdx = Math.min(allFrames.length - 1, frameIdx + windowRadius);
  const windowItems: FrameWindowItem[] = [];

  /** 估算帧间隔时间（毫秒） */
  const estimatedIntervalMs = allFrames.length > 1
    ? (frameTimeMs * 2) / (frameIdx + 1) || 1000
    : 1000;

  for (let i = startIdx; i <= endIdx; i++) {
    windowItems.push({
      filePath: allFrames[i],
      timeMs: Math.round(frameTimeMs + (i - frameIdx) * estimatedIntervalMs),
      index: i,
    });
  }

  return windowItems;
}
