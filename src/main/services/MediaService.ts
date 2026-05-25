// 📁 路径: src/main/services/MediaService.ts
import { MediaRepository } from '../database/repositories/MediaRepository';
import { PathManager } from '../utils/pathManager';
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../shared/utils/LogConstants';
import { MediaItem } from '../../shared/types';
import * as fs from 'fs';
import * as path from 'path';
import { ProjectService } from './ProjectService';
import { VideoProcessor } from '../engine/media/VideoProcessor';
import { DICT } from '../../shared/locales/dictionary';

export class MediaService {
  private repo = new MediaRepository();

  /**
   * 🚀 导入媒体文件到项目
   */
  public async importMedia(projectId: string, filePaths: string[]): Promise<MediaItem[]> {
    const results: MediaItem[] = [];
    const projectService = new ProjectService();

    for (const filePath of filePaths) {
      if (!fs.existsSync(filePath)) {
        AppLogger.warn(LOG_TAGS.MEDIA, `文件不存在，跳过导入: ${filePath}`);
        continue;
      }

      try {
        const mediaId = `media_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const fileName = filePath.split(/[\\/]/).pop() || 'unknown';
        const ext = fileName.split('.').pop()?.toLowerCase() || '';

        let type: MediaItem['type'] = DICT.MEDIA_TYPE.IMAGE as MediaItem['type'];
        if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext)) {
          type = DICT.MEDIA_TYPE.VIDEO as MediaItem['type'];
        } else if (['mp3', 'wav', 'aac', 'flac', 'm4a'].includes(ext)) {
          type = DICT.MEDIA_TYPE.AUDIO as MediaItem['type'];
        }

        let metadata: any = { formattedTime: '00:00:00', duration: 0, width: 0, height: 0, fps: 0 };
        let pureCoverName = '';

        if (type === 'video') {
          metadata = await VideoProcessor.extractMetadata(filePath);
          pureCoverName = await VideoProcessor.generateCover(filePath, PathManager.getProjectThumbnailsDir(projectId), mediaId);
        }

        const relativeCoverPath = pureCoverName ? `thumbnails/${pureCoverName}` : '';
        const mediaItem: MediaItem & { duration: number, width: number, height: number, fps: number } = {
          id: mediaId, projectId, type, name: fileName,
          filePath, coverPath: relativeCoverPath,
          status: 'parsed',
          duration: metadata.duration || 0,
          width: metadata.width || 0, height: metadata.height || 0, fps: metadata.fps || 0
        };

        // 通过仓储层写入
        this.repo.insertMedia(mediaItem);

        // 返回给前端前，组装前端需要的字段
        const frontendMediaItem: MediaItem = {
          id: mediaItem.id, projectId: mediaItem.projectId, name: mediaItem.name, type: mediaItem.type,
          filePath: mediaItem.filePath, coverPath: mediaItem.coverPath, duration: metadata.formattedTime, status: 'parsed'
        };
        results.push(projectService.hydratePaths({ mediaItems: [frontendMediaItem] }, projectId).mediaItems[0]);
      } catch (error) {
        AppLogger.error(LOG_TAGS.MEDIA, `导入媒体失败: ${filePath}`, error);
      }
    }
    return results;
  }

  /**
   * 按项目获取媒体列表
   */
  public async getMediaByProject(projectId: string) {
    return await this.repo.getByProject(projectId);
  }

  /**
   * 删除媒体（包含物理文件）
   */
  public async deleteMedia(projectId: string, mediaId: string) {
    this.repo.deleteMediaById(projectId, mediaId);

    try {
      // 智能清道夫：精准识别带有该 mediaId 的任何散落文件
      const deleteFilesWithId = async (dirPath: string, id: string) => {
        try {
          const files = await fs.promises.readdir(dirPath);
          for (const file of files) {
            if (file.includes(id)) {
              try {
                await fs.promises.unlink(path.join(dirPath, file));
              } catch (e) { }
            }
          }
        } catch (e) { }
      };

      // 清剿封面、音频、台词
      await deleteFilesWithId(PathManager.getProjectThumbnailsDir(projectId), mediaId);
      await deleteFilesWithId(PathManager.getProjectExtractionsDir(projectId, 'audio'), mediaId);
      await deleteFilesWithId(PathManager.getProjectExtractionsDir(projectId, 'whisper'), mediaId);

      // 清剿抽帧和人脸目录
      const framesAbsDir = path.join(PathManager.getProjectExtractionsDir(projectId, 'frames'), mediaId);
      try { await fs.promises.rm(framesAbsDir, { recursive: true, force: true }); } catch (e) { }

      const facesAbsDir = path.join(PathManager.getProjectExtractionsDir(projectId, 'faces'), mediaId);
      try { await fs.promises.rm(facesAbsDir, { recursive: true, force: true }); } catch (e) { }

    } catch (e) {
      AppLogger.error(LOG_TAGS.MEDIA, `清理物理沙盒失败: ${mediaId}`, e);
    }

    return true;
  }
}
