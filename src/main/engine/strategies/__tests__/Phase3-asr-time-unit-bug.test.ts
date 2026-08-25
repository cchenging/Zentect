/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ScriptGenStrategy } from '../ScriptGenStrategy';
import { SemanticAnalyzeStrategy } from '../SemanticAnalyzeStrategy';

// ============================================================
// Mock：AppLogger & LOG_TAGS（避免 import 真实模块，保持单测 O(1ms) 快）
// ============================================================
vi.mock('../../../core/AppLogger', () => ({
  AppLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock('@modules/infra/logger/LogConstants', () => ({
  LOG_TAGS: {
    AI_AGENT: 'AI_AGENT',
    AI_DAEMON: 'AI_DAEMON',
  },
}));

// 访问 private helper：通过 any 类型强转
const asrLineToMs = (ScriptGenStrategy as any)._asrLineToMs as typeof ScriptGenStrategy['_asrLineToMs'];
const resolveScriptShotTiming = (SemanticAnalyzeStrategy as any)._resolveScriptShotTiming as
  typeof SemanticAnalyzeStrategy['_resolveScriptShotTiming'];

describe('🔧 8/19 项目 ASR 秒→毫秒时间单位 bug 修复（Phase 3 time-unit fix）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =================================================================================
  // Part 1：ScriptGenStrategy._asrLineToMs（修复 A1/A2/A3 三处 ASR 时间戳单位）
  // =================================================================================
  describe('ScriptGenStrategy._asrLineToMs（ASR 台词行 → 毫秒归一化）', () => {

    it('🎯 只有 start/end 秒字段 → 正确 ×1000（8/19 项目典型场景，之前直接返回 18 秒当成 18ms ❌）', () => {
      // 典型：ASR 输出 "鼎青楼" 那段在素材 18s ~ 20.5s
      const line = { start: 18, end: 20.5, text: '裂纹横亘在鼎青楼的匾额之上' };
      const out = asrLineToMs(line, 0, 0);
      expect(out.startMs).toBe(18000);       // 秒 → ms
      expect(out.endMs).toBe(20500);         // 20.5 秒 → 20500 ms
    });

    it('🎯 有明确 startMs/endMs 毫秒字段 → 真值不覆盖，不二次乘 1000（避免修正后新老数据混用再 bug）', () => {
      // 新项目/重新跑 Step3 后的数据，明确给了毫秒：1969000ms（32:49）
      const line = {
        startMs: 1969000,
        endMs: 1972300,
        start: 1969,     // 即使同时带了秒字段（有些链路会冗余写入），优先用毫秒
        end: 1972.3,
        text: '最后一段真实台词（32:49处）',
      };
      const out = asrLineToMs(line, 0, 0);
      expect(out.startMs).toBe(1969000);     // ✅ 1969000 真值，不会变成 1,969,000,000（×1000 二次伤害）
      expect(out.endMs).toBe(1972300);
    });

    it('🎯 混合：有 startMs（毫秒）但 end 只有秒值 → 各走各的优先级链', () => {
      const line = { startMs: 1200, end: 4.5 };     // start 给了毫秒=1.2s，end 只给了秒=4.5s
      const out = asrLineToMs(line, 0, 0);
      expect(out.startMs).toBe(1200);
      expect(out.endMs).toBe(4500);
    });

    it('🎯 缺 start 缺 end → 用 defaultStartMs / defaultEndMs 兜底（避免 undefined 导致 chunkStartMs=NaN）', () => {
      // 场景 1：不传 defaultEndMs → 默认 fallback 到 startMs + 4000
      const out1 = asrLineToMs({}, 0);
      expect(out1.startMs).toBe(0);
      expect(out1.endMs).toBe(4000);              // 默认：没给 defaultEndMs → start+4000 ms
      // 场景 2：显式给了 defaultEndMs=0（有些调用方明确要求兜底到起点）→ 就用 0，不硬加 4000
      const outZero = asrLineToMs({}, 0, 0);
      expect(outZero.startMs).toBe(0);
      expect(outZero.endMs).toBe(0);
      // 场景 3：明确给了 defaultStartMs / defaultEndMs，且 line=null/空
      const out2 = asrLineToMs(null as any, 500, 5000);
      expect(out2.startMs).toBe(500);
      expect(out2.endMs).toBe(5000);              // defaultEndMs 明确给了 5000ms 兜底
    });

    it('🎯 非整数秒（18.327 秒）→ 四舍五入取整毫秒（避免浮点 0.1+0.2=0.30000000000000004 污染）', () => {
      const line = { start: 18.3276, end: 20.9992 };
      const out = asrLineToMs(line, 0, 0);
      expect(out.startMs).toBe(18328);           // 18.3276 → round → 18328
      expect(out.endMs).toBe(20999);             // 20.9992 → round → 20999
    });
  });

  // =================================================================================
  // Part 2：SemanticAnalyzeStrategy._resolveScriptShotTiming（修复 Bug B）
  // =================================================================================
  describe('SemanticAnalyzeStrategy._resolveScriptShotTiming（解说词 shot → 毫秒归一化）', () => {

    it('🎯 只有 start/end 秒字段（8/19 项目 Step1 出的 shots，之前 durationMs 全是 0 ❌）', () => {
      const shot = { start: 18, end: 20, text: '裂纹横亘在鼎青楼的匾额之上' };
      const out = resolveScriptShotTiming(shot);
      expect(out.startMs).toBe(18000);
      expect(out.durationMs).toBe(2000);         // (20-18)*1000 = 2000 ms
    });

    it('🎯 有明确 startMs/durationMs 毫秒字段 → 真值不覆盖（老数据不二次 ×1000）', () => {
      const shot = {
        startMs: 18000,
        durationMs: 2000,
        start: 18, end: 20,   // 冗余秒字段也带着
      };
      const out = resolveScriptShotTiming(shot);
      expect(out.startMs).toBe(18000);           // 18000ms 保留原样，不会变成 18*1000*1000
      expect(out.durationMs).toBe(2000);
    });

    it('🎯 有单独 start（秒）但没有 end/durationMs → durationMs=0 兜底（不抛错不 NaN）', () => {
      const shot = { start: 42 };
      const out = resolveScriptShotTiming(shot);
      expect(out.startMs).toBe(42000);
      expect(out.durationMs).toBe(0);            // 无时长信息 → 0 兜底，不会 undefined
    });

    it('🎯 有单独 duration（秒）字段（某些 Step3 链路只给 duration）→ 兜底 ×1000', () => {
      const shot = { start: 9, duration: 4.5 };
      const out = resolveScriptShotTiming(shot);
      expect(out.startMs).toBe(9000);
      expect(out.durationMs).toBe(4500);         // duration=4.5 秒 → 4500ms
    });

    it('🎯 边界：end < start（脏数据/乱序）→ durationMs 不返回负数，至少 0', () => {
      const shot = { start: 20, end: 18 };       // 写反了 18/20
      const out = resolveScriptShotTiming(shot);
      expect(out.startMs).toBe(20000);
      expect(out.durationMs).toBe(0);            // 不会变成 -2000，保证下游 Math.max/排序不炸
    });

    it('🎯 全缺字段（null/undefined/空 obj）→ 0 兜底不炸', () => {
      expect(resolveScriptShotTiming(null)).toStrictEqual({ startMs: 0, durationMs: 0 });
      expect(resolveScriptShotTiming(undefined)).toStrictEqual({ startMs: 0, durationMs: 0 });
      expect(resolveScriptShotTiming({})).toStrictEqual({ startMs: 0, durationMs: 0 });
    });
  });

  // =================================================================================
  // Part 3：buildMatchQueries 集成端到端验证（把 A/B 两个 bug 串起来）
  // =================================================================================
  describe('SemanticAnalyzeStrategy.buildMatchQueries（整体输出 query 字段正确性）', () => {

    it('🎯 只传秒级 shot（Step1 ASR 产出 + 跳过 Step3 的典型场景）→ startMs/durationMs 自动换算到毫秒', () => {
      const scriptShots = [
        { id: 'shot_1', text: '台词一', start: 0,    end: 9    },  // 秒：0→9
        { id: 'shot_2', text: '台词二', start: 9,    end: 16   },  // 秒：9→16
        { id: 'shot_3', text: '台词三', start: 18,   end: 23.5 },  // 秒：18→23.5
      ];
      const qs = SemanticAnalyzeStrategy.buildMatchQueries(scriptShots, []);
      expect(qs).toHaveLength(3);
      expect(qs[0].startMs).toBe(0);
      expect(qs[0].durationMs).toBe(9000);
      expect(qs[1].startMs).toBe(9000);
      expect(qs[1].durationMs).toBe(7000);
      expect(qs[2].startMs).toBe(18000);
      expect(qs[2].durationMs).toBe(5500);           // (23.5-18) ×1000 = 5500 ms
      // 保证文案没被改坏（visualIntent 兜底后依然作为独立 tag 拼在末尾 | 分隔）
      expect(qs[0].text.startsWith('台词一')).toBe(true);
    });

    it('🎯 毫秒级 shot（Step3 新生成，带 startMs/durationMs）→ 真值不覆盖', () => {
      const scriptShots = [
        { id: 'shot_1', text: '鼎青楼', startMs: 18000, durationMs: 2500, start: 18, end: 20.5 },
      ];
      const qs = SemanticAnalyzeStrategy.buildMatchQueries(scriptShots, []);
      expect(qs[0].startMs).toBe(18000);            // 原毫秒值保留
      expect(qs[0].durationMs).toBe(2500);           // 原毫秒值保留（不会变成 (20.5-18)*1000=2500，恰好相等但走的是真值分支）
    });

    it('🎯 空文本段落自动被 filter 掉（避免 Step5 拿空 query 去 KM 造成 NaN）', () => {
      const scriptShots = [
        { id: 's1', text: '', start: 0, end: 1 },
        { id: 's2', text: '只有这段有效', start: 1, end: 3 },
        { id: 's3', text: '   \n\t  ', start: 3, end: 5 }, // 纯空白
      ];
      const qs = SemanticAnalyzeStrategy.buildMatchQueries(scriptShots, []);
      expect(qs).toHaveLength(1);
      expect(qs[0].shotId).toBe('s2');
    });
  });
});
