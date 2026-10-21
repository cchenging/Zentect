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
