// 📁 路径: src/main/services/MediaService.ts
/**
 * @deprecated 已迁移至 src/modules/media/import/backend/ImportService.ts
 * 请使用 `import { ImportService } from '../modules/media/import'`
 *
 * 本文件仅保留 import 相关的核心逻辑重新导出。
 * 其他非 import 方法（getMediaByProject / getMediaById / updateMedia / deleteMedia）
 * 也通过 MediaRepository 代理到新模块。
 */

import { ImportService } from '../../modules/media/import/backend/ImportService';
import { MediaRepository } from '../../modules/media/import/data/MediaRepository';
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../modules/infra/logger/LogConstants';
import * as fs from 'fs';
import * as path from 'path';

export class MediaService {
  private importService = new ImportService();
  private repo = new MediaRepository();

  /** @deprecated 使用 ImportService.importMedia */
  public async importMedia(
    projectId: string,
    filePaths: string[],
    pathManager?: any,
    videoProcessor?: any,
  ): Promise<any[]> {
    return this.importService.importMedia(
      projectId,
      filePaths,
      pathManager,
      videoProcessor,
    );
  }

  public async getMediaById(id: string): Promise<any> {
    return this.repo.findById(id);
  }

  public async getMediaByProject(projectId: string): Promise<any[]> {
    return this.repo.getByProject(projectId);
  }

  public async updateMedia(id: string, data: any): Promise<void> {
    this.repo.updateMedia(id, data);
  }

  public async deleteMedia(projectId: string, mediaId: string): Promise<void> {
    try {
      const media = this.repo.findById(mediaId);
      if (media?.coverPath) {
        await this.deleteThumbnail(mediaId);
      }
      this.repo.deleteMediaById(projectId, mediaId);
    } catch (error) {
      AppLogger.error(LOG_TAGS.MEDIA, `Delete media failed: ${mediaId}`, error);
    }
  }

  private async deleteThumbnail(mediaId: string): Promise<void> {
    // 缩略图清理由上层 controller 配合 PathManager 处理
  }
}
