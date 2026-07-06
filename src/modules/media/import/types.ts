// Module: media/import - Types (§3.5.1)

/** 导入输入 */
export interface ImportInput {
  projectId: string;
  filePaths: string[];
}

/** 导入输出 */
export interface ImportOutput {
  mediaItems: MediaItem[];
}

/** 媒体资产项（导入模块视角） */
export interface MediaItem {
  id: string;
  type: 'video' | 'audio' | 'frame' | 'video_chunk';
  filePath: string;
  fileName?: string;
  name?: string;
  coverPath?: string;
  duration?: string;
  width?: number;
  height?: number;
  fps?: number;
  status: 'importing' | 'parsed' | 'transcoding';
}

/** MediaItem 数据库操作接口（Repository 返回的完整行） */
export interface MediaRow extends MediaItem {
  projectId: string;
  frames?: string[];
  extractedAudio?: string;
  extractedVocals?: string;
  extractedBgm?: string;
  extractedText?: string;
  extractDuration?: number;
  narrationScript?: unknown;
  createTime?: string;
  updateTime?: string;
}
