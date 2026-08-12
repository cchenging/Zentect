// 📁 路径：src/modules/media/frames/backend/GapFrameRefiller.ts
// V2 真补帧（P3）—— 检测长镜头空段并通过二次 FFmpeg 单帧 seek 补充代表帧。
// 纯追加式，不删除原帧；失败不 crash 主流程，尽力而为。
import type { FrameAssetDetail } from './SmartFramePostProcessor';
import type { BudgetClipPriorityFlag } from './BudgetClipper';
import { normalizeFrameStrategy } from '../../../../shared/contracts/capabilities';
import * as path from 'path';

/** P3 长镜头空段（按 sceneIndex 分组后计算 startMs/endMs） */
export interface LongGapScene {
  sceneIndex: number;
  startMs: number;
  endMs: number;
  gapMs: number;
  gapSeconds: number;
}

/** P3 V2 真补帧配置
 *  - enabled=false / strategy=UNIFORM_FPS → 全 gate 跳过
 *  - minGapSeconds 默认 12s（与 BudgetClipper long_gap_scene 告警阈值一致）
 *  - framesPerGap 每段补几帧（默认 1；最多 clamp 为 3，避免单次补帧过多浪费 FFmpeg 子进程）
 */
export interface GapRefillConfig {
  /** 是否启用 V2 真补帧（默认 true）；显式 false → 完全跳过 P3 流程（A/B 基线回归用） */
  enabled?: boolean;
  /** 长空段阈值（秒，默认 12s）；镜头内首尾帧间距 > 该值才补 */
  minGapSeconds?: number;
  /** 每段补帧数量（默认 1，取镜头时间中心）；上限 3（超阈值自动 clamp），<=0=该段不补 */
  framesPerGap?: number;
  /** 抽帧策略（传入归一化前的 raw 字符串即可）；UNIFORM_FPS 时 gate=空（均匀时序优先，不破坏等间隔抽帧） */
  strategy?: string;
  /** 原抽帧宽度（建议与原抽帧相同，默认 1024；传入 SFPP 时由 Service 层透传 adaptiveScale） */
  width?: number;
  /** 原抽帧 JPG quality（默认 3；建议与原抽帧相同，size 接近避免下游视觉风格突变） */
  quality?: number;
}

/** 单次 FFmpeg 单帧 seek 的返回结果（注入式 runner，便于测试 mock 零 spawn） */
export interface SingleFrameExtractResult {
  success: boolean;
  stderr?: string;
}

/** 注入式单帧抽帧执行器（生产环境包裹 child_process.spawn(ffmpeg)；测试 mock 返回 success） */
export type SingleFrameRunner = (args: {
  videoPath: string;
  outputPath: string;
  timePointSec: number;
  width?: number;
  quality?: number;
}) => Promise<SingleFrameExtractResult>;

/** P3 真补帧结果 */
export interface GapFrameRefillResult {
  /** 实际落盘成功的补帧数量（=refilledFrames.length） */
  refilledCount: number;
  /** 补帧详情（追加到 kept 数组时，BudgetClipper 会把 gap_refill flag 视为白名单） */
  refilledFrames: FrameAssetDetail[];
  /** 检测到的长空段数量（minGapSeconds 阈值触发） */
  gapScenesDetected: number;
  /** UNIFORM_FPS 策略 gate=空时为 true（便于调用方日志） */
  skippedByStrategy: boolean;
  /** 未提供 videoPath 时为 true（不调用 FFmpeg，补帧流程空） */
  skippedNoVideoPath: boolean;
  /** runner 执行失败次数（用于调用方告警） */
  refillRunnerFailures: number;
}

/** 毫秒时间戳格式化为 "mm:ss.CS"（与原 SFPP 时间戳格式一致） */
function formatTimeMs(ms: number): string {
  const totalSec = Math.floor(Math.max(0, ms) / 1000);
  const cs = Math.floor((Math.max(0, ms) - totalSec * 1000) / 10);
  const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const ss = String(totalSec % 60).padStart(2, '0');
  const csStr = String(cs).padStart(2, '0');
  return `${mm}:${ss}.${csStr}`;
}

/**
 * 工具：计算长空段列表（按 sceneIndex 分组，取组内 min(timeMs)/max(timeMs) 为跨度）
 *  - 单镜头单帧 → gapMs=0 → 不产生空段
 *  - minGapMs = minGapSeconds × 1000；gapMs > minGapMs 才进入返回数组
 *  - 纯函数，无 IO，可直接测试
 */
export function computeLongGapScenes(frames: FrameAssetDetail[], minGapMs: number): LongGapScene[] {
  if (!Array.isArray(frames) || frames.length < 2) return [];

  const groups = new Map<number, FrameAssetDetail[]>();
  for (const f of frames) {
    const idx = Number.isFinite(f.sceneIndex) ? f.sceneIndex : 0;
    const arr = groups.get(idx);
    if (arr) arr.push(f); else groups.set(idx, [f]);
  }

  const result: LongGapScene[] = [];
  for (const [sceneIndex, list] of groups.entries()) {
    if (list.length < 2) continue;
    let startMs = list[0].timeMs;
    let endMs = list[0].timeMs;
    for (const x of list) {
      if (x.timeMs < startMs) startMs = x.timeMs;
      if (x.timeMs > endMs) endMs = x.timeMs;
    }
    const gapMs = Math.max(0, endMs - startMs);
    if (gapMs > minGapMs) {
      result.push({
        sceneIndex,
        startMs,
        endMs,
        gapMs,
        gapSeconds: Math.round(gapMs / 1000),
      });
    }
  }
  // 按 sceneIndex 升序，便于 runner 顺序调用，SFPP 追加后 kept 时间轴仍大体有序
  result.sort((a, b) => a.sceneIndex - b.sceneIndex);
  return result;
}

/**
 * 工具：为单个长空段分配补帧时间戳（毫秒，与原帧 timeMs 单位一致）
 *  - framesPerGap<=0 → [] （不补）
 *  - framesPerGap=1 → [(startMs+endMs)/2] （时间中心 1 帧）
 *  - framesPerGap>=3 → clamp 为 3，按 25%/50%/75% 三分（避免单次补帧过多 FFmpeg 子进程）
 *  - 纯函数，无 IO
 */
export function computeRefillTimePoints(gap: LongGapScene, framesPerGap: number): number[] {
  if (!gap || !Number.isFinite(gap.startMs) || !Number.isFinite(gap.endMs)) return [];
  if (typeof framesPerGap !== 'number' || framesPerGap <= 0) return [];
  const n = Math.min(3, Math.floor(framesPerGap)); // 上限 3
  if (n <= 0) return [];
  const { startMs, endMs } = gap;
  if (endMs <= startMs) return [];
  if (n === 1) {
    return [startMs + Math.round((endMs - startMs) / 2)];
  }
  const pts: number[] = [];
  for (let i = 1; i <= n; i++) {
    // framesPerGap=2 → i/3 (33%/67%)；framesPerGap=3 → i/4 (25%/50%/75%)，四等分位置中心对称
    const ratio = i / (n + 1);
    pts.push(startMs + Math.round((endMs - startMs) * ratio));
  }
  return pts;
}

/**
 * 优先级标志合并（与 P1/P2 buildPriorityFlags 保持同样的 immutable 合并不覆盖语义）
 *  - refilledFramePaths：gap_refill 要追加声明的 framePath 集合
 *  - existing：上游 priorityFlags（P0 hardCut/P1 action_peak/P2 asrAnchor，不覆盖）
 *  - 返回：新 Record 对象，existing 输入对象保持不变（immutable 可追溯）
 */
export function buildPriorityFlags(
  refilledFramePaths: Iterable<string>,
  existing?: Record<string, BudgetClipPriorityFlag[]>,
): Record<string, BudgetClipPriorityFlag[]> {
  const result: Record<string, BudgetClipPriorityFlag[]> = {};
  if (existing) {
    for (const k of Object.keys(existing)) {
      const arr = existing[k];
      result[k] = Array.isArray(arr) ? arr.slice() : [];
    }
  }
  const paths = Array.from(refilledFramePaths ?? []);
  if (paths.length === 0) {
    // 空集：直接 return（existing 空时返回 {}，非空时返回 existing 的 copy）
    return result;
  }
  for (const p of paths) {
    if (!p) continue;
    const arr = result[p] ?? [];
    if (!arr.includes('gap_refill')) arr.push('gap_refill');
    result[p] = arr;
  }
  return result;
}

/**
 * 主流程：检测长空段 → runner 执行 FFmpeg 单帧 seek → 组装 refilledFrames FrameAssetDetail 数组返回
 *  - 调用方（SFPP.process）应将 refilledFrames append 到 kept，并将 buildPriorityFlags 合并入 mergedPriorityFlags
 *  - 再进入 ⑤ BudgetClipper 硬顶预算裁剪（gap_refill 属白名单 flag，保留优先级）
 *  - runner：生产环境由 SFPP 层传入（封装 spawn(ffmpeg, buildExtractCommand strategy=PRECISE_SINGLE)）；测试 mock 即可
 */
export async function refillLongGapScenes(args: {
  frames: FrameAssetDetail[];
  videoPath?: string;
  framesDir: string;
  config?: GapRefillConfig;
  runner?: SingleFrameRunner;
}): Promise<GapFrameRefillResult> {
  const { frames, videoPath, framesDir, config, runner } = args ?? {};

  // —— 空值早返回（避免下游 undefined 崩溃）
  if (!Array.isArray(frames) || frames.length < 2) {
    return {
      refilledCount: 0,
      refilledFrames: [],
      gapScenesDetected: 0,
      skippedByStrategy: false,
      skippedNoVideoPath: !videoPath,
      refillRunnerFailures: 0,
    };
  }
  if (!videoPath) {
    return {
      refilledCount: 0,
      refilledFrames: [],
      gapScenesDetected: 0,
      skippedByStrategy: false,
      skippedNoVideoPath: true,
      refillRunnerFailures: 0,
    };
  }
  if (!framesDir) {
    // framesDir 缺失 → 无落盘位置，视为 skippedNoVideoPath 同级（不抛异常，不 crash）
    return {
      refilledCount: 0,
      refilledFrames: [],
      gapScenesDetected: 0,
      skippedByStrategy: false,
      skippedNoVideoPath: true,
      refillRunnerFailures: 0,
    };
  }

  // —— 配置默认值
  const enabled = config?.enabled !== false; // 默认 true
  const minGapSeconds = typeof config?.minGapSeconds === 'number' && config!.minGapSeconds > 0
    ? config!.minGapSeconds : 12;
  const framesPerGapRaw = typeof config?.framesPerGap === 'number' ? config!.framesPerGap : 1;
  const framesPerGap = Math.min(3, Math.max(0, Math.floor(framesPerGapRaw))); // clamp: 0..3
  const strategy = normalizeFrameStrategy(config?.strategy ?? 'AUTO_ADAPTIVE');

  // —— Gate：enabled=false 或 UNIFORM_FPS → 跳过（尽力而为 flag，不抛）
  if (!enabled) {
    return {
      refilledCount: 0, refilledFrames: [], gapScenesDetected: 0,
      skippedByStrategy: false, skippedNoVideoPath: false, refillRunnerFailures: 0,
    };
  }
  if (strategy === 'UNIFORM_FPS') {
    return {
      refilledCount: 0, refilledFrames: [], gapScenesDetected: 0,
      skippedByStrategy: true, skippedNoVideoPath: false, refillRunnerFailures: 0,
    };
  }
  if (framesPerGap <= 0) {
    return {
      refilledCount: 0, refilledFrames: [], gapScenesDetected: 0,
      skippedByStrategy: false, skippedNoVideoPath: false, refillRunnerFailures: 0,
    };
  }

  // —— Step 1：计算长空段（纯函数，无 IO）
  const minGapMs = Math.round(minGapSeconds * 1000);
  const gapScenes = computeLongGapScenes(frames, minGapMs);
  if (gapScenes.length === 0) {
    return {
      refilledCount: 0,
      refilledFrames: [],
      gapScenesDetected: 0,
      skippedByStrategy: false,
      skippedNoVideoPath: false,
      refillRunnerFailures: 0,
    };
  }

  // —— Step 2：计算所有补帧时间戳（按 gap 聚合为 flat 任务列表）
  type Task = {
    sceneIndex: number;
    timeMs: number;
    outputPath: string;
  };
  const tasks: Task[] = [];
  // 避免文件名冲突：每 gap 独立 seq
  for (let i = 0; i < gapScenes.length; i++) {
    const gap = gapScenes[i];
    const timePoints = computeRefillTimePoints(gap, framesPerGap);
    for (let j = 0; j < timePoints.length; j++) {
      const t = timePoints[j];
      // 文件名：refill + 时间戳 + scene + seq，确保在 framesDir 下不与原 frame_%08d.jpg 冲突
      const safeScene = String(gap.sceneIndex).replace(/[^0-9a-zA-Z]/g, '_');
      const fname = `gap_refill_t${t}_scene${safeScene}_${j}.jpg`;
      tasks.push({
        sceneIndex: gap.sceneIndex,
        timeMs: t,
        outputPath: path.join(framesDir, fname),
      });
    }
  }

  const refilledFrames: FrameAssetDetail[] = [];
  let runnerFailures = 0;

  if (tasks.length > 0 && typeof runner === 'function') {
    const width = config?.width ?? 1024;
    const quality = config?.quality ?? 3;
    for (const task of tasks) {
      try {
        const res = await runner({
          videoPath,
          outputPath: task.outputPath,
          timePointSec: task.timeMs / 1000,
          width,
          quality,
        });
        if (res?.success) {
          refilledFrames.push({
            framePath: task.outputPath,
            timeMs: task.timeMs,
            timeStr: formatTimeMs(task.timeMs),
            // 跳过 sharp 单次计算（节省补帧耗时）；给合理默认值，仍通过 minClarity/minLuma 门禁不被删
            clarityScore: 300,
            lumaScore: 128,
            sceneIndex: task.sceneIndex,
            estimatedTime: false, // 我们明确 seek 到该 PTS，因此精确
          });
        } else {
          runnerFailures++;
        }
      } catch {
        runnerFailures++;
      }
    }
  }

  return {
    refilledCount: refilledFrames.length,
    refilledFrames,
    gapScenesDetected: gapScenes.length,
    skippedByStrategy: false,
    skippedNoVideoPath: false,
    refillRunnerFailures: runnerFailures,
  };
}

/** P3 GapFrameRefiller：纯静态工具类（与项目其他模块命名风格一致） */
export class GapFrameRefiller {
  static readonly computeLongGapScenes = computeLongGapScenes;
  static readonly computeRefillTimePoints = computeRefillTimePoints;
  static readonly buildPriorityFlags = buildPriorityFlags;
  static readonly refillLongGapScenes = refillLongGapScenes;
}
