// Module: media/audio - Types 单元测试

import { describe, it, expect } from 'vitest';
import type { AudioSeparateInput, AudioSeparateOutput } from '../types';

describe('Media Audio Types', () => {
  describe('AudioSeparateInput', () => {
    it('应包含必填字段 videoPath 和 engine', () => {
      const input: AudioSeparateInput = {
        videoPath: 'C:/videos/test.mp4',
        engine: 'spleeter',
      };
      expect(input.videoPath).toBe('C:/videos/test.mp4');
      expect(input.engine).toBe('spleeter');
    });

    it('engine 应为 spleeter 或 uvr5', () => {
      const engines = ['spleeter', 'uvr5'];
      for (const engine of engines) {
        const input: AudioSeparateInput = { videoPath: '/v.mp4', engine };
        expect(input.engine).toBe(engine);
      }
    });
  });

  describe('AudioSeparateOutput', () => {
    it('应包含 vocalsPath 和 bgmPath', () => {
      const output: AudioSeparateOutput = {
        vocalsPath: 'C:/output/vocals.wav',
        bgmPath: 'C:/output/accompaniment.wav',
      };
      expect(output.vocalsPath).toBe('C:/output/vocals.wav');
      expect(output.bgmPath).toBe('C:/output/accompaniment.wav');
    });

    it('bgmPath 可为空字符串（降级方案）', () => {
      const output: AudioSeparateOutput = {
        vocalsPath: 'C:/output/audio.wav',
        bgmPath: '',
      };
      expect(output.bgmPath).toBe('');
    });
  });
});
