// 📁 路径：src/modules/export/contracts/ExportJob.ts
// 契约层：导出作业（承载输入载荷 + 进度回调）

import type { ExportProject } from './ExportProject';

/** 进度回调载荷 */
export interface ExportProgress {
  /** 进度百分比 0~100 */
  percent: number;
  /** 当前步骤描述 */
  step: string;
}

/**
 * 导出作业：所有出口统一接收的输入。
 * 通过 `project`（装配好的中间模型）+ `payload`（出口专属原始载荷）双通道承载数据。
 */
export interface ExportJob {
  /** 项目 ID */
  projectId: string;
  /** 项目名称 */
  projectName?: string;
  /** 装配好的中间数据模型（由 ExportAssembler 产出） */
  project?: ExportProject;
  /** 原始载荷（各出口专属字段，如剪映的 jianyingRoot、成片的 exportPath） */
  payload?: Record<string, unknown>;
  /** 进度回调（percent 0~100） */
  onProgress?: (p: ExportProgress) => void;
}