// 📁 路径: src/main/engine/strategies/__tests__/SemanticAnalyzeStrategy.unitFragmentWindow.test.ts
// 🎬 单位内碎片画面窗切分（2026-09-25 治「同句碎片共窗重放 / 前后不衔接」）单元测试
//
// 背景：sentence 档一个完整句折叠成 1 条 query ⇒ 命中 1 个切片，回填时该句全部碎片继承同一
// chunkData/时间窗 ⇒ 导出层各片段从同一窗头重放（用户实测：前 3 段文案重复同一镜头）。
//
// 覆盖：
//   1. 单碎片单位 ⇒ 空表（调用方零变化）
//   2. 三碎片 + 无兄弟片 ⇒ 同片内按比例切 N 段，首尾相接且总和恒等于命中窗长（用户选定降级口径）
//   3. 三碎片 + 兄弟片链充足 ⇒ 每段窗长 = 碎片自身 TTS 时长（变速恒 1.0，余料不用）
//   4. 三碎片 + 链不足 ⇒ 覆盖整条链、仍首尾相接
//   5. 源时间断开（间隙 ≥100ms）⇒ 不跨接，链退化为命中片自身
//   6. 兄弟片 filePath 不同 ⇒ 不跨接（禁止跨素材文件取窗）
//   7. 单调守卫：0 时长碎片不产生零长/逆序窗
//   8. buildSiblingPool：按 parentChunkId 分组 + (parent,id,startMs) 去重 + startMs 升序
//   9. retimeFragmentWindow：只改窗（chunkData.startMs/endMs/durationMs + videoTimeline），
//      身份/文本/配音时长/父 id 不动；
//      窗落点属于另一源切片时 id/mediaId/thumbnail/coverPath/description「身份三件套同源」跟随（治卡片
//      缩略图与描述停在命中切片、彼此自相矛盾）
//  10. buildUnitWindowTable：多碎片单位聚合；单碎片/原声段/未命中一律跳过
//  11. buildUnitWindowTable：跨镜头填料（方案甲）—— 命中镜头料不够时顺延候选镜头取满窗，
//      前序单位吃光的候选跳过、游标不裁剪兜底
//  12. buildUnitWindowTable：同母句「同父不相接」收敛（2026-09-27）—— legacy 一碎片一 query 时
//      把同母句同父的不相接窗重切为连续窗；不同父 / 已相接 / 锚点落不到兄弟片一律零变化
//  13. retimeFragmentWindow：变速系数随新窗重算（2026-09-27）—— 系数 = 源窗长 / 配音时长（与 daemon 同源）；
//      原声段恒 1.0；配音时长缺失/非正/窗长无效时保持原值（不造数）
//  14. retimeFragmentWindow：chunkData.durationMs 随新窗同源改写（2026-09-27）—— 治「窗长已 = 配音、
//      durationMs 仍为旧单片值」被误判料荒（实测 seg_10 2524/1851.9、seg_11 2524/1685、seg_24_sub_2 3333/2052.1）

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../core/AppLogger', () => ({
  AppLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@modules/infra/logger/LogConstants', () => ({
  LOG_TAGS: { AI_AGENT: 'AI_AGENT', SCHEDULER: 'SCHEDULER' },
}));

import { SemanticAnalyzeStrategy } from '../SemanticAnalyzeStrategy';

/** 私有静态方法测试入口（TS private 仅编译期可见，运行期按既有测试惯例直取） */
const S = SemanticAnalyzeStrategy as any;

type Win = { startMs: number; endMs: number };

/** 断言窗序列首尾相接（end_i === start_{i+1}） */
function expectContiguous(wins: Win[]): void {
  for (let i = 1; i < wins.length; i++) {
    expect(wins[i].startMs).toBe(wins[i - 1].endMs);
  }
}

/** 取窗序列（按碎片顺序，缺窗报错暴露，不静默兜底） */
function pick(map: Map<string, Win>, shotIds: string[]): Win[] {
  return shotIds.map((id) => {
    const w = map.get(id);
    if (!w) throw new Error(`碎片 ${id} 未分配到窗`);
    return w;
  });
}

describe('单位内碎片画面窗切分（治重复重放 + 前后不衔接）', () => {
  it('单碎片单位 ⇒ 空表（零变化）', () => {
    const frags = [{ shotId: 'seg_a', audioDurationMs: 1200 }];
    const map = S.buildUnitFragmentWindows(
      frags, { startMs: 0, endMs: 3000, parentChunkId: 'scene_a', filePath: 'a.mp4' },
      S.buildSiblingPool([]),
    );
    expect(map.size).toBe(0);
  });

  it('命中窗无效（逆序/非数）⇒ 空表（不造假）', () => {
    const frags = [
      { shotId: 'seg_a_sub_1', audioDurationMs: 1200 },
      { shotId: 'seg_a_sub_2', audioDurationMs: 800 },
    ];
    expect(S.buildUnitFragmentWindows(
      frags, { startMs: 3000, endMs: 1000, parentChunkId: 'scene_a' }, S.buildSiblingPool([])).size,
    ).toBe(0);
    expect(S.buildUnitFragmentWindows(
      frags, { startMs: undefined, endMs: undefined }, S.buildSiblingPool([])).size,
    ).toBe(0);
    expect(S.buildUnitFragmentWindows(frags, null, S.buildSiblingPool([])).size).toBe(0);
  });

  it('三碎片 + 无兄弟片 ⇒ 同片内按比例切 N 段，首尾相接且总和 = 命中窗长（实机 seg_1 形态）', () => {
    const frags = [
      { shotId: 'seg_1_sub_1', audioDurationMs: 2233 },
      { shotId: 'seg_1_sub_2', audioDurationMs: 1676 },
      { shotId: 'seg_1_sub_3', audioDurationMs: 835 },
    ];
    const map = S.buildUnitFragmentWindows(
      frags, { startMs: 65229, endMs: 66296, parentChunkId: 'scene_001', filePath: 'a.mp4' },
      S.buildSiblingPool([]),
    );
    const wins = pick(map, ['seg_1_sub_1', 'seg_1_sub_2', 'seg_1_sub_3']);
    expectContiguous(wins);
    expect(wins[0].startMs).toBe(65229);
    expect(wins[wins.length - 1].endMs).toBe(66296);
    // 总长恒等于命中窗（614+377+188 = 1067 由右端对齐天然保证）
    const total = wins.reduce((s, w) => s + (w.endMs - w.startMs), 0);
    expect(total).toBe(66296 - 65229);
    // 比例单调：配音越长窗越长
    expect(wins[0].endMs - wins[0].startMs).toBeGreaterThan(wins[1].endMs - wins[1].startMs);
    expect(wins[1].endMs - wins[1].startMs).toBeGreaterThan(wins[2].endMs - wins[2].startMs);
  });

  it('兄弟片链充足 ⇒ 每段窗长 = 碎片自身时长（变速 1.0），余料不用', () => {
    const frags = [
      { shotId: 'u_sub_1', audioDurationMs: 2000 },
      { shotId: 'u_sub_2', audioDurationMs: 1000 },
      { shotId: 'u_sub_3', audioDurationMs: 1000 },
    ];
    const pool = S.buildSiblingPool([
      { id: 'scene_h_seg0', parentChunkId: 'scene_h', startMs: 1000, endMs: 2000, filePath: 'a.mp4' },
      { id: 'scene_h_seg1', parentChunkId: 'scene_h', startMs: 2000, endMs: 4000, filePath: 'a.mp4' },
      { id: 'scene_h_seg2', parentChunkId: 'scene_h', startMs: 4000, endMs: 7000, filePath: 'a.mp4' },
    ]);
    const map = S.buildUnitFragmentWindows(
      frags, { startMs: 1000, endMs: 2000, parentChunkId: 'scene_h', filePath: 'a.mp4' }, pool,
    );
    const wins = pick(map, ['u_sub_1', 'u_sub_2', 'u_sub_3']);
    expectContiguous(wins);
    expect(wins.map((w) => w.endMs - w.startMs)).toEqual([2000, 1000, 1000]);
    expect(wins[0].startMs).toBe(1000);
    expect(wins[2].endMs).toBe(5000);   // 只消费 need（4000ms），余料 5000~7000 不用
  });

  it('窗落在同父兄弟片链的后半段 ⇒ srcChunkId/srcCover 跟随该兄弟片（治缩略图三张一样）', () => {
    const frags = [
      { shotId: 'u_sub_1', audioDurationMs: 2000 },
      { shotId: 'u_sub_2', audioDurationMs: 1000 },
    ];
    const pool = S.buildSiblingPool([
      { id: 'scene_h_seg0', parentChunkId: 'scene_h', startMs: 1000, endMs: 2000, filePath: 'a.mp4', coverPath: 'thumb/seg_10_cover.jpg' },
      { id: 'scene_h_seg1', parentChunkId: 'scene_h', startMs: 2000, endMs: 5000, filePath: 'a.mp4', coverPath: 'thumb/seg_11_cover.jpg' },
    ]);
    const map = S.buildUnitFragmentWindows(
      frags, { id: 'scene_h_seg0', coverPath: 'thumb/seg_10_cover.jpg', parentChunkId: 'scene_h', filePath: 'a.mp4', startMs: 1000, endMs: 2000 }, pool,
    );
    expect(map.get('u_sub_1')!.srcChunkId).toBe('scene_h_seg0');   // 起点 1000 落在 seg0
    expect(map.get('u_sub_2')!.srcChunkId).toBe('scene_h_seg1');   // 起点 3000 落在 seg1
    expect(map.get('u_sub_2')!.srcCover).toBe('thumb/seg_11_cover.jpg');
    expect(map.get('u_sub_1')!.srcParent).toBeUndefined();         // 同父 ⇒ 不改父 id（导出层仍合并）
  });

  it('跨镜头取料 ⇒ srcChunkId/srcCover 取候选切片自身（身份跟随候选镜头）', () => {
    const frags = [
      { shotId: 'u_sub_1', audioDurationMs: 800 },
      { shotId: 'u_sub_2', audioDurationMs: 800 },
    ];
    const pool = S.buildSiblingPool([]);
    const map = S.buildUnitFragmentWindows(
      frags,
      { id: 'scene_hit_seg0', coverPath: 'thumb/seg_1_cover.jpg', parentChunkId: 'scene_hit', filePath: 'a.mp4', startMs: 0, endMs: 800 },
      pool,
      [{ id: 'scene_cand_seg0', coverPath: 'thumb/seg_9_cover.jpg', parentChunkId: 'scene_cand', filePath: 'b.mp4', startMs: 5000, endMs: 7000 }],
    );
    expect(map.get('u_sub_1')!.srcChunkId).toBe('scene_hit_seg0');
    expect(map.get('u_sub_2')!.srcChunkId).toBe('scene_cand_seg0');
    expect(map.get('u_sub_2')!.srcCover).toBe('thumb/seg_9_cover.jpg');
    expect(map.get('u_sub_2')!.srcParent).toBe('scene_cand');
  });

  it('链不足 ⇒ 覆盖整条链、仍首尾相接（实机 seg_0 形态：5081ms 配音 / 3370ms 料）', () => {
    const frags = [
      { shotId: 'seg_0_sub_1', audioDurationMs: 914 },
      { shotId: 'seg_0_sub_2', audioDurationMs: 2250 },
      { shotId: 'seg_0_sub_3', audioDurationMs: 1917 },
    ];
    const pool = S.buildSiblingPool([
      { id: 'scene_494_seg0', parentChunkId: 'scene_494', startMs: 3416376, endMs: 3418061, filePath: 'a.mp4' },
      { id: 'scene_494_seg1', parentChunkId: 'scene_494', startMs: 3418061, endMs: 3419746, filePath: 'a.mp4' },
    ]);
    const map = S.buildUnitFragmentWindows(
      frags, { startMs: 3416376, endMs: 3418061, parentChunkId: 'scene_494', filePath: 'a.mp4' }, pool,
    );
    const wins = pick(map, ['seg_0_sub_1', 'seg_0_sub_2', 'seg_0_sub_3']);
    expectContiguous(wins);
    expect(wins[0].startMs).toBe(3416376);
    expect(wins[2].endMs).toBe(3419746);   // 整条链用尽
  });

  it('源时间断开（间隙 ≥100ms）⇒ 只吃命中片，不跨接', () => {
    const frags = [
      { shotId: 'u_sub_1', audioDurationMs: 500 },
      { shotId: 'u_sub_2', audioDurationMs: 500 },
    ];
    const pool = S.buildSiblingPool([
      { id: 'scene_d_seg1', parentChunkId: 'scene_d', startMs: 2500, endMs: 4000, filePath: 'a.mp4' },
    ]);
    const map = S.buildUnitFragmentWindows(
      frags, { startMs: 1000, endMs: 2000, parentChunkId: 'scene_d', filePath: 'a.mp4' }, pool,
    );
    const wins = pick(map, ['u_sub_1', 'u_sub_2']);
    expectContiguous(wins);
    expect(wins[0].startMs).toBe(1000);
    expect(wins[1].endMs).toBe(2000);      // 未跨到 2500（间隙 500ms ≥ 容差）
  });

  it('兄弟片 filePath 不同 ⇒ 不跨接（禁止跨素材文件取窗）', () => {
    const frags = [
      { shotId: 'u_sub_1', audioDurationMs: 500 },
      { shotId: 'u_sub_2', audioDurationMs: 500 },
    ];
    const pool = S.buildSiblingPool([
      { id: 'scene_p_seg1', parentChunkId: 'scene_p', startMs: 2000, endMs: 6000, filePath: 'b.mp4' },
    ]);
    const map = S.buildUnitFragmentWindows(
      frags, { startMs: 1000, endMs: 2000, parentChunkId: 'scene_p', filePath: 'a.mp4' }, pool,
    );
    const wins = pick(map, ['u_sub_1', 'u_sub_2']);
    expect(wins[1].endMs).toBe(2000);      // 未跨到 b.mp4 的 2000~6000
  });

  it('单调守卫：0 时长碎片不产生零长/逆序窗', () => {
    const frags = [
      { shotId: 'u_sub_1', audioDurationMs: 0 },
      { shotId: 'u_sub_2', audioDurationMs: 900 },
      { shotId: 'u_sub_3', audioDurationMs: 0 },
    ];
    const map = S.buildUnitFragmentWindows(
      frags, { startMs: 0, endMs: 900, parentChunkId: 'scene_z', filePath: 'a.mp4' },
      S.buildSiblingPool([]),
    );
    const wins = pick(map, ['u_sub_1', 'u_sub_2', 'u_sub_3']);
    expectContiguous(wins);
    for (const w of wins) expect(w.endMs).toBeGreaterThan(w.startMs);
    expect(wins[2].endMs).toBeLessThanOrEqual(900);
  });

  it('buildSiblingPool：按 parent 分组、去重、startMs 升序', () => {
    const pool = S.buildSiblingPool(
      [
        { id: 'scene_a_seg1', parentChunkId: 'scene_a', startMs: 200, endMs: 400 },
        { id: 'scene_a_seg0', parentChunkId: 'scene_a', startMs: 0, endMs: 200 },
        { id: 'scene_a_seg0', parentChunkId: 'scene_a', startMs: 0, endMs: 200 },  // 重复项
        { id: 'no_parent', startMs: 0, endMs: 100 },
      ],
      [{ id: 'scene_b_seg0', parentChunkId: 'scene_b', startMs: 5, endMs: 9 }],
    );
    expect(pool.has('scene_a')).toBe(true);
    expect(pool.get('scene_a')!.map((c: any) => c.id)).toEqual(['scene_a_seg0', 'scene_a_seg1']);
    expect(pool.get('scene_b')!.length).toBe(1);
    expect(pool.has('')).toBe(false);
  });

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
    // 🎛️ 变速随新窗重算：502ms 源窗 / 2233ms 配音 = 0.225（原样按比例切分的慢放，与导出层实际一致）
    expect(out.appliedSpeedFactor).toBe(0.225);
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

  it('retimeFragmentWindow：变速系数随新窗重算（窗长=配音时长 ⇒ 1.0，治实测 0.946 错配）', () => {
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

    /** 料不足（窗 3370ms / 配音 5081ms，实机 seg_0 形态）⇒ 如实记慢放，与导出层实际播放一致 */
    const slow = S.retimeFragmentWindow(
      { audioDurationMs: 5081, appliedSpeedFactor: 1.0, chunkData: { startMs: 0, endMs: 10 } },
      { startMs: 3416376, endMs: 3419746 },
    );
    expect(slow.appliedSpeedFactor).toBe(0.663);

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

  it('buildUnitFragmentWindows：命中母块尾片 ⇒ 向前回吃前驱片补足（2026-09-27，治 seg_19/21/26 真料荒）', () => {
    /** 实测形态：scene_053/075/452 的命中片都是母块**最后一片**，后向链为空 ⇒ 旧口径必判荒。
     *  本用例：母块 seg0(0-2000) + seg1(2000-4000) + 命中 seg2(4000-6000)，两碎片各需 1500ms
     *  ⇒ 后向只有 2000ms < 3000ms，须回吃 seg1 补足，窗 = [6000-3000, 6000] = [3000, 6000]。 */
    const pool = S.buildSiblingPool([
      { id: 'scene_T_seg0', parentChunkId: 'scene_T', filePath: 'v.mp4', startMs: 0, endMs: 2000 },
      { id: 'scene_T_seg1', parentChunkId: 'scene_T', filePath: 'v.mp4', startMs: 2000, endMs: 4000 },
      { id: 'scene_T_seg2', parentChunkId: 'scene_T', filePath: 'v.mp4', startMs: 4000, endMs: 6000, coverPath: 'c2.jpg' },
    ]);
    const cursor = new Map<string, number>();
    const map = S.buildUnitFragmentWindows(
      [{ shotId: 'seg_A', audioDurationMs: 1500 }, { shotId: 'seg_B', audioDurationMs: 1500 }],
      { id: 'scene_T_seg2', parentChunkId: 'scene_T', filePath: 'v.mp4', startMs: 4000, endMs: 6000, coverPath: 'c2.jpg' },
      pool, undefined, undefined, cursor,
    );
    expect(map.size).toBe(2);
    const a = map.get('seg_A')!;
    const b = map.get('seg_B')!;
    expect(a.startMs).toBe(3000);                 // 窗尾固定 ⇒ 窗头前移到 6000-3000
    expect(a.endMs).toBe(4500);
    expect(b.startMs).toBe(4500);                 // 碎片间首尾相接
    expect(b.endMs).toBe(6000);
    expect(a.startMs).toBeLessThan(4000);         // 确实回吃到命中片左侧
    expect(cursor.get('scene_T')).toBe(6000);     // 消费游标推进到窗尾

    /** 独占：游标已越过前驱片左界 ⇒ 禁止回吃（宁缺勿错，退回旧口径比例切分，总长仍是后向可用量） */
    const cursor2 = new Map<string, number>([['scene_T', 3900]]);
    const map2 = S.buildUnitFragmentWindows(
      [{ shotId: 'seg_A', audioDurationMs: 1500 }, { shotId: 'seg_B', audioDurationMs: 1500 }],
      { id: 'scene_T_seg2', parentChunkId: 'scene_T', filePath: 'v.mp4', startMs: 4000, endMs: 6000, coverPath: 'c2.jpg' },
      pool, undefined, undefined, cursor2,
    );
    const span2 = Math.max(...[...map2.values()].map((w) => w.endMs))
      - Math.min(...[...map2.values()].map((w) => w.startMs));
    expect(span2).toBe(2000);                     // 未回吃 ⇒ 总窗长 = 后向链可用量（旧口径零变化）
    expect(Math.min(...[...map2.values()].map((w) => w.startMs))).toBe(4000);

    /** 独占：前驱片是【他段命中片】⇒ 即使游标未越过也禁止回吃（防与相邻段重播） */
    const map3 = S.buildUnitFragmentWindows(
      [{ shotId: 'seg_A', audioDurationMs: 1500 }, { shotId: 'seg_B', audioDurationMs: 1500 }],
      { id: 'scene_T_seg2', parentChunkId: 'scene_T', filePath: 'v.mp4', startMs: 4000, endMs: 6000, coverPath: 'c2.jpg' },
      pool, undefined, undefined, new Map<string, number>(), new Set(['scene_T_seg1']),
    );
    const span3 = Math.max(...[...map3.values()].map((w) => w.endMs))
      - Math.min(...[...map3.values()].map((w) => w.startMs));
    expect(span3).toBe(2000);                     // 他段命中 seg1 ⇒ 不回吃，窗恒 [4000,6000]
    expect(Math.min(...[...map3.values()].map((w) => w.startMs))).toBe(4000);
  });

  it('buildUnitWindowTable：多碎片单位聚合；原声段与未命中一律跳过', () => {
    const shotLevelQueries = [
      { shotId: 'seg_1_sub_1', matchUnitId: 'seg_1', audioDurationMs: 500 },
      { shotId: 'seg_1_sub_2', matchUnitId: 'seg_1', audioDurationMs: 500 },
      { shotId: 'seg_9', matchUnitId: 'seg_9', audioDurationMs: 700 },                    // 单碎片
      { shotId: 'seg_o_sub_1', matchUnitId: 'seg_o', audioDurationMs: 400, keepOriginalAudio: true },
      { shotId: 'seg_o_sub_2', matchUnitId: 'seg_o', audioDurationMs: 400, keepOriginalAudio: true },
      { shotId: 'seg_miss_sub_1', matchUnitId: 'seg_miss', audioDurationMs: 300 },        // 未命中
      { shotId: 'seg_miss_sub_2', matchUnitId: 'seg_miss', audioDurationMs: 300 },
    ];
    const matchById = new Map<string, any>([
      ['seg_1', { chunkData: { id: 'scene_001_seg0', parentChunkId: 'scene_001', filePath: 'a.mp4', startMs: 0, endMs: 1000 } }],
    ]);
    const table = S.buildUnitWindowTable(shotLevelQueries, matchById, new Map(), S.buildSiblingPool([]));
    expect([...table.keys()].sort()).toEqual(['seg_1_sub_1', 'seg_1_sub_2']);
    const wins = pick(table, ['seg_1_sub_1', 'seg_1_sub_2']);
    expectContiguous(wins);
    expect(wins[0].startMs).toBe(0);
    expect(wins[1].endMs).toBe(1000);
  });

  it('buildUnitWindowTable：chunkData 被 daemon 裁剪时用 originalChunksById 补回', () => {
    const shotLevelQueries = [
      { shotId: 'seg_c_sub_1', matchUnitId: 'seg_c', audioDurationMs: 400 },
      { shotId: 'seg_c_sub_2', matchUnitId: 'seg_c', audioDurationMs: 600 },
    ];
    const matchById = new Map<string, any>([['seg_c', { chunkId: 'scene_c_seg0' }]]);
    const originalChunksById = new Map<string, any>([
      ['scene_c_seg0', { id: 'scene_c_seg0', parentChunkId: 'scene_c', filePath: 'a.mp4', startMs: 100, endMs: 1100 }],
    ]);
    const table = S.buildUnitWindowTable(shotLevelQueries, matchById, originalChunksById, S.buildSiblingPool([]));
    const wins = pick(table, ['seg_c_sub_1', 'seg_c_sub_2']);
    expectContiguous(wins);
    expect(wins[0].startMs).toBe(100);
    expect(wins[1].endMs).toBe(1100);
  });

  it('方案甲：命中块能装下前两片、第三片顺延候选镜头（混块 = 硬切，仅跨块片带 srcFile/srcParent）', () => {
    const frags = [
      { shotId: 'seg_0_sub_1', audioDurationMs: 914 },
      { shotId: 'seg_0_sub_2', audioDurationMs: 2250 },
      { shotId: 'seg_0_sub_3', audioDurationMs: 1917 },
    ];
    const extra = [
      { id: 'scene_313_seg0', parentChunkId: 'scene_313', filePath: 'a.mp4', startMs: 100000, endMs: 110000 },
    ];
    const map = S.buildUnitFragmentWindows(
      frags, { startMs: 3416376, endMs: 3419746, parentChunkId: 'scene_494', filePath: 'a.mp4' },
      S.buildSiblingPool([]), extra,
    );
    const wins = pick(map, ['seg_0_sub_1', 'seg_0_sub_2', 'seg_0_sub_3']);
    // 每片窗长 = 自身配音时长（变速恒 1.0；旧口径只能把 3370ms 料按比例拉成 5081ms ⇒ 1.51× 慢放）
    expect(wins.map((w) => w.endMs - w.startMs)).toEqual([914, 2250, 1917]);
    expect(wins[0].startMs).toBe(3416376);
    expect(wins[1].startMs).toBe(wins[0].endMs);          // 命中块内首尾相接
    expect((wins[0] as any).srcParent).toBeUndefined();    // 命中镜头取料不带来源覆写
    expect((wins[1] as any).srcParent).toBeUndefined();
    expect((wins[2] as any).srcParent).toBe('scene_313');  // 第三片跨镜头 ⇒ 来源跟随
    expect((wins[2] as any).srcFile).toBe('a.mp4');
    expect(wins[2].startMs).toBe(100000);
  });

  it('方案甲：命中镜头短于任一片 ⇒ 该镜头料弃用，全部顺延候选（不制造慢放）', () => {
    const frags = [
      { shotId: 'seg_1_sub_1', audioDurationMs: 2233 },
      { shotId: 'seg_1_sub_2', audioDurationMs: 1676 },
      { shotId: 'seg_1_sub_3', audioDurationMs: 835 },
    ];
    const extra = [
      { id: 'scene_313_seg0', parentChunkId: 'scene_313', filePath: 'a.mp4', startMs: 100000, endMs: 110000 },
    ];
    const map = S.buildUnitFragmentWindows(
      frags, { startMs: 65229, endMs: 66296, parentChunkId: 'scene_001', filePath: 'a.mp4' },
      S.buildSiblingPool([]), extra,
    );
    const wins = pick(map, ['seg_1_sub_1', 'seg_1_sub_2', 'seg_1_sub_3']);
    expect(wins.map((w) => w.endMs - w.startMs)).toEqual([2233, 1676, 835]);
    expect(wins[0].startMs).toBe(100000);                  // 1067ms 命中镜头承载不了任一片 ⇒ 弃用
    expect(wins[2].endMs).toBe(104744);
    expect(wins.every((w) => (w as any).srcParent === 'scene_313')).toBe(true);
  });

  it('方案甲：候选镜头仍不足 ⇒ 退回旧口径比例切分（慢放兜底，行为不回归）', () => {
    const frags = [
      { shotId: 'seg_1_sub_1', audioDurationMs: 2233 },
      { shotId: 'seg_1_sub_2', audioDurationMs: 1676 },
      { shotId: 'seg_1_sub_3', audioDurationMs: 835 },
    ];
    const extra = [
      { id: 'scene_x_seg0', parentChunkId: 'scene_x', filePath: 'a.mp4', startMs: 100000, endMs: 102000 },
    ];
    const map = S.buildUnitFragmentWindows(
      frags, { startMs: 65229, endMs: 66296, parentChunkId: 'scene_001', filePath: 'a.mp4' },
      S.buildSiblingPool([]), extra,
    );
    const wins = pick(map, ['seg_1_sub_1', 'seg_1_sub_2', 'seg_1_sub_3']);
    expectContiguous(wins);
    expect(wins[0].startMs).toBe(65229);
    expect(wins[2].endMs).toBe(66296);                     // 仍只吃命中链（1067+2000 < 4744）
    expect(wins.every((w) => (w as any).srcParent === undefined)).toBe(true);
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

  it('buildUnitWindowTable：候选透传生效，且同父候选被排除（同父已由兄弟链覆盖）', () => {
    const shotLevelQueries = [
      { shotId: 'seg_1_sub_1', matchUnitId: 'seg_1', audioDurationMs: 1500 },
      { shotId: 'seg_1_sub_2', matchUnitId: 'seg_1', audioDurationMs: 1500 },
    ];
    const matchById = new Map<string, any>([
      ['seg_1', { chunkData: { id: 'scene_001_seg0', parentChunkId: 'scene_001', filePath: 'a.mp4', startMs: 0, endMs: 1000 } }],
    ]);
    const originalChunksById = new Map<string, any>([
      ['scene_001_seg1', { id: 'scene_001_seg1', parentChunkId: 'scene_001', filePath: 'a.mp4', startMs: 1000, endMs: 2000 }],
      ['scene_313_seg0', { id: 'scene_313_seg0', parentChunkId: 'scene_313', filePath: 'a.mp4', startMs: 50000, endMs: 60000 }],
    ]);
    const table = S.buildUnitWindowTable(
      shotLevelQueries, matchById, originalChunksById, S.buildSiblingPool([]),
      { seg_1: ['scene_001_seg1', 'scene_313_seg0'] },
    );
    const wins = pick(table, ['seg_1_sub_1', 'seg_1_sub_2']);
    expect(wins[0].startMs).toBe(50000);                    // 同父的 seg1 被排除 ⇒ 走 scene_313
    expect((wins[0] as any).srcParent).toBe('scene_313');
    expect((wins[1] as any).srcParent).toBe('scene_313');
  });

  it('跨单位消费游标：单碎片单位未被消费过 ⇒ 零变化；已被消费过 ⇒ 顺延取满自身时长', () => {
    const frags = [{ shotId: 'seg_a', audioDurationMs: 1200 }];
    const hit = { startMs: 0, endMs: 3000, parentChunkId: 'scene_a', filePath: 'a.mp4' };
    const pool = S.buildSiblingPool([]);
    // 未被任何前序单位消费 ⇒ 保持旧口径（交回导出层做句尾对齐子窗裁剪）
    expect(S.buildUnitFragmentWindows(frags, hit, pool).size).toBe(0);
    expect(S.buildUnitFragmentWindows(frags, hit, pool, [], undefined, new Map()).size).toBe(0);
    // 已被前序单位消费到 1500ms ⇒ 从 1500 续接、取满 1200ms（不回头重放窗头）
    const cursor = new Map<string, number>([['scene_a', 1500]]);
    const map = S.buildUnitFragmentWindows(frags, hit, pool, [], undefined, cursor);
    const w = map.get('seg_a')!;
    expect(w.startMs).toBe(1500);
    expect(w.endMs).toBe(2700);
    expect(cursor.get('scene_a')).toBe(2700);               // 就地推进游标
  });

  it('跨单位消费游标：同一父镜头被连续单位复用时顺延续接（seg_0尾/seg_1/seg_2 形态）', () => {
    const hit = { startMs: 1000, endMs: 2000, parentChunkId: 'scene_c', filePath: 'a.mp4' };
    const pool = S.buildSiblingPool([
      { id: 'scene_c_seg1', parentChunkId: 'scene_c', filePath: 'a.mp4', startMs: 2000, endMs: 8000 },
    ]);
    const cursor = new Map<string, number>();
    const u1 = S.buildUnitFragmentWindows(
      [{ shotId: 'u1_a', audioDurationMs: 800 }, { shotId: 'u1_b', audioDurationMs: 1200 }],
      hit, pool, [], undefined, cursor,
    );
    expect(u1.get('u1_a')!.startMs).toBe(1000);
    expect(u1.get('u1_b')!.endMs).toBe(3000);
    expect(cursor.get('scene_c')).toBe(3000);
    // 第二个单位命中同一镜头 ⇒ 从 3000 续接，绝不回到 1000（旧口径两段窗完全重叠）
    const u2 = S.buildUnitFragmentWindows(
      [{ shotId: 'u2_a', audioDurationMs: 1000 }], hit, pool, [], undefined, cursor,
    );
    expect(u2.get('u2_a')!.startMs).toBe(3000);
    expect(u2.get('u2_a')!.endMs).toBe(4000);
  });

  it('跨单位消费游标：命中镜头已被吃光 ⇒ 剔除该块，直接顺延候选镜头并推进候选游标', () => {
    const hit = { startMs: 1000, endMs: 2000, parentChunkId: 'scene_c', filePath: 'a.mp4' };
    const extra = [
      { id: 'scene_x_seg0', parentChunkId: 'scene_x', filePath: 'a.mp4', startMs: 50000, endMs: 60000 },
    ];
    const cursor = new Map<string, number>([['scene_c', 2000]]);   // 命中镜头料已被前序单位吃光
    const map = S.buildUnitFragmentWindows(
      [{ shotId: 'u_a', audioDurationMs: 900 }, { shotId: 'u_b', audioDurationMs: 600 }],
      hit, S.buildSiblingPool([]), extra, undefined, cursor,
    );
    const wins = pick(map, ['u_a', 'u_b']);
    expect(wins[0].startMs).toBe(50000);
    expect(wins[1].endMs).toBe(51500);
    expect((wins[0] as any).srcParent).toBe('scene_x');
    expect(cursor.get('scene_x')).toBe(51500);
  });

  it('buildUnitWindowTable：两单位复用同一父镜头 ⇒ 第二个单位顺延续接（游标跨单位接线）', () => {
    const chunk = { id: 'scene_c_seg0', parentChunkId: 'scene_c', filePath: 'a.mp4', startMs: 1000, endMs: 2000 };
    const shotLevelQueries = [
      { shotId: 'u1_a', matchUnitId: 'u1', audioDurationMs: 800 },
      { shotId: 'u1_b', matchUnitId: 'u1', audioDurationMs: 1200 },
      { shotId: 'u2_a', matchUnitId: 'u2', audioDurationMs: 1000 },
    ];
    const matchById = new Map<string, any>([['u1', { chunkData: chunk }], ['u2', { chunkData: chunk }]]);
    const pool = S.buildSiblingPool([
      { id: 'scene_c_seg1', parentChunkId: 'scene_c', filePath: 'a.mp4', startMs: 2000, endMs: 8000 },
    ]);
    const table = S.buildUnitWindowTable(shotLevelQueries, matchById, new Map(), pool);
    const w1 = pick(table, ['u1_a', 'u1_b']);
    expect(w1[0].startMs).toBe(1000);
    expect(w1[1].endMs).toBe(3000);
    const w2 = table.get('u2_a')!;
    expect(w2.startMs).toBe(3000);                          // 续接，不回到 1000
    expect(w2.endMs).toBe(4000);
  });

  it('🎯 游标裁剪后料不足 ⇒ 改用「不裁剪」重算（宁可复用，不极端慢放；实测 seg_2 20× 慢放回归）', () => {
    const frags = [
      { shotId: 'v_sub_1', audioDurationMs: 600 },
      { shotId: 'v_sub_2', audioDurationMs: 600 },
    ];
    const pool = S.buildSiblingPool([
      { id: 'scene_v_seg1', parentChunkId: 'scene_v', filePath: 'a.mp4', startMs: 1100, endMs: 3100 },
    ]);
    const cursor = new Map<string, number>([['scene_v', 3000]]);
    const map = S.buildUnitFragmentWindows(
      frags, { startMs: 1000, endMs: 1100, parentChunkId: 'scene_v', filePath: 'a.mp4' },
      pool, [], undefined, cursor,
    );
    const wins = pick(map, ['v_sub_1', 'v_sub_2']);
    expectContiguous(wins);
    expect(wins[0].startMs).toBe(1000);   // 未从游标 3000 起（否则仅剩 100ms 料 ⇒ 约 12× 慢放）
    expect(wins[1].endMs).toBe(2200);     // 每片取自身 TTS 时长（变速恒 1.0）
  });

  it('🎯 候选池剔除已消费父镜头：跳过前序单位用过的候选，换到未用镜头', () => {
    const frags = [
      { shotId: 'w_sub_1', audioDurationMs: 600 },
      { shotId: 'w_sub_2', audioDurationMs: 600 },
    ];
    const extra = [
      { id: 'scene_x_seg0', parentChunkId: 'scene_x', filePath: 'a.mp4', startMs: 5000, endMs: 7000 },
      { id: 'scene_y_seg0', parentChunkId: 'scene_y', filePath: 'a.mp4', startMs: 2000, endMs: 4000 },
    ];
    const cursor = new Map<string, number>([['scene_x', 5000]]);   // scene_x 已被前序单位消费
    const map = S.buildUnitFragmentWindows(
      frags, { startMs: 1000, endMs: 1100, parentChunkId: 'scene_h', filePath: 'a.mp4' },
      S.buildSiblingPool([]), extra, undefined, cursor,
    );
    const wins = pick(map, ['w_sub_1', 'w_sub_2']);
    expectContiguous(wins);
    expect(wins[0].startMs).toBe(2000);                     // 未取已消费的 scene_x（5000 起）
    expect(wins[1].endMs).toBe(3200);
    expect((wins[0] as any).srcParent).toBe('scene_y');
    expect(cursor.get('scene_y')).toBe(3200);
  });

  it('🎯 候选全被前序单位消费 ⇒ 不裁剪重算命中镜头（退让为全窗，而非极端慢放）', () => {
    const frags = [
      { shotId: 'z_sub_1', audioDurationMs: 600 },
      { shotId: 'z_sub_2', audioDurationMs: 600 },
    ];
    const extra = [
      { id: 'scene_x_seg0', parentChunkId: 'scene_x', filePath: 'a.mp4', startMs: 5000, endMs: 9000 },
    ];
    const cursor = new Map<string, number>([['scene_h', 2000], ['scene_x', 5000]]);
    const map = S.buildUnitFragmentWindows(
      frags, { startMs: 1000, endMs: 3000, parentChunkId: 'scene_h', filePath: 'a.mp4' },
      S.buildSiblingPool([]), extra, undefined, cursor,
    );
    const wins = pick(map, ['z_sub_1', 'z_sub_2']);
    expectContiguous(wins);
    expect(wins[0].startMs).toBe(1000);   // 退让到命中镜头全窗（游标版只余 2000~3000 的 1000ms 不够）
    expect(wins[1].endMs).toBe(2200);     // 两片各取自身 TTS 时长 ⇒ 变速恒 1.0（非比例切分）
  });

  it('🎯 候选池在构建阶段剔除已消费父镜头：前 3 个候选全被用过时继续往后取，不空手', () => {
    const h0 = { id: 'h0', parentChunkId: 'scene_h0', filePath: 'a.mp4', startMs: 1000, endMs: 1100 };
    const h1 = { id: 'h1', parentChunkId: 'scene_h1', filePath: 'a.mp4', startMs: 1000, endMs: 1100 };
    const chunks = new Map<string, any>([
      ['cx', { id: 'cx', parentChunkId: 'scene_x', filePath: 'a.mp4', startMs: 5000, endMs: 7000 }],
      ['cy', { id: 'cy', parentChunkId: 'scene_y', filePath: 'a.mp4', startMs: 2000, endMs: 4000 }],
      ['cw', { id: 'cw', parentChunkId: 'scene_w', filePath: 'a.mp4', startMs: 3000, endMs: 5000 }],
      ['cz', { id: 'cz', parentChunkId: 'scene_z', filePath: 'a.mp4', startMs: 2000, endMs: 4000 }],
    ]);
    const shotLevelQueries = [
      ...Array.from({ length: 9 }, (_, i) => ({ shotId: `p0_${i + 1}`, matchUnitId: 'u0', audioDurationMs: 500 })),
      { shotId: 'p1_1', matchUnitId: 'u1', audioDurationMs: 500 },
      { shotId: 'p1_2', matchUnitId: 'u1', audioDurationMs: 500 },
    ];
    const matchById = new Map<string, any>([['u0', { chunkData: h0 }], ['u1', { chunkData: h1 }]]);
    const table = S.buildUnitWindowTable(
      shotLevelQueries, matchById, chunks, S.buildSiblingPool([]),
      { u0: ['cx', 'cy', 'cw'], u1: ['cx', 'cy', 'cw', 'cz'] },
    );
    // u0 跨三个候选镜头取满 9 片 ⇒ scene_x / scene_y / scene_w 全部被消费
    expect(pick(table, ['p0_9'])[0].endMs).toBe(3500);
    // u1 候选前 3 个的父镜头已被 u0 吃光 ⇒ 必须继续往后取到 scene_z，而非空手退化慢放
    const w = pick(table, ['p1_1', 'p1_2']);
    expectContiguous(w);
    expect(w[0].startMs).toBe(2000);
    expect(w[1].endMs).toBe(3000);
    expect((w[0] as any).srcParent).toBe('scene_z');
  });

  it('🎬 同母句同父窗不相接 ⇒ 重切为连续窗（legacy 一碎片一 query；实测 seg_2 跳 12492ms+3062ms）', () => {
    /** legacy 档：碎片 query 无 matchUnitId ⇒ 主循环按碎片 id 各自成单碎片单位（切窗机制空转） */
    const shotLevelQueries = [
      { shotId: 'seg_2_sub_1', audioDurationMs: 1843 },
      { shotId: 'seg_2_sub_2', audioDurationMs: 789 },
      { shotId: 'seg_2_sub_3', audioDurationMs: 1683 },
    ];
    const c = (id: string, s: number, e: number) => ({
      id, parentChunkId: 'scene_272', filePath: 'a.mp4', startMs: s, endMs: e,
    });
    const matchById = new Map<string, any>([
      ['seg_2_sub_1', { chunkData: c('scene_272_seg0', 1750912, 1752755) }],
      ['seg_2_sub_2', { chunkData: c('scene_272_seg5', 1765247, 1766036) }],
      ['seg_2_sub_3', { chunkData: c('scene_272_seg7', 1769098, 1770781) }],
    ]);
    const pool = S.buildSiblingPool([
      c('scene_272_seg0', 1750712, 1753579),
      c('scene_272_seg1', 1753579, 1756446),
      c('scene_272_seg2', 1756446, 1759313),
    ]);
    const table = S.buildUnitWindowTable(shotLevelQueries, matchById, new Map(), pool);
    const wins = pick(table, ['seg_2_sub_1', 'seg_2_sub_2', 'seg_2_sub_3']);
    expectContiguous(wins);
    expect(wins[0].startMs).toBe(1750912);                        // 锚 = 首片命中窗起点（不被推到下一片片头）
    expect(wins[1].endMs).toBe(1753544);
    expect(wins[2].endMs).toBe(1755227);                          // 每片取自身时长 ⇒ 变速恒 1.0
    expect((wins[2] as any).srcChunkId).toBe('scene_272_seg1');   // 窗横跨两片 ⇒ 身份取重叠更多的片
  });

  it('🎬 同母句同父但窗已首尾相接 ⇒ 零变化（实测 seg_21/seg_24 已走对，不许动）', () => {
    const shotLevelQueries = [
      { shotId: 'seg_21_sub_1', audioDurationMs: 1522 },
      { shotId: 'seg_21_sub_2', audioDurationMs: 2566 },
    ];
    const c = (id: string, s: number, e: number) => ({
      id, parentChunkId: 'scene_075', filePath: 'a.mp4', startMs: s, endMs: e,
    });
    const matchById = new Map<string, any>([
      ['seg_21_sub_1', { chunkData: c('scene_075_seg0', 475718, 477240) }],
      ['seg_21_sub_2', { chunkData: c('scene_075_seg1', 477240, 478975) }],
    ]);
    const table = S.buildUnitWindowTable(shotLevelQueries, matchById, new Map(), S.buildSiblingPool([]));
    expect(table.size).toBe(0);
  });

  it('🎬 同母句碎片命中不同父场景 ⇒ 零变化（实测 seg_0 机舱/更衣室/柜门，口径未采纳跨父收敛）', () => {
    const shotLevelQueries = [
      { shotId: 'seg_0_sub_1', audioDurationMs: 914 },
      { shotId: 'seg_0_sub_2', audioDurationMs: 2250 },
      { shotId: 'seg_0_sub_3', audioDurationMs: 1917 },
    ];
    const c = (id: string, p: string, s: number, e: number) => ({
      id, parentChunkId: p, filePath: 'a.mp4', startMs: s, endMs: e,
    });
    const matchById = new Map<string, any>([
      ['seg_0_sub_1', { chunkData: c('scene_122_seg0', 'scene_122', 825588, 826502) }],
      ['seg_0_sub_2', { chunkData: c('scene_001_seg0', 'scene_001', 65229, 66296) }],
      ['seg_0_sub_3', { chunkData: c('scene_004_seg0', 'scene_004', 76757, 78674) }],
    ]);
    const table = S.buildUnitWindowTable(shotLevelQueries, matchById, new Map(), S.buildSiblingPool([]));
    expect(table.size).toBe(0);
  });

  it('🎬 锚点落不到同父兄弟片（supply 块重贴标签脏数据）⇒ 零变化（实测 seg_7 形态）', () => {
    const shotLevelQueries = [
      { shotId: 'seg_7_sub_1', audioDurationMs: 848 },
      { shotId: 'seg_7_sub_2', audioDurationMs: 3250 },
    ];
    const c = (id: string, s: number, e: number) => ({
      id, parentChunkId: 'scene_494', filePath: 'a.mp4', startMs: s, endMs: e,
    });
    const matchById = new Map<string, any>([
      ['seg_7_sub_1', { chunkData: c('scene_494_seg0', 2049974, 2052822) }],   // 窗不在任何 scene_494 片内
      ['seg_7_sub_2', { chunkData: c('scene_494_seg0', 3416376, 3418061) }],
    ]);
    const pool = S.buildSiblingPool([c('scene_494_seg0', 3416376, 3418061)]);
    const table = S.buildUnitWindowTable(shotLevelQueries, matchById, new Map(), pool);
    expect(table.size).toBe(0);
  });
});