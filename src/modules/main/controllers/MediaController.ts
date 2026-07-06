// 📁 路径: src/main/controllers/MediaController.ts
import { dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { IpcRouter } from '../core/IpcRouter';
import { JobScheduler } from '../core/JobScheduler';
import { IPC_CHANNELS } from '../../shared/utils/IpcConstants';
import { AppError, ErrorCode } from '../../infra/error/AppError';
import { ALL_MEDIA_EXTENSIONS } from '../../infra/i18n/dictionary';
import { MediaService } from '../services/MediaService';
import { PathManager } from '../utils/pathManager';
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../infra/logger/LogConstants';
import { VideoProcessor } from '../engine/media/VideoProcessor';
// @deprecated 抽帧功能已迁移至 src/modules/media/frames/，此 import 保留兼容
import type { FrameStrategy } from '../../modules/media/frames';

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

    IpcRouter.handle(IPC_CHANNELS.MEDIA_UPDATE, async (_, mediaId: string, data: any) => {
      if (!mediaId) {
        throw new AppError(ErrorCode.FS_PATH_INVALID, 'Media ID is required');
      }
      await this.mediaService.updateMedia(mediaId, data);
      return { success: true };
    });

    IpcRouter.handle(IPC_CHANNELS.MEDIA_PROCESS, async (_, projectId: string, activeMedia: any, config: any) => {
      if (!activeMedia || !activeMedia.filePath) {
        throw new AppError(ErrorCode.FS_FILE_NOT_FOUND, 'Invalid media file path');
      }
      /** 将 magic:// URL 还原为物理绝对路径，FFmpeg 无法识别 magic:// 协议 */
      let physicalPath = activeMedia.filePath;
      const projectDir = PathManager.getProjectDir(projectId);
      if (physicalPath.startsWith('magic://')) {
        const prefix = `magic://${projectId}/`;
        if (physicalPath.startsWith(prefix)) {
          /** 项目内相对路径：magic://{projectId}/videos/xxx.mp4 → videos/xxx.mp4 */
          const relativePath = physicalPath.replace(prefix, '');
          physicalPath = path.isAbsolute(relativePath) ? relativePath : path.join(projectDir, relativePath);
        } else if (physicalPath.startsWith('magic://local/')) {
          /** 跨盘符绝对路径：magic://local/F:/Videos/test.mp4 → F:\Videos\test.mp4 */
          physicalPath = physicalPath.replace('magic://local/', '').replace(/\//g, '\\');
        } else {
          /** 兜底：无法识别的 magic:// 格式，拼接项目目录 */
          physicalPath = path.join(projectDir, physicalPath.replace(/^magic:\/\/[^/]+\//, ''));
        }
        AppLogger.info(LOG_TAGS.MEDIA_ENGINE, '[MediaController] magic:// 路径脱水完成', { original: activeMedia.filePath, physicalPath });
      }
      const scheduler = JobScheduler.getInstance();
      scheduler.addExtractionJob(projectId, activeMedia.id, physicalPath, config);
      return { success: true };
    });

    /**
     * 轻量抽帧通道：只执行抽帧，不跑全管线
     * 用于前端"开始提取"按钮的即时反馈闭环
     */
    IpcRouter.handle(IPC_CHANNELS.MEDIA_EXTRACT_FRAMES, async (_, payload: {
      mediaId: string; projectId: string; strategy: string; fps: number;
      sceneThreshold: number; scale: number; quality: number; minFrameInterval?: number; timePoint?: number;
    }) => {
      const { mediaId, projectId, strategy, fps, sceneThreshold, scale, quality, minFrameInterval, timePoint } = payload;
      if (!mediaId || !projectId) {
        throw new AppError(ErrorCode.FS_PATH_INVALID, 'mediaId 和 projectId 必填');
      }

      /** 从 DB 获取媒体信息 */
      const mediaItem = await this.mediaService.getMediaById(mediaId);
      if (!mediaItem) {
        throw new AppError(ErrorCode.FS_FILE_NOT_FOUND, `媒体资产不存在: ${mediaId}`);
      }

      /** magic:// 路径脱水 */
      let physicalPath = mediaItem.filePath || '';
      const projectDir = PathManager.getProjectDir(projectId);
      if (physicalPath.startsWith('magic://')) {
        const prefix = `magic://${projectId}/`;
        if (physicalPath.startsWith(prefix)) {
          const relativePath = physicalPath.replace(prefix, '');
          physicalPath = path.isAbsolute(relativePath) ? relativePath : path.join(projectDir, relativePath);
        } else if (physicalPath.startsWith('magic://local/')) {
          physicalPath = physicalPath.replace('magic://local/', '').replace(/\//g, '\\');
        } else {
          physicalPath = path.join(projectDir, physicalPath.replace(/^magic:\/\/[^/]+\//, ''));
        }
      }

      if (!fs.existsSync(physicalPath)) {
        throw new AppError(ErrorCode.FS_FILE_NOT_FOUND, `物理文件不存在: ${physicalPath}`);
      }

      /** 构建输出目录：统一走 PathManager 标准路径，确保与全管线一致 */
      const framesDir = path.join(PathManager.getProjectExtractionsDir(projectId, 'frames'), mediaId);
      if (!fs.existsSync(framesDir)) {
        fs.mkdirSync(framesDir, { recursive: true });
      }

      /** 策略名映射：前端小写 → 后端大写 */
      const STRATEGY_MAP: Record<string, FrameStrategy> = {
        'vlm_optimized': 'VLM_OPTIMIZED', 'VLM_OPTIMIZED': 'VLM_OPTIMIZED',
        'uniform': 'UNIFORM_FPS', 'UNIFORM_FPS': 'UNIFORM_FPS',
        'scene': 'VLM_OPTIMIZED',
        'iframe': 'FAST_KEYFRAME', 'FAST_KEYFRAME': 'FAST_KEYFRAME',
        'precise_single': 'PRECISE_SINGLE', 'PRECISE_SINGLE': 'PRECISE_SINGLE',
      };
      const resolvedStrategy = STRATEGY_MAP[strategy] || 'VLM_OPTIMIZED';

      /** 调用 VideoProcessor 轻量抽帧 */
      const telemetry = await VideoProcessor.extractFrames(physicalPath, framesDir, mediaId, {
        strategy: resolvedStrategy,
        fps: fps || 2,
        sceneThreshold: sceneThreshold || 0.28,
        minFrameInterval: minFrameInterval || 4,
        scale: scale ?? 1024,
        quality: quality || 3,
        timePoint,
      });

      /** 结果写 DB — 帧路径转为 magic:// 协议 */
      const framePaths = telemetry.files || [];
      const magicFramePaths = framePaths.map((p: string) => {
        const relative = path.relative(projectDir, p).replace(/\\/g, '/');
        return `magic://${projectId}/${relative}`;
      });

      await this.mediaService.updateMedia(mediaId, {
        frames: magicFramePaths,
        frameCount: telemetry.metrics?.frameCount || framePaths.length,
        status: 'parsed',
      });

      AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[MediaController] 轻量抽帧完成`, {
        mediaId, strategy: resolvedStrategy, frameCount: framePaths.length,
      });

      return {
        success: true,
        frameCount: framePaths.length,
        previewUrls: magicFramePaths.slice(0, 30),
      };
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
