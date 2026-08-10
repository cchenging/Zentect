// 📁 路径：src/modules/export/mp4/backend/RenderJobFactory.ts
// 渲染作业工厂：构建 FFmpegRenderer.RenderJob
//
// 职责：只负责「渲染作业」的组装（输出路径 / 帧率 / 预览模式 / 字幕），不涉及渲染执行。

import type { ExportProject } from '../../contracts/ExportProject';
import type { RenderJob } from '../../../../main/engine/media/FFmpegRenderer';
import { assembleRenderShots } from './RenderShotsAssembler';

/** 渲染作业工厂输入 */
export interface RenderJobFactoryInput {
  /** 装配好的中间数据模型 */
  project: ExportProject;
  /** 输出目录 */
  outputDir: string;
  /** 输出文件名（不含扩展名） */
  outputName: string;
  /** 字幕文件路径（可选，烧录用） */
  subtitlePath?: string;
}

/**
 * 构建 FFmpegRenderer.RenderJob。
 *
 * 汇总镜头渲染参数（起止时间 / 配音 / 切片 / 变速）、帧率、预览模式与字幕路径。
 *
 * @param input 渲染作业工厂输入
 * @returns FFmpegRenderer.RenderJob
 */
export function buildRenderJob(input: RenderJobFactoryInput): RenderJob {
  const { project, outputDir, outputName, subtitlePath } = input;

  return {
    projectId: project.projectId,
    mediaPath: project.mediaPath || '',
    shots: assembleRenderShots(project),
    bgmPath: project.bgmPath,
    subtitlePath,
    outputDir,
    outputName,
    fps: project.fps,
    preview: project.preview,
  };
}