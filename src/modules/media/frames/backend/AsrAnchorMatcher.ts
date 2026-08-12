// 📁 路径：src/modules/media/frames/backend/AsrAnchorMatcher.ts
// P2 · 声画锚定：将帧（timeMs）与 ASR 台词时间轴（startMs/endMs）做吸附匹配，
//   把贴近台词关键时间的帧标记为 asrAnchor priorityFlag，供 BudgetClipper 白名单保留。
//   全部纯函数实现，零磁盘 I/O、零 FFmpeg 调用，可在 Node 测试环境直接调用。
import type { FrameAssetDetail } from '../types';
import type { BudgetClipPriorityFlag } from './BudgetClipper';
import type { AsrLine } from '../../../../shared/types/entities/editor';
import { normalizeFrameStrategy, type FrameExtractStrategy } from '../../../../shared/contracts/capabilities';

/** AsrAnchor 吸附配置类型 */
export interface AsrAnchoringConfig {
  /** 是否启用声画锚定（默认 true） */
  enabled?: boolean;
  /** 抽帧策略；UNIFORM_FPS 时强制 gate=空（保持均匀时序优先） */
  strategy?: FrameExtractStrategy | string;
  /** 吸附匹配锚点模式：center=台词中点/start=台词开头/end=台词结尾（默认 center） */
  matchMode?: 'center' | 'start' | 'end';
  /** 匹配容忍的最大毫秒差（默认 2000）。超出则认为该台词无合适帧代表，不吸附 */
  toleranceMs?: number;
  /** 跳过的最短台词长度（默认 2）。过短台词（感叹词等）通常不值得占用 BudgetClipper 白名单 */
  minTextLength?: number;
}

/** matchFramesToAsr 返回的匹配结果 */
export interface AsrAnchorMatchResult {
  /** 成功吸附的帧数量（anchor 帧集合长度） */
  anchoredCount: number;
  /** 成功吸附的帧路径集合（Set，供 buildPriorityFlags 直接消费） */
  anchoredFramePaths: Set<string>;
  /** 帧路径 → ASR 行索引（调试或下游聚合展示用；一条台词只对应 0~1 帧） */
  asrLineIndexByPath: Map<string, number>;
  /** 因为 strategy=UNIFORM_FPS gate 被整体跳过（true）；否则 false */
  skippedByStrategy: boolean;
  /** 输入里被过滤掉的无效 ASR 台词条数（空文本/过短/缺 startMs/endMs 等） */
  filteredAsrLines: number;
}

/** 静态工具类：声画锚定 */
export class AsrAnchorMatcher {
  // ────────────────────────────────────────────────────────────────────────
  // Public：1) 帧 ↔ 台词 吸附匹配
  // ────────────────────────────────────────────────────────────────────────
  /**
   * 为输入 frames 与 asrLines 执行声画锚定吸附匹配。
   * 纯函数，无磁盘 I/O：
   *   - 先过滤无效 asrLines（空文本/长度不够/缺 startMs endMs 非法值）
   *   - strategy gate：UNIFORM_FPS → 直接返回空吸附（保持均匀时序覆盖优先）
   *   - 对每条有效台词按 matchMode 计算 anchorMs，在 frames 中找距离最近且≤ toleranceMs 的帧
   *   - 多帧等距 → 选更早的帧（时间轴稳定性）；每帧重复吸附 → 只选 1 条台词最佳匹配
   */
  static matchFramesToAsr(
    frames: FrameAssetDetail[],
    asrLines: AsrLine[],
    opts: AsrAnchoringConfig = {},
  ): AsrAnchorMatchResult {
    // 默认值
    const enabled = opts.enabled !== false; // 默认开启
    const normalizedStrategy = normalizeFrameStrategy(
      (opts.strategy ?? 'AUTO_ADAPTIVE') as FrameExtractStrategy | string,
      'AUTO_ADAPTIVE',
    );
    const strategy = normalizedStrategy as FrameExtractStrategy;
    const toleranceMs = typeof opts.toleranceMs === 'number' ? opts.toleranceMs : 2000;
    const minTextLength = typeof opts.minTextLength === 'number' ? opts.minTextLength : 2;
    const matchMode = opts.matchMode ?? 'center';

    const emptyResult: AsrAnchorMatchResult = {
      anchoredCount: 0,
      anchoredFramePaths: new Set<string>(),
      asrLineIndexByPath: new Map<string, number>(),
      skippedByStrategy: false,
      filteredAsrLines: 0,
    };

    // Gate 1：开关关闭 / frames 空 / asr 空 → 零吸附
    if (!enabled || frames.length === 0 || asrLines.length === 0) {
      return emptyResult;
    }

    // Gate 2：strategy=UNIFORM_FPS → 整体跳过（均匀策略不被声画锚定干扰）
    if (strategy === 'UNIFORM_FPS') {
      return { ...emptyResult, skippedByStrategy: true };
    }

    // Step 1：过滤无效 ASR 台词
    let filteredCount = 0;
    const validLines: Array<{ line: AsrLine; anchorMs: number }> = [];
    for (const l of asrLines) {
      if (typeof l.startMs !== 'number' || Number.isNaN(l.startMs) || l.startMs < 0) { filteredCount++; continue; }
      if (typeof l.endMs !== 'number' || Number.isNaN(l.endMs) || l.endMs < 0) { filteredCount++; continue; }
      if (l.endMs < l.startMs) { filteredCount++; continue; } // 非法时序
      const text = (l.text ?? '').trim();
      if (text.length === 0) { filteredCount++; continue; }
      if (text.length < minTextLength) { filteredCount++; continue; }

      const anchorMs = matchMode === 'start'
        ? l.startMs
        : matchMode === 'end'
          ? l.endMs
          : Math.round((l.startMs + l.endMs) / 2);
      validLines.push({ line: l, anchorMs });
    }

    if (validLines.length === 0) {
      return { ...emptyResult, filteredAsrLines: filteredCount };
    }

    // Step 2：按台词顺序逐个吸附（台词互斥：一条台词选 1 帧最佳）
    //   单帧可被多条台词命中 → 只保留最小 delta 的那条索引（最后一次写 = 最佳）
    const asrIdxByPath = new Map<string, number>();
    const pathToDelta = new Map<string, number>(); // 用于 tie-break 判断

    for (let lineIdx = 0; lineIdx < validLines.length; lineIdx++) {
      const { anchorMs } = validLines[lineIdx];

      // 找 frames 中距离最近且 ≤ toleranceMs 的帧；多帧同距离选 更 早 的
      let bestFrameIdx = -1;
      let bestDelta = Number.POSITIVE_INFINITY;
      for (let fIdx = 0; fIdx < frames.length; fIdx++) {
        const t = frames[fIdx].timeMs;
        if (typeof t !== 'number' || Number.isNaN(t) || t < 0) continue;
        const delta = Math.abs(t - anchorMs);
        if (delta > toleranceMs) continue;
        // 严格小于 则替换；相等则保留更早的帧（fIdx 更小），所以不替换
        if (delta < bestDelta) {
          bestDelta = delta;
          bestFrameIdx = fIdx;
        }
      }
      if (bestFrameIdx < 0) continue; // 本台词无合适帧

      const framePath = frames[bestFrameIdx].framePath;
      // 如果该帧已被更早的台词命中（但本次 line 不一定更优：通常先到先得，但 delta 更小才换）
      const prevDelta = pathToDelta.get(framePath);
      if (prevDelta === undefined || bestDelta < prevDelta) {
        asrIdxByPath.set(framePath, lineIdx); // lineIdx 对应 validLines 索引
        pathToDelta.set(framePath, bestDelta);
      }
    }

    const anchoredPaths = new Set<string>(asrIdxByPath.keys());

    return {
      anchoredCount: anchoredPaths.size,
      anchoredFramePaths: anchoredPaths,
      asrLineIndexByPath: asrIdxByPath,
      skippedByStrategy: false,
      filteredAsrLines: filteredCount,
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Public：2) 构造 BudgetClipper priorityFlags（Immutable 合并不覆盖 upstream）
  // ────────────────────────────────────────────────────────────────────────
  /**
   * 基于吸附帧路径集合，构造 BudgetClipper priorityFlags（标记 asrAnchor）。
   * Immutable 合并：若 upstream 已声明该帧的 hardCut/action_peak 等标志，**绝不覆盖**，只追加 asrAnchor。
   * 同帧多次匹配：asrAnchor 在数组中只出现 1 次（去重）。
   */
  static buildPriorityFlags(
    anchoredFramePaths: Set<string>,
    existing?: Record<string, BudgetClipPriorityFlag[]>,
  ): Record<string, BudgetClipPriorityFlag[]> {
    const result: Record<string, BudgetClipPriorityFlag[]> = {};
    // 先浅拷贝 upstream（若存在）→ 保证 immutable 语义
    if (existing && typeof existing === 'object') {
      for (const p of Object.keys(existing)) {
        const arr = existing[p];
        if (Array.isArray(arr)) {
          result[p] = [...arr]; // 浅拷贝数组，避免对 upstream 写入副作用
        }
      }
    }
    // 追加 asrAnchor（去重）
    for (const p of anchoredFramePaths) {
      const arr = result[p] ?? [];
      if (!arr.includes('asrAnchor')) {
        arr.push('asrAnchor');
        result[p] = arr;
      } else if (!result[p]) {
        result[p] = arr;
      }
    }
    return result;
  }
}
