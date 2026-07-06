// 📁 路径：src/modules/export/srt/types.ts
// 接口契约：SRT 字幕导出模块（§3.6.2）

/** ASR 台词行 */
export interface AsrLine {
  /** 起始时间，格式 "MM:SS" 或 "HH:MM:SS" */
  start: string;
  /** 结束时间，格式 "MM:SS" 或 "HH:MM:SS"（可选） */
  end?: string;
  /** 台词文本 */
  text: string;
  /** AI 原始识别文本（可选） */
  originalText?: string;
  /** 是否正在编辑 */
  editing?: boolean;
}

/** SRT 字幕导出输入参数 */
export interface SrtExportInput {
  /** ASR 台词行列表 */
  asrLines: AsrLine[];
  /** 输出文件完整路径（含 .srt 扩展名） */
  outputPath: string;
}
