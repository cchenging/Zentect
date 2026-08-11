// 📁 路径: src/main/services/ExportService.ts
// 导出编排服务：统一分发「剪映草稿导出」与「成片渲染导出」两条出口
//   - exportToJianYing: 生成剪映可编辑草稿（走 JianyingExportService）
//   - exportVideo:      软件内直接合成最终 MP4 成片（走 FFmpegRenderer）
// 真模块化：两条出口共享同一个 ExportProjectAssembler 装配中心（单一装配源），
// 不再各自读取 DB / 手搓镜头装配，避免新增字段时改两处漏一处。
import * as path from 'path';
import { app } from 'electron';
import { SrtExportService } from '../../modules/export/srt';
import { TxtExportService } from '../../modules/export/txt';
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../modules/infra/logger/LogConstants';
import { ProjectRepository } from '../database/repositories/ProjectRepository';
import { SettingsService } from './SettingsService';
import { AppError, ErrorCode } from '../../modules/infra/error/AppError';
import type { JianyingExportInput } from '../../modules/export/jianying/types';
import type { JianyingExportPayload } from '../../modules/export/jianying/backend/JianyingExporter';
import type { ExportJob } from '../../modules/export/contracts/ExportJob';
import { buildExportRegistry } from '../../modules/export/createExportRegistry';
import type { Mp4ExportInput } from '../../modules/export/mp4/types';
import { IPC_CHANNELS } from '../../modules/infra/ipc/IpcConstants';
import type { WebContents } from 'electron';
import { dehydrateMagicPath } from '../engine/utils/pathUtils';
import {
  assembleExportProjectSync,
  type AssembleExportProjectOptions,
} from '../../modules/export/backend/ExportProjectAssembler';

export class ExportService {
  private projectRepo = new ProjectRepository();
  private settingsService = new SettingsService();

  /**
   * 向触发导出的渲染窗口推送导出进度（EXPORT_PROGRESS 通道）。
   *
   * @param sender    触发导出的 WebContents
   * @param projectId 项目 ID（前端按此过滤并发任务的进度）
   * @param percent   进度百分比 0~100
   * @param step      当前步骤描述
   */
  private pushProgress(sender: WebContents | undefined, projectId: string, percent: number, step: string): void {
    if (!sender || sender.isDestroyed()) return;
    sender.send(IPC_CHANNELS.EXPORT_PROGRESS, { projectId, percent, step });
  }

  /** 渲染最终成片（MP4） */
  public async exportVideo(payload: any, sender: Electron.WebContents): Promise<any> {
    const { projectId, projectName, ratio, resolution, fps, preview, exportPath, subtitleMode, exportRange, selectedShotIds } = payload;
    try {
      if (!projectId) throw new AppError(ErrorCode.SYS_INVALID_INPUT, '缺少 projectId');

      // 真模块化：统一装配（DB读取 + 镜头 + BGM + 字幕样式 + S8 过滤）全部在一处完成
      const assemblerOptions: AssembleExportProjectOptions = {
        exportRange: exportRange || 'all',
        selectedShotIds,
        includeSubtitleStyle: true,
      };
      const assembled = assembleExportProjectSync(projectId, assemblerOptions, {
        projectRepo: this.projectRepo,
        settingsService: this.settingsService,
        dehydratePath: dehydrateMagicPath,
      });
      const project = assembled.project;
      // 成片专属画面参数：覆盖装配器的默认空值
      if (ratio !== undefined) project.ratio = ratio;
      if (resolution !== undefined) project.resolution = resolution;
      if (fps !== undefined) project.fps = fps;
      if (preview !== undefined) project.preview = preview;
      // projectName 优先级：前端传入 > DB 项目名
      if (projectName && !project.projectName) project.projectName = projectName;

      const mp4Payload: Mp4ExportInput = {
        projectId,
        projectName: projectName || project.projectName,
        ratio,
        resolution,
        fps,
        preview,
        exportPath,
        subtitleMode,
      };
      const job: ExportJob = {
        projectId,
        projectName: project.projectName,
        project,
        payload: mp4Payload as unknown as Record<string, unknown>,
        // 进度桥接：FFmpeg 渲染进度 → 主进程 → EXPORT_PROGRESS 通道
        onProgress: (p) => this.pushProgress(sender, projectId, p.percent, p.step),
      };

      const registry = buildExportRegistry();
      const exporter = registry.get('mp4');
      exporter.validate(job);
      const result = await exporter.export(job);

      if (!result.success) {
        throw new AppError(ErrorCode.FS_WRITE_ERROR, `成片渲染失败：${result.error || '未知错误'}`);
      }
      AppLogger.info(LOG_TAGS.EXPORT, `成片导出成功: ${result.outputPath}`, { format: payload.format });
      return { success: true, data: { outputPath: result.outputPath, duration: result.duration } };
    } catch (error: any) {
      AppLogger.error(LOG_TAGS.EXPORT, '视频编译崩溃', error);
      throw error;
    }
  }

  /** 导出剪映可编辑草稿 */
  public async exportToJianYing(payload: any, sender: Electron.WebContents): Promise<any> {
    const { projectId, customPath, exportRange, selectedShotIds } = payload;
    try {
      if (!projectId) throw new AppError(ErrorCode.SYS_INVALID_INPUT, '缺少 projectId');

      // 真模块化：统一装配（DB读取 + 镜头 + BGM + 字幕样式 + S8 过滤）一处完成
      // 剪映端需要 scriptParagraphs/shots/matchResults/ttsResults 额外字段 → 走 extras 透传
      const assemblerOptions: AssembleExportProjectOptions = {
        exportRange: exportRange || 'all',
        selectedShotIds,
        includeSubtitleStyle: true,
        extraPayloadFields: ['scriptParagraphs', 'shots', 'matchResults', 'ttsResults'],
      };
      const assembled = assembleExportProjectSync(projectId, assemblerOptions, {
        projectRepo: this.projectRepo,
        settingsService: this.settingsService,
        dehydratePath: dehydrateMagicPath,
      });
      const { project, extras } = assembled;

      // S8 范围过滤已在装配器中完成（project.shots 即为 scopedShots），这里直接用
      if (exportRange === 'selected') {
        AppLogger.info(
          LOG_TAGS.EXPORT,
          `剪映导出 S8 生效：选中 ${project.shots.length} 段（共请求 ${(selectedShotIds || []).length} 个 id）`,
          { exportRange, selectedShotIds: selectedShotIds || [] },
        );
      }

      // 剪映端兼容：按 JianyingExportInput 格式重组（scriptParagraphs 仍从 extras 取，保持剪映字幕段落 s_xx 粒度）
      const input: JianyingExportInput = {
        projectId,
        projectName: project.projectName,
        shots: (extras.shots || []) as any[],
        // S8 范围过滤：matchResults/ttsResults/scriptParagraphs 按装配器已过滤的 shotId 集合二次裁剪
        matchResults: filterBySelectedShotIds(
          (extras.matchResults || []) as any[],
          project.shots.map((s) => s.id),
          'shotId',
        ),
        ttsResults: filterBySelectedShotIds(
          (extras.ttsResults || []) as any[],
          project.shots.map((s) => s.id),
          'shotId',
        ),
        scriptParagraphs: filterBySelectedShotIds(
          (extras.scriptParagraphs || []) as any[],
          project.shots.map((s) => s.id),
          'shotId',
          'id',
        ),
        bgmPath: project.bgmPath,
        mediaPath: project.mediaPath,
        outputDir: project.mediaPath || '',
      };

      const jianyingRoot = this.resolveJianyingRoot(customPath);
      // 字幕样式从统一装配器取（与成片端同一份，避免分叉读取）
      const subtitleStyle = project.subtitleStyle as any;
      if (subtitleStyle && project.bgmPath) {
        AppLogger.info(LOG_TAGS.EXPORT, `剪映导出: 检测到分离 BGM 轨道`, { bgmPath: project.bgmPath });
      }

      const jyPayload: JianyingExportPayload = { input, jianyingRoot, subtitleStyle };
      const job: ExportJob = {
        projectId,
        projectName: input.projectName,
        project,                                    // 双通道契约落地：剪映端 job.project 首次赋值！
        payload: jyPayload as unknown as Record<string, unknown>,
        // 进度桥接：剪映写盘为同步快速路径，直接推送完成态
        onProgress: (p) => this.pushProgress(sender, projectId, p.percent, p.step),
      };
      const registry = buildExportRegistry();
      const exporter = registry.get('jianying');
      exporter.validate(job);
      const result = await exporter.export(job);
      AppLogger.info(LOG_TAGS.EXPORT, `剪映草稿生成成功: ${result.outputPath}`);
      return { success: true, data: result };
    } catch (error: any) {
      AppLogger.error(LOG_TAGS.EXPORT, '剪映草稿生成失败', error);
      throw error;
    }
  }

  /**
   * 解析剪映草稿根目录：优先调用方指定路径，其次配置的 jianyingPath，最后默认安装目录
   */
  private resolveJianyingRoot(customPath?: string): string {
    if (customPath && customPath.trim() !== '') return customPath;
    // 设置界面保存的键为 jianyingPath（历史别名 jianyingDraftPath 兼容）
    const configured =
      this.settingsService.getByKey('jianyingPath') ||
      this.settingsService.getByKey('jianyingDraftPath');
    if (configured && configured.trim() !== '') return configured;
    return path.join(
      app.getPath('home'),
      'AppData/Local/JianyingPro/User Data/Projects/com.lveditor.draft',
    );
  }

  /**
   * 导出 SRT 字幕
   */
  public async exportSrt(payload: {
    asrLines: Array<{ start: string; end?: string; text: string; originalText?: string }>;
    outputPath: string;
  }): Promise<{ success: boolean; filePath: string }> {
    try {
      const filePath = SrtExportService.export(payload);
      AppLogger.info(LOG_TAGS.EXPORT, 'SRT 字幕导出成功', { filePath });
      return { success: true, filePath };
    } catch (error: any) {
      AppLogger.error(LOG_TAGS.EXPORT, 'SRT 字幕导出失败', error);
      throw error;
    }
  }

  /**
   * 导出 TXT 文案
   */
  public async exportTxt(payload: {
    scriptParagraphs: Array<{ id: string; shotId?: string; text: string; duration?: number; emotion?: string }>;
    outputPath: string;
  }): Promise<{ success: boolean; filePath: string }> {
    try {
      const filePath = TxtExportService.export({
        scriptParagraphs: payload.scriptParagraphs.map((p: any) => ({ ...p, editing: false })),
        outputPath: payload.outputPath,
      });
      AppLogger.info(LOG_TAGS.EXPORT, 'TXT 文案导出成功', { filePath });
      return { success: true, filePath };
    } catch (error: any) {
      AppLogger.error(LOG_TAGS.EXPORT, 'TXT 文案导出失败', error);
      throw error;
    }
  }
}

/**
 * S8 辅助：按选中的 shotId 集合，对 extras 里的原始数组（matchResults/ttsResults/scriptParagraphs）做二次过滤。
 *
 * 说明：ExportProjectAssembler 已按 shotId 过滤出 ExportShot[]，但 extras 里透传的 matchResults/ttsResults/scriptParagraphs
 * 是 DB 原始数组（未过滤），剪映端 JianyingExportInput 需要这些结构按同一 S8 范围对齐，否则会出现
 * "实际只有 3 段视频片段，但 scriptParagraphs 仍有 26 段 s_xx → 字幕轨道多 23 段空素材" 的问题。
 *
 * @param list        原始 extras 数组（matchResults/ttsResults/scriptParagraphs）
 * @param selectedIds 装配器已过滤的选中 shotId 集合（白名单）
 * @param primaryKey  list[i][primaryKey] 与 selectedIds 对齐的主键名（matchResults/ttsResults 用 'shotId'）
 * @param fallbackKey 若 primaryKey 取不到时的回退键（scriptParagraphs 的 'shotId' 可能空，用 'id' 兜底，需传两键）
 */
function filterBySelectedShotIds<T extends Record<string, any>>(
  list: T[],
  selectedIds: string[],
  primaryKey: string,
  fallbackKey?: string,
): T[] {
  if (!list || list.length === 0) return [];
  const selected = new Set(selectedIds || []);
  // selectedIds 空：说明是 'all' 范围（装配器未裁剪）→ 原样返回，不做过滤
  if (selected.size === 0) return list;
  return list.filter((item) => {
    const id1 = item?.[primaryKey];
    if (typeof id1 === 'string' && selected.has(id1)) return true;
    if (fallbackKey) {
      const id2 = item?.[fallbackKey];
      if (typeof id2 === 'string' && selected.has(id2)) return true;
    }
    return false;
  });
}

/**
 * 按导出范围过滤待渲染镜头。
 *
 * - 范围非 'selected'（全部）时原样返回
 * - 范围 'selected' 时仅保留 ids 命中的镜头；若没有任何命中则抛错，避免静默降级为全部
 *
 * @param shots          装配好的中间镜头数组
 * @param exportRange    导出范围：'all' | 'selected'
 * @param selectedShotIds 选中片段的镜头 id 列表
 * @returns 过滤后的镜头数组
 */
export function applyExportRange<T extends { id: string }>(
  shots: T[],
  exportRange?: string,
  selectedShotIds?: string[],
): T[] {
  if (exportRange !== 'selected') return shots;
  const selected = new Set(selectedShotIds || []);
  const filtered = shots.filter((s) => selected.has(s.id));
  if (filtered.length === 0) {
    throw new AppError(ErrorCode.SYS_INVALID_INPUT, '选中的片段未匹配到可导出的镜头，请重新选中');
  }
  return filtered;
}