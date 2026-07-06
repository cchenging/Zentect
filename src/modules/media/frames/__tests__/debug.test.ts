import { describe, it, expect } from 'vitest';
import { buildExtractCommand } from '../backend/Strategy';

const baseConfig = {
  videoPath: 'C:/videos/test.mp4',
  outputPath: 'C:/frames/frame_%08d.jpg',
  strategy: 'VLM_OPTIMIZED' as const,
  fps: 2,
  sceneThreshold: 0.28,
  minFrameInterval: 4,
  width: 1024,
  quality: 3,
  threads: 4,
};
describe('debug', () => {
  it('sceneThreshold 1.5', () => {
    expect(() => buildExtractCommand({ ...baseConfig, sceneThreshold: 1.5 })).toThrow();
  });
  it('minFrameInterval 0', () => {
    expect(() => buildExtractCommand({ ...baseConfig, minFrameInterval: 0 })).toThrow();
  });
  it('width -1', () => {
    expect(() => buildExtractCommand({ ...baseConfig, width: -1 })).toThrow();
  });
  it('width 0', () => {
    const args = buildExtractCommand({ ...baseConfig, width: 0 });
    console.log('ARGS:', JSON.stringify(args));
  });
});
