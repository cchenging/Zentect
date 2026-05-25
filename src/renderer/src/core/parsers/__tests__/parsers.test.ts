import { describe, it, expect } from 'vitest';

const { VisionExtractParser } = await import('../VisionExtractParser');
const { AudioSeparateParser } = await import('../AudioSeparateParser');
const { ASRParser } = await import('../ASRParser');
const { ScriptGenParser } = await import('../ScriptGenParser');

describe('VisionExtractParser', () => {
  const parser = new VisionExtractParser();

  it('should parse with mediaPath', () => {
    const node = { id: 'n1', data: { params: { fps: 2, threshold: 0.5, strategy: 'uniform' } } };
    const ctx = { mediaPath: '/video.mp4', mediaWidth: 1920, mediaHeight: 1080, dependsOn: ['src'] };
    const result = parser.parse(node as any, ctx);
    expect(result).not.toBeNull();
    expect(result!.actionType).toBe('vision-extract');
    expect(result!.params.fps).toBe(2);
    expect(result!.params.strategy).toBe('uniform');
    expect(result!.mergedInputs.mediaPath).toBe('/video.mp4');
    expect(result!.dependsOn).toEqual(['src']);
  });

  it('should use defaults when params missing', () => {
    const node = { id: 'n1', data: {} };
    const ctx = { mediaPath: '/video.mp4', dependsOn: [] };
    const result = parser.parse(node as any, ctx);
    expect(result!.params.fps).toBe(1);
    expect(result!.params.strategy).toBe('scene');
    expect(result!.params.threshold).toBe(0);
  });

  it('should return null when mediaPath missing', () => {
    const node = { id: 'n1', data: {} };
    const result = parser.parse(node as any, { dependsOn: [] });
    expect(result).toBeNull();
  });
});

describe('AudioSeparateParser', () => {
  const parser = new AudioSeparateParser();

  it('should parse with mediaPath', () => {
    const node = { id: 'n1', data: { params: { model: 'htdemucs' } } };
    const ctx = { mediaPath: '/audio.mp4', dependsOn: ['src'] };
    const result = parser.parse(node as any, ctx);
    expect(result).not.toBeNull();
    expect(result!.actionType).toBe('audio-separate');
    expect(result!.params.model).toBe('htdemucs');
    expect(result!.mergedInputs.mediaPath).toBe('/audio.mp4');
  });

  it('should return null when mediaPath missing', () => {
    const node = { id: 'n1', data: {} };
    const result = parser.parse(node as any, { dependsOn: [] });
    expect(result).toBeNull();
  });
});

describe('ASRParser', () => {
  const parser = new ASRParser();

  it('should prefer vocalPath over mediaPath', () => {
    const node = { id: 'n1', data: { params: { engine: 'whisper', language: 'en' } } };
    const ctx = { vocalPath: '/vocals.wav', mediaPath: '/audio.mp4', dependsOn: ['sep'] };
    const result = parser.parse(node as any, ctx);
    expect(result!.mergedInputs.audioPath).toBe('/vocals.wav');
  });

  it('should fallback to mediaPath', () => {
    const node = { id: 'n1', data: {} };
    const ctx = { mediaPath: '/audio.mp4', dependsOn: [] };
    const result = parser.parse(node as any, ctx);
    expect(result!.mergedInputs.audioPath).toBe('/audio.mp4');
  });

  it('should return null when no audio source', () => {
    const node = { id: 'n1', data: {} };
    const result = parser.parse(node as any, { dependsOn: [] });
    expect(result).toBeNull();
  });
});

describe('ScriptGenParser', () => {
  const parser = new ScriptGenParser();

  it('should parse with params', () => {
    const node = { id: 'n1', data: { params: { llmEngine: 'gpt-4', temperature: 0.9 } } };
    const ctx = { mediaPath: '/video.mp4', framesDir: '/frames', textData: '转录文本', dependsOn: ['vis', 'asr'] };
    const result = parser.parse(node as any, ctx);
    expect(result).not.toBeNull();
    expect(result!.actionType).toBe('script-gen');
    expect(result!.dependsOn).toEqual(['vis', 'asr']);
  });

  it('should work with minimal context', () => {
    const node = { id: 'n1', data: {} };
    const result = parser.parse(node as any, { dependsOn: [], mediaPath: '/video.mp4' });
    expect(result).not.toBeNull();
    expect(result!.params.llmEngine).toBe('openai');
  });
});
