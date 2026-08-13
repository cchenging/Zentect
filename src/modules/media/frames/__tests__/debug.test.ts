import { describe, it, expect } from 'vitest';
import { buildExtractCommand } from '../backend/Strategy';

const baseConfig = {
  videoPath: 'C:/videos/test.mp4',
  outputPath: 'C:/frames/frame_%08d.jpg',
  // P0 · VLM_OPTIMIZED → 归一化为 AUTO_ADAPTIVE（Strategy.ExtractConfig.strategy 接受 string）
  strategy: 'VLM_OPTIMIZED',
  fps: 2,
  sceneThreshold: 0.28,
  minFrameInterval: 4,
  width: 1024,
  threads: 4,
};
describe('debug', () => {
  it('sceneThreshold 1.5', () => {
    expect(() => buildExtractCommand({ ...baseConfig, sceneThreshold: 1.5 })).toThrow();
  });
  it('minFrameInterval 0', () => {
    expect(() => buildExtractCommand({ ...baseConfig, minFrameInterval: 0 })).toThrow();
  });
  it('width -1（保持原始不放大，决策点②）不抛错且不加缩放滤镜', () => {
    expect(() => buildExtractCommand({ ...baseConfig, width: -1 })).not.toThrow();
    const args = buildExtractCommand({ ...baseConfig, width: -1 });
    const vfArg = args.find(a => a === '-vf') ? args[args.indexOf('-vf') + 1] : '';
    expect(vfArg).not.toContain('scale=');
  });
  it('width 0', () => {
    const args = buildExtractCommand({ ...baseConfig, width: 0 });
    console.log('ARGS:', JSON.stringify(args));
  });
});
