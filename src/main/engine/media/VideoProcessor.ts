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
import { LOG_TAGS } from '@modules/infra/logger/LogConstants';
import {
  buildCoverCommand,
  buildThumbnailCoverCommand,
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
          resolve({ formattedTime: `${h}:${m}:${s}`, duration, width: videoStream?.width || 0, height: videoStream?.height || 0, fps: fps });
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
   * 快速获取视频时长（秒），失败返回 0
   */
  private static async getDuration(filePath: string): Promise<number> {
    return new Promise((resolve) => {
      const ffprobeExe = PathManager.getBinPath('ffprobe.exe');
      if (!ffprobeExe || !fs.existsSync(ffprobeExe)) return resolve(0);

      const args = buildProbeCommand({ videoPath: filePath });
      const child = spawn(ffprobeExe, args, { windowsHide: true });

      let stdout = '';
      const timer = setTimeout(() => { child.kill(); resolve(0); }, 10000);

      child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) return resolve(0);
        try {
          const data = JSON.parse(stdout);
          resolve(parseFloat(data.format?.duration) || 0);
        } catch {
          resolve(0);
        }
      });
      child.on('error', () => { clearTimeout(timer); resolve(0); });
      ProcessManager.register(child, 'FFprobe-时长探测');
    });
  }

  /**
   * 执行一次 FFmpeg 封面截图，返回是否成功
   */
  private static captureFrameAt(ffmpegExe: string, videoPath: string, outputPath: string, seekTime: number): Promise<boolean> {
    return new Promise((resolve) => {
      const args = buildCoverCommand({ videoPath, outputPath, seekTime, scaleHeight: 360, jpgQuality: 2 });
      const child = spawn(ffmpegExe, args);
      let stderr = '';
      child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
      child.on('close', (code) => {
        if (code === 0 && fs.existsSync(outputPath)) resolve(true);
        else {
          if (stderr) AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, `[VideoProcessor] 封面截图失败 seek=${seekTime}s (code=${code}): ${stderr.slice(0, 500)}`);
          resolve(false);
        }
      });
      child.on('error', () => resolve(false));
      ProcessManager.register(child, 'FFmpeg-封面截图');
    });
  }

  /**
   * 🎬 生成视频封面图(FFmpeg thumbnail 滤镜版)
   *
   * 旧版策略(已废弃):循环 N 次 captureFrameAt + sharp 算亮度
   *   - 10分钟视频 240 帧 × ~200ms = 48s,太慢
   *   - 只看平均亮度,选不出色彩最丰富的帧
   *
   * 新版策略:FFmpeg 原生 thumbnail 滤镜
   *   - 一次调用分析前 N 帧的色彩直方图,自动抛弃纯黑/纯白/高重复帧
   *   - 选出色彩最丰富的代表帧,0.5-2s 完成
   *   - 不再依赖 sharp 算亮度
   *
   * @param videoPath 视频文件绝对路径
   * @param outputDir 封面输出目录
   * @param mediaId   媒体 ID,用于命名
   * @param frames    thumbnail 滤镜扫描帧数(默认 100,约 3-4 秒内容)
   */
  static async generateCover(
    videoPath: string,
    outputDir: string,
    mediaId: string,
    frames: number = 100,
  ): Promise<string> {
    const safeMediaId = mediaId.replace(/[^\w\-\u4e00-\u9fff]/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
    const coverFileName = `${safeMediaId}.jpg`;
    const coverFullPath = path.join(outputDir, coverFileName);
    const ffmpegExe = PathManager.getBinPath('ffmpeg.exe');

    if (!ffmpegExe || !fs.existsSync(ffmpegExe)) {
      AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, '[VideoProcessor] FFmpeg 未找到，无法生成封面');
      return '';
    }

    // 确保输出目录存在
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const duration = await this.getDuration(videoPath);
    if (duration <= 0) {
      AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, '[VideoProcessor] 无法获取视频时长，放弃封面生成');
      return '';
    }

    // 极端短视频(< 1s):thumbnail 滤镜无意义,直接取中间帧
    if (duration <= 1) {
      const midPoint = parseFloat((duration / 2).toFixed(2));
      if (fs.existsSync(coverFullPath)) fs.unlinkSync(coverFullPath);
      const ok = await this.captureFrameAt(ffmpegExe, videoPath, coverFullPath, midPoint);
      if (!ok) return '';
      AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[VideoProcessor] 短视频封面 seek=${midPoint}s`);
      return coverFileName;
    }

    // 常规视频:thumbnail 滤镜选最佳帧
    if (fs.existsSync(coverFullPath)) fs.unlinkSync(coverFullPath);

    const args = buildThumbnailCoverCommand({
      videoPath,
      outputPath: coverFullPath,
      frames,
      scaleHeight: 360,
      jpgQuality: 2,
    });

    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(ffmpegExe, args);
      let stderr = '';
      child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
      child.on('close', (code) => {
        if (code === 0 && fs.existsSync(coverFullPath)) resolve(true);
        else {
          if (stderr) AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, `[VideoProcessor] thumbnail 滤镜失败 (code=${code}): ${stderr.slice(0, 500)}`);
          resolve(false);
        }
      });
      child.on('error', () => resolve(false));
      ProcessManager.register(child, 'FFmpeg-thumbnail封面');
    });

    if (!ok) return '';

    AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[VideoProcessor] thumbnail 封面生成成功 frames=${frames}`);
    return coverFileName;
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
