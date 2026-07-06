// 📁 路径：src/modules/media/frames/backend/Service.ts
// 关键帧抽取服务：FFmpeg 抽帧执行 + 前置探针 + 自适应参数
//
// 依赖说明：
// - 本模块通过函数参数注入外部依赖（PathManager、AppLogger 等），
//   保持对 infra 的单向依赖，不直接 import 外部实现。

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { FrameStrategy, FrameExtractionTelemetry } from '../types';
import { buildExtractCommand } from './Strategy';

// ──────────────────────────────────────────────
// 外部依赖注入接口
// ──────────────────────────────────────────────

export interface FrameExtractionDeps {
  /** 获取 ffmpeg.exe 绝对路径 */
  getFfmpegPath: () => string;
  /** 获取 ffprobe.exe 绝对路径 */
  getFfprobePath: () => string;
}

// ──────────────────────────────────────────────
// 旧策略名映射表
// ──────────────────────────────────────────────

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

export function resolveStrategy(raw: string): FrameStrategy {
  return STRATEGY_MIGRATION[raw] || (raw as FrameStrategy);
}

// ──────────────────────────────────────────────
// 抽帧选项
// ──────────────────────────────────────────────

export interface ExtractOptions {
  strategy?: string;
  fps?: number;
  scale?: number;
  quality?: number;
  sceneThreshold?: number;
  minFrameInterval?: number;
  timePoint?: number;
  inPoint?: number;
  outPoint?: number;
  abortSignal?: AbortSignal;
}

// ──────────────────────────────────────────────
// 服务类
// ──────────────────────────────────────────────

export class FrameExtractionService {
  private readonly deps: FrameExtractionDeps;

  constructor(deps: FrameExtractionDeps) {
    this.deps = deps;
  }

  /**
   * 前置探针：校验视频流存在、时长>0、编码兼容
   * 在抽帧前 1 秒内拦截无效输入，避免浪费 FFmpeg 进程
   */
  async probeVideo(filePath: string): Promise<{
    valid: boolean;
    reason?: string;
    duration?: number;
    width?: number;
    height?: number;
  }> {
    const ffprobeExe = this.deps.getFfprobePath();
    if (!fs.existsSync(ffprobeExe)) {
      return { valid: true };
    }
    if (!fs.existsSync(filePath)) {
      return { valid: false, reason: '物理文件不存在' };
    }

    return new Promise((resolve) => {
      const args = [
        '-v', 'quiet', '-print_format', 'json',
        '-show_format', '-show_streams', filePath,
      ];
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
    });
  }

  /**
   * 视频抽帧（核心方法）
   *
   * 支持四大策略：VLM_OPTIMIZED / UNIFORM_FPS / FAST_KEYFRAME / PRECISE_SINGLE
   */
  async extractFrames(
    videoPath: string,
    outputDir: string,
    mediaId: string,
    options: ExtractOptions = {},
  ): Promise<FrameExtractionTelemetry> {
    const {
      fps = 2,
      scale = 1024,
      quality = 3,
      sceneThreshold = 0.28,
      minFrameInterval = 4,
      timePoint,
      inPoint,
      outPoint,
      abortSignal,
    } = options;

    const strategy = resolveStrategy(options.strategy || 'VLM_OPTIMIZED');
    const safeMediaId = mediaId.replace(/[^\w\-\u4e00-\u9fff]/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
    const safeOutputDir = outputDir.replace(mediaId, safeMediaId);

    const emptyTelemetry: FrameExtractionTelemetry = {
      files: [],
      metrics: { durationMs: 0, frameCount: 0, totalSizeMB: 0, processingFps: 0 },
    };

    // 清除旧帧
    if (fs.existsSync(safeOutputDir)) {
      const oldFrames = fs.readdirSync(safeOutputDir).filter(f => f.endsWith('.jpg'));
      for (const f of oldFrames) {
        try { fs.unlinkSync(path.join(safeOutputDir, f)); } catch {}
      }
    }

    if (!fs.existsSync(safeOutputDir)) {
      fs.mkdirSync(safeOutputDir, { recursive: true });
    }

    const ffmpegExe = this.deps.getFfmpegPath();
    if (!fs.existsSync(ffmpegExe)) return emptyTelemetry;

    // 前置探针
    const probeResult = await this.probeVideo(videoPath);
    if (!probeResult.valid) {
      return emptyTelemetry;
    }

    // 长视频自适应
    const videoDurationSec = (outPoint ?? Infinity) - (inPoint ?? 0);
    let adaptiveMinInterval = minFrameInterval;
    let adaptiveScale = scale;
    if (videoDurationSec > 600) {
      adaptiveMinInterval = Math.min(15, Math.max(4, Math.round(videoDurationSec / 600) * 2));
      adaptiveScale = Math.min(1024, Math.max(512, 1024 - Math.floor(videoDurationSec / 600) * 64));
    }

    const outputPattern = path.join(safeOutputDir, 'frame_%08d.jpg');

    const args = buildExtractCommand({
      videoPath,
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
      threads: 0,
    });

    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const child = spawn(ffmpegExe, args);

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
        if (code !== 0 && code !== null) {
          const isEmptyOutput = stderrLog.includes('received no packets')
            || stderrLog.includes('Nothing was written')
            || stderrLog.includes('Output file is empty');
          if (!isEmptyOutput) {
            resolve(emptyTelemetry);
            return;
          }
          resolve(emptyTelemetry);
          return;
        }

        try {
          const files = fs.readdirSync(safeOutputDir)
            .filter(f => f.endsWith('.jpg'))
            .map(f => path.join(safeOutputDir, f))
            .sort();

          const fileStats = await Promise.all(
            files.map(f => fs.promises.stat(f).catch(() => ({ size: 0 }))),
          );
          const totalSizeBytes = fileStats.reduce((acc, curr) => acc + curr.size, 0);
          const frameCount = files.length;
          const totalSizeMB = Number((totalSizeBytes / (1024 * 1024)).toFixed(2));
          const processingFps = durationMs > 0 ? Number((frameCount / (durationMs / 1000)).toFixed(2)) : 0;

          resolve({
            files,
            metrics: { durationMs, frameCount, totalSizeMB, processingFps },
          });
        } catch {
          resolve(emptyTelemetry);
        }
      });

      child.on('error', () => resolve(emptyTelemetry));
    });
  }
}
