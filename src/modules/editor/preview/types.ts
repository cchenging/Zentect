// Module: editor/preview - Types

/** 预览播放器输入接口（素材源由 Store 统一管理） */
export interface PreviewInput {}

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
