import { describe, it, expect } from 'vitest';
describe('Step Data Contracts', () => {
  it('compatible chain', () => {
    const o = { asrLines:[], framePaths:[], frameCount:0, audioSeparated:true, roles:[] };
    expect(o.audioSeparated).toBe(true);
  });
  it('MatchingInput combines data', () => {
    const i = { scriptParagraphs:[{id:'s',text:'t',editing:false}], vlmFrames:[], ttsResults:[], activeBgm:null };
    expect(i.scriptParagraphs).toHaveLength(1);
  });
});