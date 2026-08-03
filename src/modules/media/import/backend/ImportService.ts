// Module: media/import - ImportService (backend)
// §3.5.1: 视频导入、HEVC检测、异步转码、封面生成、元数据提取

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { BrowserWindow } from 'electron';
import { MediaRepository } from '../data/MediaRepository';
import { ProjectRepository } from '../../../../main/database/repositories/ProjectRepository';
import { AppLogger } from '@modules/infra/logger/AppLogger';
import { LOG_TAGS } from '@modules/infra/logger/LogConstants';
import { IPC_CHANNELS } from '@modules/infra/ipc/IpcConstants';
import type { MediaItem } from '../types';

/** 需转码的视频容器格式 */
const TRANSCODE_FORMATS = [
  'mkv', 'avi', 'mov', 'wmv', 'flv', 'ts', 'rmvb', 'rm', '3gp', 'vob',
];

/** 视频扩展名 */
const VIDEO_EXTS = [
  'mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'flv', 'ts', 'rmvb', 'rm',
  '3gp', 'vob',
];

/** 音频扩展名 */
const AUDIO_EXTS = ['mp3', 'wav', 'aac', 'flac', 'm4a'];

export class ImportService {
  private repo = new MediaRepository();

  /**
   * 导入媒体文件：立即返回基本信息，后台异步提取元数据/封面/转码
   */
  public async importMedia(
    projectId: string,
    filePaths: string[],
    pathManager: any,
    videoProcessor: any,
  ): Promise<MediaItem[]> {
    const results: MediaItem[] = [];

    for (const filePath of filePaths) {
      if (!fs.existsSync(filePath)) {
        AppLogger.warn(LOG_TAGS.MEDIA, `File not found, skipping: ${filePath}`);
        continue;
      }

      try {
        const mediaId = `media_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const fileName = filePath.split(/[\\/]/).pop() || 'unknown';
        const ext = fileName.split('.').pop()?.toLowerCase() || '';

        let type: MediaItem['type'] = 'frame';
        if (VIDEO_EXTS.includes(ext)) {
          type = 'video';
        } else if (AUDIO_EXTS.includes(ext)) {
          type = 'audio';
        }

        const mediaItem: any = {
          id: mediaId,
          projectId,
          type,
          name: fileName,
          filePath,
          coverPath: '',
          status: 'importing',
          duration: 0,
          width: 0,
          height: 0,
          fps: 0,
        };

        this.repo.insertMedia(mediaItem);

        // 视频导入：同步用 FFmpeg thumbnail 滤镜生成封面（0.5-2秒）
        // thumbnail 滤镜自动跳过黑场/纯白/高重复帧，选色彩最丰富的代表帧
        // 一次生成即为最终封面，无需异步二次覆盖，避免图片跳变
        let coverPath = '';
        if (type === 'video') {
          try {
            const coverName = await videoProcessor.generateCover(
              filePath,
              pathManager.getProjectThumbnailsDir(projectId),
              mediaId,
            );
            if (coverName) {
              coverPath = `thumbnails/${coverName}`;
              // 同步写入 DB
              this.repo.updateMediaMeta(mediaId, { coverPath });
              // 同步写 projects.cover_path，让首页立即显示封面
              try {
                new ProjectRepository().updateCover(projectId, coverPath);
                this.broadcastCoverUpdated(projectId, coverPath);
              } catch (e) {
                AppLogger.warn(LOG_TAGS.MEDIA, `同步回写 projects.cover_path 失败: ${projectId}`);
              }
            }
          } catch (e) {
            AppLogger.warn(LOG_TAGS.MEDIA, `generateCover failed for ${mediaId}`);
          }
        }

        // 推送给前端的 coverPath 必须是 magic URL，否则 getSafeMediaUrl 解析失败
        const frontendMediaItem: MediaItem = {
          id: mediaId,
          type,
          name: fileName,
          filePath,
          coverPath: coverPath ? `magic://${projectId}/${coverPath}` : '',
          duration: '00:00:00',
          status: 'importing',
        };
        results.push(frontendMediaItem);

        // 后台异步处理（元数据提取 + 可选转码，封面已同步生成无需再处理）
        this.processMediaInBackground(
          projectId,
          mediaId,
          filePath,
          type,
          ext,
          pathManager,
          videoProcessor,
        );
      } catch (error) {
        AppLogger.error(LOG_TAGS.MEDIA, `Import failed: ${filePath}`, error);
      }
    }
    return results;
  }

  // --- 后台处理 ---

  private async processMediaInBackground(
    projectId: string,
    mediaId: string,
    filePath: string,
    type: string,
    ext: string,
    pathManager: any,
    videoProcessor: any,
  ): Promise<void> {
    try {
      let playableFilePath = filePath;
      let needsTranscode = false;

      if (type === 'video' && TRANSCODE_FORMATS.includes(ext)) {
        AppLogger.info(
          LOG_TAGS.MEDIA,
          `Non-native format .${ext}, async transcode: ${filePath.split(/[\\/]/).pop()}`,
        );
        needsTranscode = true;
      }

      if (type === 'video' && ext === 'mp4') {
        const isHevc = await this.detectHevcCodec(filePath, pathManager);
        if (isHevc) {
          AppLogger.info(
            LOG_TAGS.MEDIA,
            `HEVC MP4 detected, async transcode: ${filePath.split(/[\\/]/).pop()}`,
          );
          needsTranscode = true;
        }
      }

      if (needsTranscode) {
        const transcodedPath = this.getTranscodedPath(
          projectId,
          mediaId,
          pathManager,
        );
        if (!fs.existsSync(transcodedPath)) {
          this.transcodeAsync(
            filePath,
            projectId,
            mediaId,
            transcodedPath,
            pathManager,
          );
        } else {
          playableFilePath = transcodedPath;
        }
      }

      // 提取元数据（封面已在导入时同步生成，此处不再处理）
      let metadata: any = {
        formattedTime: '00:00:00',
        duration: 0,
        width: 0,
        height: 0,
        fps: 0,
      };

      if (type === 'video') {
        try {
          metadata = await videoProcessor.extractMetadata(playableFilePath);
        } catch (e) {
          AppLogger.warn(
            LOG_TAGS.MEDIA,
            `extractMetadata failed for ${mediaId}, using defaults`,
          );
        }
      }

      this.repo.updateMediaMeta(mediaId, {
        status: 'parsed',
        duration: metadata.duration || 0,
        width: metadata.width || 0,
        height: metadata.height || 0,
        fps: metadata.fps || 0,
        filePath: playableFilePath,
      });

      this.notifyFrontend(projectId, mediaId, {
        duration: metadata.formattedTime,
        status: 'parsed',
      });

      AppLogger.info(
        LOG_TAGS.MEDIA,
        `Background processing done: ${mediaId} (${metadata.formattedTime})`,
      );
    } catch (error) {
      AppLogger.error(
        LOG_TAGS.MEDIA,
        `Background processing failed: ${mediaId}`,
        error,
      );
      this.repo.updateMediaMeta(mediaId, { status: 'parsed' });
      this.notifyFrontend(projectId, mediaId, { status: 'parsed' });
    }
  }

  // --- 工具方法 ---

  /**
   * 🎬 封面增量广播:通知首页 patch 指定项目的 coverPath
   * 前端收到后追加 ?t=timestamp 破除 Chromium 图片强缓存,局部 state patch
   * @param projectId 项目 ID
   * @param relativeCoverPath 裸相对路径(如 thumbnails/media_xxx.jpg),前端自行转 magic URL
   */
  private broadcastCoverUpdated(projectId: string, relativeCoverPath: string): void {
    try {
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC_CHANNELS.EVENT_COVER_UPDATED, {
            projectId,
            coverPath: `magic://${projectId}/${relativeCoverPath}`,
            updatedAt: Date.now(),
          });
        }
      }
    } catch {}
  }

  private notifyFrontend(
    projectId: string,
    mediaId: string,
    updates: any,
  ): void {
    try {
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        if (!win.isDestroyed()) {
          win.webContents.send('media:updated', {
            projectId,
            mediaId,
            ...updates,
          });
        }
      }
    } catch {}
  }

  private getTranscodedPath(
    projectId: string,
    mediaId: string,
    pathManager: any,
  ): string {
    const dir = pathManager.getProjectMediaDir(projectId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${mediaId}_transcoded.mp4`);
  }

  private async detectHevcCodec(
    filePath: string,
    pathManager: any,
  ): Promise<boolean> {
    const ffprobeExe = pathManager.getBinPath(
      process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe',
    );
    if (!fs.existsSync(ffprobeExe)) return false;

    return new Promise((resolve) => {
      const proc = spawn(
        ffprobeExe,
        [
          '-v', 'quiet', '-select_streams', 'v:0',
          '-show_entries', 'stream=codec_name', '-of', 'csv=p=0',
          filePath,
        ],
        { windowsHide: true },
      );
      let output = '';
      proc.stdout?.on('data', (data: Buffer) => {
        output += data.toString();
      });
      proc.stderr?.on('data', () => {});
      proc.on('close', (code) => {
        if (code === 0) {
          const codecName = output.trim().toLowerCase();
          resolve(
            codecName.includes('hevc') ||
              codecName.includes('h265') ||
              codecName.includes('libx265'),
          );
        } else {
          resolve(false);
        }
      });
      proc.on('error', () => resolve(false));
    });
  }

  private transcodeAsync(
    filePath: string,
    projectId: string,
    mediaId: string,
    outputPath: string,
    pathManager: any,
  ): void {
    const ffmpegExe = pathManager.getBinPath(
      process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
    );
    if (!fs.existsSync(ffmpegExe)) {
      AppLogger.warn(LOG_TAGS.MEDIA, 'FFmpeg not found, cannot transcode');
      return;
    }
    const args = [
      '-i', filePath, '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-c:a', 'aac', '-y', outputPath,
    ];
    const proc = spawn(ffmpegExe, args, { windowsHide: true });
    proc.on('close', (code) => {
      if (code === 0) {
        AppLogger.info(LOG_TAGS.MEDIA, `Transcode complete: ${mediaId}`);
        this.repo.updateMediaMeta(mediaId, { filePath: outputPath });
        this.notifyFrontend(projectId, mediaId, { filePath: outputPath });
      } else {
        AppLogger.error(
          LOG_TAGS.MEDIA,
          `Transcode failed (code ${code}): ${mediaId}`,
        );
      }
    });
    proc.on('error', (err) =>
      AppLogger.error(LOG_TAGS.MEDIA, `Transcode error: ${mediaId}`, err),
    );
  }

  // --- 公开查询方法 (供 Controller 等消费者使用) ---

  public getMediaById(id: string): any {
    return this.repo.findById(id);
  }

  public getMediaByProject(projectId: string): any[] {
    return this.repo.getByProject(projectId);
  }

  public updateMedia(mediaId: string, data: any): void {
    this.repo.updateMedia(mediaId, data);
  }
}
