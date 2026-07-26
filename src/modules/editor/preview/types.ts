// Module: editor/preview - Types

/** 预览播放器输入接口（素材源由 Store 统一管理） */
// 🔧 修复 TS2339：测试期望 mediaPath/startMs/endMs 字段
export interface PreviewInput {
  mediaPath?: string | null;
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
  /** 替换当前视频：删旧视频及衍生数据后导入新视频 */
  onReplaceClick?: () => void;
}
