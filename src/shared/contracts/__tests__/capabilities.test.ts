import { describe, it, expect } from 'vitest';
import type {
  IFrameExtractor,
  ITTSProvider,
  IASREngine,
  IVisionAnalyzer,
} from '../capabilities';

describe('IFrameExtractor interface contract', () => {
  it('defines required method signatures', () => {
    const mock: IFrameExtractor = {
      extractFrames: async () => ({ framePaths: ['f1.jpg'], fps: 1, totalFrames: 1, duration: 10 }),
      getProgress: () => 50,
      abort: () => {},
    };
    expect(typeof mock.extractFrames).toBe('function');
    expect(typeof mock.getProgress).toBe('function');
    expect(typeof mock.abort).toBe('function');
  });

  it('extractFrames returns correct result shape', async () => {
    const mock: IFrameExtractor = {
      extractFrames: async () => ({ framePaths: ['a.jpg', 'b.jpg'], fps: 2, totalFrames: 2, duration: 5 }),
      getProgress: () => 100,
      abort: () => {},
    };
    const r = await mock.extractFrames({ mediaPath: '/v.mp4', outputDir: '/out' });
    expect(r.framePaths).toHaveLength(2);
    expect(r.totalFrames).toBe(2);
    expect(r.duration).toBe(5);
  });

  it('extractFrames accepts optional params', async () => {
    const mock: IFrameExtractor = {
      extractFrames: async (p) => ({ framePaths: [], fps: p.fps ?? 1, totalFrames: 0, duration: 0 }),
      getProgress: () => 0,
      abort: () => {},
    };
    const r = await mock.extractFrames({ mediaPath: '/v.mp4', outputDir: '/out', fps: 5, startTime: 10, endTime: 20 });
    expect(r.fps).toBe(5);
  });
});

describe('ITTSProvider interface contract', () => {
  it('defines required methods', () => {
    const mock: ITTSProvider = {
      generateTTS: async () => ({ audioPath: '/a.wav', duration: 3, format: 'wav' }),
      getVoices: async () => [{ id: 'v1', name: 'Voice 1', language: 'zh' }],
      abort: () => {},
    };
    const r = mock.getVoices();
    expect(typeof r).toBe('object');
  });

  it('voice has description field', async () => {
    const mock: ITTSProvider = {
      generateTTS: async () => ({ audioPath: '/a.wav', duration: 1, format: 'mp3' }),
      getVoices: async () => [{ id: 'v2', name: 'V2', language: 'en', description: 'English' }],
      abort: () => {},
    };
    const voices = await mock.getVoices();
    expect(voices[0].description).toBe('English');
  });
});

describe('IASREngine interface contract', () => {
  it('defines required methods', () => {
    const mock: IASREngine = {
      transcribe: async () => ({
        segments: [{ text: 'hello', start: 0, end: 1, confidence: 0.95 }],
        fullText: 'hello', language: 'en',
      }),
      abort: () => {},
    };
    expect(typeof mock.transcribe).toBe('function');
  });

  it('transcribe returns segments', async () => {
    const mock: IASREngine = {
      transcribe: async () => ({
        segments: [
          { text: '你好', start: 0, end: 2, confidence: 0.98 },
          { text: '世界', start: 2, end: 4, confidence: 0.96 },
        ],
        fullText: '你好世界', language: 'zh',
      }),
      abort: () => {},
    };
    const r = await mock.transcribe({ audioPath: '/a.wav' });
    expect(r.segments).toHaveLength(2);
    expect(r.fullText).toBe('你好世界');
  });
});

describe('IVisionAnalyzer interface contract', () => {
  it('defines analyze and analyzeBatch', () => {
    const mock: IVisionAnalyzer = {
      analyze: async () => ({
        framePath: '/f1.jpg', labels: ['person'], objects: [], description: 'a person',
      }),
      analyzeBatch: async () => [],
    };
    expect(typeof mock.analyze).toBe('function');
    expect(typeof mock.analyzeBatch).toBe('function');
  });

  it('analyze returns vision result shape', async () => {
    const mock: IVisionAnalyzer = {
      analyze: async () => ({
        framePath: '/f.jpg', labels: ['car', 'road'],
        objects: [{ label: 'car', confidence: 0.9, bbox: [0, 0, 100, 50] }],
        description: 'a car on the road',
      }),
      analyzeBatch: async () => [],
    };
    const r = await mock.analyze('/f.jpg');
    expect(r.labels).toContain('car');
    expect(r.objects[0].confidence).toBe(0.9);
  });
});
