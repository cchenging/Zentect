import { describe, it, expect } from 'vitest';
import { mapPipelineResultToState } from '../usePipelineResultMapper';

/** 🚫 参考帧锚点退役回归（2026-10-31）：MATCH 分支不再搬运 refFrame 三字段。
 *  即使上游（老工程 / 老 daemon 请求体）仍带着这三个键，也要在此被丢弃，
 *  防止「锚点无真实依据却重新流回交付台账」。 */
function collectMatchResults(nodeResult: Record<string, any>): any[] {
  let captured: any[] = [];
  const noop = () => {};
  mapPipelineResultToState(
    { 'match-1': nodeResult },
    {
      setAudioSeparated: noop,
      setAsrLines: noop,
      setFrameCount: noop,
      setExtractedData: noop,
      setVlmFrames: noop,
      setScriptParagraphs: noop,
      setTtsResults: noop,
      setTtsProgress: noop,
      setMatchResults: (r: any[]) => { captured = r; },
      setVideoChunks: noop,
      setBeatTimestamps: noop,
    } as any,
  );
  return captured;
}

const chunkData = { id: 'chunk_1', startMs: 1000, endMs: 4000 };

describe('usePipelineResultMapper · MATCH 参考帧已退役', () => {
  it('matches 分支：refFrame 三字段不再透出', () => {
    const out = collectMatchResults({
      matches: [{
        id: 'seg_46', text: '婚姻却输给了这支口红', chunkData,
        refFrameTimeMs: 1234567.6, refFrameDesc: '【特写】手指握持口红', refFrameSource: 'matched',
      }],
    });
    expect(out).toHaveLength(1);
    const json = JSON.parse(JSON.stringify(out[0]));
    expect('refFrameTimeMs' in json).toBe(false);
    expect('refFrameDesc' in json).toBe(false);
    expect('refFrameSource' in json).toBe(false);
  });

  it('segments 分支：同口径不再透出', () => {
    const out = collectMatchResults({
      segments: [{
        shotId: 'seg_7', narration: '台词', chunkData,
        refFrameTimeMs: 888000, refFrameDesc: '【中景】餐厅门口', refFrameSource: 'block_first',
      }],
    });
    expect(out).toHaveLength(1);
    const json = JSON.parse(JSON.stringify(out[0]));
    expect('refFrameTimeMs' in json).toBe(false);
    expect('refFrameDesc' in json).toBe(false);
    expect('refFrameSource' in json).toBe(false);
  });
});
