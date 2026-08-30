// 📁 路径: src/main/engine/strategies/__tests__/SemanticAnalyzeStrategy.findAsrSourceWindow.test.ts
// 🎯 原声段 ASR 时间窗定位（findAsrSourceWindow）单元测试
// 覆盖核心路径:
//   1. 单行命中: 文本与 ASR 行直接包含匹配
//   2. 跨多行合并: 台词被 ASR 切成多行 → 合并成完整台词时间窗
//   3. 时间锚点收窄: 台词重复出现时, 锚点窗口内优先, 避免跨镜头误匹配
//   4. 锚点窗口内无命中 → 退回全轴匹配
//   5. 超短语气词过滤: "嗯/啊" 这类短行不污染时间窗
//   6. 未命中返回 null

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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SemanticAnalyzeStrategy.findAsrSourceWindow — 原声段 ASR 时间窗定位', () => {
  it('[AW-1] 单行命中: 文本包含 ASR 行 → 返回该行时间窗', () => {
    const asr = [
      asrLine('大家好，欢迎来到我的频道', 10000, 15000),
      asrLine('今天教大家做一道红烧肉', 16000, 21000),
    ];
    const win = SemanticAnalyzeStrategy.findAsrSourceWindow('今天教大家做一道红烧肉', asr);
    expect(win).toEqual({ sourceStartMs: 16000, sourceEndMs: 21000 });
  });

  it('[AW-2] 跨多行合并: 台词被 ASR 切成多行 → 合并成完整台词时间窗', () => {
    const asr = [
      asrLine('前面一镜带过', 30000, 34000),
      asrLine('后来我们终于', 40000, 43000),
      asrLine('找到了那家店', 43200, 46000),
      asrLine('里面的老板人很好', 46200, 50000),
      asrLine('后面完全不相关的内容', 60000, 64000),
    ];
    // LLM 引用整段台词, ASR 切成 3 行 → 期望合并 40000~50000 的连续 3 行
    const win = SemanticAnalyzeStrategy.findAsrSourceWindow('后来我们终于找到了那家店里面的老板人很好', asr);
    expect(win).toEqual({ sourceStartMs: 40000, sourceEndMs: 50000 });
  });

  it('[AW-3] 时间锚点收窄: 台词重复出现时, 锚点窗口内优先, 避免跨镜头误匹配', () => {
    const asr = [
      asrLine('老铁们点点关注', 10000, 14000),
      asrLine('老铁们给力', 30000, 34000),
      asrLine('老铁们再见', 60000, 64000),
    ];
    // 锚点指向 30~38s 的画面区间 → 窗口 [27000, 39000] 只含中间那处 → 命中 30000~34000
    const win = SemanticAnalyzeStrategy.findAsrSourceWindow('老铁们', asr, 28000, 38000);
    expect(win).toEqual({ sourceStartMs: 30000, sourceEndMs: 34000 });
  });

  it('[AW-4] 锚点窗口内无命中 → 退回全轴匹配', () => {
    const asr = [
      asrLine('开头说了个开场白', 1000, 5000),
      asrLine('关键台词出现了', 100000, 105000),
    ];
    // 锚点在 20000~25000, 窗口内无匹配 → 全轴找到"关键台词出现了"
    const win = SemanticAnalyzeStrategy.findAsrSourceWindow('关键台词出现了', asr, 20000, 25000);
    expect(win).toEqual({ sourceStartMs: 100000, sourceEndMs: 105000 });
  });

  it('[AW-5] 超短语气词过滤: "嗯/啊" 这类短行不污染时间窗', () => {
    const asr = [
      asrLine('嗯', 1000, 1800),
      asrLine('我们出发吧', 2000, 6000),
      asrLine('啊', 6200, 7000),
    ];
    const win = SemanticAnalyzeStrategy.findAsrSourceWindow('我们出发吧', asr);
    // "我们出发吧" 直接匹配; "嗯"/"啊" 为超短行被过滤 → 只返回 2000~6000
    expect(win).toEqual({ sourceStartMs: 2000, sourceEndMs: 6000 });
  });

  it('[AW-6] 未命中返回 null', () => {
    const asr = [
      asrLine('完全不相关的旁白', 1000, 5000),
    ];
    const win = SemanticAnalyzeStrategy.findAsrSourceWindow('这句台词片中没出现过', asr);
    expect(win).toBeNull();
  });
});
