// 📁 路径: src/main/services/ExportService.ts
import { LocalExporter } from '../engine/export/LocalExporter';
import { JianyingExportService } from '../../modules/export/jianying';
import { SrtExportService } from '../../modules/export/srt';
import { TxtExportService } from '../../modules/export/txt';
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../modules/infra/logger/LogConstants';
import { ProjectRepository } from '../database/repositories/ProjectRepository';

export class ExportService {
  private projectRepo = new ProjectRepository();

  public async exportVideo(payload: any, _sender: Electron.WebContents): Promise<any> {
    void _sender;
    try {
      const result = await this.exportToJianYing(payload);
      return result;
    } catch (error: any) {
      AppLogger.error(LOG_TAGS.EXPORT, '视频编译崩溃', error);
      throw error;
    }
  }

  public async exportToJianYing(payload: any): Promise<any> {
    const { projectId, shots: inputShots, customPath } = payload;

    try {
      let shots = (inputShots && inputShots.length > 0) ? inputShots : null;
      let mediaPath = '';

      if (!shots) {
        const projectData = this.projectRepo.loadFullProjectData(projectId);
        shots = projectData?.shots || [];
        mediaPath = projectData?.mediaItems?.[0]?.filePath || '';
      }

      // 使用新模块 JianyingExportService
      const result = await LocalExporter.exportToJianying(projectId, shots, customPath, mediaPath);
      return { success: true, data: result };
    } catch (error: any) {
      AppLogger.error(LOG_TAGS.EXPORT, '剪映草稿生成失败', error);
      throw error;
    }
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
