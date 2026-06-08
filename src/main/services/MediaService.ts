// 📁 路径: src/main/services/MediaService.ts
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

/** Chromium 原生支持的视频容器格式 */
const NATIVE_VIDEO_FORMATS = ['mp4', 'webm', 'ogg'];

/** 需要转码的视频格式 */
const TRANSCODE_FORMATS = ['mkv', 'avi', 'mov', 'wmv', 'flv', 'ts', 'rmvb', 'rm', '3gp', 'vob'];

export class MediaService {
  private repo = new MediaRepository();
  private projectService = new ProjectService();
  private projectRepo = new ProjectRepository();

  /**
   * 🚀 导入媒体文件到项目
   */
  public async importMedia(projectId: string, filePaths: string[]): Promise<MediaItem[]> {
    const results: MediaItem[] = [];

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
        if (['mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'flv', 'ts', 'rmvb', 'rm', '3gp', 'vob'].includes(ext)) {
          type = DICT.MEDIA_TYPE.VIDEO as MediaItem['type'];
        } else if (['mp3', 'wav', 'aac', 'flac', 'm4a'].includes(ext)) {
          type = DICT.MEDIA_TYPE.AUDIO as MediaItem['type'];
        }

        let metadata: any = { formattedTime: '00:00:00', duration: 0, width: 0, height: 0, fps: 0 };
        let pureCoverName = '';
        let playableFilePath = filePath; // 最终用于播放的文件路径

        // 非原生格式自动转码为 MP4，确保 Chromium 可播放
        if (type === 'video' && TRANSCODE_FORMATS.includes(ext)) {
          AppLogger.info(LOG_TAGS.MEDIA, `检测到非原生格式 .${ext}，启动 FFmpeg 转码: ${fileName}`);
          const transcodedPath = await this.transcodeToMp4(filePath, projectId, mediaId);
          if (transcodedPath) {
            playableFilePath = transcodedPath;
            AppLogger.info(LOG_TAGS.MEDIA, `转码完成: ${fileName} -> MP4`);
          } else {
            AppLogger.warn(LOG_TAGS.MEDIA, `转码失败，保留原始路径: ${fileName}`);
          }
        }

        // MP4 文件检测 HEVC 编码，Chromium 不支持 HEVC 播放，需转码为 H.264
        if (type === 'video' && ext === 'mp4') {
          const isHevc = await this.detectHevcCodec(filePath);
          if (isHevc) {
            AppLogger.info(LOG_TAGS.MEDIA, `检测到 HEVC 编码 MP4，启动转码: ${fileName}`);
            const transcodedPath = await this.transcodeToMp4(filePath, projectId, mediaId);
            if (transcodedPath) {
              playableFilePath = transcodedPath;
              AppLogger.info(LOG_TAGS.MEDIA, `HEVC 转码完成: ${fileName} -> H.264 MP4`);
            } else {
              AppLogger.warn(LOG_TAGS.MEDIA, `HEVC 转码失败，保留原始路径: ${fileName}`);
            }
          }
        }

        if (type === 'video') {
          metadata = await VideoProcessor.extractMetadata(playableFilePath);
          pureCoverName = await VideoProcessor.generateCover(playableFilePath, PathManager.getProjectThumbnailsDir(projectId), mediaId);
        }

        const relativeCoverPath = pureCoverName ? `thumbnails/${pureCoverName}` : '';
        const mediaItem: MediaItem & { duration: number, width: number, height: number, fps: number } = {
          id: mediaId, projectId, type, name: fileName,
          filePath: playableFilePath, coverPath: relativeCoverPath,
          status: 'parsed',
          duration: metadata.duration || 0,
          width: metadata.width || 0, height: metadata.height || 0, fps: metadata.fps || 0
        };

        // 通过仓储层写入
        this.repo.insertMedia(mediaItem);

        // 同步更新项目封面（用于首页卡片展示）
        if (relativeCoverPath) {
          this.projectRepo.updateCover(projectId, relativeCoverPath);
        }

        // 返回给前端前，组装前端需要的字段
        const frontendMediaItem: MediaItem = {
          id: mediaItem.id, projectId: mediaItem.projectId, name: mediaItem.name, type: mediaItem.type,
          filePath: mediaItem.filePath, coverPath: mediaItem.coverPath, duration: metadata.formattedTime, status: 'parsed'
        };
        results.push(this.projectService.hydratePaths({ mediaItems: [frontendMediaItem] }, projectId).mediaItems[0]);
      } catch (error) {
        AppLogger.error(LOG_TAGS.MEDIA, `导入媒体失败: ${filePath}`, error);
      }
    }
    return results;
  }

  /**
   * 检测视频文件是否使用 HEVC (H.265) 编码
   * 通过 ffprobe 检测视频流编码名称
   */
  private async detectHevcCodec(filePath: string): Promise<boolean> {
    const ffprobeExe = PathManager.getBinPath(process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    if (!fs.existsSync(ffprobeExe)) {
      AppLogger.warn(LOG_TAGS.MEDIA, 'ffprobe 不存在，跳过 HEVC 检测');
      return false;
    }

    return new Promise((resolve) => {
      const args = [
        '-v', 'quiet',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name',
        '-of', 'csv=p=0',
        filePath
      ];

      const proc = spawn(ffprobeExe, args, { windowsHide: true });
      let output = '';

      proc.stdout?.on('data', (data: Buffer) => { output += data.toString(); });
      proc.stderr?.on('data', () => {});

      proc.on('close', (code) => {
        if (code === 0) {
          const codecName = output.trim().toLowerCase();
          const isHevc = codecName.includes('hevc') || codecName.includes('h265') || codecName.includes('libx265');
          if (isHevc) {
            AppLogger.info(LOG_TAGS.MEDIA, `检测到 HEVC 编码: codec=${codecName} file=${filePath.split(/[\\/]/).pop()}`);
          }
          resolve(isHevc);
        } else {
          resolve(false);
        }
      });

      proc.on('error', () => { resolve(false); });
    });
  }

  /**
   * 将非原生格式视频转码为 MP4（H.264 + AAC），确保 Chromium 可播放
   */
  private async transcodeToMp4(sourcePath: string, projectId: string, mediaId: string): Promise<string | null> {
    const ffmpegExe = PathManager.getBinPath(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    if (!fs.existsSync(ffmpegExe)) {
      AppLogger.warn(LOG_TAGS.MEDIA, 'FFmpeg 不存在，无法转码');
      return null;
    }

    const outputDir = PathManager.getProjectExtractionsDir(projectId, 'transcoded');
    const outputPath = path.join(outputDir, `${mediaId}.mp4`);

    // 如果已经转码过，直接返回
    if (fs.existsSync(outputPath)) return outputPath;

    return new Promise((resolve) => {
      const args = [
        '-i', sourcePath,
        '-c:v', 'libx264',       // H.264 视频编码
        '-preset', 'fast',        // 快速转码
        '-crf', '23',             // 质量平衡
        '-c:a', 'aac',            // AAC 音频编码
        '-b:a', '128k',           // 音频码率
        '-movflags', '+faststart', // 流式播放优化
        '-y',                     // 覆盖输出
        outputPath
      ];

      const proc = spawn(ffmpegExe, args, { windowsHide: true });
      let stderrOutput = '';

      proc.stderr?.on('data', (data: Buffer) => {
        stderrOutput += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0 && fs.existsSync(outputPath)) {
          resolve(outputPath);
        } else {
          AppLogger.error(LOG_TAGS.MEDIA, `FFmpeg 转码失败 (exit code: ${code})`, { stderr: stderrOutput.slice(-500) });
          // 清理不完整文件
          try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
          resolve(null);
        }
      });

      proc.on('error', (err) => {
        AppLogger.error(LOG_TAGS.MEDIA, `FFmpeg 进程启动失败`, err);
        resolve(null);
      });
    });
  }

  /**
   * 按项目获取媒体列表
   */
  public async getMediaByProject(projectId: string) {
    const medias = await this.repo.getByProject(projectId);
    return this.projectService.hydratePaths({ mediaItems: medias }, projectId).mediaItems;
  }

  /** 根据 mediaId 获取单个媒体资产 */
  public async getMediaById(mediaId: string) {
    return this.repo.findById(mediaId);
  }

  /**
   * 更新媒体信息（提取结果等）
   */
  public async updateMedia(mediaId: string, data: any) {
    this.repo.updateMedia(mediaId, data);
    return true;
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
