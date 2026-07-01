// Path: src/main/services/MediaService.ts
import { MediaRepository } from '../database/repositories/MediaRepository';
import { ProjectRepository } from '../database/repositories/ProjectRepository';
import { PathManager } from '../utils/pathManager';
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../shared/utils/LogConstants';
import { MediaItem } from '../../shared/types';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { ProjectService } from './ProjectService';
import { VideoProcessor } from '../engine/media/VideoProcessor';
import { DICT } from '../../shared/locales/dictionary';
import { BrowserWindow } from 'electron';

const TRANSCODE_FORMATS = ['mkv', 'avi', 'mov', 'wmv', 'flv', 'ts', 'rmvb', 'rm', '3gp', 'vob'];

export class MediaService {
  private repo = new MediaRepository();
  private projectService = new ProjectService();
  private projectRepo = new ProjectRepository();

  /**
   * Import media files - returns immediately with basic info, processes metadata/cover in background
   */
  public async importMedia(projectId: string, filePaths: string[]): Promise<MediaItem[]> {
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

        let type: MediaItem['type'] = DICT.MEDIA_TYPE.IMAGE as MediaItem['type'];
        if (['mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'flv', 'ts', 'rmvb', 'rm', '3gp', 'vob'].includes(ext)) {
          type = DICT.MEDIA_TYPE.VIDEO as MediaItem['type'];
        } else if (['mp3', 'wav', 'aac', 'flac', 'm4a'].includes(ext)) {
          type = DICT.MEDIA_TYPE.AUDIO as MediaItem['type'];
        }

        // Create media item immediately with basic info - no waiting for ffprobe/ffmpeg
        const mediaItem: any = {
          id: mediaId, projectId, type, name: fileName,
          filePath: filePath, coverPath: '',
          status: 'importing',
          duration: 0, width: 0, height: 0, fps: 0
        };

        this.repo.insertMedia(mediaItem);

        // Return immediately to frontend
        const frontendMediaItem: MediaItem = {
          id: mediaItem.id, projectId: mediaItem.projectId, name: mediaItem.name, type: mediaItem.type,
          filePath: mediaItem.filePath, coverPath: '', duration: '00:00:00', status: 'importing'
        };
        results.push(this.projectService.hydratePaths({ mediaItems: [frontendMediaItem] }, projectId).mediaItems[0]);

        // Process metadata + cover in background (non-blocking)
        this.processMediaInBackground(projectId, mediaId, filePath, type, ext);

      } catch (error) {
        AppLogger.error(LOG_TAGS.MEDIA, `Import failed: ${filePath}`, error);
      }
    }
    return results;
  }

  /**
   * Background processing: extract metadata, generate cover, detect HEVC, transcode if needed
   * Updates the database and notifies frontend when done
   */
  private async processMediaInBackground(
    projectId: string, mediaId: string, filePath: string,
    type: string, ext: string
  ): Promise<void> {
    try {
      let playableFilePath = filePath;
      let needsTranscode = false;

      // Check if transcoding needed
      if (type === 'video' && TRANSCODE_FORMATS.includes(ext)) {
        AppLogger.info(LOG_TAGS.MEDIA, `Non-native format .${ext}, async transcode: ${filePath.split(/[\\/]/).pop()}`);
        needsTranscode = true;
      }

      if (type === 'video' && ext === 'mp4') {
        const isHevc = await this.detectHevcCodec(filePath);
        if (isHevc) {
          AppLogger.info(LOG_TAGS.MEDIA, `HEVC MP4 detected, async transcode: ${filePath.split(/[\\/]/).pop()}`);
          needsTranscode = true;
        }
      }

      // Start background transcoding (fire and forget)
      if (needsTranscode) {
        const transcodedPath = this.getTranscodedPath(projectId, mediaId);
        if (!fs.existsSync(transcodedPath)) {
          this.transcodeAsync(filePath, projectId, mediaId, transcodedPath);
        } else {
          playableFilePath = transcodedPath;
        }
      }

      // Extract metadata (non-blocking, but we await here in background)
      let metadata: any = { formattedTime: '00:00:00', duration: 0, width: 0, height: 0, fps: 0 };
      let pureCoverName = '';

      if (type === 'video') {
        try {
          metadata = await VideoProcessor.extractMetadata(playableFilePath);
        } catch (e) {
          AppLogger.warn(LOG_TAGS.MEDIA, `extractMetadata failed for ${mediaId}, using defaults`);
        }
        try {
          pureCoverName = await VideoProcessor.generateCover(playableFilePath, PathManager.getProjectThumbnailsDir(projectId), mediaId);
        } catch (e) {
          AppLogger.warn(LOG_TAGS.MEDIA, `generateCover failed for ${mediaId}`);
        }
      }

      // Update database with real metadata
      const relativeCoverPath = pureCoverName ? `thumbnails/${pureCoverName}` : '';
      this.repo.updateMedia(mediaId, {
        coverPath: relativeCoverPath,
        status: 'parsed',
        duration: metadata.duration || 0,
        width: metadata.width || 0,
        height: metadata.height || 0,
        fps: metadata.fps || 0,
      });

      if (relativeCoverPath) {
        this.projectRepo.updateCover(projectId, relativeCoverPath);
      }

      // Notify frontend to refresh
      this.notifyFrontend(projectId, mediaId, {
        coverPath: relativeCoverPath,
        duration: metadata.formattedTime,
        status: 'parsed',
      });

      AppLogger.info(LOG_TAGS.MEDIA, `Background processing done: ${mediaId} (${metadata.formattedTime})`);
    } catch (error) {
      AppLogger.error(LOG_TAGS.MEDIA, `Background processing failed: ${mediaId}`, error);
      this.repo.updateMedia(mediaId, { status: 'parsed' });
      this.notifyFrontend(projectId, mediaId, { status: 'parsed' });
    }
  }

  /**
   * Notify frontend via IPC that media processing is done
   */
  private notifyFrontend(projectId: string, mediaId: string, updates: any): void {
    try {
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        if (!win.isDestroyed()) {
          win.webContents.send('media:updated', { projectId, mediaId, ...updates });
        }
      }
    } catch {}
  }

  private getTranscodedPath(projectId: string, mediaId: string): string {
    const dir = PathManager.getProjectMediaDir(projectId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${mediaId}_transcoded.mp4`);
  }

  private async detectHevcCodec(filePath: string): Promise<boolean> {
    const ffprobeExe = PathManager.getBinPath(process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    if (!fs.existsSync(ffprobeExe)) return false;

    return new Promise((resolve) => {
      const proc = spawn(ffprobeExe, [
        '-v', 'quiet', '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', filePath
      ], { windowsHide: true });
      let output = '';
      proc.stdout?.on('data', (data: Buffer) => { output += data.toString(); });
      proc.stderr?.on('data', () => {});
      proc.on('close', (code) => {
        if (code === 0) {
          const codecName = output.trim().toLowerCase();
          resolve(codecName.includes('hevc') || codecName.includes('h265') || codecName.includes('libx265'));
        } else { resolve(false); }
      });
      proc.on('error', () => resolve(false));
    });
  }

  private transcodeAsync(filePath: string, projectId: string, mediaId: string, outputPath: string): void {
    const ffmpegExe = PathManager.getBinPath(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    if (!fs.existsSync(ffmpegExe)) {
      AppLogger.warn(LOG_TAGS.MEDIA, 'FFmpeg not found, cannot transcode');
      return;
    }
    const args = ['-i', filePath, '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-c:a', 'aac', '-y', outputPath];
    const proc = spawn(ffmpegExe, args, { windowsHide: true });
    proc.on('close', (code) => {
      if (code === 0) {
        AppLogger.info(LOG_TAGS.MEDIA, `Transcode complete: ${mediaId}`);
        this.repo.updateMedia(mediaId, { filePath: outputPath });
        this.notifyFrontend(projectId, mediaId, { filePath: outputPath });
      } else {
        AppLogger.error(LOG_TAGS.MEDIA, `Transcode failed (code ${code}): ${mediaId}`);
      }
    });
    proc.on('error', (err) => AppLogger.error(LOG_TAGS.MEDIA, `Transcode error: ${mediaId}`, err));
  }

  async deleteMedia(projectId: string, mediaId: string): Promise<void> {
    try {
      const media = this.repo.findById(mediaId);
      if (media?.coverPath) {
        await this.deleteThumbnail(PathManager.getProjectThumbnailsDir(projectId), mediaId);
      }
      this.repo.delete(mediaId);
    } catch (error) {
      AppLogger.error(LOG_TAGS.MEDIA, `Delete media failed: ${mediaId}`, error);
    }
  }

  private async deleteThumbnail(dir: string, mediaId: string): Promise<void> {
    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (file.startsWith(mediaId)) {
          fs.unlinkSync(path.join(dir, file));
        }
      }
    } catch {}
  }
}
