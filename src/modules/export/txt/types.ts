// 📁 路径：src/modules/export/txt/types.ts
// 接口契约：TXT 文案导出模块（§3.6.3）

/** 解说文案段落 */
export interface ScriptParagraph {
  /** 段落唯一 ID */
  id: string;
  /** 关联镜头 ID（可选） */
  shotId?: string;
  /** 文案文本 */
  text: string;
  /** 预估时长（秒） */
  duration?: number;
  /** 情绪标签（可选） */
  emotion?: string;
  /** 是否正在编辑 */
  editing?: boolean;
}

/** TXT 文案导出输入参数 */
export interface TxtExportInput {
  /** 解说文案段落列表 */
  scriptParagraphs: ScriptParagraph[];
  /** 输出文件完整路径（含 .txt 扩展名） */
  outputPath: string;
}
