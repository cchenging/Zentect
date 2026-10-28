// 📁 路径: src/main/engine/strategies/__tests__/SemanticAnalyzeStrategy.shotWindowTable.test.ts
// 🎬 P4（2026-09-30）镜头内连续切窗取料链单元测试
//
// 取代已退役的 SemanticAnalyzeStrategy.unitFragmentWindow.test.ts —— 后者的断言全部指向
// buildUnitWindowTable / buildUnitFragmentWindows / buildSiblingPool，但这些函数已被 commit 1868254
// （「步骤5 帧召回→镜头决策→取料链落地 P2~P5」）用 buildShotWindowTable 取代删除，属过期死测试；
// 本文件同时把该旧文件里仍有效的 8 条 retimeFragmentWindow 用例迁回，保住取料层覆盖。
//
// 覆盖：
//   A. buildShotWindowTable：同镜多碎片按文案顺序连续前移开窗（游标单调不减、首尾相接、不回头重放）
//   A2. 🔴 交付不变量（2026-10-15）：同镜余量不足以承载整窗 ⇒ **不截短**，改走整镜头兜底，源窗恒 ≥ 配音
//   B. buildShotWindowTable：同镜余量用尽（剩余 ≤200ms）⇒ 顺延次优候选镜头（跨镜带 srcParent 供硬切）
//   C. buildShotWindowTable：候选截断为 1+MAX_EXTRA_SHOTS=4；截断外候选一律不取 ⇒ 整镜头兜底
//   D. buildShotWindowTable：原声段跳过、未匹配计 uncovered、diag 口径
//   E. buildShotWindowTable：命中帧真锚点决定入点、越界回退镜头起点、配音缺失退化默认窗长
//   F. retimeFragmentWindow：只改窗三件套 / 身份三件套同源 / 变速重算（**只许快不许慢**，下限 1.0）/ 不可变

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../core/AppLogger', () => ({
  AppLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@modules/infra/logger/LogConstants', () => ({
  LOG_TAGS: { AI_AGENT: 'AI_AGENT', SCHEDULER: 'SCHEDULER' },
}));

import { SemanticAnalyzeStrategy } from '../SemanticAnalyzeStrategy';
import { AppLogger } from '../../../core/AppLogger';

/** 私有静态方法测试入口（TS private 仅编译期可见，运行期按既有测试惯例直取） */
const S = SemanticAnalyzeStrategy as any;

type Win = {
  startMs: number;
  endMs: number;
  srcFile?: string;
  srcParent?: string;
  srcChunkId?: string;
  srcCover?: string;
  srcDesc?: string;
};

/** 取窗序列（按碎片顺序，缺窗报错暴露，不静默兜底） */
function pick(map: Map<string, Win>, shotIds: string[]): Win[] {
  return shotIds.map((id) => {
    const w = map.get(id);
    if (!w) throw new Error(`碎片 ${id} 未分配到窗`);
    return w;
  });
}

/** 断言窗序列首尾相接（end_i === start_{i+1}） */
function expectContiguous(wins: Win[]): void {
  for (let i = 1; i < wins.length; i++) {
    expect(wins[i].startMs).toBe(wins[i - 1].endMs);
  }
}

/** 取最近一次「P4 镜头内连续切窗」诊断行（同文件其他用例也会打该行 ⇒ 必须取最近一次，避免串味） */
function lastShotWindowDiag(): string {
  const hit = (AppLogger.info as any).mock.calls
    .map((c: any[]) => String(c[1]))
    .reverse()
    .find((t: string) => t.includes('P4 镜头内连续切窗'));
  if (!hit) throw new Error('未打出「P4 镜头内连续切窗」诊断行');
  return hit;
}

/** 构造物理镜头对象（含 startMs/endMs/filePath/parentChunkId） */
const mkChunk = (id: string, parent: string, s: number, e: number) => ({
  id, parentChunkId: parent, filePath: 'a.mp4', startMs: s, endMs: e,
});

describe('buildShotWindowTable（P4 镜头内连续切窗取料）', () => {
  it('A. 同镜多碎片 ⇒ 按文案顺序连续前移开窗（游标单调不减、首尾相接、不回头重放）', () => {
    const shot = mkChunk('scene_001_seg0', 'scene_001', 0, 5000);
    const queries = [
      { shotId: 'u1_sub_1', matchUnitId: 'u1', audioDurationMs: 1000 },
      { shotId: 'u1_sub_2', matchUnitId: 'u1', audioDurationMs: 800 },
      { shotId: 'u1_sub_3', matchUnitId: 'u1', audioDurationMs: 600 },
    ];
    const matchById = new Map<string, any>([['u1', { chunkData: shot }]]);
    const chunkById = new Map<string, any>([['scene_001_seg0', shot]]);
    const table = S.buildShotWindowTable(
      queries, matchById, chunkById, null, { u1: { chunkId: 'scene_001_seg0', timeMs: 0 } },
    );
    const wins = pick(table, ['u1_sub_1', 'u1_sub_2', 'u1_sub_3']);
    expectContiguous(wins);
    expect(wins.map((w) => w.startMs)).toEqual([0, 1000, 1800]);
    expect(wins.map((w) => w.endMs)).toEqual([1000, 1800, 2400]);
    // 同镜（落点=命中切片）⇒ 不带 srcParent（导出层可继续合并），身份/素材恒为命中镜头
    expect(wins.every((w) => w.srcParent === undefined)).toBe(true);
    expect(wins.every((w) => w.srcChunkId === 'scene_001_seg0')).toBe(true);
    expect(wins.every((w) => w.srcFile === 'a.mp4')).toBe(true);

    const diag = lastShotWindowDiag();
    expect(diag).toContain('出窗碎片 3/3');
    expect(diag).toContain('顺延起窗 0');
    expect(diag).toContain('窗长不足配音 0');
    expect(diag).toContain('顺延次优镜头 0');
    expect(diag).toContain('整镜头兜底 0');
  });

  it('A2. 同镜余量不足整窗 ⇒ 不截短：弃该镜余料，改走整镜头兜底（源窗恒 ≥ 配音时长）', () => {
    /** 🔴 旧口径此处产出的是 300ms 短窗（配音 1200ms）+ 由 retimeFragmentWindow 写出的 0.25 慢放系数
     *  —— 成片慢放/定格的真正来源（实测 11 段），故本用例为该不变量的守门用例。 */
    const shot = mkChunk('scene_001_seg0', 'scene_001', 0, 1500);
    const queries = [
      { shotId: 'u1_sub_1', matchUnitId: 'u1', audioDurationMs: 1200 },
      { shotId: 'u1_sub_2', matchUnitId: 'u1', audioDurationMs: 1200 },
    ];
    const matchById = new Map<string, any>([['u1', { chunkData: shot }]]);
    const chunkById = new Map<string, any>([['scene_001_seg0', shot]]);
    const table = S.buildShotWindowTable(
      queries, matchById, chunkById, null, { u1: { chunkId: 'scene_001_seg0', timeMs: 0 } },
    );
    const w0 = table.get('u1_sub_1')!;
    expect(w0).toMatchObject({ startMs: 0, endMs: 1200 });   // 余量足够 ⇒ 正常整窗
    const w1 = table.get('u1_sub_2')!;
    // 余量仅 300ms < 配音 1200ms ⇒ 不截短；本用例无候选可顺延 ⇒ 退回命中镜头整镜头兜底
    expect(w1).toMatchObject({ startMs: 0, endMs: 1500 });
    expect(w1.endMs - w1.startMs).toBeGreaterThanOrEqual(1200);   // 交付不变量：窗长 ≥ 配音
    const diag = lastShotWindowDiag();
    expect(diag).toContain('整镜头兜底 1');
    expect(diag).toContain('窗长不足配音 0');                 // 自检：绝不产出源窗 < 配音
    expect(diag).toContain('顺延次优镜头 0');                 // 兜底落回命中镜头，不算顺延
  });

  it('B. 同镜余量用尽（剩余 ≤200ms）⇒ 顺延次优候选镜头，跨镜带 srcParent', () => {
    const hitShot = mkChunk('scene_h_seg0', 'scene_h', 0, 500);
    const altShot = mkChunk('scene_x_seg0', 'scene_x', 20000, 30000);
    const queries = [
      { shotId: 'u1_a', matchUnitId: 'u1', audioDurationMs: 300 },
      { shotId: 'u1_b', matchUnitId: 'u1', audioDurationMs: 300 },
    ];
    const matchById = new Map<string, any>([['u1', { chunkData: hitShot }]]);
    const chunkById = new Map<string, any>([['scene_h_seg0', hitShot], ['scene_x_seg0', altShot]]);
    const table = S.buildShotWindowTable(
      queries, matchById, chunkById, { u1: ['scene_x_seg0'] },
      { u1: { chunkId: 'scene_h_seg0', timeMs: 0 } },
    );
    const wins = pick(table, ['u1_a', 'u1_b']);
    expect(wins[0]).toMatchObject({ startMs: 0, endMs: 300, srcChunkId: 'scene_h_seg0' });
    expect(wins[0].srcParent).toBeUndefined();
    expect(wins[1]).toMatchObject({ startMs: 20000, endMs: 20300, srcChunkId: 'scene_x_seg0' });
    expect(wins[1].srcParent).toBe('scene_x');               // 跨镜 ⇒ 供导出层按硬切处理
    expect(wins[1].srcFile).toBe('a.mp4');

    const diag = lastShotWindowDiag();
    expect(diag).toContain('出窗碎片 2/2');
    expect(diag).toContain('顺延次优镜头 1');
    expect(diag).toContain('整镜头兜底 0');
    expect(diag).toContain('窗长不足配音 0');               // 顺延镜头余量充足 ⇒ 源窗恒 ≥ 配音
  });

  it('C. 候选截断为 1+MAX_EXTRA_SHOTS=4；截断外候选一律不取 ⇒ 整镜头兜底', () => {
    const h = mkChunk('h', 'scene_h', 0, 200);               // 余量 200ms ⇒ 不可开窗
    const cz = mkChunk('cz', 'scene_z', 0, 60000);           // 第 5 个候选（被 slice 截断），本应可用
    const queries = [{ shotId: 'u1_a', matchUnitId: 'u1', audioDurationMs: 2000 }];
    const matchById = new Map<string, any>([['u1', { chunkData: h }]]);
    const chunkById = new Map<string, any>([['h', h], ['cz', cz]]);
    const table = S.buildShotWindowTable(
      queries, matchById, chunkById,
      { u1: ['cx', 'cy', 'cw', 'cz'] },                       // cx/cy/cw 不存在；cz 被截断
      { u1: { chunkId: 'h', timeMs: 0 } },
    );
    const w = table.get('u1_a')!;
    expect(w.startMs).toBe(0);
    expect(w.endMs).toBe(200);                               // 整镜头兜底，未取到 cz(→60000)
    expect(w.srcChunkId).toBe('h');
    expect(w.srcParent).toBeUndefined();
    const diag = lastShotWindowDiag();
    expect(diag).toContain('整镜头兜底 1');
    expect(diag).toContain('窗长不足配音 1');   // 兜底镜头本身仅 200ms < 配音 2000ms ⇒ 无可取料，如实计数
  });

  it('D. 原声段跳过（不进表、不污染游标）；未匹配计 uncovered；diag 口径', () => {
    const shot = mkChunk('scene_001_seg0', 'scene_001', 0, 5000);
    const queries = [
      { shotId: 'orig', matchUnitId: 'u_orig', keepOriginalAudio: true, audioDurationMs: 1000 },
      { shotId: 'miss', matchUnitId: 'u_miss', audioDurationMs: 1000 },
      { shotId: 'ok', matchUnitId: 'u_ok', audioDurationMs: 1000 },
    ];
    const matchById = new Map<string, any>([['u_ok', { chunkData: shot }]]);
    const chunkById = new Map<string, any>([['scene_001_seg0', shot]]);
    const table = S.buildShotWindowTable(queries, matchById, chunkById, null, null);
    expect(table.has('orig')).toBe(false);                   // 原声段完全跳过
    expect(table.has('miss')).toBe(false);                   // 未匹配
    expect(table.get('ok')!.startMs).toBe(0);
    expect(table.size).toBe(1);
    const diag = lastShotWindowDiag();
    expect(diag).toContain('出窗碎片 1/3');
    expect(diag).toContain('无窗/未匹配 1');
  });

  it('E1. 命中帧真锚点决定入点；命中帧越界则回退镜头起点', () => {
    const shot = mkChunk('scene_002_seg0', 'scene_002', 10000, 20000);
    const matchById = new Map<string, any>([['u2', { chunkData: shot }]]);
    const chunkById = new Map<string, any>([['scene_002_seg0', shot]]);
    const inRange = S.buildShotWindowTable(
      [{ shotId: 'u2_a', matchUnitId: 'u2', audioDurationMs: 2000 }],
      matchById, chunkById, null, { u2: { chunkId: 'scene_002_seg0', timeMs: 15000 } },
    );
    expect(inRange.get('u2_a')).toMatchObject({ startMs: 15000, endMs: 17000 });

    const outOfRange = S.buildShotWindowTable(
      [{ shotId: 'u2_a', matchUnitId: 'u2', audioDurationMs: 2000 }],
      matchById, chunkById, null, { u2: { chunkId: 'scene_002_seg0', timeMs: 999 } },
    );
    expect(outOfRange.get('u2_a')).toMatchObject({ startMs: 10000, endMs: 12000 });
  });

  it('E2. 配音时长缺失/非正 ⇒ 窗长退化默认 3s（仍受镜头余量夹取）', () => {
    const narrow = mkChunk('scene_003_seg0', 'scene_003', 0, 2000);
    const t1 = S.buildShotWindowTable(
      [{ shotId: 'u3_a', matchUnitId: 'u3' }],
      new Map<string, any>([['u3', { chunkData: narrow }]]),
      new Map<string, any>([['scene_003_seg0', narrow]]), null, null,
    );
    expect(t1.get('u3_a')).toMatchObject({ startMs: 0, endMs: 2000 }); // min(余量 2000, 默认 3000)

    const wide = mkChunk('scene_004_seg0', 'scene_004', 0, 9000);
    const t2 = S.buildShotWindowTable(
      [{ shotId: 'u4_a', matchUnitId: 'u4', audioDurationMs: 0 }],
      new Map<string, any>([['u4', { chunkData: wide }]]),
      new Map<string, any>([['scene_004_seg0', wide]]), null, null,
    );
    expect(t2.get('u4_a')).toMatchObject({ startMs: 0, endMs: 3000 });  // 默认窗长 3000
  });

  it('F1. 同镜被非相邻碎片复用 ⇒ 回放拦下，顺延次优候选镜头（不同 srcParent）', () => {
    const a = mkChunk('scene_a_seg0', 'scene_a', 0, 5000);
    const b = mkChunk('scene_b_seg0', 'scene_b', 10000, 20000);
    const c = mkChunk('scene_c_seg0', 'scene_c', 30000, 40000);
    const queries = [
      { shotId: 'u1_a', matchUnitId: 'u1', audioDurationMs: 1000 },
      /** 中间这句落在别处 ⇒ 下标差 2，u3 再用 a 即「非相邻复用」 */
      { shotId: 'u2_a', matchUnitId: 'u2', audioDurationMs: 1000 },
      { shotId: 'u3_a', matchUnitId: 'u3', audioDurationMs: 1000 },
    ];
    const matchById = new Map<string, any>([
      ['u1', { chunkData: a }],
      ['u2', { chunkData: b }],
      ['u3', { chunkId: 'scene_a_seg0', chunkData: a }],
    ]);
    const chunkById = new Map<string, any>([
      ['scene_a_seg0', a], ['scene_b_seg0', b], ['scene_c_seg0', c],
    ]);
    const table = S.buildShotWindowTable(queries, matchById, chunkById, { u3: ['scene_c_seg0'] }, null);
    expect(table.get('u1_a')).toMatchObject({ startMs: 0, endMs: 1000 });
    expect(table.get('u2_a')).toMatchObject({ startMs: 10000, endMs: 11000 });
    // a 已在 frag 0 交付过 ⇒ frag 2 复用被拦；候选链顺延到 c
    expect(table.get('u3_a')).toMatchObject({
      startMs: 30000, endMs: 31000, srcChunkId: 'scene_c_seg0', srcParent: 'scene_c',
    });
    const diag = lastShotWindowDiag();
    expect(diag).toContain('回放拦下 1');
    expect(diag).toContain('顺延次优镜头 1');
  });

  it('F2. 相邻碎片复用同镜 ⇒ 合法连续长镜头，不拦（跨句）/ 同句三片照旧首尾相接', () => {
    const a = mkChunk('scene_a_seg0', 'scene_a', 0, 9000);
    const queries = [
      { shotId: 'u1_a', matchUnitId: 'u1', audioDurationMs: 1000 },
      { shotId: 'u2_a', matchUnitId: 'u2', audioDurationMs: 1000 },   // 下标差 1 ⇒ 相邻
      { shotId: 'u3_a', matchUnitId: 'u3', audioDurationMs: 1000 },   // 对 u2 仍差 1
    ];
    const matchById = new Map<string, any>([
      ['u1', { chunkData: a }], ['u2', { chunkData: a }], ['u3', { chunkData: a }],
    ]);
    const chunkById = new Map<string, any>([['scene_a_seg0', a]]);
    const table = S.buildShotWindowTable(queries, matchById, chunkById, null, null);
    const wins = pick(table, ['u1_a', 'u2_a', 'u3_a']);
    expect(wins.map((w) => w.startMs)).toEqual([0, 1000, 2000]);
    expect(wins.map((w) => w.endMs)).toEqual([1000, 2000, 3000]);
    expectContiguous(wins);
    const diag = lastShotWindowDiag();
    expect(diag).toContain('回放拦下 0');
    expect(diag).toContain('出窗碎片 3/3');
  });

  it('F3. 相邻 chunk 源窗真重叠 ⇒ 拦下（真重叠判据不看 chunk id）', () => {
    const a = mkChunk('chunk_a', 'scene_a', 0, 5000);
    /** b 与 a 源区间真重叠 1000ms（相邻 chunk 的实际情形），但 chunk id 不同 */
    const b = mkChunk('chunk_b', 'scene_b', 4000, 9000);
    const c = mkChunk('chunk_c', 'scene_c', 20000, 30000);
    const queries = [
      { shotId: 'u1_a', matchUnitId: 'u1', audioDurationMs: 1000 },
      { shotId: 'u2_a', matchUnitId: 'u2', audioDurationMs: 1000 },
    ];
    const matchById = new Map<string, any>([
      ['u1', { chunkData: a }],
      ['u2', { chunkData: b }],
    ]);
    const chunkById = new Map<string, any>([['chunk_a', a], ['chunk_b', b], ['chunk_c', c]]);
    const table = S.buildShotWindowTable(queries, matchById, chunkById, { u2: ['chunk_c'] }, null);
    expect(table.get('u1_a')).toMatchObject({ startMs: 0, endMs: 1000 });
    // b 从 4000 起开窗 [4000,5000] 与 a 的 [0,1000] 其实不重叠 ⇒ 正常取用（本用例前半段校准）
    expect(table.get('u2_a')).toMatchObject({ startMs: 4000, endMs: 5000, srcChunkId: 'chunk_b' });

    /** 真重叠：同样是 a，但 b 的候选窗落在 [500,1500]（与已交付 [0,1000] 重叠 500ms） */
    const b2 = mkChunk('chunk_b2', 'scene_b', 500, 9000);
    const chunkById2 = new Map<string, any>([['chunk_a', a], ['chunk_b2', b2], ['chunk_c', c]]);
    const matchById2 = new Map<string, any>([
      ['u1', { chunkData: a }],
      ['u2', { chunkData: b2 }],
    ]);
    const table2 = S.buildShotWindowTable(queries, matchById2, chunkById2, { u2: ['chunk_c'] }, null);
    expect(table2.get('u2_a')).toMatchObject({ startMs: 20000, endMs: 21000, srcChunkId: 'chunk_c' });
    const diag = lastShotWindowDiag();
    expect(diag).toContain('回放拦下 1');
    expect(diag).toContain('顺延次优镜头 1');
  });

  it('F4. 候选全被回放拦下 ⇒ 第二轮放行（宁可回放也不留空窗，不走整镜头兜底）', () => {
    const a = mkChunk('scene_a_seg0', 'scene_a', 0, 5000);
    const b = mkChunk('scene_b_seg0', 'scene_b', 10000, 20000);
    const queries = [
      { shotId: 'u1_a', matchUnitId: 'u1', audioDurationMs: 1000 },
      { shotId: 'u2_a', matchUnitId: 'u2', audioDurationMs: 1000 },
      { shotId: 'u3_a', matchUnitId: 'u3', audioDurationMs: 1000 },
    ];
    const matchById = new Map<string, any>([
      ['u1', { chunkData: a }],
      ['u2', { chunkData: b }],
      ['u3', { chunkData: a }],           // 唯一候选 = a（无召回白名单可顺延）
    ]);
    const chunkById = new Map<string, any>([['scene_a_seg0', a], ['scene_b_seg0', b]]);
    const table = S.buildShotWindowTable(queries, matchById, chunkById, null, null);
    expect(table.get('u3_a')).toMatchObject({ startMs: 1000, endMs: 2000, srcChunkId: 'scene_a_seg0' });
    const diag = lastShotWindowDiag();
    expect(diag).toContain('回放拦下 1');       // 第一轮被拦
    expect(diag).toContain('整镜头兜底 0');     // 第二轮放行成功，非兜底
    expect(diag).toContain('出窗碎片 3/3');
  });
});

describe('retimeFragmentWindow（改窗三件套 / 身份三件套同源 / 变速重算 / 不可变）', () => {
  it('retimeFragmentWindow：无源身份透传 ⇒ 只改窗（窗长三件套同源），身份/文本/配音时长/父 id 不动', () => {
    const result = {
      id: 'seg_1_sub_1',
      shotId: 'seg_1_sub_1',
      text: '韩智恩被告知中了银行头奖，',
      audioDurationMs: 2233,
      mediaId: 'scene_001_seg0',
      score: 0,
      chunkData: { id: 'scene_001_seg0', parentChunkId: 'scene_001', filePath: 'a.mp4', startMs: 65229, endMs: 66296 },
      videoTimelineStartMs: 65229,
      videoTimelineEndMs: 66296,
    };
    const out = S.retimeFragmentWindow(result, { startMs: 65229, endMs: 65731 });
    expect(out.chunkData.startMs).toBe(65229);
    expect(out.chunkData.endMs).toBe(65731);
    /** 🩹 窗长三件套同源：durationMs 必须随新窗改写（原 fixture 无该字段 ⇒ 写入新窗长，不留旧值/缺项） */
    expect(out.chunkData.durationMs).toBe(502);        // 65731 - 65229
    expect(out.videoTimelineStartMs).toBe(65229);
    expect(out.videoTimelineEndMs).toBe(65731);
    // 其余字段一律保真（碎片级文本/时长 + 切片身份）
    expect(out.id).toBe(result.id);
    expect(out.text).toBe(result.text);
    expect(out.audioDurationMs).toBe(2233);
    expect(out.mediaId).toBe('scene_001_seg0');
    expect(out.chunkData.id).toBe('scene_001_seg0');
    expect(out.chunkData.parentChunkId).toBe('scene_001');
    expect(out.thumbnail).toBeUndefined();
    // 🎛️ 变速随新窗重算 + **只许快不许慢**：502ms 源窗 / 2233ms 配音 = 0.225 < 1 ⇒ 下限 1.0（不写慢放）
    expect(out.appliedSpeedFactor).toBe(1);
    // 不可变：原对象未被改写
    expect(result.chunkData.endMs).toBe(66296);
    expect((result.chunkData as any).durationMs).toBeUndefined();
  });

  it('retimeFragmentWindow：窗落点属于另一源切片 ⇒ id/mediaId/thumbnail/coverPath/description 同源跟随', () => {
    const result = {
      id: 'seg_0_sub_3',
      shotId: 'seg_0_sub_3',
      text: '于是她答应了。',
      audioDurationMs: 1917,
      mediaId: 'scene_494_seg0',
      thumbnail: 'thumb/seg_1351_cover.jpg',
      chunkData: {
        id: 'scene_494_seg0', parentChunkId: 'scene_494', filePath: 'a.mp4', startMs: 3416376, endMs: 3418061,
        coverPath: 'thumb/seg_1351_cover.jpg', description: '【特写】低头浅笑 场景:餐厅内景',
      },
      videoTimelineStartMs: 3416376,
      videoTimelineEndMs: 3418061,
    };
    const out = S.retimeFragmentWindow(result, {
      startMs: 76707, endMs: 78624,
      srcFile: 'b.mp4', srcParent: 'scene_004',
      srcChunkId: 'scene_004_seg0', srcCover: 'thumb/seg_777_cover.jpg',
      srcDesc: '【中景】手拉冰箱门 场景:厨房内景',
    });
    expect(out.mediaId).toBe('scene_004_seg0');
    expect(out.chunkData.id).toBe('scene_004_seg0');
    expect(out.chunkData.parentChunkId).toBe('scene_004');
    expect(out.chunkData.filePath).toBe('b.mp4');
    expect(out.thumbnail).toBe('thumb/seg_777_cover.jpg');
    /** 🩹 身份三件套同源：封面/描述必须与 id 一起跟随，否则卡片出现「图是 A 镜头、描述写 B 场景」 */
    expect(out.chunkData.coverPath).toBe('thumb/seg_777_cover.jpg');
    expect(out.chunkData.description).toBe('【中景】手拉冰箱门 场景:厨房内景');
    expect(out.chunkData.startMs).toBe(76707);
    expect(out.chunkData.endMs).toBe(78624);
    /** 🎛️ 窗长 1917ms = 配音 1917ms ⇒ 变速归 1.0（daemon 旧系数 0.946 已被重算覆盖） */
    expect(out.appliedSpeedFactor).toBe(1);
    // 碎片级保真不变
    expect(out.id).toBe('seg_0_sub_3');
    expect(out.text).toBe('于是她答应了。');
    expect(out.audioDurationMs).toBe(1917);
    expect(result.chunkData.id).toBe('scene_494_seg0');
    // 不可变：原对象封面/描述未被改写
    expect(result.chunkData.coverPath).toBe('thumb/seg_1351_cover.jpg');
    expect(result.chunkData.description).toBe('【特写】低头浅笑 场景:餐厅内景');
  });

  it('retimeFragmentWindow：跨片但缺 srcCover/srcDesc ⇒ 封面/描述保持原值（不写空、不造假）', () => {
    const result = {
      id: 'seg_b_sub_2', mediaId: 'scene_b_seg0',
      chunkData: {
        id: 'scene_b_seg0', parentChunkId: 'scene_b', startMs: 0, endMs: 900,
        coverPath: 'thumb/keep.jpg', description: '原描述',
      },
    };
    const out = S.retimeFragmentWindow(result, {
      startMs: 1000, endMs: 1400, srcChunkId: 'scene_c_seg0',
    });
    expect(out.chunkData.id).toBe('scene_c_seg0');
    expect(out.chunkData.coverPath).toBe('thumb/keep.jpg');
    expect(out.chunkData.description).toBe('原描述');
  });

  it('retimeFragmentWindow：源切片与当前 id 相同 ⇒ 不改写身份（零扰动）', () => {
    const result = {
      id: 'seg_a', mediaId: 'scene_a_seg0', thumbnail: 'thumb/seg_1_cover.jpg',
      chunkData: { id: 'scene_a_seg0', parentChunkId: 'scene_a', filePath: 'a.mp4', startMs: 0, endMs: 900 },
    };
    const out = S.retimeFragmentWindow(result, { startMs: 0, endMs: 400, srcChunkId: 'scene_a_seg0', srcCover: '' });
    expect(out.mediaId).toBe('scene_a_seg0');
    expect(out.chunkData.id).toBe('scene_a_seg0');
    expect(out.thumbnail).toBe('thumb/seg_1_cover.jpg');   // 无 srcCover ⇒ 保留原封面
  });

  it('retimeFragmentWindow：无窗 / 无 chunkData ⇒ 原样返回（零变化）', () => {
    const result = { id: 'x', chunkData: { startMs: 0, endMs: 10 } };
    expect(S.retimeFragmentWindow(result, undefined)).toBe(result);
    expect(S.retimeFragmentWindow({ id: 'y', chunkData: null }, { startMs: 0, endMs: 5 })).toEqual({ id: 'y', chunkData: null });
  });

  it('retimeFragmentWindow：变速系数随新窗重算（窗长=配音 ⇒ 1.0；源窗<配音 ⇒ 恒速 1.0，只许快不许慢）', () => {
    /** 实测形态 seg_2_sub_3：窗 1753544~1755227（1683ms）= 配音 1683ms，daemon 旧系数却记 0.946
     *  ⇒ 导出层按 0.946 变速会把画面拉长约 96ms（画面与配音错配） */
    const result = {
      id: 'seg_2_sub_3', shotId: 'seg_2_sub_3', text: '她走进了那扇门。', audioDurationMs: 1683,
      mediaId: 'scene_272_seg1', appliedSpeedFactor: 0.946,
      chunkData: { id: 'scene_272_seg1', parentChunkId: 'scene_272', filePath: 'a.mp4', startMs: 1, endMs: 2 },
    };
    const out = S.retimeFragmentWindow(result, { startMs: 1753544, endMs: 1755227 });
    expect(out.appliedSpeedFactor).toBe(1);
    expect(result.appliedSpeedFactor).toBe(0.946);   // 不可变：原对象不动

    /** 料不足（窗 3370ms / 配音 5081ms，实机 seg_0 形态）⇒ **不再记慢放**：下限 1.0、恒速播出
     *  （2026-10-15「只许快不许慢」；旧口径此处写 0.663 慢放，是成片慢放的残留出口之一） */
    const slow = S.retimeFragmentWindow(
      { audioDurationMs: 5081, appliedSpeedFactor: 1.0, chunkData: { startMs: 0, endMs: 10 } },
      { startMs: 3416376, endMs: 3419746 },
    );
    expect(slow.appliedSpeedFactor).toBe(1);

    /** 反向对照：源窗 > 配音（快放方向）⇒ 原样写比值 1.2，绝不夹到 1.0（下限只管慢放侧） */
    const fast = S.retimeFragmentWindow(
      { audioDurationMs: 1000, chunkData: { startMs: 0, endMs: 10 } },
      { startMs: 0, endMs: 1200 },
    );
    expect(fast.appliedSpeedFactor).toBe(1.2);

    /** 原声段恒 1.0（守「原声不变速」铁律） */
    const orig = S.retimeFragmentWindow(
      { audioDurationMs: 1000, keepOriginalAudio: true, appliedSpeedFactor: 0.94, chunkData: { startMs: 0, endMs: 10 } },
      { startMs: 0, endMs: 500 },
    );
    expect(orig.appliedSpeedFactor).toBe(1);

    /** 配音时长缺失/非正 ⇒ 保持原值（不造数） */
    expect(S.retimeFragmentWindow(
      { appliedSpeedFactor: 0.94, chunkData: { startMs: 0, endMs: 10 } }, { startMs: 0, endMs: 500 },
    ).appliedSpeedFactor).toBe(0.94);
    expect(S.retimeFragmentWindow(
      { audioDurationMs: 0, appliedSpeedFactor: 0.94, chunkData: { startMs: 0, endMs: 10 } }, { startMs: 0, endMs: 500 },
    ).appliedSpeedFactor).toBe(0.94);
  });

  it('retimeFragmentWindow：chunkData.durationMs 随新窗同源改写（治「窗长=配音却 durationMs<配音」假料荒）', () => {
    /** 实测形态 seg_10：窗已被重切为 2524ms（= 配音 2524ms），chunkData.durationMs 却仍是命中单片值
     *  1851.9ms ⇒ DB 读数 nat=durationMs/audio=0.734 被判料荒，与 spd=1.0 自相矛盾。 */
    const seg10 = S.retimeFragmentWindow(
      {
        id: 'seg_10', shotId: 'seg_10', audioDurationMs: 2524, appliedSpeedFactor: 1,
        chunkData: { id: 'scene_006_seg0', parentChunkId: 'scene_006', filePath: 'a.mp4', startMs: 1000, endMs: 2852, durationMs: 1851.9 },
      },
      { startMs: 1000, endMs: 3524 },
    );
    expect(seg10.chunkData.durationMs).toBe(2524);                 // 窗长三件套同源（= 配音 ⇒ spd 1.0 自洽）
    expect(seg10.chunkData.endMs - seg10.chunkData.startMs).toBe(2524);
    expect(seg10.appliedSpeedFactor).toBe(1);
    /** 小数窗长按 1 位小数落（口径与 applyCleanInoutToChunk 一致） */
    const frac = S.retimeFragmentWindow(
      { audioDurationMs: 900, chunkData: { startMs: 0, endMs: 100, durationMs: 100 } },
      { startMs: 0, endMs: 900.25 },
    );
    expect(frac.chunkData.durationMs).toBe(900.3);
    /** 窗长无效（零长/逆序）⇒ durationMs 保持原值（不造数、不写 0） */
    expect(S.retimeFragmentWindow(
      { audioDurationMs: 500, chunkData: { startMs: 0, endMs: 100, durationMs: 100 } },
      { startMs: 700, endMs: 700 },
    ).chunkData.durationMs).toBe(100);
    expect(S.retimeFragmentWindow(
      { audioDurationMs: 500, chunkData: { startMs: 0, endMs: 100, durationMs: 100 } },
      { startMs: 700, endMs: 400 },
    ).chunkData.durationMs).toBe(100);
  });

  it('retimeFragmentWindow：跨镜头取料时 filePath/parentChunkId 跟随，身份/文本/配音时长/切片 id 仍保真', () => {
    const result = {
      id: 'seg_1_sub_1',
      shotId: 'seg_1_sub_1',
      text: '谁能想到，',
      audioDurationMs: 2233,
      mediaId: 'scene_001_seg0',
      chunkData: { id: 'scene_001_seg0', parentChunkId: 'scene_001', filePath: 'a.mp4', startMs: 65229, endMs: 66296 },
      videoTimelineStartMs: 65229,
      videoTimelineEndMs: 66296,
    };
    const out = S.retimeFragmentWindow(result, {
      startMs: 100000, endMs: 102233, srcFile: 'b.mp4', srcParent: 'scene_313',
    });
    expect(out.chunkData.filePath).toBe('b.mp4');
    expect(out.chunkData.parentChunkId).toBe('scene_313');
    expect(out.chunkData.startMs).toBe(100000);
    expect(out.videoTimelineEndMs).toBe(102233);
    expect(out.chunkData.durationMs).toBe(2233);           // 窗长三件套同源：102233 - 100000
    expect(out.text).toBe(result.text);
    expect(out.audioDurationMs).toBe(2233);
    expect(out.chunkData.id).toBe('scene_001_seg0');       // 切片 id 不覆写
    expect(result.chunkData.filePath).toBe('a.mp4');        // 不可变
  });
});

describe('extendAbstractCandidates：抽象句并入空镜/宽景候选（方案 A）', () => {
  const chunks = [
    { id: 'c1', shotScale: '近景', description: '妻子面部', startMs: 1000 },
    { id: 'c2', shotScale: '中景', description: '两人对话', startMs: 1200 },
    { id: 'c3', shotScale: '全景', description: '庭院静谧', startMs: 1300 },
    { id: 'c4', shotScale: '远景', description: '城市夜景', startMs: 90000 },  // 超出 ±45s
    { id: 'c5', shotScale: '全景', description: '宴会空镜', startMs: 2000 },
    { id: 'c6', shotScale: '全景', description: '', startMs: 2100 },           // 空描述不进池
  ];
  const shotById = new Map(chunks.map((c) => [c.id, c]));

  it('抽象句：锚点 ±45s 内的宽景并入召回白名单，非抽象句不动', () => {
    const candidateIds: Record<string, string[]> = { s1: ['c1', 'c2', 'c3'], s2: ['c1'] };
    const stat = S.extendAbstractCandidates({
      kmQueries: [
        { shotId: 's1', isAbstractNarration: true },
        { shotId: 's2' },                                   // 非抽象 ⇒ 不扩
      ],
      chunks, candidateIds, shotById,
      hasChunkDesc: (cid: string) => String(shotById.get(cid)?.description || '').trim().length > 0,
      windowSec: 45, enabled: true,
    });
    expect(candidateIds.s1).toEqual(['c1', 'c2', 'c3', 'c5']);  // 去重 + 只收窗口内宽景
    expect(candidateIds.s2).toEqual(['c1']);                     // 非抽象句保持原样
    expect(stat).toEqual({ sentences: 1, added: 1, skipped: 0 });
  });

  it('抽象句锚点取同段非抽象兄弟句 Top1 中位数（自身召回飘到错场景也不跟）', () => {
    const wrong = { id: 'c9', shotScale: '全景', description: '完全无关的场景', startMs: 100000 };
    const byId = new Map([...chunks, wrong].map((c) => [c.id, c]));
    const candidateIds: Record<string, string[]> = { s1: ['c9'], s2: ['c1'] };
    const stat = S.extendAbstractCandidates({
      kmQueries: [
        { shotId: 's1', matchUnitId: 'seg_1_sub_1', isAbstractNarration: true },
        { shotId: 's2', matchUnitId: 'seg_1_sub_2' },          // 兄弟句：Top1=c1@1000
      ],
      chunks: [...chunks, wrong], candidateIds, shotById: byId,
      hasChunkDesc: (cid: string) => Boolean(String(byId.get(cid)?.description || '').trim()),
      windowSec: 45, enabled: true,
    });
    // 锚点 = 1000（兄弟句），而不是自身的 100000 ⇒ 并入 c3/c5
    expect(candidateIds.s1).toEqual(['c9', 'c3', 'c5']);
    expect(stat).toEqual({ sentences: 1, added: 2, skipped: 0 });
  });

  it('锚点缺失（无召回且无 sourceRefTimeMs）⇒ 跳过，绝不跨场景乱补', () => {
    const candidateIds: Record<string, string[]> = {};
    const stat = S.extendAbstractCandidates({
      kmQueries: [{ shotId: 's1', isAbstractNarration: true }],
      chunks, candidateIds, shotById,
      hasChunkDesc: () => true, windowSec: 45, enabled: true,
    });
    expect(candidateIds.s1).toBeUndefined();
    expect(stat).toEqual({ sentences: 0, added: 0, skipped: 1 });
  });

  it('开关 off ⇒ 零行为变化', () => {
    const candidateIds: Record<string, string[]> = { s1: ['c1'] };
    const stat = S.extendAbstractCandidates({
      kmQueries: [{ shotId: 's1', isAbstractNarration: true }],
      chunks, candidateIds, shotById,
      hasChunkDesc: () => true, windowSec: 45, enabled: false,
    });
    expect(candidateIds.s1).toEqual(['c1']);
    expect(stat).toEqual({ sentences: 0, added: 0, skipped: 0 });
  });
});
