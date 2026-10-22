import { describe, it, expect } from 'vitest';
import { StoryboardAgent, SegmentSummary } from '../StoryboardAgent';

const chunk = (o: Record<string, any>) => ({
  id: o.id, startMs: o.startMs, endMs: o.endMs,
  scene: o.scene, characters: o.characters || [], primarySubject: o.primary || '',
  shotScale: o.shot || '', description: o.desc || '',
});

const seg = (id: number, startMs: number, endMs: number): SegmentSummary => ({
  segmentId: id, startMs, endMs, parentIds: [], parentCount: 0, chunkCount: 0,
  locClass: '', locPurity: 0, locRaw: [], topChars: [], shotDist: {}, repDesc: '',
});

describe('场记单上游数据守卫（2026-10-22）', () => {
  it('场记单越出素材时段（旧视频残留）⇒ 判不符', () => {
    const chunks = [chunk({ id: 'c1', startMs: 224000, endMs: 500000 }),
      chunk({ id: 'c2', startMs: 2600000, endMs: 2702000 })];
    const stale = [seg(1, 65229, 400000), seg(2, 400000, 900000), seg(3, 2792219, 2834428)];
    expect(StoryboardAgent.segmentsLookStale(stale, chunks)).toBe(true);
    // 3 段里 2 段落在素材内（0.67 < 0.8）且第 3 段起点晚于素材末尾
  });

  it('场记单与素材时段相符 ⇒ 放行', () => {
    const chunks = [chunk({ id: 'c1', startMs: 224000, endMs: 500000 })];
    const ok = [seg(1, 200000, 400000), seg(2, 400000, 600000)];
    expect(StoryboardAgent.segmentsLookStale(ok, chunks)).toBe(false);
  });

  it('无切片时不做判断（维持旧行为）', () => {
    expect(StoryboardAgent.segmentsLookStale([seg(1, 0, 1000)], [])).toBe(false);
  });

  it('按场景标签/间隔断段，topChars 取人物频次并剔除 EMPTY 哨兵', () => {
    const chunks = [
      chunk({ id: 'a', startMs: 1000, endMs: 4000, scene: '客厅', characters: ['林夏'], shot: '中景', desc: '林夏坐在沙发' }),
      chunk({ id: 'b', startMs: 4000, endMs: 9000, scene: '客厅', characters: ['林夏', '陈默'], shot: '近景', desc: '林夏与陈默对话，气氛紧张' }),
      chunk({ id: 'c', startMs: 20000, endMs: 30000, scene: '街头', primary: 'EMPTY', shot: '全景', desc: '雨夜街道' }),
    ];
    const segs = StoryboardAgent.buildSegmentsFromChunks(chunks);
    expect(segs).toHaveLength(2);
    expect(segs.map((s) => s.segmentId)).toEqual([1, 2]);
    expect(segs[0].parentIds).toEqual(['a', 'b']);
    expect(segs[0].topChars).toEqual(['林夏', '陈默']);
    expect(segs[0].shotDist).toEqual({ 中景: 1, 近景: 1 });
    expect(segs[1].topChars).toEqual([]);
    expect(segs[1].repDesc).toBe('雨夜街道');
  });

  it('短于 8s 的碎段不入场（避免制造无意义段号）', () => {
    const chunks = [
      chunk({ id: 'a', startMs: 1000, endMs: 9000, scene: '客厅' }),
      chunk({ id: 'b', startMs: 9000, endMs: 14000, scene: '走廊' }), // 仅 5s
    ];
    const segs = StoryboardAgent.buildSegmentsFromChunks(chunks);
    expect(segs).toHaveLength(1);
    expect(segs[0].parentIds).toEqual(['a']);
  });
});
