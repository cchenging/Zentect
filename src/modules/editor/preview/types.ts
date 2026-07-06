// Module: editor/preview - Types

/** 预览播放器输入接口 */
export interface PreviewInput {
  mediaPath: string | null;
  startMs?: number;
  endMs?: number;
}

/** 预览播放器输出接口 */
export interface PreviewOutput {
  currentTime: number;
  isPlaying: boolean;
}

/** 播放器事件回调 */
export interface PreviewCallbacks {
  onTimeUpdate?: (time: number) => void;
  onImportClick?: () => void;
}
