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
import sharp from 'sharp';
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
   * 使用 sharp 检测封面亮度（平均灰度值 0~255），失败返回 null
   */
  private static async measureBrightness(imagePath: string): Promise<number | null> {
    try {
      const { data } = await sharp(imagePath)
        .raw()
        .resize(50, 50, { fit: 'inside' })
        .toBuffer({ resolveWithObject: true });
      const avg = data.reduce((sum, v) => sum + v, 0) / data.length;
      return avg;
    } catch (e) {
      AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, `[VideoProcessor] 封面亮度检测失败: ${e}`);
      return null;
    }
  }

  /**
   * 生成视频封面图（动态扫描 + 自动跳过黑帧）
   *
   * 策略：
   *   1. 取视频总时长 duration
   *   2. 从 startTime（默认 1s）开始，以 interval（默认 2s）为步长向 duration 方向扫描
   *   3. 每个候选时间点截取一帧，用 sharp 计算平均亮度
   *   4. 首帧亮度 >= brightnessThreshold → 直接返回
   *   5. 扫描到 duration * maxSampleRatio 仍未达标 → 取所有采样中最亮帧
   *   6. 后置验证：最亮帧仍 < 30（极暗）→ 删除文件返回空字符串，触发前端占位图标兜底
   *   7. 极端短视频 (< startTime) → 取中间位置截图
   *
   * @param videoPath    视频文件绝对路径
   * @param outputDir    封面输出目录
   * @param mediaId      媒体 ID，用于命名
   * @param startTime    起始扫描时间（秒），默认 1
   * @param interval     扫描间隔（秒），默认 2
   * @param brightnessThreshold  亮度阈值（0~255），默认 40
   * @param maxSampleRatio       最大扫描比例（0~1），默认 0.8
   */
  static async generateCover(
    videoPath: string,
    outputDir: string,
    mediaId: string,
    startTime: number = 1,
    interval: number = 2,
    brightnessThreshold: number = 40,
    maxSampleRatio: number = 0.8,
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

    // 极端短视频：取中间位置
    if (duration <= startTime) {
      const midPoint = parseFloat((duration / 2).toFixed(2));
      if (fs.existsSync(coverFullPath)) fs.unlinkSync(coverFullPath);

      const ok = await this.captureFrameAt(ffmpegExe, videoPath, coverFullPath, midPoint);
      if (!ok) return '';

      const brightness = await this.measureBrightness(coverFullPath);
      if (brightness !== null && brightness < 30) {
        AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, `[VideoProcessor] 短视频封面极暗 (${brightness.toFixed(1)})，返回空触发前端占位图标`);
        if (fs.existsSync(coverFullPath)) fs.unlinkSync(coverFullPath);
        return '';
      }
      AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[VideoProcessor] 短视频封面 seek=${midPoint}s 亮度=${brightness?.toFixed(1) ?? 'N/A'}`);
      return coverFileName;
    }

    // 常规视频：动态扫描候选时间点
    const maxSampleTime = duration * maxSampleRatio;
    const candidates: number[] = [];
    for (let t = startTime; t < maxSampleTime; t += interval) {
      candidates.push(parseFloat(t.toFixed(2)));
    }
    // 兜底：确保至少有一个候选点
    if (candidates.length === 0) {
      candidates.push(startTime);
    }

    let bestSeekTime = candidates[0];
    let bestBrightness = -1;

    for (const seekTime of candidates) {
      if (fs.existsSync(coverFullPath)) fs.unlinkSync(coverFullPath);

      const ok = await this.captureFrameAt(ffmpegExe, videoPath, coverFullPath, seekTime);
      if (!ok) continue;

      const brightness = await this.measureBrightness(coverFullPath);
      if (brightness === null) continue;

      if (brightness > bestBrightness) {
        bestBrightness = brightness;
        bestSeekTime = seekTime;
      }

      if (brightness >= brightnessThreshold) {
        AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[VideoProcessor] 封面合格 seek=${seekTime}s 亮度=${brightness.toFixed(1)}`);
        return coverFileName;
      }

      AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[VideoProcessor] 封面过暗 seek=${seekTime}s 亮度=${brightness.toFixed(1)}`);
    }

    // 全部候选均不达标，取最亮帧
    if (bestBrightness >= 0) {
      // 如果最亮帧不是最后一个扫描的，需要重新截取
      if (bestSeekTime !== candidates[candidates.length - 1]) {
        if (fs.existsSync(coverFullPath)) fs.unlinkSync(coverFullPath);
        await this.captureFrameAt(ffmpegExe, videoPath, coverFullPath, bestSeekTime);
      }

      // 后置验证：极暗封面直接放弃，触发前端占位图标兜底
      const finalBrightness = await this.measureBrightness(coverFullPath);
      if (finalBrightness !== null && finalBrightness < 30) {
        AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, `[VideoProcessor] 封面极暗 (${finalBrightness.toFixed(1)})，返回空触发前端占位图标`);
        if (fs.existsSync(coverFullPath)) fs.unlinkSync(coverFullPath);
        return '';
      }

      AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, `[VideoProcessor] 封面亮度始终不合格，返回最亮帧 seek=${bestSeekTime}s 亮度=${bestBrightness.toFixed(1)}`);
      return coverFileName;
    }

    return '';
  }

  /**
   * 快速封面截图：只截 1 帧（seek 1秒），不做亮度检测/多帧扫描
   * 用于导入时同步生成，避免封面闪烁（后台异步再跑完整 generateCover 优化为最亮帧）
   * @returns 成功返回封面文件名（如 media_xxx.jpg），失败返回空串
   */
  public static async generateCoverFast(
    videoPath: string,
    outputDir: string,
    mediaId: string,
  ): Promise<string> {
    const safeMediaId = mediaId.replace(/[^\w\-\u4e00-\u9fff]/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
    const coverFileName = `${safeMediaId}.jpg`;
    const coverFullPath = path.join(outputDir, coverFileName);
    const ffmpegExe = PathManager.getBinPath('ffmpeg.exe');

    if (!ffmpegExe || !fs.existsSync(ffmpegExe)) return '';
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const duration = await this.getDuration(videoPath);
    if (duration <= 0) return '';

    // seek 1 秒（短视频取中间位置避免黑屏）
    const seekTime = duration > 1 ? 1 : parseFloat((duration / 2).toFixed(2));
    if (fs.existsSync(coverFullPath)) fs.unlinkSync(coverFullPath);

    const ok = await this.captureFrameAt(ffmpegExe, videoPath, coverFullPath, seekTime);
    return ok ? coverFileName : '';
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
