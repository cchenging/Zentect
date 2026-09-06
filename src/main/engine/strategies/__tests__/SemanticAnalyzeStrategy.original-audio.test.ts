/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import { SemanticAnalyzeStrategy } from '../SemanticAnalyzeStrategy';
import { buildMatchStepDiagnostics } from '../SemanticAnalyzeStrategy';

// ============================================================
// Mock：AppLogger & LOG_TAGS（避免 import 真实模块，保持单测快）
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

// ============================================================
// 🎙️ 原声段（type='original_audio'）在 buildMatchQueries 中的存活与透传回归
//
// 背景（2026-09 修复）：原声段主字段 text 恒为空、台词存于 audioSource.transcript，
// 旧实现末尾的空文案 filter 把原声段整段丢弃 → matchResults 完全缺失原声段
// （步骤5 无"原声"卡片、导出时间线丢段、导出原声音量无从谈起）。
// ============================================================
// ============================================================
// 🩺 buildMatchStepDiagnostics：匹配诊断纯函数（2026-09-04 新增）
// 覆盖四类根因：无解说文案 / 切片池空 / KM 全未命中 / 原声定位失败，以及正常无警告。
// ============================================================
describe('buildMatchStepDiagnostics：匹配根因透出', () => {

  it('🩺 无解说文案（totalQueries=0）→ 只给 emptyQueryWarning', () => {
    const d = buildMatchStepDiagnostics({
      matches: [], chunks: [{ id: 'c0' }], matchSegments: [{ id: 's0' }],
      originalQueryCount: 0, originalMatchedCount: 0,
      emptyQueryWarning: '未找到解说文案段落：请先运行步骤3 生成解说词后再匹配',
    });
    expect(d.warnings).toEqual(['未找到解说文案段落：请先运行步骤3 生成解说词后再匹配']);
  });

  it('🩺 切片池空（chunks=0）→ 提示未检测到视频切片', () => {
    const d = buildMatchStepDiagnostics({
      matches: [{ id: 'a', mediaId: '' }], chunks: [], matchSegments: [],
      originalQueryCount: 0, originalMatchedCount: 0,
    });
    expect(d.warnings.join('')).toContain('未检测到视频切片');
  });

  it('🩺 KM 全未命中（有切片有候选但 matchedCount=0）→ 提示未命中任何画面', () => {
    const d = buildMatchStepDiagnostics({
      matches: [{ id: 'a', mediaId: '' }, { id: 'b', mediaId: '' }],
      chunks: [{ id: 'c0' }], matchSegments: [{ id: 's0' }],
      originalQueryCount: 0, originalMatchedCount: 0,
    });
    expect(d.matchedCount).toBe(0);
    expect(d.warnings.join('')).toContain('未命中任何画面');
  });

  it('🩺 原声定位失败 → 提示 N/M 段回退画面匹配', () => {
    const d = buildMatchStepDiagnostics({
      matches: [{ id: 'a', mediaId: 'chunk_1' }], chunks: [{ id: 'c0' }], matchSegments: [{ id: 's0' }],
      originalQueryCount: 5, originalMatchedCount: 2,
    });
    expect(d.warnings.join('')).toContain('原声段定位失败 3/5 段');
  });

  it('🩺 全部命中且无原声失败 → warnings 为空（不打扰正常卡片区）', () => {
    const d = buildMatchStepDiagnostics({
      matches: [{ id: 'a', mediaId: 'chunk_1' }, { id: 'b', mediaId: 'chunk_2' }],
      chunks: [{ id: 'c0' }], matchSegments: [{ id: 's0' }],
      originalQueryCount: 0, originalMatchedCount: 0,
    });
    expect(d.warnings).toEqual([]);
    expect(d.matchedCount).toBe(2);
  });
});

describe('SemanticAnalyzeStrategy.buildMatchQueries：原声段存活与时间窗透传', () => {

  it('🎯 原声段（text 为空 + transcript 有台词）不被过滤，text 回填 transcript 并剥"原声："前缀', () => {
    const scriptShots = [
      {
        id: 'seg_7',
        type: 'original_audio',
        text: '',
        startMs: 679000,
        durationMs: 11000,
        audioSource: {
          sourceStartMs: 679000,
          sourceEndMs: 681000,
          speaker: '未知角色',
          transcript: '原声：我爷不行了啥 我爷爷不行了',
          duckingBgm: true,
        },
      },
    ];
    const qs = SemanticAnalyzeStrategy.buildMatchQueries(scriptShots, []);
    expect(qs).toHaveLength(1);                        // 不再被空文案 filter 丢弃
    expect(qs[0].keepOriginalAudio).toBe(true);
    expect(qs[0].text.split('|')[0].trim()).toBe('我爷不行了啥 我爷爷不行了'); // transcript 回填 + 前缀剥离（visualIntent 后缀用 | 分隔，取前半）
    expect(qs[0].audioSourceStartMs).toBe(679000);      // 无裁剪 → 源坐标原值透传
    expect(qs[0].audioSourceEndMs).toBe(681000);
  });

  it('🎯 legacy 口径（老数据 keepOriginalAudio=true 无 type）同样回填 transcript', () => {
    const scriptShots = [
      {
        id: 'seg_1',
        keepOriginalAudio: true,
        text: '',
        startMs: 5000,
        durationMs: 3000,
        audioSource: { sourceStartMs: 5000, sourceEndMs: 6000, transcript: '台词原文' },
      },
    ];
    const qs = SemanticAnalyzeStrategy.buildMatchQueries(scriptShots, []);
    expect(qs).toHaveLength(1);
    expect(qs[0].keepOriginalAudio).toBe(true);
    expect(qs[0].text.split('|')[0].trim()).toBe('台词原文');
  });

  it('🎯 模式 A（2026-09-05）：第三参 trimStartMs 已弃用——audioSource/startMs 恒为源坐标，不再转 body、不再钳 0', () => {
    const scriptShots = [
      {
        id: 'a', type: 'original_audio', text: '',
        startMs: 10000, durationMs: 2000,
        audioSource: { sourceStartMs: 10000, sourceEndMs: 12000, transcript: '裁剪窗口内' },
      },
      {
        id: 'b', type: 'original_audio', text: '',
        startMs: 3000, durationMs: 2000,
        audioSource: { sourceStartMs: 3000, sourceEndMs: 5000, transcript: '跨裁剪线窗口' },
      },
    ];
    // 即使调用方传 8000，源坐标也原样透传（候选切片同为源坐标，两端同参照无需换算）
    const qs = SemanticAnalyzeStrategy.buildMatchQueries(scriptShots, [], 8000);
    expect(qs[0].audioSourceStartMs).toBe(10000);      // 保持源坐标（不再 -8000）
    expect(qs[0].audioSourceEndMs).toBe(12000);
    expect(qs[1].audioSourceStartMs).toBe(3000);       // 源坐标原值，不做负值钳 0
    expect(qs[1].audioSourceEndMs).toBe(5000);
  });

  it('🎯 回归保护：非原声的纯空 text 段仍被 filter 丢弃（原修复语义不回退）', () => {
    const scriptShots = [
      { id: 's1', text: '', start: 0, end: 1 },
      { id: 's2', text: '有效解说', start: 1, end: 3 },
      { id: 's3', type: 'original_audio', text: '', startMs: 3000, durationMs: 2000,
        audioSource: { sourceStartMs: 3000, sourceEndMs: 4000, transcript: '原声：有台词' } },
      { id: 's4', type: 'original_audio', text: '', startMs: 5000, durationMs: 2000 }, // 原声但 transcript 也缺
    ];
    const qs = SemanticAnalyzeStrategy.buildMatchQueries(scriptShots, []);
    // s1 被滤；s2/s3 存活；s4 原声但无台词可回填 → 仍被滤（无文本可用，定位与 KM 均无从谈起）
    expect(qs.map(q => q.shotId)).toEqual(['s2', 's3']);
  });

  it('🎯 解说段主 text 优先：原声段若 text 非空则不覆盖（回填仅兜底）', () => {
    const scriptShots = [
      {
        id: 'seg_x', type: 'original_audio',
        text: '显式台词优先',
        startMs: 1000, durationMs: 2000,
        audioSource: { sourceStartMs: 1000, sourceEndMs: 3000, transcript: 'transcript 不覆盖' },
      },
    ];
    const qs = SemanticAnalyzeStrategy.buildMatchQueries(scriptShots, []);
    expect(qs[0].text.split('|')[0].trim()).toBe('显式台词优先');
  });
});

// ============================================================
// 🎙️ 第二轮回归：跨切片边界原声窗口的定位兜底与标记保真
//
// 背景（2026-09 第二轮修复）：场景切片与台词不对齐时，原声精确窗口跨 chunk 边界，
// findCoveringChunk 的"单切片全覆盖"约束定位失败 → 段落混入 KM 语义匹配，
// 组装/流式/回退多处 buildMatchResult 第三参硬编码 false → keepOriginalAudio 被抹掉
// （用户实测 4 个原声段只有 1 个出"原声"卡的根因）。
// 修复 = 三级定位（全覆盖 → ±500ms 收缩 → findMaxOverlapChunk 最大重叠兜底）
//       + 全部调用点第三参透传 q.keepOriginalAudio === true。
// ============================================================
describe('原声定位兜底与标记保真（跨切片边界回归）', () => {

  /** 切片池：两个切片，边界在 10000ms（模拟场景切分与台词窗口不对齐） */
  const chunks = [
    { id: 'c_1', startMs: 0, endMs: 10000, coverPath: 'c1.jpg' },
    { id: 'c_2', startMs: 10000, endMs: 20000, coverPath: 'c2.jpg' },
  ];

  it('🎯 findMaxOverlapChunk：窗口 [9500,11500] 跨边界 → 取重叠最大的 c_2', () => {
    const fn = (SemanticAnalyzeStrategy as any).findMaxOverlapChunk.bind(SemanticAnalyzeStrategy);
    expect(fn(chunks, 9500, 11500)?.id).toBe('c_2');    // c_1 重叠 500ms < c_2 重叠 1500ms
  });

  it('🎯 findMaxOverlapChunk：窗口完全落在单切片内 → 该切片（与全覆盖路径等价）', () => {
    const fn = (SemanticAnalyzeStrategy as any).findMaxOverlapChunk.bind(SemanticAnalyzeStrategy);
    expect(fn(chunks, 5000, 6000)?.id).toBe('c_1');
  });

  it('🎯 findMaxOverlapChunk：零重叠 / 无效窗口 / 空切片池 → null（回落 KM 兜底语义）', () => {
    const fn = (SemanticAnalyzeStrategy as any).findMaxOverlapChunk.bind(SemanticAnalyzeStrategy);
    expect(fn(chunks, 25000, 26000)).toBeNull();
    expect(fn(chunks, 6000, 5000)).toBeNull();          // tgtEnd <= tgtStart
    expect(fn([], 0, 1000)).toBeNull();
  });

  it('🎯 buildMatchResult 第三参透传：原声段命中 KM 切片时标记保真（score 0.95 / confirmed true）', () => {
    const q = { shotId: 'seg_7', text: '我爷不行了', audioDurationMs: 2000, keepOriginalAudio: true };
    const kmChunk = {
      chunkId: 'c_2', confidence: 0.42, coverPath: 'c2.jpg',
      chunkData: { id: 'c_2', startMs: 10000, endMs: 20000 },
      videoTimelineStartMs: 10000, videoTimelineEndMs: 20000,
    };
    const m = SemanticAnalyzeStrategy.buildMatchResult(q, kmChunk, q.keepOriginalAudio === true);
    expect(m.keepOriginalAudio).toBe(true);             // 修复前：此处被硬编码 false 抹掉
    expect(m.score).toBe(0.95);
    expect(m.confirmed).toBe(true);
    expect(m.mediaId).toBe('c_2');
  });

  it('🎯 buildMatchResult：原声段未匹配（matched=null）时标记同样保真', () => {
    const q = { shotId: 'seg_22', text: '台词', audioDurationMs: 1500, keepOriginalAudio: true };
    const m = SemanticAnalyzeStrategy.buildMatchResult(q, null, q.keepOriginalAudio === true);
    expect(m.keepOriginalAudio).toBe(true);
    expect(m.mediaId).toBe('');
    expect(m.confirmed).toBe(false);
  });

  it('🎯 对照组：普通解说段透传后仍为 false（修复不影响非原声段语义）', () => {
    const q = { shotId: 'seg_1', text: '解说', audioDurationMs: 3000, keepOriginalAudio: false };
    // 🔧 B3：命中结果必须带合法切片窗口（无窗口 → fail-fast）；此处补合法 chunkData 供切片窗口回退
    const kmChunk = { chunkId: 'c_1', confidence: 0.9, chunkData: { id: 'c_1', startMs: 1000, endMs: 4000 } };
    const m = SemanticAnalyzeStrategy.buildMatchResult(q, kmChunk, q.keepOriginalAudio === true);
    expect(m.keepOriginalAudio).toBe(false);
    expect(m.score).toBe(0.9);
    expect(m.confirmed).toBe(true);                     // 0.9 >= 0.88 阈值
  });
});

// ============================================================
// 🛡️ 第三轮回归：daemon 坏 timeline（两端相等/逆序）出生处防御
//
// 背景（2026-09-03 修复）：daemon KM 对个别段落返回 videoTimelineStartMs==videoTimelineEndMs
// （如 seg_7 的 32544.9/32544.9），旧 `|| 0` 透传只挡 nullish、挡不住非零无效值 →
// 坏数据落库 → 剪映装配 start<end 校验 fail-fast 炸整次导出。
// 修复 = resolveTimelineWindow 三级取值（有效 timeline → 切片窗口 → 0/0）。
// ============================================================
describe('buildMatchResult：坏 timeline 出生处防御（三级取值回归）', () => {
  const q = { shotId: 'seg_7', text: '我爷不行了啥 我爷爷不行了', audioDurationMs: 2000, keepOriginalAudio: true };

  it('🎯 核心回归（seg_7 实录）：timeline 两端相等 + 切片窗口合法 → 回退切片边界落库', () => {
    const kmChunk = {
      chunkId: 'chunk_095_seg29', confidence: 0.6865,
      chunkData: { id: 'chunk_095_seg29', startMs: 679640, endMs: 682640 },
      videoTimelineStartMs: 32544.9, videoTimelineEndMs: 32544.9,   // daemon 脏数据：两端相等
    };
    const m = SemanticAnalyzeStrategy.buildMatchResult(q, kmChunk, true);
    expect(m.videoTimelineStartMs).toBe(679640);        // 修复前：32544.9 原样落库
    expect(m.videoTimelineEndMs).toBe(682640);
  });

  it('🎯 timeline 有效 → 原样保留（正常路径零影响，切片窗口不抢优先级）', () => {
    const kmChunk = {
      chunkId: 'c_1', confidence: 0.9,
      chunkData: { id: 'c_1', startMs: 0, endMs: 999999 },
      videoTimelineStartMs: 679000, videoTimelineEndMs: 681000,
    };
    const m = SemanticAnalyzeStrategy.buildMatchResult(q, kmChunk, true);
    expect(m.videoTimelineStartMs).toBe(679000);
    expect(m.videoTimelineEndMs).toBe(681000);
  });

  it('🎯 timeline 与切片窗口均无效 → fail-fast 抛错（2026-09-05 B3：不再伪装 0/0 静默落库）', () => {
    const kmChunk = {
      chunkId: 'c_1', confidence: 0.9,
      chunkData: { id: 'c_1', startMs: 5000, endMs: 4000 },   // 切片窗口自身逆序
      videoTimelineStartMs: 900, videoTimelineEndMs: 100,     // 逆序
    };
    expect(() => SemanticAnalyzeStrategy.buildMatchResult(q, kmChunk, false))
      .toThrow(/均无效/);
  });

  it('🎯 resolveTimelineWindow 直测：三分支各归其位（无效 → null）', () => {
    const fn = (SemanticAnalyzeStrategy as any).resolveTimelineWindow.bind(SemanticAnalyzeStrategy);
    expect(fn(100, 300, 0, 999)).toEqual({ startMs: 100, endMs: 300 });      // timeline 优先
    expect(fn(null, undefined, 50, 250)).toEqual({ startMs: 50, endMs: 250 }); // 回退切片
    expect(fn(400, 400, 700, 700)).toBeNull();                                // 均两端相等 → null（fail-fast）
  });
});
