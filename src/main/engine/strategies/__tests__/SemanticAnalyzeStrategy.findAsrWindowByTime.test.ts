// 📁 路径: src/main/engine/strategies/__tests__/SemanticAnalyzeStrategy.findAsrWindowByTime.test.ts
// 🎯 原声段 ASR 时间窗定位（findAsrWindowByTime）单元测试 —— P0「收敛不放大」+ P1「幻觉行剔除」
// 背景（2026-09-25 实测）: proj_1788878097336_nzcvrq 的 seg_22 / seg_23 两段不同台词拿到了
//   **逐字节相同**的 audioSource 3156000~3179000（23000ms），而各自画面窗仅 10000ms。
//   根因: ASR 解码死循环行（223 字「아」，实测时长 20000ms）进入 ≤1s 停顿合并，
//   把 3000ms 的真实台词吞成 23000ms 的长块，再被「取窗口内最长块」选中。
//   下游连锁: 步骤5 按 23000ms 定承载切片 → 落 2772ms 切片 → 8.3× 素材缺口 → 补丁20 收窄恒 0。
// 修复口径:
//   P1 幻觉行在【合并之前】剔除（长度 ≥20 且单字符占比 ≥0.7 双达标）；
//   P0 收敛上界 = 锚窗长，结果窗长超出即返回 null，交回调用方的段落画面窗兜底。
// 覆盖核心路径:
//   1. 单行收敛（短于锚窗）正常返回
//   2. P1 幻觉行剔除 → 真实台词不再被吞成超长块
//   3. P0 收敛不放大 → 超长块返回 null
//   4. 真实数据回归 → seg_22 / seg_23 不再拿到 23000ms 幻影窗（缺口 8.3×→1.08×）
//   5. 锚窗不可用（缺 end）→ 不设限，保持旧行为
//   6. 既有行为不回归：超短语气词过滤 / ≤1s 停顿合并 / 长正常句不误杀
// 已知残留（不属 P0/P1 面，已登记 P2）: 修后 seg_22 / seg_23 仍收敛到【同一】3000ms 台词窗，
//   因为两根锚窗都偏早于各自真实台词，且 ±1000ms 缓冲使相邻段互相捕获对方台词行。

import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Mock AppLogger（屏蔽测试日志） */
vi.mock('../../../core/AppLogger', () => ({
  AppLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
/** Mock LOG_TAGS */
vi.mock('@modules/infra/logger/LogConstants', () => ({
  LOG_TAGS: { AI_AGENT: 'AI_AGENT', SCHEDULER: 'SCHEDULER' },
}));

import { SemanticAnalyzeStrategy } from '../SemanticAnalyzeStrategy';

/**
 * 构造一条 ASR 行（源坐标毫秒）
 * @param text 台词文本
 * @param startMs 起点（源坐标 ms）
 * @param endMs 终点（源坐标 ms）
 */
function asrLine(text: string, startMs: number, endMs: number) {
  return { text, startMs, endMs };
}

/** 构造 ASR 解码死循环行（同一字符重复 n 次），实测形态为 223 个「주」/「아」 */
function loopLine(ch: string, n: number, startMs: number, endMs: number) {
  return asrLine(ch.repeat(n), startMs, endMs);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SemanticAnalyzeStrategy.findAsrWindowByTime — 原声段 ASR 时间窗定位', () => {
  it('[FT-1] 单行收敛: 窗口内单行台词短于锚窗 → 返回该行时间窗', () => {
    const asr = [
      asrLine('前面一镜带过', 2000, 5000),
      asrLine('这段就是目标台词', 12000, 15000),
      asrLine('后面完全不相关', 30000, 34000),
    ];
    // 锚窗 10000~20000（10000ms）；扫描窗 9000~21000 → 只命中 12000~15000
    const win = SemanticAnalyzeStrategy.findAsrWindowByTime(asr, 10000, 20000);
    expect(win).toEqual({ sourceStartMs: 12000, sourceEndMs: 15000 });
  });

  it('[FT-2] P1 幻觉行剔除: 死循环行不再把真实台词吞成超长块', () => {
    const asr = [
      loopLine('주', 223, 1000, 20000),          // 死循环行（19000ms）
      asrLine('这段就是目标台词', 21000, 24000),   // 真实台词
    ];
    // 锚窗 18000~28000（10000ms）；扫描窗 17000~29000
    //  未修前: 死循环行与真实台词首尾相接（21000 ≤ 20000+1000）→ 合并成 1000~24000（23000ms）
    //  修后:   死循环行被剔除 → 只剩 21000~24000（3000ms）≤ 锚窗长 → 正常返回
    const win = SemanticAnalyzeStrategy.findAsrWindowByTime(asr, 18000, 28000);
    expect(win).toEqual({ sourceStartMs: 21000, sourceEndMs: 24000 });
  });

  it('[FT-3] P0 收敛不放大: 窗口内只有超出锚窗长的块 → 返回 null（交回画面窗兜底）', () => {
    const asr = [
      // 正常中文长句，不属幻觉行（长度 12，单字符占比低）
      asrLine('这段画面里一直在说话', 8000, 16000),   // 8000ms
    ];
    // 锚窗 10000~14000（4000ms）；扫描窗 9000~15000 → 命中块 8000~16000（8000ms）> 4000ms
    const win = SemanticAnalyzeStrategy.findAsrWindowByTime(asr, 10000, 14000);
    expect(win).toBeNull();
  });

  it('[FT-4] 真实数据回归: 幻觉行不再造出 23000ms 幻影窗（缺口 8.3×→1.08×）', () => {
    // 取自 proj_1788878097336_nzcvrq 的 media_assets.extracted_text（源坐标 ms，逐字节实录）
    const asr = [
      loopLine('주', 223, 3154000, 3156000),        // 死循环行（2000ms）
      loopLine('아', 223, 3156000, 3176000),        // 死循环行（20000ms，元凶）
      asrLine('안녕히계세요.', 3176000, 3179000),    // seg_22 真实台词（其 transcript 即「안녕히 계세요.」）
      asrLine('근데요.', 3187000, 3190000),
      asrLine('저이옷을왜입어야되는건데요?', 3188000, 3190000),
      asrLine('저지금이상황이이해가안가거든요?', 3190000, 3192000),
    ];
    // 段落锚窗（源=ScriptGenStrategy anchorStart=startMs / anchorEnd=startMs+durationMs，各 10000ms）
    const w22 = SemanticAnalyzeStrategy.findAsrWindowByTime(asr, 3166000, 3176000);
    const w23 = SemanticAnalyzeStrategy.findAsrWindowByTime(asr, 3176000, 3186000);

    // ① 修复主目标：23000ms 幻影窗消失（未修前两段均得 3156000~3179000 = 23000ms）
    expect(w22).not.toBeNull();
    expect(w23).not.toBeNull();
    for (const w of [w22!, w23!]) {
      // 收敛到真实台词行 3000ms ⇒ 对 2772ms 承载切片的素材缺口从 8.3× 降到 1.08×，补丁20 重新有 slack
      expect(w.sourceEndMs - w.sourceStartMs).toBe(3000);
      expect(w.sourceEndMs - w.sourceStartMs).toBeLessThanOrEqual(10000);  // 同时不越过 P0 上界
    }
    expect(w22).toEqual({ sourceStartMs: 3176000, sourceEndMs: 3179000 });
    // ② 残留如实固化（不属 P0/P1 面，已登记 P2）：两根锚窗（3166000~3176000 / 3176000~3186000）
    //    都【偏早于各自真实台词】，「안녕히계세요.」(3176000~3179000) 恰落在 seg_23 锚窗起点，
    //    又被 seg_22 锚窗的 +1000ms 尾缓冲捕获 ⇒ 两段仍收敛到同一 3000ms 窗。
    //    收口需 P2「段落 ↔ ASR 行唯一归属」；P2 落地后本断言须一并更新。
    expect(w23).toEqual({ sourceStartMs: 3176000, sourceEndMs: 3179000 });
  });

  it('[FT-5] 锚窗不可用（缺 end）→ 不设限，保持旧行为', () => {
    const asr = [
      asrLine('锚点附近有台词', 9500, 12500),   // 3000ms
    ];
    // 只给 startMs → 扫描窗 9000~11000，anchorLen 不设限（旧行为）
    const win = SemanticAnalyzeStrategy.findAsrWindowByTime(asr, 10000);
    expect(win).toEqual({ sourceStartMs: 9500, sourceEndMs: 12500 });
  });

  it('[FT-6] 既有行为不回归: 超短语气词行被过滤', () => {
    const asr = [
      asrLine('嗯', 1000, 1800),
      asrLine('我们出发吧', 2000, 6000),
      asrLine('啊', 6200, 7000),
    ];
    // 锚窗 1000~7000（6000ms）；「嗯」「啊」为超短行被过滤 → 只返回 2000~6000
    const win = SemanticAnalyzeStrategy.findAsrWindowByTime(asr, 1000, 7000);
    expect(win).toEqual({ sourceStartMs: 2000, sourceEndMs: 6000 });
  });

  it('[FT-7] 既有行为不回归: ≤1s 停顿视为同句并合并', () => {
    const asr = [
      asrLine('后来我们终于', 40000, 43000),
      asrLine('找到了那家店', 43200, 46000),
      asrLine('里面的老板人很好', 46200, 50000),
    ];
    // 三行首尾相接（≤1s 停顿）→ 合并成 40000~50000（10000ms）= 锚窗长，未超上界 → 正常返回
    const win = SemanticAnalyzeStrategy.findAsrWindowByTime(asr, 40000, 50000);
    expect(win).toEqual({ sourceStartMs: 40000, sourceEndMs: 50000 });
  });

  it('[FT-8] 长正常句不被 P1 误杀', () => {
    const asr = [
      asrLine('今天教大家做一道非常好吃的红烧肉做法分享给大家', 10000, 15000),
    ];
    // 长度 23（≥20）但单字符占比极低 → 不判为幻觉行，正常返回
    const win = SemanticAnalyzeStrategy.findAsrWindowByTime(asr, 10000, 20000);
    expect(win).toEqual({ sourceStartMs: 10000, sourceEndMs: 15000 });
  });

  it('[FT-9] 空 ASR 轴 → 返回 null', () => {
    expect(SemanticAnalyzeStrategy.findAsrWindowByTime([], 10000, 20000)).toBeNull();
  });
});