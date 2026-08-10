// 📁 路径：src/modules/export/jianying/backend/JianyingExporter.ts
// 剪映导出出口适配器：实现契约层 IExporter，供 ExportRegistry 统一编排。
//
// 职责：只做「ExportJob → 剪映导出」的桥接，不实现格式细节。
// 具体格式逻辑委托给 core（validateInput / buildCompileShots / exportJianying）。
// 设计原则：错就错、不降级、不兜底；validate 前置 fail-fast。

import type { IExporter } from '../../contracts/IExporter';
import type { ExportJob } from '../../contracts/ExportJob';
import type { ExportResult } from '../../contracts/ExportResult';
import type { JianyingExportInput, SubtitleStyle } from '../types';
import { AppError, ErrorCode } from '@modules/infra/error/AppError';
import { validateInput } from './core/JianyingExporter';
import { JianyingExportService } from './Service';

/** 剪映导出出口的专属载荷（经 ExportJob.payload 透传） */
export interface JianyingExportPayload {
  /** 剪映导出输入（scriptParagraphs / matchResults / ttsResults / mediaPath / bgmPath 等） */
  input: JianyingExportInput;
  /** 剪映草稿根目录 */
  jianyingRoot: string;
  /** 字幕样式（可选，缺省用默认样式） */
  subtitleStyle?: SubtitleStyle;
}

/**
 * 剪映导出出口：实现 IExporter，桥接契约层 ExportJob 与剪映导出主流程。
 *
 * 新增出口只需实现 IExporter + 在 ExportRegistry 注册一行，编排层无感知。
 */
export class JianyingExporter implements IExporter {
  readonly id = 'jianying';

  /** 校验输入，前置 fail-fast */
  validate(job: ExportJob): void {
    if (!job || !job.projectId) {
      throw new AppError(ErrorCode.SYS_INVALID_INPUT, '缺少 projectId');
    }
    const payload = (job.payload || {}) as Partial<JianyingExportPayload>;
    if (!payload.input) {
      throw new AppError(ErrorCode.SYS_INVALID_INPUT, '剪映导出缺少 input 载荷');
    }
    validateInput(payload.input, payload.jianyingRoot || '');
  }

  /** 执行剪映草稿导出，返回统一结果 */
  async export(job: ExportJob): Promise<ExportResult> {
    this.validate(job);
    const payload = (job.payload || {}) as unknown as JianyingExportPayload;
    // 委托 Service.export：内部已完成「三源重组编译镜头 → 批量 ffprobe 探针 → 素材/轨道装配 → 写盘」完整闭环
    const result = JianyingExportService.export(
      payload.input,
      payload.jianyingRoot,
      undefined, // ffmpegPath：封面生成预留，当前 Service 层未使用（void 忽略）
      payload.subtitleStyle,
    );
    return {
      exporterId: this.id,
      success: true,
      outputPath: result.filePath,
      fileNames: [result.fileName],
    };
  }
}