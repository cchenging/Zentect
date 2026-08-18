// 📁 路径: src/main/engine/strategies/__tests__/SemanticAnalyzeStrategy.realdata.test.ts
// 🎯 方案A Top-K 预选 + 审计的"真实项目数据"回归测试
// 用法（项目根目录）:
//   先跑 node scripts/diag-project-top3.cjs <可选projectId>  生成 data/_diag_dump/*.json
//   再跑 npx vitest run src/main/engine/strategies/__tests__/SemanticAnalyzeStrategy.realdata.test.ts

import { describe, it, expect, vi, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// === Mock 依赖链（同 preselectTopK.test.ts） ===
vi.mock('../../../core/AppLogger', () => ({
  AppLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock('@modules/infra/logger/LogConstants', () => ({
  LOG_TAGS: { AI_AGENT: 'AI_AGENT', SCHEDULER: 'SCHEDULER' },
}));

import { SemanticAnalyzeStrategy } from '../SemanticAnalyzeStrategy';
import type {
  SemanticAnalyzeStrategy as _SAS,
} from '../SemanticAnalyzeStrategy';

// ============================================================
// 加载最新 dump：自动找 data/_diag_dump/ 下最新 JSON
// ============================================================
type DumpShape = {
  projectId: string;
  projectName: string;
  queries: Array<{
    shotId: string; text: string; audioDurationMs: number;
    emotion?: string; visualIntent?: string;
    startMs: number; durationMs: number;
  }>;
  videoChunks: Array<any>;
  finalMatches: Array<{ shotId: string; chunkId: string; confidence: number | null }>;
  fallbackMatches: Array<{ shotId: string; chunkId: string; confidence: number | null; source?: string }>;
};
function loadLatestDump(): DumpShape | null {
  // __dirname = src/main/engine/strategies/__tests__
  // 项目根: src 的父级目录
  const dumpDir = path.join(__dirname, '..', '..', '..', '..', '..', 'data', '_diag_dump');
  if (!fs.existsSync(dumpDir)) return null;
  const files = fs.readdirSync(dumpDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ name: f, full: path.join(dumpDir, f), mtime: fs.statSync(path.join(dumpDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!files.length) return null;
  const latest = files[0];
  // eslint-disable-next-line no-console
  console.log(`[realdata.test] 使用 dump: ${latest.name}  (${new Date(latest.mtime).toLocaleString()})`);
  return JSON.parse(fs.readFileSync(latest.full, 'utf-8'));
}

// ============================================================
// 命中率计算：最终匹配的 chunk 被预选（perQueryTopK or filteredChunks 并集）收录的比例
// ============================================================
function calcHitRate(
  matches: Array<{ shotId: string; chunkId: string }>,
  perQueryTopK: Record<string, string[]>,
  unionSet: Set<string>,
): { shotsWithMatch: number; hitPerQuery: number; hitUnion: number; ratePerQuery: number; rateUnion: number } {
  let shotsWithMatch = 0, hitPerQuery = 0, hitUnion = 0;
  for (const m of matches) {
    if (!m.shotId || !m.chunkId) continue;
    shotsWithMatch++;
    const inPer = perQueryTopK[m.shotId]?.includes(m.chunkId);
    if (inPer) hitPerQuery++;
    if (unionSet.has(m.chunkId)) hitUnion++;
  }
  return {
    shotsWithMatch,
    hitPerQuery,
    hitUnion,
    ratePerQuery: shotsWithMatch ? hitPerQuery / shotsWithMatch : 0,
    rateUnion: shotsWithMatch ? hitUnion / shotsWithMatch : 0,
  };
}

describe('SemanticAnalyzeStrategy.preselectTopK 真实项目数据回归', () => {
  let dump: DumpShape | null = null;

  beforeAll(() => {
    dump = loadLatestDump();
    if (!dump) {
      // eslint-disable-next-line no-console
      console.warn('[realdata.test] ⚠️ 未找到 dump JSON，请先运行 node scripts/diag-project-top3.cjs 生成，跳过本测试套件');
    }
  });

  // -------------------------------------------------------------------------
  // 场景 1：抽样 50 段 queries（避免 K=800 触发小项目保护） + 全量 chunks，直接触发预选
  //   - 预期: applied=true, M1 < M0, 压缩率 ~50~80%, 命中率（并集/ per-query）≥ 95%
  // -------------------------------------------------------------------------
  it('【抽样场景】N=50 queries 子样本 + M=全量 chunks → 触发预选并验证命中率', () => {
    if (!dump) return; // skip when no dump
    const N = Math.min(50, dump.queries.length);
    const subQueries = dump.queries.slice(0, N);
    const subChunks = dump.videoChunks; // 全量 359
    // 最终匹配：取 fallbackMatches 中 shotId 在 subQueries 范围内的（subQueries[].shotId）
    const subShotsIds = new Set(subQueries.map(q => q.shotId));
    const subMatches = dump.fallbackMatches.filter(m => m.shotId && subShotsIds.has(m.shotId));

    const out = SemanticAnalyzeStrategy.preselectTopK(subQueries, subChunks, { logProjectId: dump.projectName });

    // 计算 union chunk ids 集合
    const unionSet = new Set(out.filteredChunks.map((c: any) => c.id || c.media_id));

    // 断言基础形态
    expect(typeof out.K).toBe('number');
    expect(out.M0).toBe(subChunks.length);
    expect(out.M1).toBe(unionSet.size);
    expect(out.filteredChunks.length).toBe(unionSet.size);

    // 对于这个真实数据，预期 K×1.5 < M 会触发预选，applied 应该 true
    // （若 description 覆盖率 <30% 则保护规则①跳，覆盖率按该项目 47% 不会跳）
    // eslint-disable-next-line no-console
    console.log(
      `\n  【抽样结果】project=${dump.projectName}  N=${N}  M0=${out.M0}  K=${out.K}  applied=${out.applied}  M1=${out.M1}  压缩率=${(out.M1 / Math.max(1, out.M0) * 100).toFixed(1)}%`
    );
    expect(out.applied).toBe(true);
    expect(out.M1).toBeLessThan(out.M0);

    // 并集补池保证：M1 ≥ max(2N, 10%M)
    const minUnion = Math.max(2 * N, Math.ceil(out.M0 * 0.1));
    expect(out.M1).toBeGreaterThanOrEqual(minUnion);

    // 命中率：fallbackMatches（按时间重叠推算的最终匹配 chunk）并集命中必须 ≥90%（因为该 chunk 就是时间最近的，时间锚加分很高）
    const rate = calcHitRate(subMatches, out.perQueryTopK, unionSet);
    // eslint-disable-next-line no-console
    console.log(
      `  【命中率】共 ${rate.shotsWithMatch} 段有匹配记录：per-query TopK 命中=${rate.hitPerQuery}/${rate.shotsWithMatch} (${(rate.ratePerQuery * 100).toFixed(1)}%),  并集命中=${rate.hitUnion}/${rate.shotsWithMatch} (${(rate.rateUnion * 100).toFixed(1)}%)\n`
    );
    // 并集命中应该接近 100%（时间锚 + 文本的组合会把该段最可能的 chunk 放进池），设 ≥80% 最低门槛
    expect(rate.rateUnion).toBeGreaterThanOrEqual(0.8);
  });

  // -------------------------------------------------------------------------
  // 场景 2：模拟大项目（chunk 复制 7 份，时间偏移避免完全相同 startMs）
  //   - N=全量 queries (444), M=359×7=2513  → K=800, K×1.5=1200 < 2513，会触发预选
  //   - 预期: M1 在 ~1000 量级 (压缩 ~50%+), 并集命中率 ≥95%（复制后匹配 chunk 的副本之一必进 topK）
  // -------------------------------------------------------------------------
  it('【大项目模拟】chunks×7 复制扩成大数据集 → 触发预选并验证压缩率与命中率', () => {
    if (!dump) return;
    const queries = dump.queries; // 444
    const baseChunks = dump.videoChunks;
    const videoEndMs = Math.max(...baseChunks.map(c => Number(c.endMs) || 0));
    const copies = 7;
    const expandedChunks: any[] = [];
    for (let i = 0; i < copies; i++) {
      for (const c of baseChunks) {
        const shiftedStart = Number(c.startMs || 0) + videoEndMs * i;
        const shiftedEnd = Number(c.endMs || 0) + videoEndMs * i;
        expandedChunks.push({
          ...c,
          id: `${c.id || 'chunk'}__cp${i}`,
          startMs: shiftedStart,
          endMs: shiftedEnd,
          // 保留原 description / emotion / shotType 等字段不变（这样每段文本相似度一样，只靠时间锚区分）
        });
      }
    }
    // 重新构造 matches：原始 fallbackMatches 的 chunkId 对应副本 0（__cp0）
    const expandedMatches = dump.fallbackMatches.map(m => ({
      shotId: m.shotId,
      chunkId: `${m.chunkId}__cp0`,
    }));

    const out = SemanticAnalyzeStrategy.preselectTopK(queries, expandedChunks, { logProjectId: `${dump.projectName}×${copies}` });
    const unionSet = new Set(out.filteredChunks.map((c: any) => c.id));

    // eslint-disable-next-line no-console
    console.log(
      `\n  【大项目结果】N=${queries.length}  M0=${out.M0}  K=${out.K}  applied=${out.applied}  M1=${out.M1}  压缩率=${(out.M1 / Math.max(1, out.M0) * 100).toFixed(1)}%`
    );

    expect(out.applied).toBe(true);
    expect(out.M0).toBe(copies * baseChunks.length);
    expect(out.M1).toBeLessThan(out.M0);
    expect(out.K).toBeGreaterThanOrEqual(15);

    // 并集补池
    const minUnion = Math.max(2 * queries.length, Math.ceil(out.M0 * 0.1));
    expect(out.M1).toBeGreaterThanOrEqual(minUnion);

    // 命中率（必进并集；perQueryTopK 也应该包含 cp0 或其他 cp，≥90% 门槛）
    const rate = calcHitRate(expandedMatches, out.perQueryTopK, unionSet);
    // eslint-disable-next-line no-console
    console.log(
      `  【命中率】共 ${rate.shotsWithMatch} 段：per-query TopK 命中=${rate.hitPerQuery}/${rate.shotsWithMatch} (${(rate.ratePerQuery * 100).toFixed(1)}%),  并集命中=${rate.hitUnion}/${rate.shotsWithMatch} (${(rate.rateUnion * 100).toFixed(1)}%)\n`
    );
    expect(rate.rateUnion).toBeGreaterThanOrEqual(0.9);
  });

  // -------------------------------------------------------------------------
  // 场景 3：保护规则① 触发：description 覆盖率 < 30% 时跳预选，applied=false
  //   用同一个项目，把 80% 的 chunk.description 清空，就会触发保护规则
  // -------------------------------------------------------------------------
  it('【保护规则①】description 覆盖率 15% 时跳过预选，返回全集 applied=false', () => {
    if (!dump) return;
    const queries = dump.queries.slice(0, 30);
    const videoChunks = dump.videoChunks;
    const projectName = dump.projectName;
    // 保留 15% 有 description，其他清空
    const keepRatio = 0.15;
    const chunksDegraded = videoChunks.map((c, i) =>
      i < Math.floor(videoChunks.length * keepRatio) ? c : { ...c, description: '', emotion: '' }
    );
    const out = SemanticAnalyzeStrategy.preselectTopK(queries, chunksDegraded, { logProjectId: `${projectName} - degrade15%` });
    expect(out.applied).toBe(false);
    expect(out.M1).toBe(out.M0);
    expect(out.filteredChunks.length).toBe(out.M0);
    expect(Object.keys(out.perQueryTopK).length).toBe(0);
    // eslint-disable-next-line no-console
    console.log(`\n  【保护①触发】覆盖率=${keepRatio * 100}%<30% → applied=${out.applied} (期望 false) ✓\n`);
  });
});
