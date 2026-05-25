// 📁 路径: src/main/controllers/MediaController.ts
import { dialog } from 'electron';
import * as path from 'path';
import { IpcRouter } from '../core/IpcRouter'; // 💥 重构：使用新的 IpcRouter
import { JobScheduler } from '../core/JobScheduler';
import { IPC_CHANNELS } from '../../shared/utils/IpcConstants';
import { AppError, ErrorCode } from '../../shared/utils/AppError';
import { ALL_MEDIA_EXTENSIONS } from '../../shared/locales/dictionary';
import { MediaService } from '../services/MediaService'; // 💥 重构：使用 MediaService

export class MediaController {
  private mediaService = new MediaService();

  public register() {
    IpcRouter.handle(IPC_CHANNELS.MEDIA_IMPORT, async (_, projectId: string, filePaths: string[]) => {
      if (!projectId) {
        throw new AppError(ErrorCode.FS_PATH_INVALID, 'Project ID is required');
      }

      if (!filePaths || filePaths.length === 0) {
        const { canceled, filePaths: selectedPaths } = await dialog.showOpenDialog({
          title: '导入媒体素材',
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: 'Media Files', extensions: [...ALL_MEDIA_EXTENSIONS] }]
        });
        if (canceled || selectedPaths.length === 0) {
          return [];
        }
        filePaths = selectedPaths;
      }

      const newMediaItems = await this.mediaService.importMedia(projectId, filePaths);

      // 补全封面字段一致性
      if (Array.isArray(newMediaItems)) {
        return newMediaItems.map(m => {
          const obj = JSON.parse(JSON.stringify(m));
          if (obj.coverPath && !obj.cover) obj.cover = obj.coverPath;
          if (obj.cover && !obj.coverPath) obj.coverPath = obj.cover;
          return obj;
        });
      }
      return newMediaItems;
    });

    IpcRouter.handle(IPC_CHANNELS.MEDIA_PROCESS, async (_, projectId: string, activeMedia: any, config: any) => {
      if (!activeMedia || !activeMedia.filePath) {
        throw new AppError(ErrorCode.FS_FILE_NOT_FOUND, 'Invalid media file path');
      }
      const scheduler = JobScheduler.getInstance();
      scheduler.addExtractionJob(projectId, activeMedia.id, activeMedia.filePath, config);
      return { success: true };
    });

    IpcRouter.handle(IPC_CHANNELS.MEDIA_CANCEL, async (_, mediaId: string) => {
      const scheduler = JobScheduler.getInstance();
      scheduler.cancelJob(mediaId);
      return { success: true };
    });

    IpcRouter.handle(IPC_CHANNELS.MEDIA_DELETE, async (_, projectId: string, mediaId: string) => {
      if (!projectId || !mediaId) {
        throw new AppError(ErrorCode.FS_PATH_INVALID, 'Project ID and Media ID are required');
      }
      const success = await this.mediaService.deleteMedia(projectId, mediaId);
      return { success };
    });

    IpcRouter.handle(IPC_CHANNELS.MEDIA_GET_BY_PROJECT, async (_, projectId: string) => {
      if (!projectId) {
        throw new AppError(ErrorCode.FS_PATH_INVALID, 'Project ID is required');
      }
      
      const medias = await this.mediaService.getMediaByProject(projectId);

      const mappedMedias = medias.map(m => {
        const obj = JSON.parse(JSON.stringify(m));
        const rawCover = obj.cover || obj.coverPath || '';
        
        if (rawCover) {
          if (!/^magic:\/\//i.test(rawCover) && !/^(https?:\/\/|file:\/\/|data:image)/i.test(rawCover) && !path.isAbsolute(rawCover)) {
            const fileName = rawCover.includes('/') || rawCover.includes('\\')
              ? rawCover.replace(/^thumbnails\//i, '')
              : rawCover;
            obj.cover = `magic://${projectId}/thumbnails/${fileName}`;
            obj.coverPath = obj.cover;
          } else if (!/^magic:\/\//i.test(rawCover)) {
            obj.cover = rawCover;
            obj.coverPath = rawCover;
          }
        }
        return obj;
      });

      return { success: true, data: mappedMedias };
    });
  }
}
