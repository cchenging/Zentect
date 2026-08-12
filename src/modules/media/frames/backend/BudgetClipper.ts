// 📁 路径：src/modules/media/frames/backend/BudgetClipper.ts
// P0 · 预算封顶裁剪器：保证 AUTO_ADAPTIVE 全片总帧数受 densityPreset 硬上限约束，
// 同时遵守首帧/末帧/硬切帧/ASR 吸附帧的保留优先权（fitness function 不变式）。
//
// 裁剪算法（最小破坏）：
//   1. 白名单分离：priorityFlags 中含 hardCut / asrAnchor / p1DeltaIntraShot 的帧
//      + 数组首帧 + 数组末帧  →  一律进入 whitelist（100% 保留，永不裁剪）
//   2. 预算计算：maxFrames = videoDurationMin × framesPerMinute；容差上限 = maxFrames × (1 + 0.1)
//   3. 白名单超容差：仅打印告警，绝不裁剪白名单（宁可略超预算也不破坏架构不变式）
//   4. 总帧 ≤ 容差上限  →  全保留（不做无谓裁剪，不破坏动作连续性）
//   5. 否则，candidate 池按时间轴均匀步长采样，目标数量 = 容差上限 − whitelist.length
//      candidate 的索引 i 映射为保留下标：round(i × step)，step = candidate.length / targetCount
//   6. 输出 kept / dropped 及裁剪原因；调用方负责 unlink dropped 文件

import type { DensityPreset, FrameAssetDetail } from '../types';
import { DENSITY_PRESET_CONFIG } from '../types';

/** 帧保留优先权标志（fitness function 白名单依据）
 *  first/last：由 BudgetClipper 根据数组位置自动判定，无需调用方传
 *  hardCut：FFmpeg scene 分数超过阈值的硬切帧（P0 暂由调用方传入，未来可从 showinfo 解析）
 *  asrAnchor：P2 ASR 吸附帧
 *  p1DeltaIntraShot：P1 V2 真·补帧（镜内新抽取的 ΔH 大动作帧，原视频不存在的补帧）
 *  action_peak：P1 V1 动作峰值帧（从现有候选帧中用差分识别的已有帧，优先级低于 hardCut/asrAnchor）
 *  debugForceKeep：调试强制保留，不受裁剪影响
 */
export type BudgetClipPriorityFlag =
  | 'hardCut'
  | 'asrAnchor'
  | 'p1DeltaIntraShot'
  | 'action_peak'
  /** P3 · V2 补帧：长镜头空段二次 FFmpeg 单帧 seek 补充的代表帧（保留优先级低于硬切/ASR/动作峰，高于普通候选帧） */
  | 'gap_refill'
  | 'debugForceKeep';

/** 预算裁剪输入选项 */
export interface BudgetClipOptions {
  /** 抽帧密度预设；显式传入 maxFrames 时优先使用 maxFrames */
  densityPreset?: DensityPreset;
  /** 视频总时长（分钟），与 densityPreset 的 framesPerMinute 相乘得到 maxFrames */
  videoDurationMinutes?: number;
  /** 显式指定总帧数上限；当与 densityPreset 同时提供时优先取此值 */
  maxFrames?: number;
  /** 超预算容忍度（默认 10%）：≤maxFrames×(1+TOLERANCE) 时不裁剪，避免小数字无谓丢动作 */
  toleranceRatio?: number;
  /** 以 framePath 为键的优先权标志集合；P0 阶段通常为空（首末帧自动为白名单） */
  priorityFlags?: Record<string, BudgetClipPriorityFlag[]>;
  /**
   * P0 · 是否在裁剪后自动从磁盘删除 dropped 帧文件（默认 true）。
   * 设为 false 可用于 dry-run / 预览裁剪结果，由调用方自行清理。
   */
  deleteDroppedFiles?: boolean;
  /** 关闭日志（测试用） */
  silent?: boolean;
}

/** 裁剪原因描述 */
export interface BudgetClipDropReason {
  framePath: string;
  /** 丢弃原因：budget_trim = 预算裁剪；重复/模糊/黑屏等原因由前序 SmartFramePostProcessor 记录 */
  reason: 'budget_trim' | 'budget_trim_debug_note';
  /** 丢弃时该帧在原候选池中的时间百分比（0~1，用于定位是哪个时间段被裁剪） */
  timePercent: number;
}

/** BudgetClipper 裁剪结果 */
export interface BudgetClipResult {
  /** 保留帧（顺序与输入一致，相对时间有序） */
  kept: FrameAssetDetail[];
  /** 因预算裁剪丢弃的帧（仅记录 budget_trim；不含前序已丢弃的黑屏/模糊/重复帧） */
  dropped: BudgetClipDropReason[];
  /** 实际应用的预算上限（含容差） */
  effectiveBudget: number;
  /** 白名单帧数 */
  whitelistCount: number;
  /** 是否触发了"白名单超容差，仅告警不裁剪"的降级路径 */
  whitelistExceededTolerance: boolean;
  /** P1 · 裁剪过程中产生的告警列表（长镜头空段 / 白名单分级裁剪等信息） */
  warnings: string[];

  // ── P0 · 语义化别名（方便调用方与测试断言）───────────────────────────────────
  /** 白名单保留数量（= whitelistCount，同义别名） */
  whitelistKept: number;
  /** 是否实际裁剪了任何帧（kept.length < 输入帧数时 true；白名单降级为 false） */
  clipped: boolean;
  /** 是否触发降级路径（= whitelistExceededTolerance，更短的别名） */
  degraded: boolean;
  /** 预算详情对象，便于监控面板展示 */
  budget: {
    rawMaxFrames: number;
    effectiveMaxFrames: number;
    toleranceRatio: number;
  };
}

/** 预算裁剪器：纯静态工具类 */
export class BudgetClipper {
  /** 默认超预算容忍度（10%） */
  private static readonly DEFAULT_TOLERANCE = 0.1;

  /**
   * 安全同步删除文件（P0 BudgetClipper 内部使用）：
   * - 文件不存在时静默跳过（避免重复删除抛错）
   * - ENOENT / ENOTDIR 之外的真实磁盘错误才抛；其他一律 debug 告警，避免抽帧主流程崩
   */
  static tryUnlink(filePath: string, silent = false): void {
    // node:fs 动态 require，避免在纯函数外场景（未来迁移 browser）直接 import 报错
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (err: any) {
      const code = err?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return; // 目标本就不存在/非文件 → 忽略
      if (!silent) {
        // eslint-disable-next-line no-console
        console.warn(`[BudgetClipper] 删除丢弃帧文件失败（已跳过，不阻断流程）: ${filePath}`, err?.message ?? err);
      }
    }
  }

  /**
   * 根据 densityPreset + 视频时长，或显式 maxFrames，解析出目标预算上限
   * @param options 裁剪选项
   * @returns maxFrames（未取容差前的目标上限）
   */
  static resolveMaxFrames(options: BudgetClipOptions): number {
    const { maxFrames, densityPreset, videoDurationMinutes } = options;
    // 显式指定最高优先级（例如 UNIFORM_FPS 调试模式）
    if (typeof maxFrames === 'number' && Number.isFinite(maxFrames) && maxFrames > 0) {
      return Math.floor(maxFrames);
    }
    // densityPreset + 时长分钟数
    if (densityPreset && typeof videoDurationMinutes === 'number'
      && Number.isFinite(videoDurationMinutes) && videoDurationMinutes > 0) {
      const framesPerMin = DENSITY_PRESET_CONFIG[densityPreset]?.framesPerMinute ?? 20;
      return Math.max(1, Math.floor(videoDurationMinutes * framesPerMin));
    }
    // 兜底：0 / NaN / 未提供  → 返回 Infinity（不裁剪，相当于关闭 BudgetClipper）
    return Number.POSITIVE_INFINITY;
  }

  /**
   * 主流程：对质检+去重后的精选帧做预算封顶裁剪
   * @param frames SmartFramePostProcessor 的 kept 输出（时间有序，已过门禁）
   * @param options 裁剪选项（densityPreset + 时长 或 显式 maxFrames）
   * @returns BudgetClipResult：保留帧 / 裁剪丢弃帧 / 预算统计
   */
  static clip(
    frames: FrameAssetDetail[],
    options: BudgetClipOptions = {},
  ): BudgetClipResult {
    const {
      toleranceRatio = this.DEFAULT_TOLERANCE,
      priorityFlags = {},
      silent = false,
      deleteDroppedFiles = true,
    } = options;
    const rawMaxFrames = this.resolveMaxFrames(options);
    const effectiveTolerance = Math.max(0, Math.min(1, toleranceRatio));

    /** 构造完整 BudgetClipResult（统一填充语义化别名字段 + P1 warnings 组装） */
    const finalize = (params: {
      kept: FrameAssetDetail[];
      dropped: BudgetClipDropReason[];
      effectiveBudget: number;
      whitelistCount: number;
      whitelistExceededTolerance: boolean;
      extraWarnings?: string[];
    }): BudgetClipResult => {
      const originalTotal = frames.length;
      const clipped = params.kept.length < originalTotal && params.dropped.length > 0;

      // P1 · 长镜头空段告警：同 sceneIndex 内相邻帧 timeMs 差 > 12s → 写 warnings
      const longGapWarnings: string[] = [];
      const gapGroups = new Map<number, FrameAssetDetail[]>();
      for (const f of params.kept) {
        if (!gapGroups.has(f.sceneIndex)) gapGroups.set(f.sceneIndex, []);
        gapGroups.get(f.sceneIndex)!.push(f);
      }
      for (const [sceneIdx, sceneFrames] of gapGroups) {
        if (sceneFrames.length < 2) continue;
        for (let s = 1; s < sceneFrames.length; s++) {
          const gapMs = sceneFrames[s].timeMs - sceneFrames[s - 1].timeMs;
          if (gapMs > 12000) {
            const gapSeconds = Math.round(gapMs / 1000);
            longGapWarnings.push(
              `long_gap_scene:sceneIndex=${sceneIdx}:gapSeconds=${gapSeconds}`
            );
          }
        }
      }
      const warnings = [...(params.extraWarnings ?? []), ...longGapWarnings];

      return {
        kept: params.kept,
        dropped: params.dropped,
        effectiveBudget: params.effectiveBudget,
        whitelistCount: params.whitelistCount,
        whitelistExceededTolerance: params.whitelistExceededTolerance,
        warnings,
        // P0 · 语义化别名
        whitelistKept: params.whitelistCount,
        clipped,
        degraded: params.whitelistExceededTolerance,
        budget: {
          rawMaxFrames,
          effectiveMaxFrames: params.effectiveBudget,
          toleranceRatio: effectiveTolerance,
        },
      };
    };

    if (!frames || frames.length === 0) {
      return finalize({
        kept: [],
        dropped: [],
        effectiveBudget: 0,
        whitelistCount: 0,
        whitelistExceededTolerance: false,
      });
    }

    // 无预算限制（Infinity / ≤0） → 全保留，不裁剪
    if (!Number.isFinite(rawMaxFrames) || rawMaxFrames <= 0) {
      if (!silent) {
        // eslint-disable-next-line no-console
        console.debug(`[BudgetClipper] 无预算限制，保留全部 ${frames.length} 帧`);
      }
      return finalize({
        kept: frames.slice(),
        dropped: [],
        effectiveBudget: Number.POSITIVE_INFINITY,
        whitelistCount: 0,
        whitelistExceededTolerance: false,
      });
    }

    // 1. 打首帧/末帧位置白名单，结合 priorityFlags 外部白名单
    const firstPath = frames[0].framePath;
    const lastPath = frames[frames.length - 1].framePath;
    const totalMs = frames[frames.length - 1].timeMs - frames[0].timeMs;

    const isWhitelistIdx = (i: number, frame: FrameAssetDetail): boolean => {
      if (i === 0 || i === frames.length - 1) return true; // 首末帧强制白名单
      const flags = priorityFlags[frame.framePath];
      if (flags && flags.length > 0) return true; // 外部声明为硬切/ASR/补帧等一律保留
      return false;
    };

    // P1 · 判定白名单帧是否「仅 action_peak 标记」（首末帧除外、priorityFlags 只有 action_peak）→ 分级裁剪时先踢此类帧
    const isOnlyActionPeak = (i: number, frame: FrameAssetDetail): boolean => {
      if (i === 0 || i === frames.length - 1) return false; // 首末帧不参与分级剔除
      const flags = priorityFlags[frame.framePath];
      if (!flags || flags.length === 0) return false;
      // 所有 flag 都是 action_peak（无 hardCut / asrAnchor / p1DeltaIntraShot / debugForceKeep）
      return flags.every(f => f === 'action_peak');
    };

    // 分离 whitelist 与 candidate，同时记录 candidate 在原数组的下标
    // P1 R5 修复：whitelistIdxs Set<number> 对每个 idx 只计 1 次，避免首末帧 + priorityFlags 双重判定时重复计数
    const whitelistIdxs = new Set<number>();
    const whitelist: FrameAssetDetail[] = [];
    const candidates: Array<{ idx: number; frame: FrameAssetDetail }> = [];
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      if (isWhitelistIdx(i, f) && !whitelistIdxs.has(i)) {
        whitelistIdxs.add(i);
        whitelist.push(f);
      } else if (!whitelistIdxs.has(i)) {
        candidates.push({ idx: i, frame: f });
      }
    }

    // 2. 预算含容差
    const effectiveBudget = Math.floor(rawMaxFrames * (1 + effectiveTolerance));

    // 不变式断言：首末帧都在 whitelist
    if (whitelist[0]?.framePath !== firstPath || whitelist[whitelist.length - 1]?.framePath !== lastPath) {
      // eslint-disable-next-line no-console
      console.warn('[BudgetClipper] 首末帧白名单判定异常，fallback 到强制加入');
      if (!whitelistIdxs.has(0)) { whitelistIdxs.add(0); whitelist.unshift(frames[0]); }
      if (!whitelistIdxs.has(frames.length - 1)) { whitelistIdxs.add(frames.length - 1); whitelist.push(frames[frames.length - 1]); }
    }

    // P1 D5 分级裁剪：白名单超容差时，**先按优先级从低到高**剔除仅 action_peak 帧（差分推断最低优先级）
    // → 如果剔除后仍超容差，才走降级全保留（避免上游 hardCut/asrAnchor 被挤）
    let gradedTrimWarning: string | undefined;
    if (whitelist.length > effectiveBudget) {
      // 按原数组下标顺序（时间有序）筛选：保留非仅 action_peak 帧（优先级更高的）
      const afterGradeIdxs = new Set<number>();
      const afterGrade: FrameAssetDetail[] = [];
      // 先按数组顺序遍历 whitelist 帧（whitelist 顺序是 i 从小到大，保持时间序）
      for (let i = 0; i < frames.length; i++) {
        if (!whitelistIdxs.has(i)) continue;
        // 仅 action_peak 帧 → 本轮分级剔除
        if (isOnlyActionPeak(i, frames[i])) continue;
        afterGradeIdxs.add(i);
        afterGrade.push(frames[i]);
      }
      if (afterGrade.length <= effectiveBudget) {
        const droppedActionPeak = whitelist.length - afterGrade.length;
        gradedTrimWarning = `graded_trim_action_peak:dropped=${droppedActionPeak}:whitelistAfter=${afterGrade.length}:budget=${effectiveBudget}`;
        if (!silent) {
          // eslint-disable-next-line no-console
          console.info(
            `[BudgetClipper] 白名单超容差，分级裁剪剔除仅 action_peak 帧 ${droppedActionPeak} 张，` +
            `剩 ${afterGrade.length} ≤ 容差 ${effectiveBudget}，保留 hardCut/asrAnchor 等高优帧。`
          );
        }
        // R5 修复：替换原 whitelist 结构
        whitelistIdxs.clear();
        afterGradeIdxs.forEach(idx => whitelistIdxs.add(idx));
        whitelist.length = 0;
        whitelist.push(...afterGrade);
      }
    }

    // 3. 白名单本身仍超容差：仅告警不裁剪（fitness function：绝不误删首末/硬切/ASR）
    if (whitelist.length > effectiveBudget) {
      if (!silent) {
        // eslint-disable-next-line no-console
        console.warn(
          `[BudgetClipper] ⚠️ 白名单帧 ${whitelist.length} 已超过预算上限（含容差）${effectiveBudget}，` +
          `触发降级：全部保留不裁剪。建议降低 densityPreset 或人工干预。`
        );
      }
      // 恢复原始顺序（whitelist 按原顺序拼接；首末在边界已确保）
      return finalize({
        kept: frames.slice(),
        dropped: [],
        effectiveBudget,
        whitelistCount: whitelist.length,
        whitelistExceededTolerance: true,
        extraWarnings: gradedTrimWarning ? [gradedTrimWarning] : undefined,
      });
    }

    // 4. 总帧 ≤ 容差上限：全保留
    if (frames.length <= effectiveBudget) {
      if (!silent) {
        // eslint-disable-next-line no-console
        console.debug(
          `[BudgetClipper] 总帧 ${frames.length} ≤ 预算(含容差) ${effectiveBudget}，全保留（白名单 ${whitelist.length}）`
        );
      }
      return finalize({
        kept: frames.slice(),
        dropped: [],
        effectiveBudget,
        whitelistCount: whitelist.length,
        whitelistExceededTolerance: false,
        extraWarnings: gradedTrimWarning ? [gradedTrimWarning] : undefined,
      });
    }

    // 5. 候选池均匀步长抽样 → 凑够预算剩余配额
    const remainingQuota = effectiveBudget - whitelist.length;
    const candidateCount = candidates.length;
    const step = candidateCount > 0 && remainingQuota > 0
      ? candidateCount / remainingQuota
      : Number.POSITIVE_INFINITY;

    const keptIndices = new Set<number>(whitelistIdxs);
    // P1 R5 修复：白名单索引直接复用 whitelistIdxs（与分级裁剪后的白名单一致，不重复判定）
    // 候选按步长抽样，target = remainingQuota；避免越界与重复取
    const takenCandidates: number[] = [];
    for (let k = 0; k < remainingQuota; k++) {
      const pos = Math.min(candidateCount - 1, Math.floor(k * step));
      if (pos >= 0 && pos < candidateCount) {
        const pick = candidates[pos];
        if (pick && !keptIndices.has(pick.idx)) {
          keptIndices.add(pick.idx);
          takenCandidates.push(pick.idx);
        }
      }
    }
    // 若 step 取整导致 takenCandidates 不够剩余配额（边界取整重复），按头部补取
    if (takenCandidates.length < remainingQuota) {
      for (let j = 0; j < candidates.length && takenCandidates.length < remainingQuota; j++) {
        if (!keptIndices.has(candidates[j].idx)) {
          keptIndices.add(candidates[j].idx);
          takenCandidates.push(candidates[j].idx);
        }
      }
    }

    // 6. 组装 kept / dropped（保持原时间顺序）
    const kept: FrameAssetDetail[] = [];
    const dropped: BudgetClipDropReason[] = [];
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      if (keptIndices.has(i)) {
        kept.push(f);
      } else {
        const timePercent = totalMs > 0
          ? Math.max(0, Math.min(1, (f.timeMs - frames[0].timeMs) / totalMs))
          : i / frames.length;
        dropped.push({
          framePath: f.framePath,
          reason: 'budget_trim',
          timePercent,
        });
      }
    }

    if (!silent) {
      // eslint-disable-next-line no-console
      console.info(
        `[BudgetClipper] 预算封顶完成：原 ${frames.length} → 留 ${kept.length}（白名单 ${whitelist.length}，候选抽样 ${takenCandidates.length}），` +
        `预算(含容差)=${effectiveBudget}，裁剪 ${dropped.length} 帧`
      );
    }

    // 7. P0 · 按需从磁盘删除被裁剪的帧文件（默认启用；dry-run 场景设 deleteDroppedFiles=false）
    if (deleteDroppedFiles && dropped.length > 0) {
      for (const d of dropped) {
        this.tryUnlink(d.framePath, silent);
      }
    }

    return finalize({
      kept,
      dropped,
      effectiveBudget,
      whitelistCount: whitelist.length,
      whitelistExceededTolerance: false,
      extraWarnings: gradedTrimWarning ? [gradedTrimWarning] : undefined,
    });
  }
}
