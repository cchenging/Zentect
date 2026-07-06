// 📁 路径：src/main/engine/media/VideoProcessor.ts
// ⚠️ 抽帧功能已迁移至 src/modules/media/frames/
//   - extractFrames / probeVideo → FrameExtractionService
//   - FrameExtractionOptions / FrameExtractionTelemetry → 从 frames 模块重新导出
// 保留封面生成（generateCover）和元数据提取（extractMetadata）。

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { PathManager } from '../../utils/pathManager';
import { ProcessManager } from '../../utils/processManager';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '../../../infra/logger/LogConstants';
import {
  buildCoverCommand,
  buildProbeCommand,
} from './FFmpegCommandBuilder';

// @deprecated 从新模块重导出抽帧相关类型
export type { FrameExtractionTelemetry } from '../../../modules/media/frames';

/** @deprecated 抽帧选项已迁移至 src/modules/media/frames/，请使用 ExtractOptions from '@/modules/media/frames' */
export type { ExtractOptions as FrameExtractionOptions } from '../../../modules/media/frames';

export class VideoProcessor {
  /**
   * 探测视频元数据（时长、分辨率、帧率）
   * 使用 buildProbeCommand 结构化生成 ffprobe 参数
   */
  static async extractMetadata(filePath: string): Promise<any> {
    return new Promise((resolve) => {
      const ffprobeExe = PathManager.getBinPath('ffprobe.exe');
      if (!filePath) { resolve({ formattedTime: '00:00:00', width: 0, height: 0, fps: 0 }); return; }

      const args = buildProbeCommand({ videoPath: filePath });
      const child = spawn(ffprobeExe, args, { windowsHide: true });

      let stdout = '';
      child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      child.on('close', (code) => {
        if (code !== 0) { resolve({ formattedTime: '00:00:00', width: 0, height: 0, fps: 0 }); return; }
        try {
          const data = JSON.parse(stdout);
          const videoStream = data.streams.find((s: any) => s.codec_type === 'video');
          const duration = parseFloat(data.format.duration) || 0;
          const h = Math.floor(duration / 3600).toString().padStart(2, '0');
          const m = Math.floor((duration % 3600) / 60).toString().padStart(2, '0');
          const s = Math.floor(duration % 60).toString().padStart(2, '0');
          let fps = 0;
          if (videoStream?.r_frame_rate) {
             const [num, den] = videoStream.r_frame_rate.split('/');
             if (num && den && parseInt(den) !== 0) fps = parseInt(num) / parseInt(den);
          }
          resolve({ formattedTime: `${h}:${m}:${s}`, width: videoStream?.width || 0, height: videoStream?.height || 0, fps: fps });
        } catch (e) { resolve({ formattedTime: '00:00:00', width: 0, height: 0, fps: 0 }); }
      });
      child.on('error', () => resolve({ formattedTime: '00:00:00', width: 0, height: 0, fps: 0 }));
      ProcessManager.register(child, 'FFprobe-元数据');
    });
  }

  /**
   * 前置探针：校验视频流存在、时长>0、编码兼容
   * 在抽帧前 1 秒内拦截无效输入，避免浪费 30+ 秒的 FFmpeg 进程
   */
  static async probeVideo(filePath: string): Promise<{ valid: boolean; reason?: string; duration?: number; width?: number; height?: number }> {
    const ffprobeExe = PathManager.getBinPath('ffprobe.exe');
    if (!fs.existsSync(ffprobeExe)) {
      /** ffprobe 不可用时跳过探针，不阻断流程 */
      AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, '[VideoProcessor] ffprobe 不可用，跳过前置探针');
      return { valid: true };
    }
    if (!fs.existsSync(filePath)) {
      return { valid: false, reason: '物理文件不存在' };
    }

    return new Promise((resolve) => {
      const args = buildProbeCommand({ videoPath: filePath });
      const child = spawn(ffprobeExe, args, { windowsHide: true });

      let stdout = '';
      const timer = setTimeout(() => {
        child.kill();
        resolve({ valid: false, reason: 'ffprobe 探针超时（10秒）' });
      }, 10000);

      child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          return resolve({ valid: false, reason: `ffprobe 退出码 ${code}，无法解析视频文件` });
        }
        try {
          const data = JSON.parse(stdout);
          const videoStream = data.streams?.find((s: any) => s.codec_type === 'video');
          if (!videoStream) {
            return resolve({ valid: false, reason: '文件中未检测到视频流' });
          }
          const duration = parseFloat(data.format?.duration) || 0;
          if (duration <= 0) {
            return resolve({ valid: false, reason: `视频时长无效 (${duration}s)` });
          }
          const width = videoStream.width || 0;
          const height = videoStream.height || 0;
          if (width === 0 || height === 0) {
            return resolve({ valid: false, reason: `视频分辨率无效 (${width}x${height})` });
          }
          resolve({ valid: true, duration, width, height });
        } catch {
          resolve({ valid: false, reason: 'ffprobe 返回数据解析失败' });
        }
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolve({ valid: false, reason: 'ffprobe 启动失败' });
      });
      ProcessManager.register(child, 'FFprobe-前置探针');
    });
  }

  /**
   * 生成视频封面图
   * 使用 buildCoverCommand 结构化生成 FFmpeg 参数
   */
  static async generateCover(videoPath: string, outputDir: string, mediaId: string): Promise<string> {
    return new Promise((resolve) => {
       const safeMediaId = mediaId.replace(/[^\w\-\u4e00-\u9fff]/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
       const coverFileName = `${safeMediaId}.jpg`;
       const coverFullPath = path.join(outputDir, coverFileName);
       const ffmpegExe = PathManager.getBinPath('ffmpeg.exe');

       if (!fs.existsSync(ffmpegExe)) return resolve('');

       const args = buildCoverCommand({
         videoPath,
         outputPath: coverFullPath,
         seekTime: 0.1,
         scaleHeight: 360,
         jpgQuality: 2,
       });

       const child = spawn(ffmpegExe, args);
       child.on('close', (code) => {
         if (code === 0 && fs.existsSync(coverFullPath)) resolve(coverFileName);
         else resolve('');
       });
       child.on('error', () => resolve(''));
       ProcessManager.register(child, 'FFmpeg-生成封面');
    });
  }

  /**
   * 视频抽帧（核心方法）
   * @deprecated 已迁移至 src/modules/media/frames/，请使用 FrameExtractionService.extractFrames
   */
  public static async extractFrames(
    filePath: string, outputDir: string, mediaId: string,
    options: {
      inPoint?: number; outPoint?: number; fps?: number; scale?: number; quality?: number;
      strategy?: string; sceneThreshold?: number; minFrameInterval?: number;
      timePoint?: number; abortSignal?: AbortSignal;
    } = {}
  ): Promise<{ files: string[]; metrics: { durationMs: number; frameCount: number; totalSizeMB: number; processingFps: number } }> {
    const { FrameExtractionService } = await import('../../../modules/media/frames');
    const deps = {
      getFfmpegPath: () => PathManager.getBinPath('ffmpeg.exe'),
      getFfprobePath: () => PathManager.getBinPath('ffprobe.exe'),
    };
    const service = new FrameExtractionService(deps);
    return service.extractFrames(filePath, outputDir, mediaId, options);
  }

}
