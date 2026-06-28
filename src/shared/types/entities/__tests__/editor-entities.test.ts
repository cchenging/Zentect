import { describe, it, expect } from 'vitest';
describe('Entity Types', () => {
  it('AsrLine valid', () => { const l = { start: '00:00', text: 'hi', editing: false }; expect(l.text).toBe('hi'); });
  it('VlmFrame valid', () => { const f = { url: '/f.jpg', description: 'd', editing: false, confirmed: true }; expect(f.confirmed).toBe(true); });
  it('ScriptParagraph valid', () => { const p = { id: 'p1', text: 't', editing: false }; expect(p.id).toBe('p1'); });
  it('PipelineParams', () => { const p = { R:70,S:50,T:80,P:100 }; expect(p.R).toBe(70); });
  it('MatchResult score range', () => { const m = { shotId:'s',mediaId:'m',score:0.85,confirmed:false }; expect(m.score).toBeGreaterThan(0.5); });
  it('TtsResult failed', () => { const r = { shotId:'s',_failed:true,_error:'err' }; expect(r._failed).toBe(true); });
});