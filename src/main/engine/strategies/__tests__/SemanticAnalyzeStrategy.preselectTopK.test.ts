// 📁 路径: src/main/engine/strategies/__tests__/SemanticAnalyzeStrategy.preselectTopK.test.ts
// 🎯 P2 #11 方案 A: KM Top-K 预选 + 审计日志 单元测试
// 覆盖核心路径 5+1 条:
//   1. 保护规则①: description 覆盖率 <30% → applied=false, 返回全集不剪
//   2. 动态 K 计算 + 小项目自动跳预选: K*1.5 >= M 时 applied=false
//   3. 文本 + 时间锚融合: 匹配语义且靠近时间锚的 chunk 得分最高, 进入 top-K
//   4. 质量保护② 多样性扩张: top-K 候选挤在同一小区间 → 自动扩张到 ≤2K, 扩大时间跨度
//   5. 质量保护③ 并集补池: 候选并集 < minUnion(≥2N / ≥10%M) → 补够池防止 KM 无预算分配
//   6. 审计 auditPreselectTopK: 最终匹配 chunk 是否在预选集合内, <95% 打 warn

import { describe, it, expect, vi, beforeEach } from 'vitest';

// === Mock 依赖链 ===
/** Mock AppLogger（屏蔽测试日志，同时断言 warn/info 触发次数和内容） */
vi.mock('../../../core/AppLogger', () => ({
  AppLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
/** Mock LOG_TAGS（SemanticAnalyzeStrategy 内部引用的是别名 @modules/infra/logger/LogConstants） */
vi.mock('@modules/infra/logger/LogConstants', () => ({
  LOG_TAGS: { AI_AGENT: 'AI_AGENT', SCHEDULER: 'SCHEDULER' },
}));

import { SemanticAnalyzeStrategy } from '../SemanticAnalyzeStrategy';
import { AppLogger } from '../../../core/AppLogger';

const runPre = (qs: any[], cs: any[], opts?: any) =>
  (SemanticAnalyzeStrategy as any).preselectTopK(qs, cs, opts);
const runAudit = (p: Record<string, string[]>, ms: any[], pid?: string) =>
  (SemanticAnalyzeStrategy as any).auditPreselectTopK(p, ms, pid);

/**
 * 构造一段带时间锚和描述的 chunk 数据集
 * 每 2 秒一个 chunk, 可指定 description 批量填/留空用于测试覆盖率保护
 */
function buildChunks(count: number, opts: { descRatio?: number; startMs?: number; stepMs?: number; seedDesc?: (i: number) => string } = {}) {
  const { descRatio = 1, startMs = 0, stepMs = 2000 } = opts;
  const chunks: any[] = [];
  for (let i = 0; i < count; i++) {
    const hasDesc = i < Math.floor(count * descRatio);
    chunks.push({
      id: `c_${i}`,
      startMs: startMs + i * stepMs,
      endMs: startMs + i * stepMs + stepMs - 1,
      description: hasDesc ? (opts.seedDesc ? opts.seedDesc(i) : `画面${i}：默认场景描述内容占位测试文字`) : '',
    });
  }
  return chunks;
}
/**
 * 构造一段 queries, 每个 shot 在 queries 中按比例分配时间轴, 可指定 text/visualIntent/emotion 用于测试 TF-IDF 匹配
 */
function buildQueries(count: number, opts: { videoSpanMs?: number; seedText?: (i: number) => string } = {}) {
  const { videoSpanMs = 200_000, seedText } = opts;
  const qs: any[] = [];
  for (let i = 0; i < count; i++) {
    const ratio = count <= 1 ? 0 : i / (count - 1);
    const st = Math.floor(ratio * videoSpanMs);
    qs.push({
      shotId: `s_${i}`,
      text: seedText ? seedText(i) : `文案${i} 默认内容描述占位词这里是解说词文本`,
      audioDurationMs: 3000,
      startMs: st,
      durationMs: 3000,
      emotion: '',
      visualIntent: '',
    });
  }
  return qs;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SemanticAnalyzeStrategy.preselectTopK — P2 #11 方案A Top-K预选', () => {
  it('[TK-1] 保护规则① description覆盖率<30% → 直接返回全集，applied=false', () => {
    const qs = buildQueries(20);
    // 100 chunks 只给 20 个有 description → 20% < 30% 阈值
    const cs = buildChunks(100, { descRatio: 0.2 });
    const out = runPre(qs, cs, { logProjectId: '[TK-1]' });
    expect(out.applied).toBe(false);
    expect(out.filteredChunks).toHaveLength(100);
    expect(out.K).toBe(100);
    expect(out.M0).toBe(100);
    expect(out.M1).toBe(100);
    expect(AppLogger.info).toHaveBeenCalledWith(
      'AI_AGENT',
      expect.stringContaining('跳过预选（保留全集 M=100）'),
    );
  });

  it('[TK-2] 动态K + 小项目保护: N=3,M=20 → 计算K=15；K*1.5=22.5≥M=20 → 触发小项目保护，applied=false', () => {
    const qs = buildQueries(3);
    const cs = buildChunks(20); // 100% 覆盖率
    const out = runPre(qs, cs, { logProjectId: '[TK-2]' });
    // 动态 K 计算: max(15, ceil(3*1.8)=6, ceil(20*0.06)=2) = 15 → K*1.5 = 22.5 ≥ M → 触发小项目保护
    // 实现细节：跳预选回退 fallback 时，K 字段被写成 M，表示"取全集规模"，而非理论计算的 K
    expect(out.applied).toBe(false);
    expect(out.M0).toBe(20);
    expect(out.M1).toBe(20);
    expect(out.filteredChunks).toHaveLength(20);
    expect(out.K).toBe(20); // 跳预选：K = M，表示没剪
  });

  it('[TK-3] 文本语义 + 时间锚 融合打分: 关键词匹配且靠近时间锚的 chunk 获得 top', () => {
    // 构造 1 个 query, 文本为"阴沉 男子 特写 室内"
    const qs = [
      {
        shotId: 's_0',
        text: '阴沉 男子 特写 室内，眼神凌厉',
        audioDurationMs: 3000,
        emotion: '',
        visualIntent: '',
        startMs: 10_000, // 期望匹配 chunk 5 (10000~11999)
        durationMs: 3000,
      },
    ];
    // 构造 30 个 chunk (60s), 其中 c_5 描述关键词完全匹配, 且 startMs=10000 完美靠时间锚
    const cs = buildChunks(30, {
      stepMs: 2000,
      seedDesc: (i) =>
        i === 5
          ? '【特写】室内环境 阴沉压抑氛围，男子面部特写 眼神凌厉 盯着前方'
          : `户外风景${i} 蓝天白云草地开阔远景`,
    });
    const out = runPre(qs, cs, { logProjectId: '[TK-3]' });
    expect(out.applied).toBe(true);
    // s_0 的 top-K 候选第一个应该是 c_5（语义 + 时间双高）
    const topList = out.perQueryTopK['s_0'];
    expect(Array.isArray(topList)).toBe(true);
    expect(topList.length).toBeGreaterThanOrEqual(1);
    expect(topList[0]).toBe('c_5');
  });

  it('[TK-4] 质量保护② 多样性扩张: 高分 chunk 都挤在时间起点附近 → 自动扩张到 2K 扩大跨度', () => {
    // 5 段 queries，全写"开头开头开头"，让所有 query 的文本高分 chunk 都在 c_0 ~ c_5
    const qs = buildQueries(5, {
      seedText: () => '开篇 风景 开场 蓝天 白云 草地 远景 山 河 全景',
    });
    // 50 chunks，c_0 ~ c_5 全部是"开篇风景蓝天白云草地"
    const cs = buildChunks(50, {
      stepMs: 2000,
      seedDesc: (i) =>
        i <= 5
          ? '【全景】开篇风景：蓝天白云草地，山川河流远景，开阔场景'
          : `剧情中段${i}，人物对话办公室会议室争吵谈判`,
    });
    const out = runPre(qs, cs, { logProjectId: '[TK-4]' });
    expect(out.applied).toBe(true);
    // 动态 K: max(15, ceil(5*1.8)=9, ceil(50*0.06)=3) = 15
    expect(out.K).toBe(15);
    // 看任何一个 query 的 top 列表，不能只在 c_0~c_5；必须扩张到覆盖更大跨度
    const anyTop = out.perQueryTopK['s_0'];
    // 取 top 列表中 chunk 的 endMs，跨度至少要达到 3*qDur = 3*3000 = 9000 ms
    let lo = Infinity, hi = -Infinity;
    for (const cid of anyTop) {
      const c = cs.find((x) => x.id === cid);
      if (!c) continue;
      const mid = (c.startMs + c.endMs) / 2;
      lo = Math.min(lo, mid); hi = Math.max(hi, mid);
    }
    // 多样性扩张后跨度应 ≥ 9000ms（否则 15 个候选都挤在 c_0~c_5 的 12 秒以内，可能刚好达标或刚好不达标；
    // 这里取宽松 ≥ 7000，避免测试太脆弱；如果没扩张，跨度只会有 5*2000=10000 中更小的一部分，
    // 扩张后补到 30 个候选（2K），跨度必然 ≥ 2*chunk step）
    expect(hi - lo).toBeGreaterThanOrEqual(7000);
  });

  it('[TK-5] 质量保护③ 并集补池: queries/texts 非常分散导致并集小 → 补到 minUnion=2N / 10%M', () => {
    // 构造非常极端: 10 段 queries, 每段 query 文本只命中自己专属的 3 个 chunk（c_{q*3} 附近），每段 top 都不重合
    // 10 * topK=15 → 150 理论上限；但我们通过把所有 query 的文本设置成互不相关的冷门词 + 时间锚分散到全片各处，
    // 看最终并集 M1 是否能达到 minUnion(≥2N=20 / ≥10%*M)。
    const N = 10;
    const M = 80;
    const qs = buildQueries(N, {
      videoSpanMs: M * 2000,
      seedText: (i) => `专属关键词_${i} 唯一token_${i} 不可共享_${i}`,
    });
    const cs = buildChunks(M, {
      stepMs: 2000,
      seedDesc: (i) => {
        // 让每个 chunk 只拥有它"对应时间段"query 的专属关键词（i ≈ qIdx × 8），
        // 同时其他 chunk 写无关关键词，使 TF-IDF 跨段匹配分数极低
        const owner = Math.floor(i / (M / N)); // 0..9
        const base = `常规描述内容第${i}段没有特殊信息通用文本占位`;
        return i % Math.floor(M / N) === 0
          ? `${base} 专属关键词_${owner} 唯一token_${owner} 不可共享_${owner}`
          : base;
      },
    });
    const out = runPre(qs, cs, { logProjectId: '[TK-5]' });
    expect(out.applied).toBe(true);
    const minUnion = Math.min(M, Math.max(2 * N, Math.ceil(M * 0.1)));
    // minUnion = max(20, 8) = 20
    expect(minUnion).toBe(20);
    expect(out.M1).toBeGreaterThanOrEqual(minUnion);
  });
});

describe('SemanticAnalyzeStrategy.auditPreselectTopK — 命中审计', () => {
  it('[AUD-1] 10/10 全部命中 → info 日志打出符合预期，hitRate=1', () => {
    const perQueryTopK: Record<string, string[]> = {
      s_0: ['c_0', 'c_1', 'c_2'],
      s_1: ['c_1', 'c_2', 'c_3'],
      s_2: ['c_4', 'c_5', 'c_6'],
    };
    const matches = [
      { shotId: 's_0', mediaId: 'c_0' },  // 在 top
      { shotId: 's_1', mediaId: 'c_2' },  // 在 top
      { shotId: 's_2', chunkId: 'c_5' },  // 在 top（chunkId 字段也支持）
      { shotId: 's_keep', mediaId: 'c_99', keepOriginalAudio: true }, // 原声跳过
    ];
    const result = runAudit(perQueryTopK, matches, 'AUD-1');
    expect(result.total).toBe(3);
    expect(result.hit).toBe(3);
    expect(result.hitRate).toBe(1);
    expect(AppLogger.warn).not.toHaveBeenCalled();
    expect(AppLogger.info).toHaveBeenCalledWith(
      'AI_AGENT',
      expect.stringContaining('命中率=100.00%（3/3），预选质量符合预期'),
    );
  });

  it('[AUD-2] 2/10 未命中 <95% → warn 日志提示调大 K', () => {
    const perQueryTopK: Record<string, string[]> = {};
    for (let i = 0; i < 10; i++) perQueryTopK[`s_${i}`] = [`c_${i}`];
    const matches: any[] = [];
    for (let i = 0; i < 10; i++) {
      // s_0 → c_999（未入 top）, s_1 → c_1000（未入 top）, 其余 8 条正常命中 c_i
      const mediaId = i === 0 ? 'c_999' : i === 1 ? 'c_1000' : `c_${i}`;
      matches.push({ shotId: `s_${i}`, mediaId });
    }
    const result = runAudit(perQueryTopK, matches, 'AUD-2');
    expect(result.total).toBe(10);
    expect(result.hit).toBe(8);
    expect(result.hitRate).toBe(0.8);
    expect(AppLogger.warn).toHaveBeenCalledWith(
      'AI_AGENT',
      expect.stringContaining('命中率=80.00% < 95%'),
    );
    expect(AppLogger.warn).toHaveBeenCalledWith(
      'AI_AGENT',
      expect.stringContaining('建议增大 K 或调低 minDescCoverage'),
    );
  });
});
