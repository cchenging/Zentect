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
import type { ExtractOptions } from '../../../modules/media/frames/backend/Service';
import { LOG_TAGS } from '@modules/infra/logger/LogConstants';
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
   * 🎬 生成视频封面图(取第一个非黑帧版)
   *
   * 策略:从片头起按递增偏移快速 seek 取帧,逐帧判亮度,
   *      跳过片头黑场/淡入过渡,取第一个非黑帧(单次调用约 50-100ms);
   *      全片皆黑时回退中间帧兜底。
   * 不做任何帧内容筛选(高重复帧/最丰富帧),只保证不黑屏。
   *
   * @param videoPath 视频文件绝对路径
   * @param outputDir 封面输出目录
   * @param mediaId   媒体 ID,用于命名
   */
  static async generateCover(
    videoPath: string,
    outputDir: string,
    mediaId: string,
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

    // 封面取帧:跳过片头黑场/淡入,取第一个非黑帧;全黑则回退中间帧
    if (fs.existsSync(coverFullPath)) fs.unlinkSync(coverFullPath);
    const ok = await this.captureFirstNonBlackFrame(ffmpegExe, videoPath, coverFullPath, duration);
    if (!ok) return '';

    AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[VideoProcessor] 封面生成成功(第一个非黑帧) seek=${this.lastCoverSeek ?? '-'}s`);
    return coverFileName;
  }

  /** 最近一次封面取帧的 seek 时间(仅用于日志) */
  private static lastCoverSeek: number | null = null;

  /**
   * 取视频第一个非黑帧(跳过片头黑场/淡入过渡)
   *
   * 从 0.5s 起按递增偏移快速 seek 取帧,用 signalstats 判平均亮度,
   * 找到第一帧非黑帧即用;全部偏移皆黑则回退中间帧。
   */
  private static async captureFirstNonBlackFrame(
    ffmpegExe: string,
    videoPath: string,
    outputPath: string,
    durationSec: number,
  ): Promise<boolean> {
    // 递增偏移序列:前密后疏,覆盖片头黑场/淡入场景
    const offsets = [0.5, 1.5, 3, 5, 8, 12, 20, 30, 45, 60];
    for (const off of offsets) {
      if (off >= durationSec * 0.95) break;
      const ok = await this.captureFrameAt(ffmpegExe, videoPath, outputPath, off);
      if (!ok) continue;
      const luma = await this.readFrameLuma(ffmpegExe, outputPath);
      // 纯黑帧 YAVG≈16(8bit 黑电平),有内容帧通常 >30;阈值取 20 宽松判黑
      if (luma !== null && luma >= 20) {
        VideoProcessor.lastCoverSeek = off;
        return true;
      }
    }
    // 兜底:全片皆黑(或极短视频)取中间帧
    const midPoint = parseFloat((durationSec / 2).toFixed(2));
    const ok = await this.captureFrameAt(ffmpegExe, videoPath, outputPath, midPoint);
    if (ok) VideoProcessor.lastCoverSeek = midPoint;
    return ok;
  }

  /**
   * 读取单帧图片的平均亮度(signalstats YAVG)
   * @returns 平均亮度(0-255),失败返回 null
   */
  private static readFrameLuma(
    ffmpegExe: string,
    imagePath: string,
  ): Promise<number | null> {
    return new Promise((resolve) => {
      const args = ['-i', imagePath, '-vf', 'signalstats,metadata=print', '-frames:v', '1', '-f', 'null', '-'];
      const child = spawn(ffmpegExe, args);
      let stderr = '';
      child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
      child.on('close', (code) => {
        if (code !== 0) {
          resolve(null);
          return;
        }
        const m = stderr.match(/lavfi\.signalstats\.YAVG=([\d.]+)/);
        resolve(m ? parseFloat(m[1]) : null);
      });
      child.on('error', () => resolve(null));
      ProcessManager.register(child, 'FFmpeg-封面亮度判定');
    });
  }

  /**
   * 视频抽帧（核心方法）
   * @deprecated 已迁移至 src/modules/media/frames/，请使用 FrameExtractionService.extractFrames
   */
  public static async extractFrames(
    filePath: string, outputDir: string, mediaId: string,
    options: ExtractOptions = {}
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
