// 📁 路径: src/main/services/ExportService.ts
// 导出编排服务：统一分发「剪映草稿导出」与「成片渲染导出」两条出口
//   - exportToJianYing: 生成剪映可编辑草稿（走 JianyingExportService）
//   - exportVideo:      软件内直接合成最终 MP4 成片（走 FFmpegRenderer）
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
import type { ExportProject } from '../../modules/export/contracts/ExportProject';
import { buildExportRegistry } from '../../modules/export/createExportRegistry';
import type { Mp4ExportInput } from '../../modules/export/mp4/types';
import { IPC_CHANNELS } from '../../modules/infra/ipc/IpcConstants';
import type { WebContents } from 'electron';
import { dehydrateMagicPath } from '../engine/utils/pathUtils';

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
      const projectData: any = this.projectRepo.loadFullProjectData(projectId);
      if (!projectData) throw new AppError(ErrorCode.DB_RECORD_NOT_FOUND, '项目数据不存在');

      const matchResults = projectData.matchResults || [];
      const ttsResults = projectData.ttsResults || [];
      const mediaItem = Array.isArray(projectData.mediaItems)
        ? projectData.mediaItems[0]
        : undefined;
      const sourceVideoPath = mediaItem?.filePath || '';
      if (!sourceVideoPath) throw new AppError(ErrorCode.FS_FILE_NOT_FOUND, '未找到源视频，成片渲染中止');

      // 配音路径按 shotId 关联，magic:// 路径脱水为物理路径
      const ttsByShotId = new Map<string, any>(
        (ttsResults || []).map((t: any) => [t.shotId, t]),
      );

      // 逐镜头装配中间模型（视频切片 + 变速 + 配音）
      const shots = (matchResults || []).map((m: any) => {
        const chunk = m?.chunkData || null;
        const startMs = chunk?.startMs ?? m?.videoTimelineStartMs ?? 0;
        const endMs = chunk?.endMs ?? m?.videoTimelineEndMs ?? startMs + (m?.audioDurationMs ?? 3000);
        const tts = ttsByShotId.get(m.shotId);
        let audioPath: string | undefined;
        if (tts?.audioUrl && !tts._failed) {
          audioPath = dehydrateMagicPath(tts.audioUrl).replace('file://', '');
        }
        return {
          id: m.shotId,
          // 透传文案，供成片字幕烧录/字幕文件装配使用
          text: m.text,
          aiText: m.aiText,
          start: startMs / 1000,
          end: endMs / 1000,
          audioPath,
          chunkData: chunk,
          appliedSpeedFactor: m.appliedSpeedFactor,
        };
      });

      // 导出范围：选中片段时仅保留选中的镜头，无匹配则 fail-fast（不静默降级为全部）
      const scopedShots = applyExportRange(shots, exportRange, selectedShotIds);

      // 背景音乐（分离出的 BGM 轨）
      const bgmItem = (projectData.mediaItems || []).find(
        (mi: any) => mi.type === 'audio' && mi.extractedBgm,
      );
      const bgmPath = bgmItem?.extractedBgm || projectData.activeBgm || undefined;

      // 装配统一的中间数据模型，走「成片导出出口」
      const project: ExportProject = {
        projectId,
        projectName: projectName || projectData.name || '',
        mediaPath: sourceVideoPath,
        bgmPath,
        shots: scopedShots,
        ratio,
        resolution,
        fps,
        preview,
        // 透传共享字幕样式，供成片烧录 ASS 使用
        subtitleStyle: this.settingsService.getSubtitleStyle() as unknown as Record<string, unknown>,
      };
      const mp4Payload: Mp4ExportInput = { projectId, projectName, ratio, resolution, fps, preview, exportPath, subtitleMode };
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
    const { projectId, customPath } = payload;
    try {
      if (!projectId) throw new AppError(ErrorCode.SYS_INVALID_INPUT, '缺少 projectId');
      const projectData: any = this.projectRepo.loadFullProjectData(projectId);
      if (!projectData) throw new AppError(ErrorCode.DB_RECORD_NOT_FOUND, '项目数据不存在');

      const mediaPath =
        Array.isArray(projectData.mediaItems) && projectData.mediaItems[0]
          ? projectData.mediaItems[0].filePath || ''
          : '';

      // 背景音乐（分离出的 BGM 轨）
      const bgmItem = (projectData.mediaItems || []).find(
        (mi: any) => mi.type === 'audio' && mi.extractedBgm,
      );
      const bgmPath = bgmItem?.extractedBgm || projectData.activeBgm || undefined;
      if (bgmPath) {
        AppLogger.info(LOG_TAGS.EXPORT, `剪映导出: 检测到分离 BGM 轨道`, { bgmPath });
      }

      // 组装剪映导出输入（主数据源：scriptParagraphs 解说文案 s_xx；matchResults/ttsResults 按 shotId 补充切片与配音）
      const input: JianyingExportInput = {
        projectId,
        projectName: projectData.name || projectData.projectName || '',
        shots: projectData.shots || [],
        matchResults: projectData.matchResults || [],
        ttsResults: projectData.ttsResults || [],
        scriptParagraphs: projectData.scriptParagraphs || [],
        bgmPath,
        mediaPath,
        outputDir: mediaPath,
      };

      const jianyingRoot = this.resolveJianyingRoot(customPath);
      // 读取剪映字幕样式（缺省用默认样式）
      const subtitleStyle = this.settingsService.getSubtitleStyle();
      // 走「剪映导出出口」：payload 承载专属输入，registry 统一编排
      const jyPayload: JianyingExportPayload = { input, jianyingRoot, subtitleStyle };
      const job: ExportJob = {
        projectId,
        projectName: input.projectName,
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