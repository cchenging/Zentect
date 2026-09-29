// 📁 路径: src/main/engine/strategies/__tests__/SemanticAnalyzeStrategy.cleanInout.test.ts
// 🎬 补丁20 · 光学净画出入点 ASR 台词边界生产者（ISSUE-7）单元测试
// 覆盖:
//   1. 原声段命中 ASR 行 → 写出 asrAnchorStartMs/asrAnchorEndMs（与 silenceGapMs 同源，一次匹配派生）
//   2. 非原声段 → 恒不写出（TTS 旁白无 ASR 数据，守「不可造假门」）
//   3. 原声段但 ASR 行未命中（重叠≤0）/ 无 asrLines → 恒不写出
//   4. 重叠取最大者：命中多条时取重叠最大的那条台词边界
//   5. 缺省调用方（不传 asrLines）⇒ 产物字段集零变化（旧链路无感）
//   6. ASR 行时间字段归一化：秒数字 / "mm:ss" / startTime-endTime 三形态均转 ms（跨来源兼容）
//   7. 归一化优先毫秒族；任一端缺失/不可解析 ⇒ 不写锚（守「不造假门」，不猜 0）
//   8. 净画出入点纯函数（Node 侧复刻 daemon `_clean_inout_window`）：slack 三档 + 锚双端与退化
//   9. 接线层：off 档 / 未位移引用直通；on 档时长恒 = target

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../../core/AppLogger', () => ({
  AppLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@modules/infra/logger/LogConstants', () => ({
  LOG_TAGS: { AI_AGENT: 'AI_AGENT', SCHEDULER: 'SCHEDULER' },
}));

import { SemanticAnalyzeStrategy } from '../SemanticAnalyzeStrategy';

/** 原声段：带 audioSource 源时间窗（ASR 重叠匹配优先用它） */
const origShot = (winS: number, winE: number) => ({
  id: 'seg_o1',
  shotId: 'seg_o1',
  type: 'original_audio',
  text: '我爷不行了',
  audioSource: { sourceStartMs: winS, sourceEndMs: winE },
});

/** 解说段：TTS 旁白，无原声窗 */
const narrShot = () => ({
  id: 'seg_n1',
  shotId: 'seg_n1',
  type: 'narration',
  text: '他站在门口',
});

describe('补丁20 · 光学净画出入点 ASR 台词边界生产者', () => {
  it('原声段命中 ASR 行 → 写出 asrAnchorStartMs/EndMs', () => {
    const asrLines = [{ startMs: 3000, endMs: 5200, silenceGapMs: 240 }];
    const qs = SemanticAnalyzeStrategy.buildMatchQueries(
      [origShot(2000, 6000)], [], 0, undefined, undefined, asrLines);
    expect(qs).toHaveLength(1);
    expect(qs[0].keepOriginalAudio).toBe(true);
    expect(qs[0].asrAnchorStartMs).toBe(3000);
    expect(qs[0].asrAnchorEndMs).toBe(5200);
    // 与既有气口同源（一次匹配派生，不得漂移）
    expect(qs[0].silenceGapMs).toBe(240);
  });

  it('非原声段 → 恒不写出（TTS 旁白无 ASR 数据，不造假）', () => {
    const asrLines = [{ startMs: 0, endMs: 1000, silenceGapMs: 100 }];
    const qs = SemanticAnalyzeStrategy.buildMatchQueries(
      [narrShot()], [], 0, undefined, undefined, asrLines);
    expect(qs).toHaveLength(1);
    expect(qs[0].keepOriginalAudio).toBe(false);
    expect(qs[0].asrAnchorStartMs).toBeUndefined();
    expect(qs[0].asrAnchorEndMs).toBeUndefined();
    expect(qs[0].silenceGapMs).toBeUndefined();
  });

  it('原声段但 ASR 行未命中（重叠≤0）/ 无 asrLines → 恒不写出', () => {
    // 源窗 2000~6000，ASR 行 9000~9500 ⇒ 重叠 ≤0，未命中
    const miss = SemanticAnalyzeStrategy.buildMatchQueries(
      [origShot(2000, 6000)], [], 0, undefined, undefined,
      [{ startMs: 9000, endMs: 9500, silenceGapMs: 120 }]);
    expect(miss[0].asrAnchorStartMs).toBeUndefined();
    expect(miss[0].asrAnchorEndMs).toBeUndefined();

    // 无 asrLines
    const none = SemanticAnalyzeStrategy.buildMatchQueries(
      [origShot(2000, 6000)], [], 0, undefined, undefined, undefined);
    expect(none[0].asrAnchorStartMs).toBeUndefined();
    expect(none[0].asrAnchorEndMs).toBeUndefined();
  });

  it('多条 ASR 行 → 取重叠最大者（与 silenceGapMs 同一条，不漂移）', () => {
    const asrLines = [
      { startMs: 2100, endMs: 2400, silenceGapMs: 50 },   // 与源窗 2000~6000 重叠 300
      { startMs: 3000, endMs: 5600, silenceGapMs: 300 },  // 重叠 2600（最大）
      { startMs: 5700, endMs: 5900, silenceGapMs: 80 },   // 重叠 200
    ];
    const qs = SemanticAnalyzeStrategy.buildMatchQueries(
      [origShot(2000, 6000)], [], 0, undefined, undefined, asrLines);
    expect(qs[0].asrAnchorStartMs).toBe(3000);
    expect(qs[0].asrAnchorEndMs).toBe(5600);
    expect(qs[0].silenceGapMs).toBe(300);
  });

  it('缺省调用方（不传 asrLines）⇒ 新字段不出现（旧链路字段集零变化）', () => {
    const qs = SemanticAnalyzeStrategy.buildMatchQueries([origShot(2000, 6000)], []);
    expect(qs[0]).not.toHaveProperty('asrAnchorStartMs');
    expect(qs[0]).not.toHaveProperty('asrAnchorEndMs');
    expect(qs[0]).not.toHaveProperty('silenceGapMs');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 净画出入点纯函数（Node 侧复刻 daemon `_clean_inout_window`）
// 覆盖:
//   6. 素材不比目标长（slack ≤ 0）/ 非法入参 ⇒ 入点原样（不造假收窄）
//   7. 富余 ≥ 2×边距 ⇒ 两端各内缩 200ms（无锚时取 lo）
//   8. 锚优先「出点=台词结尾」（anchorEnd − target 落可行域）
//   9. 出点不可行 ⇒ 退「入点=台词开头」
//  10. 两锚都不可行 ⇒ 退纯内缩（不猜默认值）
//  11. 0 < slack < 2×边距 ⇒ 均分 slack/2（可行域退化仍非空）
//  12. 接线层：off 档 / 未位移 ⇒ 原对象引用直通（零拷贝零日志）；on 档 ⇒ 时长恒 = target
// ─────────────────────────────────────────────────────────────────────────────
describe('补丁20 · 净画出入点纯函数（Node 侧复刻 daemon _clean_inout_window）', () => {
  const EDGE = 200;

  it('slack ≤ 0 / 非法入参 ⇒ 入点原样、时长 = target（不造假收窄）', () => {
    // 承载切片 4000（< target 6000）⇒ slack = -2000
    const short = SemanticAnalyzeStrategy.cleanInoutWindow(1000, 5000, 6000, EDGE, 2000, 3000);
    expect(short.tIn).toBe(1000);
    expect(short.dur).toBe(6000);
    // 等长 ⇒ slack = 0
    const eq = SemanticAnalyzeStrategy.cleanInoutWindow(1000, 7000, 6000, EDGE);
    expect(eq.tIn).toBe(1000);
    // target ≤ 0
    const bad = SemanticAnalyzeStrategy.cleanInoutWindow(0, 10000, 0, EDGE);
    expect(bad.tIn).toBe(0);
    expect(bad.dur).toBe(0);
  });

  it('富余 ≥ 2×边距、无锚 ⇒ 两端各内缩 200ms（tIn = start + edge）', () => {
    // 0~10000, target 6000 ⇒ slack 4000 ≥ 400 ⇒ inset 200；可行域 [200, 3800]
    const r = SemanticAnalyzeStrategy.cleanInoutWindow(0, 10000, 6000, EDGE);
    expect(r.tIn).toBe(200);
    expect(r.dur).toBe(6000);
  });

  it('锚优先「出点=台词结尾」：tIn = anchorEnd − target', () => {
    // anchorEnd 7000 ⇒ c = 1000 ∈ [200, 3800]（出点恰落台词结尾）
    const r = SemanticAnalyzeStrategy.cleanInoutWindow(0, 10000, 6000, EDGE, 100, 7000);
    expect(r.tIn).toBe(1000);
    expect(r.tIn + r.dur).toBe(7000);
  });

  it('出点不可行 ⇒ 退「入点=台词开头」', () => {
    // anchorEnd 4000 ⇒ c = -2000 ∉ 可行域；anchorStart 3000 ∈ [200, 3800] ⇒ 采用
    const r = SemanticAnalyzeStrategy.cleanInoutWindow(0, 10000, 6000, EDGE, 3000, 4000);
    expect(r.tIn).toBe(3000);
  });

  it('两锚都不可行 ⇒ 退纯内缩（不猜默认值）', () => {
    // anchorEnd 20000 ⇒ c = 14000 ∉；anchorStart 0 < lo 200 ⇒ 都不可行
    const r = SemanticAnalyzeStrategy.cleanInoutWindow(0, 10000, 6000, EDGE, 0, 20000);
    expect(r.tIn).toBe(200);
    expect(r.dur).toBe(6000);
  });

  it('0 < slack < 2×边距 ⇒ 均分 slack/2（可行域退化为单点仍非空）', () => {
    // 0~6300, target 6000 ⇒ slack 300 ⇒ inset 150；lo = hi = 150
    const r = SemanticAnalyzeStrategy.cleanInoutWindow(0, 6300, 6000, EDGE, 5000, 6200);
    expect(r.tIn).toBe(150);
    expect(r.dur).toBe(6000);
  });
});

describe('补丁20 · 净画出入点接线层（原声段专用，env 开关 ZENTECT_KM_CLEAN_INOUT）', () => {
  const ENV_KEY = 'ZENTECT_KM_CLEAN_INOUT';
  const saved = process.env[ENV_KEY];
  const setEnv = (v: string | undefined) => {
    if (v === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = v;
  };
  const chunk = () => ({ id: 'ck1', coverPath: 'p.png', startMs: 0, endMs: 10000, durationMs: 10000 });

  it('off 档（缺省）⇒ 原对象引用直通，零拷贝零位移（零行为变化）', () => {
    setEnv(undefined);
    const c = chunk();
    const r = SemanticAnalyzeStrategy.applyCleanInoutToChunk(c, 6000, 100, 7000);
    expect(r.chunk).toBe(c);          // 引用相等 = 未拷贝
    expect(r.shifted).toBe(false);
    expect(r.chunk.durationMs).toBe(10000);
    expect(r.anchored).toBe(true);    // 带锚事实仍如实上报（仅计数用，不改切片）
  });

  it('off 档：非法/非正数 env 一律视为关闭', () => {
    for (const bad of ['', '0', '-1', 'abc']) {
      setEnv(bad);
      const c = chunk();
      expect(SemanticAnalyzeStrategy.applyCleanInoutToChunk(c, 6000).chunk).toBe(c);
    }
  });

  it('on 档 ⇒ 位移后时长恒 = target，出点落台词结尾', () => {
    setEnv('1');
    const r = SemanticAnalyzeStrategy.applyCleanInoutToChunk(chunk(), 6000, 100, 7000);
    expect(r.shifted).toBe(true);
    expect(r.from).toBe(0);
    expect(r.to).toBe(10000);
    expect(r.chunk.startMs).toBe(1000);
    expect(r.chunk.endMs).toBe(7000);
    expect(r.chunk.durationMs).toBe(6000);
    expect(r.anchored).toBe(true);
  });

  it('on 档但 slack ≤ 0 ⇒ 原对象直通（不留假诊断）', () => {
    setEnv('1');
    const c = { id: 'ck2', startMs: 0, endMs: 5000, durationMs: 5000 };
    const r = SemanticAnalyzeStrategy.applyCleanInoutToChunk(c, 6000, 100, 4900);
    expect(r.chunk).toBe(c);
    expect(r.shifted).toBe(false);
  });

  it('on 档但仍会保留其余字段（用户字段不丢）', () => {
    setEnv('1');
    const r = SemanticAnalyzeStrategy.applyCleanInoutToChunk(chunk(), 6000, 3000, 4000);
    expect(r.chunk.id).toBe('ck1');
    expect(r.chunk.coverPath).toBe('p.png');
    expect(r.chunk.startMs).toBe(3000);   // 退「入点=台词开头」
    expect(r.chunk.durationMs).toBe(6000);
  });

  // 每例后复位 env，避免污染同文件其它用例
  afterEach(() => setEnv(saved));
});

describe('补丁20 · ASR 行时间字段归一化（跨来源形态兼容，守「不造假门」）', () => {
  it('步骤1 落库形态：start/end 为【秒】数字 → 归一化为 ms', () => {
    const qs = SemanticAnalyzeStrategy.buildMatchQueries(
      [origShot(2000, 6000)], [], 0, undefined, undefined,
      [{ start: 3, end: 5.2, silenceGapMs: 240, text: '我爷不行了' }]);
    expect(qs[0].asrAnchorStartMs).toBe(3000);
    expect(qs[0].asrAnchorEndMs).toBe(5200);
    expect(qs[0].silenceGapMs).toBe(240); // 气口与锚同源，不漂移
  });

  it('DB/whisper 形态：start/end 为 "mm:ss" 字符串 → 归一化为 ms', () => {
    const qs = SemanticAnalyzeStrategy.buildMatchQueries(
      [origShot(2000, 6000)], [], 0, undefined, undefined,
      [{ start: '00:03', end: '00:05', text: '我爷不行了' }]);
    expect(qs[0].asrAnchorStartMs).toBe(3000);
    expect(qs[0].asrAnchorEndMs).toBe(5000);
  });

  it('中形态：startTime/endTime（秒）→ 归一化为 ms', () => {
    const qs = SemanticAnalyzeStrategy.buildMatchQueries(
      [origShot(2000, 6000)], [], 0, undefined, undefined,
      [{ startTime: 3, endTime: 5, text: '我爷不行了' }]);
    expect(qs[0].asrAnchorStartMs).toBe(3000);
    expect(qs[0].asrAnchorEndMs).toBe(5000);
  });

  it('毫秒族优先（同带 startMs 与 start 时不被秒族覆盖）', () => {
    const qs = SemanticAnalyzeStrategy.buildMatchQueries(
      [origShot(2000, 6000)], [], 0, undefined, undefined,
      [{ startMs: 3000, endMs: 5200, start: 99, end: 99, text: '我爷不行了' }]);
    expect(qs[0].asrAnchorStartMs).toBe(3000);
    expect(qs[0].asrAnchorEndMs).toBe(5200);
  });

  it('任一端缺失/不可解析 ⇒ 恒不写出（不猜 0，守「不造假门」）', () => {
    const cases = [
      [{ text: '我爷不行了' }],                       // 无任何时间字段
      [{ start: 3, text: '我爷不行了' }],             // 缺 end
      [{ start: 'abc', end: '00:05', text: '我爷不行了' }], // 不可解析
    ];
    for (const asrLines of cases) {
      const qs = SemanticAnalyzeStrategy.buildMatchQueries(
        [origShot(2000, 6000)], [], 0, undefined, undefined, asrLines as any);
      expect(qs[0].asrAnchorStartMs).toBeUndefined();
      expect(qs[0].asrAnchorEndMs).toBeUndefined();
      expect(qs[0].silenceGapMs).toBeUndefined();
    }
  });

  it('归一化后仍按「重叠取最大」选行（来源混排不改变竞争口径）', () => {
    const asrLines = [
      { start: 2.1, end: 2.4, silenceGapMs: 50, text: 'a' },   // 秒族，重叠 300
      { startMs: 3000, endMs: 5600, silenceGapMs: 300, text: 'b' }, // 毫秒族，重叠 2600（最大）
      { start: '00:05.7' as any, end: '00:05.9' as any, silenceGapMs: 80, text: 'c' },
    ];
    const qs = SemanticAnalyzeStrategy.buildMatchQueries(
      [origShot(2000, 6000)], [], 0, undefined, undefined, asrLines as any);
    expect(qs[0].asrAnchorStartMs).toBe(3000);
    expect(qs[0].asrAnchorEndMs).toBe(5600);
    expect(qs[0].silenceGapMs).toBe(300);
  });
});
