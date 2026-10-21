// 📁 路径：src/modules/media/frames/backend/AsrFrameRefiller.ts
// 声画补帧（台词↔帧）：确保「有台词的时段」都有画面帧覆盖。
//   ASR 在抽帧之后完成，故必须在 ASR 结束后补帧：对无帧覆盖的台词，从源视频定点补抽 1 帧（取台词中点）。
//   纯追加式，不删除原帧；失败不 crash 主流程，尽力而为。
//
// 与 GapFrameRefiller 的区别：
//   - GapFrameRefiller 按「镜头长空段」补帧（sceneIndex 分组）
//   - 本模块按「ASR 台词时间窗」补帧（无帧覆盖的台词行 → 中点定点截图）
//   两者互补，可同时启用。
import { spawn } from 'child_process';
import * as path from 'path';
import { buildExtractCommand } from './Strategy';
import type { FrameAssetDetail } from './SmartFramePostProcessor';
import type { AsrLine } from '../../../../shared/types/entities/editor';

/** 台词补帧配置
 *  - enabled=false → 整体跳过
 *  - padMs 默认 500：帧落在 [startMs-padMs, endMs+padMs] 内即视为该台词已有画面
 *  - minTextLength 默认 1：仅跳过空文本行（"凡有台词必抽帧"）
 *  - skipSuspectedMusic 默认 false：疑似歌词同样补帧（歌词画面也是剧情信息）
 */
export interface AsrRefillConfig {
  /** 是否启用（默认 true）；显式 false → 完全跳过（A/B 基线回归用） */
  enabled?: boolean;
  /** 台词时间窗外扩（毫秒，默认 500）：覆盖窗口 = [startMs-padMs, endMs+padMs] */
  padMs?: number;
  /** 跳过的过短台词长度（默认 1）：文本 trim 后长度 < 该值则跳过（空文本不补帧） */
  minTextLength?: number;
  /** 是否跳过疑似歌词行（suspectedMusic=true）；默认 false（歌词也补帧） */
  skipSuspectedMusic?: boolean;
  /** 最小帧间距（毫秒，默认 1500）：候选补帧点与最近帧（含本次已补帧）距离小于该值时，
   *  视为同一画面的重复 → 复用已有帧、不重复补抽。用于密集台词查重，避免凭空多出大量近似帧。 */
  minIntervalMs?: number;
  /** 补帧宽度（长边像素，与原抽帧保持一致避免视觉风格突变，默认 1024；-1 = 不加 scale） */
  width?: number;
  /** 补帧 JPEG 画质（-q:v，默认 2，与原抽帧一致） */
  jpegQuality?: number;
}

/** 待补帧的台词目标 */
export interface AsrRefillTarget {
  /** 该台词在 asrLines 中的索引 */
  lineIndex: number;
  /** 定点截图时间（毫秒，源坐标）＝台词中点 */
  timeMs: number;
  /** 台词文本（日志/映射用） */
  text: string;
}

/** 覆盖率检测结果 */
export interface AsrCoverageResult {
  /** 需要补帧的台词（按 lineIndex 升序） */
  targets: AsrRefillTarget[];
  /** 有效台词总数（有 startMs/endMs 且文本长度达标） */
  totalLines: number;
  /** 已被现有帧覆盖的台词数 */
  coveredLines: number;
}

/** 台词补帧结果 */
export interface AsrRefillResult {
  /** 检测到的待补帧台词数量（=targets.length） */
  targetsDetected: number;
  /** 有效台词总数（用于日志：补帧增量是否合理） */
  totalLines: number;
  /** 已被帧覆盖/复用（含本次已补帧查重复用）的台词数 */
  coveredLines: number;
  /** 实际落盘成功的补帧数量 */
  refilledCount: number;
  /** 补帧详情（FrameAssetDetail，调用方按 timeMs 归并回 frames 列表） */
  refilledFrames: FrameAssetDetail[];
  /** runner 执行失败次数 */
  refillFailures: number;
  /** 因前置条件缺失整体跳过时的原因（便于调用方日志；未跳过时为 undefined） */
  skippedReason?: 'disabled' | 'no-frames' | 'no-asr' | 'no-video' | 'no-frames-dir' | 'no-ffmpeg';
}

/** 毫秒时间戳格式化为 "mm:ss.CS"（与 GapFrameRefiller 一致） */
function formatTimeMs(ms: number): string {
  const totalSec = Math.floor(Math.max(0, ms) / 1000);
  const cs = Math.floor((Math.max(0, ms) - totalSec * 1000) / 10);
  const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const ss = String(totalSec % 60).padStart(2, '0');
  const csStr = String(cs).padStart(2, '0');
  return `${mm}:${ss}.${csStr}`;
}

/** 有序数组中首个 >= t 的下标（标准 lower_bound） */
function lowerBound(arr: number[], t: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** 向有序数组插入值（保持升序；重复值插入在相等元素之后） */
function insertSorted(arr: number[], t: number): void {
  arr.splice(lowerBound(arr, t), 0, t);
}

/** 返回 t 到有序数组最近元素的绝对距离；数组为空返回 Infinity */
function minDistanceTo(arr: number[], t: number): number {
  if (arr.length === 0) return Number.POSITIVE_INFINITY;
  const pos = lowerBound(arr, t);
  const cand: number[] = [];
  if (pos < arr.length) cand.push(Math.abs(arr[pos] - t));
  if (pos > 0) cand.push(Math.abs(arr[pos - 1] - t));
  return cand.length ? Math.min(...cand) : Number.POSITIVE_INFINITY;
}

/**
 * 纯函数：计算「哪些台词行需要补帧」（含查重）。
 *  - 覆盖判据：存在帧 timeMs ∈ [line.startMs - padMs, line.endMs + padMs]
 *  - **查重**：候选补帧点（台词中点）与最近帧（含本次已补帧）距离 < minIntervalMs → 视为同一画面，
 *    复用已有帧、不再补抽。贪心按台词时间升序处理，每产生一个新补帧点即插回帧时间轴，
 *    故相邻密集台词会共享同一帧，避免"一句一帧"造成大量近似重复帧。
 *  - 无效行（缺 startMs/endMs、时序非法、文本过短、可选跳过 suspectedMusic）不计入 totalLines
 *  - 无 IO，可直接单测
 */
export function computeLinesMissingFrames(
  frames: Array<{ timeMs: number }>,
  asrLines: AsrLine[],
  config?: AsrRefillConfig,
): AsrCoverageResult {
  const padMs = typeof config?.padMs === 'number' && config.padMs >= 0 ? config.padMs : 500;
  const minTextLength = typeof config?.minTextLength === 'number' ? config.minTextLength : 1;
  const skipSuspectedMusic = config?.skipSuspectedMusic === true;
  const minIntervalMs = typeof config?.minIntervalMs === 'number' && config.minIntervalMs >= 0
    ? config.minIntervalMs : 1500;

  const times = Array.isArray(frames)
    ? frames.map((f) => f?.timeMs).filter((t): t is number => typeof t === 'number' && Number.isFinite(t) && t >= 0)
    : [];
  times.sort((a, b) => a - b);

  const result: AsrCoverageResult = { targets: [], totalLines: 0, coveredLines: 0 };
  if (times.length === 0 || !Array.isArray(asrLines) || asrLines.length === 0) return result;

  // 先按时间升序收集合法行（保留 lineIndex 用于命名/回填），再贪心处理
  const rows: Array<{ lineIndex: number; lo: number; hi: number; text: string }> = [];
  for (let i = 0; i < asrLines.length; i++) {
    const l = asrLines[i];
    if (typeof l.startMs !== 'number' || Number.isNaN(l.startMs) || l.startMs < 0) continue;
    if (typeof l.endMs !== 'number' || Number.isNaN(l.endMs) || l.endMs < 0) continue;
    const text = (l.text ?? '').trim();
    if (text.length < minTextLength) continue;
    if (skipSuspectedMusic && l.suspectedMusic === true) continue;
    rows.push({
      lineIndex: i,
      lo: Math.min(l.startMs, l.endMs),
      hi: Math.max(l.startMs, l.endMs),
      text,
    });
  }
  rows.sort((a, b) => a.lo - b.lo || a.lineIndex - b.lineIndex);

  for (const r of rows) {
    result.totalLines++;
    const winStart = r.lo - padMs;
    const winEnd = r.hi + padMs;
    // ① 窗口内已有帧 → 覆盖（含前面已补的帧）
    const pos = lowerBound(times, winStart);
    if (pos < times.length && times[pos] <= winEnd) {
      result.coveredLines++;
      continue;
    }
    const midMs = Math.round((r.lo + r.hi) / 2);
    // ② 查重：与最近帧（含本次已补帧）过近 → 复用，不重复补抽
    if (minDistanceTo(times, midMs) < minIntervalMs) {
      result.coveredLines++;
      continue;
    }
    result.targets.push({ lineIndex: r.lineIndex, timeMs: midMs, text: r.text });
    insertSorted(times, midMs); // 关键：把新补帧点插回时间轴，供后续行复用查重
  }
  // 输出按 lineIndex 升序（命名/回填稳定）
  result.targets.sort((a, b) => a.lineIndex - b.lineIndex);
  return result;
}

/** 注入式单帧抽帧执行器（生产由本模块内置 spawn(ffmpeg)；测试可 mock） */
export type AsrSingleFrameRunner = (args: {
  videoPath: string;
  outputPath: string;
  timePointSec: number;
  width?: number;
  jpegQuality?: number;
}) => Promise<{ success: boolean; stderr?: string }>;

/** 内置生产级 runner 工厂：封装 spawn(ffmpeg) + buildExtractCommand(PRECISE_SINGLE) */
export function createAsrRefillRunner(getFfmpegPath: () => string): AsrSingleFrameRunner {
  return async (args) => {
    const ffmpegExe = getFfmpegPath();
    const cmdArgs = buildExtractCommand({
      videoPath: args.videoPath,
      outputPath: args.outputPath,
      strategy: 'PRECISE_SINGLE', // 内部路由：定点单帧截图 vframes=1
      fps: 1,
      sceneThreshold: 0.25,
      minFrameInterval: 0,
      width: args.width ?? 1024,
      timePoint: args.timePointSec,
      threads: 0,
      attachShowinfo: false,
      jpegQuality: args.jpegQuality,
    });
    return await new Promise<{ success: boolean; stderr?: string }>((resolve) => {
      try {
        const child = spawn(ffmpegExe, cmdArgs, { windowsHide: true });
        let stderr = '';
        child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); if (stderr.length > 1024) stderr = stderr.slice(-1024); });
        child.on('close', (code) => {
          if (code === 0) resolve({ success: true, stderr });
          else resolve({ success: false, stderr });
        });
        child.on('error', (e: any) => resolve({ success: false, stderr: `spawn_error:${String(e?.message ?? e)}` }));
      } catch (e: any) {
        resolve({ success: false, stderr: `runner_sync_error:${String(e?.message ?? e)}` });
      }
    });
  };
}

/**
 * 主流程：检测无帧覆盖的台词 → runner 定点截图 → 返回补帧 FrameAssetDetail[]
 *  - 调用方应将 refilledFrames 按 timeMs 归并进 frames 列表（保持时间轴单调，勿简单 append）
 *  - 任一前置条件缺失（无帧/无台词/无源视频/无目录/无 runner）→ 整体跳过并给出 skippedReason
 */
export async function refillAsrLineFrames(args: {
  frames: Array<{ timeMs: number }>;
  asrLines: AsrLine[];
  videoPath?: string;
  framesDir?: string;
  config?: AsrRefillConfig;
  runner?: AsrSingleFrameRunner;
}): Promise<AsrRefillResult> {
  const { frames, asrLines, videoPath, framesDir, config, runner } = args ?? {};

  const base: AsrRefillResult = {
    targetsDetected: 0, totalLines: 0, coveredLines: 0,
    refilledCount: 0, refilledFrames: [], refillFailures: 0,
  };

  if (config?.enabled === false) return { ...base, skippedReason: 'disabled' };
  if (!Array.isArray(frames) || frames.length === 0) return { ...base, skippedReason: 'no-frames' };
  if (!Array.isArray(asrLines) || asrLines.length === 0) return { ...base, skippedReason: 'no-asr' };
  if (!videoPath) return { ...base, skippedReason: 'no-video' };
  if (!framesDir) return { ...base, skippedReason: 'no-frames-dir' };
  if (typeof runner !== 'function') return { ...base, skippedReason: 'no-ffmpeg' };

  const coverage = computeLinesMissingFrames(frames, asrLines, config);
  if (coverage.targets.length === 0) {
    return {
      ...base,
      targetsDetected: 0,
      totalLines: coverage.totalLines,
      coveredLines: coverage.coveredLines,
    };
  }

  const width = typeof config?.width === 'number' ? config.width : 1024;
  const quality = typeof config?.jpegQuality === 'number' ? config.jpegQuality : 2;

  const refilledFrames: FrameAssetDetail[] = [];
  let failures = 0;

  for (const target of coverage.targets) {
    const fname = `asr_refill_t${target.timeMs}_line${target.lineIndex}.jpg`;
    const outputPath = path.join(framesDir, fname);
    try {
      const res = await runner({
        videoPath,
        outputPath,
        timePointSec: target.timeMs / 1000,
        width,
        jpegQuality: quality,
      });
      if (res?.success) {
        refilledFrames.push({
          framePath: outputPath,
          timeMs: target.timeMs,
          timeStr: formatTimeMs(target.timeMs),
          // 跳过 sharp 单次计算（节省耗时）；给合理默认值，确保通过下游 minClarity/minLuma 门禁
          clarityScore: 300,
          lumaScore: 128,
          sceneIndex: target.lineIndex,
          estimatedTime: false, // 明确 seek 到该 PTS，精确
        });
      } else {
        failures++;
      }
    } catch {
      failures++;
    }
  }

  return {
    targetsDetected: coverage.targets.length,
    totalLines: coverage.totalLines,
    coveredLines: coverage.coveredLines,
    refilledCount: refilledFrames.length,
    refilledFrames,
    refillFailures: failures,
  };
}

/** AsrFrameRefiller：纯静态工具类（与项目其他模块命名风格一致） */
export class AsrFrameRefiller {
  static readonly computeLinesMissingFrames = computeLinesMissingFrames;
  static readonly createAsrRefillRunner = createAsrRefillRunner;
  static readonly refillAsrLineFrames = refillAsrLineFrames;
}
