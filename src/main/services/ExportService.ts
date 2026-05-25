// 📁 新建文件: src/main/services/ExportService.ts
import { LocalExporter } from '../engine/export/LocalExporter';
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../shared/utils/LogConstants';
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
      // 从 DB 获取 shots 和媒体路径（前端可能未传完整数据）
      let shots = (inputShots && inputShots.length > 0) ? inputShots : null;
      let mediaPath = '';

      if (!shots) {
        const projectData = this.projectRepo.loadFullProjectData(projectId);
        shots = projectData?.shots || [];
        mediaPath = projectData?.mediaItems?.[0]?.filePath || '';
      }

      const result = await LocalExporter.exportToJianying(projectId, shots, customPath, mediaPath);
      return { success: true, data: result };
    } catch (error: any) {
      AppLogger.error(LOG_TAGS.EXPORT, '剪映草稿生成失败', error);
      throw error;
    }
  }
}
