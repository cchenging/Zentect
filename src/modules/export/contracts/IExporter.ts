// 📁 路径：src/modules/export/contracts/IExporter.ts
// 契约层：统一出口接口（所有导出出口共同实现）

import type { ExportJob } from './ExportJob';
import type { ExportResult } from './ExportResult';

/**
 * 统一出口接口：剪映/成片/字幕等所有导出出口共同实现。
 * 新增出口只需：实现本接口 + 在 ExportRegistry 注册一行。
 */
export interface IExporter {
  /** 出口唯一标识（用于注册表索引，如 'jianying' / 'mp4' / 'srt'） */
  readonly id: string;
  /**
   * 校验输入，前置 fail-fast。
   * 不合法时抛 AppError（ErrorCode），不降级、不兜底。
   */
  validate(job: ExportJob): void;
  /** 执行导出，返回统一结果 */
  export(job: ExportJob): Promise<ExportResult>;
}