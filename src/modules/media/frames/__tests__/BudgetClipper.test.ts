// 📁 路径：src/modules/media/frames/__tests__/BudgetClipper.test.ts
// P0 · BudgetClipper 单元测试：
//   验证预算封顶（≤ framesPerMinute × 分钟数）、白名单保留、均匀抽样时序、磁盘文件删除。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BudgetClipper, type BudgetClipPriorityFlag } from '../backend/BudgetClipper';
import type { FrameAssetDetail } from '../types';

/** 生成一条假帧数据 */
function makeFrame(
  idx: number,
  dir: string,
  overrides: Partial<FrameAssetDetail> = {}
): FrameAssetDetail {
  const p = path.join(dir, `frame_${String(idx).padStart(8, '0')}.jpg`);
  // 写个空文件，以便 tryUnlink 有东西删
  fs.writeFileSync(p, '');
  const timeMs = idx * 1000;
  const totalSec = Math.floor(timeMs / 1000);
  const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const ss = String(totalSec % 60).padStart(2, '0');
  const ms = String(timeMs % 1000).padStart(3, '0').slice(0, 2);
  return {
    framePath: p,
    timeMs,
    timeStr: `${mm}:${ss}.${ms}`,
    clarityScore: 0.8,
    lumaScore: 128,
    sceneIndex: 0,
    ...overrides,
  };
}

/** 生成 N 条假帧（含空磁盘文件） */
function makeFrames(n: number, dir: string): FrameAssetDetail[] {
  return Array.from({ length: n }, (_, i) => makeFrame(i, dir));
}

describe('BudgetClipper', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'budgetclipper-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  describe('预算硬封顶不变式', () => {
    it('输入 ≤ 预算时 → 零丢弃，结果与输入一致', () => {
      const frames = makeFrames(10, tmp);
      const result = BudgetClipper.clip(frames, {
        maxFrames: 100,
      });

      expect(result.kept).toHaveLength(10);
      expect(result.dropped).toHaveLength(0);
      // 总帧 ≤ 预算时仍识别首末为白名单（后续判断优先级用，但不产生裁剪）
      expect(result.whitelistKept).toBe(2);
      expect(result.clipped).toBe(false);
    });

    it('sparse preset · 5 分钟视频 · 200 帧 → 被裁到 ≤ 66 张（5 × 12 × 1.1）', () => {
      const frames = makeFrames(200, tmp);
      const result = BudgetClipper.clip(frames, {
        densityPreset: 'sparse',
        videoDurationMinutes: 5,
      });

      const expectedBudget = Math.floor(5 * 12 * 1.1); // 66
      expect(result.kept.length).toBeLessThanOrEqual(expectedBudget);
      expect(result.clipped).toBe(true);
      expect(result.budget.effectiveMaxFrames).toBe(expectedBudget);
      // 丢弃帧的磁盘文件应全部被删除
      for (const d of result.dropped) {
        expect(fs.existsSync(d.framePath)).toBe(false);
      }
    });

    it('standard preset · 120 分钟（2 小时） → 预算封顶 2640（避免 2000 张爆 Token 问题）', () => {
      const frames = makeFrames(4000, tmp); // 模拟 4k 张超限
      const result = BudgetClipper.clip(frames, {
        densityPreset: 'standard',
        videoDurationMinutes: 120,
        toleranceRatio: 0.1,
      });
      const expectedBudget = Math.floor(120 * 20 * 1.1); // 2640
      expect(result.kept.length).toBeLessThanOrEqual(expectedBudget);
      expect(result.kept.length).toBeGreaterThan(0);
      expect(result.budget.effectiveMaxFrames).toBe(expectedBudget);
      expect(result.clipped).toBe(true);
    });

    it('显式 maxFrames 与 preset 同时提供时，rawMaxFrames 取显式值（比 preset 高优先）', () => {
      const frames = makeFrames(60, tmp);
      const result = BudgetClipper.clip(frames, {
        densityPreset: 'dense',
        videoDurationMinutes: 1, // 1 × 35 = 35
        maxFrames: 48,
      });
      // rawMaxFrames 是 maxFrames=48；effectiveBudget = floor(48*1.1)=52
      expect(result.budget.rawMaxFrames).toBe(48);
      expect(result.budget.effectiveMaxFrames).toBe(52);
      // frames=60 > 52 → 触发裁剪，kept.length 等于容差上限
      expect(result.kept.length).toBe(52);
      expect(result.clipped).toBe(true);
    });
  });

  describe('白名单保留（首帧 / 末帧 / 硬切帧 / ASR 吸附帧）', () => {
    it('首帧与末帧 2 张 100% 保留，不受裁剪影响', () => {
      const frames = makeFrames(100, tmp);
      const first = frames[0].framePath;
      const last = frames[frames.length - 1].framePath;
      const result = BudgetClipper.clip(frames, { maxFrames: 5, toleranceRatio: 0 });

      expect(result.kept.map(f => f.framePath)).toContain(first);
      expect(result.kept.map(f => f.framePath)).toContain(last);
      // effectiveBudget = 5（toleranceRatio=0），首末 2 + 候选抽 3 = 5
      expect(result.kept.length).toBe(5);
    });

    it('priorityFlags 标记的硬切帧 / ASR 吸附帧 → 进入白名单', () => {
      const frames = makeFrames(100, tmp);
      // ⚠️ BudgetClipPriorityFlag 是驼峰：hardCut / asrAnchor，不要下划线
      const flags: Record<string, BudgetClipPriorityFlag[]> = {
        [frames[20].framePath]: ['hardCut'],
        [frames[55].framePath]: ['asrAnchor'],
      };
      const result = BudgetClipper.clip(frames, {
        maxFrames: 10,
        toleranceRatio: 0,
        priorityFlags: flags,
      });

      const keptPaths = new Set(result.kept.map(f => f.framePath));
      // 白名单（首 + 末 + 2 张标记）= 4 张必须保留
      expect(keptPaths.has(frames[0].framePath)).toBe(true);
      expect(keptPaths.has(frames[99].framePath)).toBe(true);
      expect(keptPaths.has(frames[20].framePath)).toBe(true);
      expect(keptPaths.has(frames[55].framePath)).toBe(true);
      expect(result.whitelistKept).toBe(4);
    });

    it('白名单超预算 + 容差 → 降级：不裁剪，直接保留全部', () => {
      // 30 张全部设为硬切帧，而预算只有 5
      const frames = makeFrames(30, tmp);
      const flags: Record<string, BudgetClipPriorityFlag[]> = {};
      for (const f of frames) flags[f.framePath] = ['hardCut'];

      const result = BudgetClipper.clip(frames, {
        maxFrames: 5,
        priorityFlags: flags,
        toleranceRatio: 0.1, // 容差上限 = floor(5*1.1)=5
      });

      // whitelist（30）> effective(5) → 降级保留
      expect(result.dropped).toHaveLength(0);
      expect(result.clipped).toBe(false);
      expect(result.degraded).toBe(true);
      expect(fs.readdirSync(tmp)).toHaveLength(30); // 磁盘没文件被删
    });
  });

  describe('候选帧均匀抽样（保持时序覆盖）', () => {
    it('100 候选 → 预算 20（toleranceRatio=0）时，精确保留 20，首尾索引被均匀覆盖', () => {
      const frames = makeFrames(100, tmp);
      // toleranceRatio=0 → effectiveBudget=20，避免默认 10% 容差使断言长度变 22
      const result = BudgetClipper.clip(frames, { maxFrames: 20, toleranceRatio: 0 });

      // 首末 2 张白名单占了，候选 98 抽 18 张，总数恰好 20
      // FrameAssetDetail 不含 index，从 timeMs 反推（makeFrame 中 timeMs = idx*1000）
      const keptIndices = result.kept.map(f => Math.floor(f.timeMs / 1000)).sort((a, b) => a - b);
      expect(keptIndices).toHaveLength(20);
      // 索引应严格递增，体现时间轴顺序
      for (let i = 1; i < keptIndices.length; i++) {
        expect(keptIndices[i]).toBeGreaterThan(keptIndices[i - 1]);
      }
      // 应覆盖整个时间轴：首帧 ≤ 5，末帧 ≥ 95
      expect(keptIndices[0]).toBeLessThanOrEqual(5);
      expect(keptIndices[keptIndices.length - 1]).toBeGreaterThanOrEqual(95);
    });
  });

  describe('磁盘清理与幂等安全', () => {
    it('dropped 帧的磁盘文件被 tryUnlink 清理，且不会因已删报错', () => {
      const frames = makeFrames(23, tmp);
      // 提前删 2 张，验证 tryUnlink 幂等（不抛错）
      fs.unlinkSync(frames[10].framePath);
      fs.unlinkSync(frames[11].framePath);

      // maxFrames=5, toleranceRatio=0 → effective=5；首末 2 + 候选抽 3 = 5 保留，其余删除
      const result = BudgetClipper.clip(frames, { maxFrames: 5, toleranceRatio: 0 });
      const remaining = fs.readdirSync(tmp);
      // 被保留的帧文件应存在
      for (const f of result.kept) {
        expect(fs.existsSync(f.framePath)).toBe(true);
      }
      // 磁盘剩余 = kept.length（5），dropped 文件已全部删除
      expect(remaining.length).toBe(result.kept.length);
    });
  });

  describe('边界情况', () => {
    it('空帧数组 → 空结果，不抛错', () => {
      const result = BudgetClipper.clip([], { maxFrames: 10 });
      expect(result.kept).toHaveLength(0);
      expect(result.dropped).toHaveLength(0);
      expect(result.clipped).toBe(false);
    });

    it('未传 densityPreset / maxFrames / videoDurationMinutes → 不裁剪（clipped=false）', () => {
      const frames = makeFrames(50, tmp);
      const result = BudgetClipper.clip(frames, {});
      expect(result.kept).toHaveLength(50);
      expect(result.clipped).toBe(false);
      expect(result.degraded).toBe(false);
    });
  });

  describe('P1 增强（白名单去重 / 分级裁剪 / warnings）', () => {
    it('action_peak 标记帧正确进入白名单，并被 BudgetClipPriorityFlag 类型接受', () => {
      // 5 帧中 frame 2 标记 action_peak → 白名单 = 首末 + frame2 = 共 3
      const frames = makeFrames(5, tmp);
      const actionFlag: BudgetClipPriorityFlag = 'action_peak'; // 类型断言验证新 flag 合法
      const priorityFlags: Record<string, BudgetClipPriorityFlag[]> = {
        [frames[2].framePath]: [actionFlag],
      };
      // maxFrames=10 > frames.length=5 → 全保留不裁剪（Step 4 分支），whitelistCount=3 仍生效
      const result = BudgetClipper.clip(frames, {
        maxFrames: 10,
        toleranceRatio: 0,
        priorityFlags,
        silent: true,
      });
      // 白名单 = 首末(2) + frame2 action_peak(1) = 3
      expect(result.whitelistCount).toBeGreaterThanOrEqual(3);
      expect(result.clipped).toBe(false); // frames=5 ≤ effective=10 → 零裁剪
      // frame2 仍在 kept（action_peak 标记保留了它）
      expect(result.kept.map(f => f.framePath)).toContain(frames[2].framePath);
    });

    it('白名单超容差时，分级裁剪优先剔除仅 action_peak 帧（保留 hardCut / asrAnchor）', () => {
      // 构造 30 帧，budget effective=5
      // priorityFlags：frames[2..16] 共 15 个 action_peak（仅 action_peak） + frames[17] hardCut + frames[18] asrAnchor（2 个高优）
      // 白名单原本 = 首末(2) + 15 action_peak + 2 高优 = 19 > effective 5
      // 分级裁剪后：仅 action_peak 全踢 → 剩 首末(2)+2 高优 = 4 ≤ 5 → 剩余配额抽 1 张 candidate，仍在预算，不降级
      const frames = makeFrames(30, tmp);
      const priorityFlags: Record<string, BudgetClipPriorityFlag[]> = {};
      for (let i = 2; i <= 16; i++) priorityFlags[frames[i].framePath] = ['action_peak'];
      priorityFlags[frames[17].framePath] = ['hardCut'];
      priorityFlags[frames[18].framePath] = ['asrAnchor'];
      const result = BudgetClipper.clip(frames, {
        maxFrames: 5,
        toleranceRatio: 0,
        priorityFlags,
        silent: true,
      });
      // 分级裁剪生效 → 未降级
      expect(result.degraded).toBe(false);
      expect(result.whitelistExceededTolerance).toBe(false);
      // kept.length = effective = 5
      expect(result.kept).toHaveLength(5);
      // warnings 含 graded_trim_action_peak 信息
      expect(result.warnings.some(w => w.startsWith('graded_trim_action_peak:'))).toBe(true);
      // 高优帧保留（17 hardCut / 18 asrAnchor 在 kept）
      const keptPaths = new Set(result.kept.map(f => f.framePath));
      expect(keptPaths.has(frames[17].framePath)).toBe(true);
      expect(keptPaths.has(frames[18].framePath)).toBe(true);
      // 仅 action_peak 的 frame2 被淘汰（不在 kept）
      expect(keptPaths.has(frames[2].framePath)).toBe(false);
    });

    it('R5 白名单去重不变式：首帧同时带 priorityFlags → whitelistCount 不翻倍', () => {
      // 首末帧同时在 priorityFlags 中声明标记 → whitelist 仍只记一次首帧 + 一次末帧（不是 4）
      const frames = makeFrames(10, tmp);
      const priorityFlags: Record<string, BudgetClipPriorityFlag[]> = {
        [frames[0].framePath]: ['hardCut'],   // 首帧 = 数组 0，同时带 hardCut
        [frames[9].framePath]: ['asrAnchor'], // 末帧 = 数组 9，同时带 asrAnchor
      };
      // effectiveBudget=5（tolerance=0），白名单 = 首末（各 1 次，不是各 2 次）→ whitelistCount=2
      const result = BudgetClipper.clip(frames, {
        maxFrames: 5,
        toleranceRatio: 0,
        priorityFlags,
        silent: true,
      });
      // whitelistCount 严格=2（首 1 + 末 1，不是 4）
      expect(result.whitelistCount).toBe(2);
      // remainingQuota = 5-2=3 → kept.length = 2 + 3 = 5
      expect(result.kept).toHaveLength(5);
      // 不应触发降级（如果白名单被重复计数为 4，再+其他会放大，导致 remainingQuota 错误）
      expect(result.degraded).toBe(false);
    });

    it('long_gap_scene 告警：同 sceneIndex 相邻帧 gap>12s → warnings 中记录', () => {
      // 构造 4 帧同 sceneIndex=3，timeMs = 0s, 5s, 20s(与前差 15s>12), 22s
      const frames = [
        makeFrame(0, tmp, { sceneIndex: 3, timeMs: 0, timeStr: '00:00.00' }),
        makeFrame(1, tmp, { sceneIndex: 3, timeMs: 5000, timeStr: '00:05.00' }),
        makeFrame(2, tmp, { sceneIndex: 3, timeMs: 20000, timeStr: '00:20.00' }), // gap=15s
        makeFrame(3, tmp, { sceneIndex: 3, timeMs: 22000, timeStr: '00:22.00' }),
      ];
      // maxFrames=Infinity（不裁剪）→ 全保留，但 finalize 会跑 long_gap_scene 检测
      const result = BudgetClipper.clip(frames, { silent: true });
      expect(result.warnings.some(w => w === 'long_gap_scene:sceneIndex=3:gapSeconds=15')).toBe(true);
    });
  });
});
