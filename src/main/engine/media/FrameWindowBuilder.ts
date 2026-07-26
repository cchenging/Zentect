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
 * @param frameTimeMsArr 每帧在视频中的绝对时间（毫秒）数组
 * @param frameIdx 当前帧在 allFrames 中的索引
 * @param windowRadius 窗口半径（向前/后取多少帧），默认 2
 * @returns 窗口内的帧信息数组，至少包含当前帧
 */
export function buildFrameWindow(
  allFrames: string[],
  frameTimeMsArr: number[],
  frameIdx: number,
  windowRadius: number = 2,
): FrameWindowItem[] {
  if (!allFrames || allFrames.length === 0) {
    return [];
  }

  const startIdx = Math.max(0, frameIdx - windowRadius);
  const endIdx = Math.min(allFrames.length - 1, frameIdx + windowRadius);
  const windowItems: FrameWindowItem[] = [];

  /** 当前帧的绝对时间（毫秒），缺省为 0 */
  const currentFrameTimeMs = frameTimeMsArr[frameIdx] ?? 0;

  for (let i = startIdx; i <= endIdx; i++) {
    // 优先使用数组中的精确时间，缺省时基于当前帧时间线性外推
    const timeMs = frameTimeMsArr[i] ?? currentFrameTimeMs;
    windowItems.push({
      filePath: allFrames[i],
      timeMs: Math.round(timeMs),
      index: i,
    });
  }

  return windowItems;
}
