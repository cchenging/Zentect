// 📁 路径：src/modules/export/mp4/backend/Mp4Exporter.ts
// 成片导出器：实现 IExporter，编排字幕装配 + 渲染作业构建 + FFmpeg 渲染
//
// 职责：只做编排，不实现格式细节。字幕由 SubtitleAssembler 生成，渲染由 FFmpegRenderer 执行。

import * as path from 'path';
import type { IExporter } from '../../contracts/IExporter';
import type { ExportJob } from '../../contracts/ExportJob';
import type { ExportResult } from '../../contracts/ExportResult';
import { AppError, ErrorCode } from '@modules/infra/error/AppError';
import { FFmpegRenderer } from '../../../../main/engine/media/FFmpegRenderer';
import { writeSrtFile, writeAssFile } from './SubtitleAssembler';
import { buildRenderJob } from './RenderJobFactory';
import type { Mp4ExportInput } from '../types';

/** 清理输出文件名中的非法字符 */
function sanitizeName(name: string): string {
  return (name || '成片').replace(/[\\/:*?"<>|]/g, '_');
}

/**
 * 成片导出器：ExportProject → SRT（可选）→ 渲染作业 → FFmpeg MP4。
 *
 * 实现契约层 IExporter，支持帧率 / 预览模式 / 字幕烧录三态。
 */
export class Mp4Exporter implements IExporter {
  readonly id = 'mp4';

  /** 校验输入，前置 fail-fast */
  validate(job: ExportJob): void {
    if (!job || !job.projectId) {
      throw new AppError(ErrorCode.SYS_INVALID_INPUT, '缺少 projectId');
    }
    if (!job.project) {
      throw new AppError(ErrorCode.SYS_INVALID_INPUT, '成片导出缺少中间数据模型 project');
    }
    if (!job.project.mediaPath) {
      throw new AppError(ErrorCode.FS_FILE_NOT_FOUND, '未找到源视频，成片渲染中止');
    }
  }

  /** 执行成片导出 */
  async export(job: ExportJob): Promise<ExportResult> {
    this.validate(job);
    const project = job.project!;
    const payload = (job.payload || {}) as unknown as Mp4ExportInput;

    // 输出目录：优先 payload.exportPath，其次 project 提供的目录
    const safeName = sanitizeName(project.projectName);
    const outDir = payload.exportPath
      ? path.join(payload.exportPath, safeName)
      : path.dirname(project.mediaPath || '');
    const outputName = `${safeName}_${Date.now()}`;

    // 字幕四态：仅烧录 / 仅字幕文件 / 两者
    const subtitleMode = payload.subtitleMode || 'none';
    const needSrt = subtitleMode === 'burn' || subtitleMode === 'file' || subtitleMode === 'both';
    const needBurn = subtitleMode === 'burn' || subtitleMode === 'both';

    // 烧录用 ASS（应用共享 subtitleStyle，样式可控）；附字幕文件用 SRT（通用格式）
    // subtitleStyle 在 ExportProject 中定义为 Record<string, unknown>（跨出口通用），
    // 真实结构是 SettingsService.getSubtitleStyle() 产出的 SubtitleStyle，结构完整，此处强转无风险。
    const subtitleStyle = (project.subtitleStyle || {}) as unknown as import('../../jianying/types').SubtitleStyle;

    let subtitleBurnPath: string | undefined;
    let subtitleFileResult: string | undefined;
    if (needSrt) {
      // 烧录路径：有样式时用 ASS 保证外观，否则退回 SRT
      subtitleBurnPath = writeAssFile(project, subtitleStyle, outDir, outputName);
      // 附字幕文件：始终用通用 SRT
      if (subtitleMode === 'file' || subtitleMode === 'both') {
        subtitleFileResult = writeSrtFile(project, outDir, outputName);
      }
    }

    // 构建渲染作业（帧率 / 预览模式随 payload 透传）
    const renderJob = buildRenderJob({
      project: { ...project, fps: payload.fps, preview: payload.preview },
      outputDir: outDir,
      outputName,
      subtitlePath: needBurn ? subtitleBurnPath : undefined,
    });

    // 进度回调桥接：FFmpegRenderer 的 RenderProgress → 契约层 ExportProgress
    renderJob.onProgress = (p) => {
      job.onProgress?.({ percent: p.percent, step: p.step });
    };

    const renderer = new FFmpegRenderer();
    const result = await renderer.render(renderJob);

    if (!result.success) {
      return {
        exporterId: this.id,
        success: false,
        outputPath: result.outputPath,
        error: `成片渲染失败：${result.error || '未知错误'}`,
      };
    }

    return {
      exporterId: this.id,
      success: true,
      outputPath: result.outputPath,
      fileNames: subtitleFileResult ? [path.basename(result.outputPath), path.basename(subtitleFileResult)] : [path.basename(result.outputPath)],
      duration: result.duration,
    };
  }
}