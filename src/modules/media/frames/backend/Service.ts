// 📁 路径：src/modules/media/frames/backend/Service.ts
// 关键帧抽取服务：FFmpeg 抽帧执行 + 前置探针 + 自适应参数
// P0 · 契约收拢：策略枚举收为 AUTO_ADAPTIVE | UNIFORM_FPS，
// PRECISE_SINGLE 不再作为管线策略暴露，改由 screenshotAt 独立 API 消费。
//
// 依赖说明：
// - 本模块通过函数参数注入外部依赖（PathManager、AppLogger 等），
//   保持对 infra 的单向依赖，不直接 import 外部实现。

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { FrameStrategy, FrameExtractionTelemetry, DensityPreset } from '../types';
import { buildExtractCommand } from './Strategy';
import { SmartFramePostProcessor } from './SmartFramePostProcessor';
// P0：复用 frames/types 已 re-export 的契约唯一真源（含兼容映射）
import { normalizeFrameStrategy, DENSITY_PRESET_CONFIG } from '../types';
import { AppError, ErrorCode } from '../../../infra/error/AppError';

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
// P0 · 策略兼容归一化（替换旧 STRATEGY_MIGRATION）
// ──────────────────────────────────────────────

/** P0 兼容归一化：所有历史别名 → 2 值枚举
 *  ⚠️ 特殊：PRECISE_SINGLE 字符串会通过 normalize 变为 AUTO_ADAPTIVE；
 *  真正的定点截图逻辑必须在调用 extractFrames 前通过 PRECISE_SINGLE 守卫拦截，
 *  改走 screenshotAt 内部子流程（无需此守卫时可直接传 timePoint，但不推荐）。
 */
export function resolveStrategy(raw: string): FrameStrategy {
  return normalizeFrameStrategy(raw);
}

/** 判断是否为 PRECISE_SINGLE 历史输入（大小写/下划线兼容）
 *  true 时应拒绝进入抽帧主流程，提示走 screenshotAt 独立 API
 */
export function isPreciseSingleAlias(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const r = String(raw).trim().toLowerCase().replace(/[\s-]/g, '_');
  return r === 'precise_single' || r === 'precise' || r === 'precise_one' || r === 'single_frame';
}

// ──────────────────────────────────────────────
// 抽帧选项
// ──────────────────────────────────────────────

export interface ExtractOptions {
  strategy?: string;
  /** 均匀抽帧帧率（仅 UNIFORM_FPS 生效，AUTO_ADAPTIVE 下由 densityPreset 派生） */
  fps?: number;
  scale?: number;
  quality?: number;
  /** 场景变化阈值；AUTO_ADAPTIVE + densityPreset 提供时默认从预设派生 */
  sceneThreshold?: number;
  /** 最小帧间隔；AUTO_ADAPTIVE + densityPreset 提供时默认从预设派生 */
  minFrameInterval?: number;
  timePoint?: number;
  inPoint?: number;
  outPoint?: number;
  abortSignal?: AbortSignal;
  /** 追加式后处理：清晰度/黑屏过滤 + 静态去重 + 时序元数据 + 预算封顶（默认关闭，非破坏） */
  postProcess?: boolean;

  // ── P0 · 密度预设 + BudgetClipper 参数 ──────────────────────────────────────
  /** 抽帧密度预设（与 videoDuration 配合启用预算封顶）；前端选择档位时传递 */
  densityPreset?: DensityPreset;
  /** 显式 maxFrames 封顶（比 densityPreset 优先，调试或 UNIFORM_FPS 场景使用） */
  maxFrames?: number;
  /** BudgetClipper 超预算容忍度（默认 0.1） */
  budgetToleranceRatio?: number;
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
   * P0 后对外 2 大策略：AUTO_ADAPTIVE | UNIFORM_FPS
   * PRECISE_SINGLE 输入会抛守卫错误，建议走 screenshotAt 独立 API。
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
      sceneThreshold,
      minFrameInterval,
      timePoint,
      inPoint,
      outPoint,
      abortSignal,
      postProcess = false,
      densityPreset,
      maxFrames,
      budgetToleranceRatio,
    } = options;

    // P0 · PRECISE_SINGLE 守卫：定点截图不走批量抽帧，改走独立 screenshotAt API
    if (isPreciseSingleAlias(options.strategy)) {
      throw new AppError(
        ErrorCode.SYS_INVALID_INPUT,
        `[FrameExtraction] 策略 "${options.strategy}"（定点截图）已不再作为批量抽帧策略暴露。` +
        `如需指定时间点精准截图，请调用 screenshotAt(...) 独立 API。`
      );
    }

    const strategy = resolveStrategy(options.strategy || 'AUTO_ADAPTIVE');
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

    // P0 · densityPreset 派生默认 sceneThreshold / minFrameInterval（用户显式传值时仍优先）
    let effectiveSceneThreshold = sceneThreshold;
    let effectiveMinInterval = minFrameInterval;
    if (densityPreset && DENSITY_PRESET_CONFIG[densityPreset]) {
      const preset = DENSITY_PRESET_CONFIG[densityPreset];
      if (effectiveSceneThreshold === undefined || effectiveSceneThreshold === null) {
        effectiveSceneThreshold = preset.sceneThreshold;
      }
      if (effectiveMinInterval === undefined || effectiveMinInterval === null) {
        effectiveMinInterval = preset.minFrameInterval;
      }
    }
    // 仍未设置 → 回退到历史默认值
    if (effectiveSceneThreshold === undefined || effectiveSceneThreshold === null) effectiveSceneThreshold = 0.25;
    if (effectiveMinInterval === undefined || effectiveMinInterval === null) effectiveMinInterval = 3.5;

    // 长视频自适应（在 preset 派生后再施加，避免 preset 的 1.7s 高密档被意外放大）
    const probedDurationSec = probeResult.duration ?? 0;
    const actualIn = inPoint ?? 0;
    const actualOut = outPoint ?? probedDurationSec;
    const videoDurationSec = Math.max(0, actualOut - actualIn);
    let adaptiveMinInterval = effectiveMinInterval;
    let adaptiveScale = scale;
    if (videoDurationSec > 600) {
      // 长视频兜底只做放大（不小于 preset 派生）
      adaptiveMinInterval = Math.max(effectiveMinInterval, Math.max(4, Math.round(videoDurationSec / 600) * 2));
      adaptiveScale = Math.min(1024, Math.max(512, 1024 - Math.floor(videoDurationSec / 600) * 64));
    }

    const outputPattern = path.join(safeOutputDir, 'frame_%08d.jpg');

    const args = buildExtractCommand({
      videoPath,
      outputPath: outputPattern,
      strategy,
      fps,
      sceneThreshold: effectiveSceneThreshold,
      minFrameInterval: adaptiveMinInterval,
      width: adaptiveScale,
      quality,
      inPoint,
      outPoint,
      timePoint,
      threads: 0,
      // 后处理启用时附加 showinfo，捕获每帧精确 PTS
      attachShowinfo: postProcess,
    });

    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const child = spawn(ffmpegExe, args);

      let stderrLog = '';
      // 🎭 后处理时序元数据：累积 showinfo 输出的 pts_time（秒）
      const ptsSeconds: number[] = [];
      child.stderr.on('data', (data: Buffer) => {
        const text = data.toString();
        stderrLog += text;
        if (stderrLog.length > 2048) stderrLog = stderrLog.slice(-2048);
        if (postProcess) {
          const matches = text.match(/pts_time:([0-9.]+)/g);
          if (matches) {
            for (const m of matches) {
              const sec = parseFloat(m.replace('pts_time:', ''));
              if (!Number.isNaN(sec)) ptsSeconds.push(sec);
            }
          }
        }
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

          // 🎭 追加式后处理：清晰度/黑屏过滤 + 静态去重 + 时序元数据 + P0 预算封顶
          // 会直接删除被丢弃的帧文件，返回的 files 即为精选后的帧
          let keptFiles = files;
          let frameDetails: import('../types').FrameAssetDetail[] = [];
          if (postProcess && files.length > 0) {
            const ptsMs = ptsSeconds.map(s => Math.round(s * 1000));
            // ptsSeconds 不含文件名配对，仅当数量一致时才作为精确时间戳使用
            const exactPtsMs = files.length > 0 && ptsMs.length === files.length ? ptsMs : undefined;
            // P0：videoDurationMinutes 基于探针实际时长（考虑 in/out point）
            const videoDurationMinutes = videoDurationSec > 0 ? videoDurationSec / 60 : undefined;
            const result = await SmartFramePostProcessor.process(files, {
              strategy,
              fps,
              timePoint,
              ptsMs: exactPtsMs,
              // P0 BudgetClipper 参数：densityPreset + 时长分钟数 / maxFrames / tolerance
              densityPreset,
              videoDurationMinutes,
              maxFrames,
              toleranceRatio: budgetToleranceRatio,
              silentBudgetClipper: false,
            });
            keptFiles = result.kept.map(d => d.framePath);
            frameDetails = result.kept;
            if (result.dropped.length > 0) {
              console.log(
                `[FrameExtraction] 后处理过滤 ${result.dropped.length}/${files.length} 帧: ` +
                result.dropped.map(d => d.reason).join('; '),
              );
            }
          }

          const fileStats = await Promise.all(
            keptFiles.map(f => fs.promises.stat(f).catch(() => ({ size: 0 }))),
          );
          const totalSizeBytes = fileStats.reduce((acc, curr) => acc + curr.size, 0);
          const frameCount = keptFiles.length;
          const totalSizeMB = Number((totalSizeBytes / (1024 * 1024)).toFixed(2));
          const processingFps = durationMs > 0 ? Number((frameCount / (durationMs / 1000)).toFixed(2)) : 0;

          resolve({
            files: keptFiles,
            metrics: { durationMs, frameCount, totalSizeMB, processingFps },
            frameDetails,
          });
        } catch (err) {
          // 错就错：后处理失败必须暴露，禁止静默返回空帧掩盖根因
          console.error('[FrameExtraction] 抽帧/后处理失败，返回空结果:', err);
          resolve(emptyTelemetry);
        }
      });

      child.on('error', () => resolve(emptyTelemetry));
    });
  }
}
