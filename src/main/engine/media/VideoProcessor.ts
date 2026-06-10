// 📁 路径：src/main/engine/media/VideoProcessor.ts
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { PathManager } from '../../utils/pathManager';
import { ProcessManager } from '../../utils/processManager';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '../../../shared/utils/LogConstants';
import {
  buildExtractCommand,
  buildCoverCommand,
  buildProbeCommand,
  type ExtractConfig,
  type FrameStrategy,
} from './FFmpegCommandBuilder';

/** 抽帧选项（对外接口，兼容旧策略名 + 新策略名） */
export interface FrameExtractionOptions {
  inPoint?: number;
  outPoint?: number;
  fps?: number;
  scale?: number;
  quality?: number;
  /** 旧策略名（向后兼容）：uniform / keyframe / scene */
  strategy?: 'uniform' | 'keyframe' | 'scene' | 'VLM_OPTIMIZED' | 'UNIFORM_FPS' | 'FAST_KEYFRAME' | 'PRECISE_SINGLE';
  /** 场景变化阈值 */
  sceneThreshold?: number;
  /** VLM 模式最小帧间隔（秒），默认 4 */
  minFrameInterval?: number;
  /** 精准截图时间点（秒），仅 PRECISE_SINGLE 策略 */
  timePoint?: number;
  abortSignal?: AbortSignal;
}

/** 抽帧遥测结果 */
export interface FrameExtractionTelemetry {
  files: string[];
  metrics: {
    durationMs: number;
    frameCount: number;
    totalSizeMB: number;
    processingFps: number;
  };
}

/** 旧策略名到新策略名的映射表 */
const STRATEGY_MIGRATION: Record<string, FrameStrategy> = {
  uniform: 'UNIFORM_FPS',
  keyframe: 'FAST_KEYFRAME',
  iframe: 'FAST_KEYFRAME',
  scene: 'VLM_OPTIMIZED',
  vlm_optimized: 'VLM_OPTIMIZED',
  uniform_fps: 'UNIFORM_FPS',
  fast_keyframe: 'FAST_KEYFRAME',
  precise_single: 'PRECISE_SINGLE',
};

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
   * 使用 buildExtractCommand 结构化生成 FFmpeg 参数，杜绝字符串拼接
   * 支持四大策略：VLM_OPTIMIZED / UNIFORM_FPS / FAST_KEYFRAME / PRECISE_SINGLE
   */
  public static async extractFrames(
    filePath: string, outputDir: string, mediaId: string,
    options: FrameExtractionOptions = {}
  ): Promise<FrameExtractionTelemetry> {
    const {
      inPoint, outPoint, fps = 1, scale = 1024, quality = 3,
      sceneThreshold = 0.28, minFrameInterval = 4, timePoint,
      abortSignal,
    } = options;

    /** 旧策略名自动迁移到新策略名 */
    const rawStrategy = options.strategy || 'VLM_OPTIMIZED';
    const strategy: FrameStrategy = STRATEGY_MIGRATION[rawStrategy] || rawStrategy as FrameStrategy;

    /** 安全化 mediaId，防止特殊字符导致路径问题 */
    const safeMediaId = mediaId.replace(/[^\w\-\u4e00-\u9fff]/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
    const safeOutputDir = outputDir.replace(mediaId, safeMediaId);

    /** 💥 重新抽帧前清除旧帧文件，防止新旧帧混合导致数量异常 */
    if (fs.existsSync(safeOutputDir)) {
      const oldFrames = fs.readdirSync(safeOutputDir).filter(f => f.endsWith('.jpg'));
      for (const f of oldFrames) {
        try { fs.unlinkSync(path.join(safeOutputDir, f)); } catch {}
      }
      if (oldFrames.length > 0) {
        AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[VideoProcessor] 已清除 ${oldFrames.length} 张旧帧`, { outputDir: safeOutputDir });
      }
    }

    if (!fs.existsSync(safeOutputDir)) fs.mkdirSync(safeOutputDir, { recursive: true });
    const ffmpegExe = PathManager.getBinPath('ffmpeg.exe');
    const emptyTelemetry: FrameExtractionTelemetry = { files: [], metrics: { durationMs: 0, frameCount: 0, totalSizeMB: 0, processingFps: 0 } };
    if (!fs.existsSync(ffmpegExe)) return emptyTelemetry;

    /** ffprobe 前置探针 — 校验视频流存在、时长>0、编码兼容，1秒内拦截无效输入 */
    const probeResult = await VideoProcessor.probeVideo(filePath);
    if (!probeResult.valid) {
      AppLogger.error(LOG_TAGS.MEDIA_ENGINE, `[VideoProcessor] 前置探针拦截：${probeResult.reason}`, { filePath });
      return emptyTelemetry;
    }

    /** 标准化顺序命名输出模式 */
    const outputPattern = path.join(safeOutputDir, 'frame_%08d.jpg');

    /** 长电影自适应：根据视频时长动态调整 minFrameInterval 和 scale */
    const videoDurationSec = (outPoint ?? Infinity) - (inPoint ?? 0);
    let adaptiveMinInterval = minFrameInterval ?? 4;
    let adaptiveScale = scale ?? 1024;
    if (videoDurationSec > 600) {
      /** 超过10分钟的视频，逐步放宽间隔和降低分辨率 */
      adaptiveMinInterval = Math.min(15, Math.max(4, Math.round(videoDurationSec / 600) * 2));
      adaptiveScale = Math.min(1024, Math.max(512, 1024 - Math.floor(videoDurationSec / 600) * 64));
      AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[VideoProcessor] 长视频自适应: ${Math.round(videoDurationSec)}s → minInterval=${adaptiveMinInterval}s, scale=${adaptiveScale}px`);
    }

    /** 使用结构化 Builder 生成命令参数，杜绝裸字符串拼接 */
    const args = buildExtractCommand({
      videoPath: filePath,
      outputPath: outputPattern,
      strategy,
      fps,
      sceneThreshold,
      minFrameInterval: adaptiveMinInterval,
      width: adaptiveScale,
      quality,
      inPoint,
      outPoint,
      timePoint,
      threads: 0,  // 0 = FFmpeg 自动选择最优线程数
    });

    AppLogger.info(LOG_TAGS.MEDIA_ENGINE, '[VideoProcessor] FFmpeg 抽帧启动', {
      strategy, fps, sceneThreshold, minFrameInterval, width: scale, quality,
    });

    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const child = spawn(ffmpegExe, args);

      /** 捕获 stderr 用于错误诊断 */
      let stderrLog = '';
      child.stderr.on('data', (data: Buffer) => {
        stderrLog += data.toString();
        if (stderrLog.length > 2048) stderrLog = stderrLog.slice(-2048);
      });

      if (abortSignal) {
        const onAbort = () => { child.kill('SIGKILL'); reject(new Error('TASK_ABORTED')); };
        abortSignal.addEventListener('abort', onAbort);
        child.on('close', () => abortSignal.removeEventListener('abort', onAbort));
        child.on('error', () => abortSignal.removeEventListener('abort', onAbort));
      }

      child.on('close', async (code) => {
        const durationMs = Date.now() - startTime;
        /** FFmpeg 非零退出码精细化处理 */
        if (code !== 0 && code !== null) {
          const stderrTail = stderrLog.slice(-500);
          /** 区分"空输出但非错误"和"真实错误" */
          const isEmptyOutput = stderrLog.includes('received no packets')
            || stderrLog.includes('Nothing was written')
            || stderrLog.includes('Output file is empty');
          if (isEmptyOutput) {
            /** 空输出：视频太短或无有效帧，非致命错误，返回空遥测 */
            AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, `[VideoProcessor] FFmpeg 空输出(非致命, code=${code})`, { stderr: stderrTail });
          } else {
            /** 真实错误：编码不支持、文件损坏等，记录详细日志 */
            AppLogger.error(LOG_TAGS.MEDIA_ENGINE, `[VideoProcessor] FFmpeg 异常退出(code=${code})`, { stderr: stderrTail });
          }
          resolve(emptyTelemetry);
          return;
        }
        try {
          const files = fs.readdirSync(safeOutputDir)
                          .filter(f => f.endsWith('.jpg'))
                          .map(f => path.join(safeOutputDir, f))
                          .sort();

          const fileStats = await Promise.all(files.map(f => fs.promises.stat(f).catch(() => ({ size: 0 }))));
          const totalSizeBytes = fileStats.reduce((acc, curr) => acc + curr.size, 0);

          const frameCount = files.length;
          const totalSizeMB = Number((totalSizeBytes / (1024 * 1024)).toFixed(2));
          const processingFps = durationMs > 0 ? Number((frameCount / (durationMs / 1000)).toFixed(2)) : 0;

          AppLogger.info(LOG_TAGS.MEDIA_ENGINE, '[VideoProcessor] 抽帧完成', {
            strategy, frameCount, totalSizeMB, durationMs, processingFps,
          });

          resolve({
             files,
             metrics: { durationMs, frameCount, totalSizeMB, processingFps }
          });
        } catch (e) {
          resolve(emptyTelemetry);
        }
      });
      child.on('error', () => resolve(emptyTelemetry));
    });
  }

}
