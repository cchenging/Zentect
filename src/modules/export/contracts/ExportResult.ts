// 📁 路径：src/modules/export/contracts/ExportResult.ts
// 契约层：统一导出结果

/** 统一导出结果：所有出口返回同一结构，便于编排层统一处理 */
export interface ExportResult {
  /** 出口标识（对应 IExporter.id） */
  exporterId: string;
  /** 是否成功 */
  success: boolean;
  /** 产出文件路径（文件夹或文件） */
  outputPath?: string;
  /** 产出名称（可多个，如成片 + 字幕） */
  fileNames?: string[];
  /** 成片时长（秒） */
  duration?: number;
  /** 失败原因 */
  error?: string;
}