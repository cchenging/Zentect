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
    const scriptParagraphs =
      ((job.payload as any)?.scriptParagraphs as any[]) ||
      payload.input?.scriptParagraphs ||
      [];

    let result: { filePath: string; fileName: string };
    // 真模块化双通道：优先消费 job.project（统一装配的中间模型），缺失时回退 payload.input（兼容旧调用）
    if (job.project && job.project.shots && job.project.shots.length > 0) {
      // 路径 A：从 ExportProject → CompileShot[] → exportWithShots（避免二次装配）
      const compileShots = JianyingExportService.buildCompileShotsFromExportProject(
        job.project,
        scriptParagraphs,
      );
      // 构建 baseInput：exportJianying 需要 projectId/projectName/mediaPath/outputDir/bgmPath 这些基础字段
      const baseInput: JianyingExportInput = payload.input
        ? { ...payload.input }
        : {
            projectId: job.projectId,
            projectName: job.project.projectName,
            shots: [],
            matchResults: [],
            ttsResults: [],
            scriptParagraphs: scriptParagraphs as any[],
            bgmPath: job.project.bgmPath,
            mediaPath: job.project.mediaPath,
            outputDir: job.project.mediaPath || '',
          };
      // 确保 baseInput 与 ExportProject 最新值对齐（防止 payload.input 是旧数据）
      if (job.project.mediaPath) baseInput.mediaPath = job.project.mediaPath;
      if (job.project.bgmPath) baseInput.bgmPath = job.project.bgmPath;
      if (job.project.projectName) baseInput.projectName = job.project.projectName;
      if (!baseInput.outputDir && baseInput.mediaPath) baseInput.outputDir = baseInput.mediaPath;

      result = JianyingExportService.exportWithShots(
        compileShots,
        baseInput,
        payload.jianyingRoot,
        payload.subtitleStyle,
      );
    } else {
      // 路径 B：兼容回退（遗留调用方只传 payload.input 三件套）
      if (!payload.input) {
        throw new AppError(
          ErrorCode.SYS_INVALID_INPUT,
          '剪映导出失败：既无 ExportProject.project 也无 payload.input，无法装配镜头',
        );
      }
      result = JianyingExportService.export(
        payload.input,
        payload.jianyingRoot,
        undefined,
        payload.subtitleStyle,
      );
    }

    return {
      exporterId: this.id,
      success: true,
      outputPath: result.filePath,
      fileNames: [result.fileName],
    };
  }
}