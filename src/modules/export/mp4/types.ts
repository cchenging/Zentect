// 📁 路径：src/modules/export/mp4/types.ts
// 成片导出类型定义

/** 成片导出输入参数 */
export interface Mp4ExportInput {
  /** 项目 ID */
  projectId: string;
  /** 项目名称（用于输出文件名） */
  projectName?: string;
  /** 画幅比例（16:9 / 9:16） */
  ratio?: string;
  /** 分辨率档（4k / 2k / 1080p / 720p） */
  resolution?: string;
  /** 帧率（30 / 60） */
  fps?: number;
  /** 是否预览模式（低码率快速导出） */
  preview?: boolean;
  /** 字幕烧录模式：none=不烧录 / burn=烧录进画面 / file=仅字幕文件 / both=烧录+字幕文件 */
  subtitleMode?: 'none' | 'burn' | 'file' | 'both';
  /** 输出目录（笔发导出路径） */
  exportPath?: string;
}

/** 成片导出输出 */
export interface Mp4ExportOutput {
  /** 成片 MP4 路径 */
  outputPath: string;
  /** 成片时长（秒） */
  duration: number;
  /** 附加产出（如烧录用的 SRT 字幕文件路径） */
  subtitlePath?: string;
}