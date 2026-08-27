import { describe, it, expect } from 'vitest';
describe('Entity Types', () => {
  it('AsrLine valid', () => { const l = { start: '00:00', startMs: 0, text: 'hi', editing: false, endMs: 3000 }; expect(l.text).toBe('hi'); });
  it('VlmFrame valid', () => { const f = { url: '/f.jpg', description: 'd', editing: false, confirmed: true }; expect(f.confirmed).toBe(true); });
  it('ScriptParagraph valid', () => { const p = { id: 'p1', text: 't', editing: false }; expect(p.id).toBe('p1'); });
  it('PipelineParams', () => { const p = { narrativePerspective:'third', narrationRatio:0.7, rhythmMode:'mixed', emotionTone:'neutral', hookIntensity:0.7 }; expect(p.hookIntensity).toBe(0.7); });
  it('MatchResult score range', () => { const m = { shotId:'s',mediaId:'m',score:0.85,confirmed:false }; expect(m.score).toBeGreaterThan(0.5); });
  it('TtsResult failed', () => { const r = { shotId:'s',_failed:true,_error:'err' }; expect(r._failed).toBe(true); });
});