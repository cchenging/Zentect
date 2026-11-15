import { describe, expect, it } from 'vitest';
import type { NarrationParagraph, VlmFrame } from '../../../../shared/types/entities/editor';
import { matchParagraphsToFrames } from '../frontend/bidirectionalMatcher';

function para(id: string, startMs: number, durationMs: number, text: string, emotion?: string): NarrationParagraph {
  return { id, type: 'narration', startMs, durationMs, text, emotion };
}

function frame(timeMs: number, description: string, extra: Partial<VlmFrame> = {}): VlmFrame {
  return { url: `/frames/${timeMs}.jpg`, description, editing: false, confirmed: true, timeMs, ...extra };
}

describe('matchParagraphsToFrames', () => {
  it('时间窗内的帧优先，超出容忍距离的帧不进候选', () => {
    const p = para('p1', 0, 5000, '雪山上风很大');
    const r = matchParagraphsToFrames([p], [
      frame(1000, '雪山远景'),
      frame(3000, '人物前行'),
      frame(20000, '完全无关的城市场景'),
    ]);

    const list = r.matches[0].candidates;
    expect(list.map((c) => c.frame.timeMs)).toEqual([1000, 3000]);
    expect(list[0].timeScore).toBeGreaterThanOrEqual(0.5);
    expect(r.matches[0].assignedIndex).not.toBeNull();
  });

  it('双向互斥：同一帧不会被两段同时锁定', () => {
    const a = para('a', 0, 4000, '雪山');
    const b = para('b', 0, 4000, '雪山');
    const r = matchParagraphsToFrames([a, b], [frame(2000, '雪山全景')]);

    const owners = r.matches.map((m) => m.assignedIndex);
    expect(owners[0]).toBe(0);
    expect(owners[1]).toBeNull();
    // 未锁定的那一段候选里该帧标记为非 assigned
    expect(r.matches[1].candidates[0].assigned).toBe(false);
  });

  it('关键词命中提升语义分并记录命中词', () => {
    const p = para('p1', 0, 4000, '镜头掠过雪山与冰川');
    const hit = frame(1000, '雪山近景', { downstream: { action: '', emotion: '', keywords: ['雪山', '冰川'] } });
    const miss = frame(2000, '城市夜景', { downstream: { action: '', emotion: '', keywords: ['城市'] } });
    const r = matchParagraphsToFrames([p], [hit, miss], { maxPerParagraph: 2 });

    const first = r.matches[0].candidates[0];
    expect(first.frame.timeMs).toBe(1000);
    expect(first.keywordHits).toEqual(['雪山', '冰川']);
    expect(first.textScore).toBeGreaterThan(0.5);
    expect(r.matches[0].candidates[1].textScore).toBe(0);
  });

  it('情绪一致时加权', () => {
    const p = para('p1', 0, 3000, '他沉默了', '紧张');
    const same = frame(1000, '人物特写', { emotion: '紧张' });
    const other = frame(2000, '人物特写', { emotion: '平静' });
    const r = matchParagraphsToFrames([p], [same, other]);

    expect(r.matches[0].candidates[0].frame.timeMs).toBe(1000);
    expect(r.matches[0].candidates[0].textScore).toBeGreaterThan(r.matches[0].candidates[1].textScore);
  });

  it('缺少 timeMs 的帧不参与匹配', () => {
    const p = para('p1', 0, 3000, '文案');
    const r = matchParagraphsToFrames([p], [
      { url: '/x.jpg', description: '无时间', editing: false, confirmed: true },
      frame(1500, '有时间'),
    ]);

    expect(r.matches[0].candidates).toHaveLength(1);
    expect(r.matches[0].candidates[0].frame.timeMs).toBe(1500);
  });

  it('空输入返回空结果且不抛错', () => {
    expect(matchParagraphsToFrames([], []).matches).toEqual([]);
    expect(matchParagraphsToFrames([para('p', 0, 1000, 'x')], []).matches).toEqual([]);
  });
});
