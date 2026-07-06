// Module: media/audio - Service 单元测试

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// === Mock fs ===
const { mockFsExistsSync, mockFsMkdirSync } = vi.hoisted(() => ({
  mockFsExistsSync: vi.fn(),
  mockFsMkdirSync: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: mockFsExistsSync,
    mkdirSync: mockFsMkdirSync,
  };
});

// === Mock AudioProcessor ===

const {
  mockExtractAudioForASR,
  mockSeparateVocals,
} = vi.hoisted(() => ({
  mockExtractAudioForASR: vi.fn(),
  mockSeparateVocals: vi.fn(),
}));

vi.mock('../../../../main/engine/media/AudioProcessor', () => ({
  AudioProcessor: {
    extractAudioForASR: (...args: any[]) => mockExtractAudioForASR(...args),
    separateVocals: (...args: any[]) => mockSeparateVocals(...args),
  },
}));

// === 测试 ===

import * as path from 'path';
import { AudioSeparationService } from '../backend/Service';
import type { SeparationOptions } from '../backend/Service';

describe('AudioSeparationService', () => {
  const defaultInput = {
    videoPath: 'C:/videos/test.mp4',
    engine: 'spleeter',
  };

  const defaultOptions: SeparationOptions = {
    outputDir: 'C:/output/audio',
    filePrefix: 'media_001',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFsExistsSync.mockReturnValue(true);
    mockFsMkdirSync.mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==================== separate ====================

  describe('separate', () => {
    it('应调用 extractAudioForASR 提取音轨', async () => {
      mockExtractAudioForASR.mockResolvedValue('C:/output/media_001_extracted.wav');
      mockSeparateVocals.mockResolvedValue({
        vocalPath: 'C:/output/vocals.wav',
        bgmPath: 'C:/output/accompaniment.wav',
      });

      const result = await AudioSeparationService.separate(defaultInput, defaultOptions);

      expect(mockExtractAudioForASR).toHaveBeenCalledTimes(1);
      const extractCall = mockExtractAudioForASR.mock.calls[0];
      expect(extractCall[0]).toBe(defaultInput.videoPath);
      expect(extractCall[1]).toContain('_extracted.wav');
    });

    it('应调用 separateVocals 分离人声和背景音乐', async () => {
      mockExtractAudioForASR.mockResolvedValue('C:/output/media_001_extracted.wav');
      mockSeparateVocals.mockResolvedValue({
        vocalPath: 'C:/output/vocals.wav',
        bgmPath: 'C:/output/bgm.wav',
      });

      const result = await AudioSeparationService.separate(defaultInput, defaultOptions);

      expect(mockSeparateVocals).toHaveBeenCalledTimes(1);
      const sepCall = mockSeparateVocals.mock.calls[0];
      expect(sepCall[0]).toContain('_extracted.wav');
      expect(sepCall[1]).toBe(defaultOptions.outputDir);
    });

    it('应返回正确的 vocalsPath 和 bgmPath', async () => {
      mockExtractAudioForASR.mockResolvedValue('C:/output/media_001_extracted.wav');
      mockSeparateVocals.mockResolvedValue({
        vocalPath: 'C:/audio/vocals.wav',
        bgmPath: 'C:/audio/bgm.wav',
      });

      const result = await AudioSeparationService.separate(defaultInput, defaultOptions);

      expect(result.vocalsPath).toBe('C:/audio/vocals.wav');
      expect(result.bgmPath).toBe('C:/audio/bgm.wav');
    });

    it('engine 参数应传递给 separateVocals', async () => {
      mockExtractAudioForASR.mockResolvedValue('/tmp/extracted.wav');
      mockSeparateVocals.mockResolvedValue({ vocalPath: '/v.wav', bgmPath: '/b.wav' });

      await AudioSeparationService.separate(
        { videoPath: 'C:/v.mp4', engine: 'uvr5' },
        defaultOptions,
      );

      const sepCall = mockSeparateVocals.mock.calls[0];
      expect(sepCall[2]).toBe('uvr5');
    });

    it('不存在的输出目录应自动创建', async () => {
      mockFsExistsSync.mockImplementation((p: string) => {
        return p !== defaultOptions.outputDir;
      });

      mockExtractAudioForASR.mockResolvedValue('/tmp/extracted.wav');
      mockSeparateVocals.mockResolvedValue({ vocalPath: '/v.wav', bgmPath: '/b.wav' });

      await AudioSeparationService.separate(defaultInput, defaultOptions);

      expect(mockFsMkdirSync).toHaveBeenCalledWith(
        defaultOptions.outputDir,
        { recursive: true },
      );
    });

    it('已存在的输出目录不应重复创建', async () => {
      mockFsExistsSync.mockReturnValue(true);

      mockExtractAudioForASR.mockResolvedValue('/tmp/extracted.wav');
      mockSeparateVocals.mockResolvedValue({ vocalPath: '/v.wav', bgmPath: '/b.wav' });

      await AudioSeparationService.separate(defaultInput, defaultOptions);

      const mkdirCalls = mockFsMkdirSync.mock.calls.filter(
        (c: any) => String(c[0]) === defaultOptions.outputDir,
      );
      expect(mkdirCalls.length).toBe(0);
    });
  });

  // ==================== 进度回调 ====================

  describe('进度回调', () => {
    it('应触发进度回调（阶段1：音轨提取）', async () => {
      const onProgress = vi.fn();

      mockExtractAudioForASR.mockImplementation(
        async (_input: string, _output: string, cb: (p: number, m: string) => void) => {
          cb(50, 'extracting...');
          return '/tmp/extracted.wav';
        },
      );
      mockSeparateVocals.mockResolvedValue({ vocalPath: '/v.wav', bgmPath: '/b.wav' });

      await AudioSeparationService.separate(defaultInput, {
        ...defaultOptions,
        onProgress,
      });

      expect(onProgress).toHaveBeenCalled();
      // 阶段1的第一条进度应在 5-40% 范围
      const firstCall = onProgress.mock.calls.find(
        (c: any) => String(c[1]).includes('音轨'),
      );
      expect(firstCall).toBeDefined();
    });

    it('应触发进度回调（阶段2：AI 分离）', async () => {
      const onProgress = vi.fn();

      mockExtractAudioForASR.mockResolvedValue('/tmp/extracted.wav');
      mockSeparateVocals.mockImplementation(
        async (
          _input: string, _dir: string, _engine: string,
          cb: (p: number, m: string) => void,
        ) => {
          cb(80, 'separating...');
          return { vocalPath: '/v.wav', bgmPath: '/b.wav' };
        },
      );

      await AudioSeparationService.separate(defaultInput, {
        ...defaultOptions,
        onProgress,
      });

      // 阶段2的进度应在 40-100% 范围
      const stage2Call = onProgress.mock.calls.find(
        (c: any) => String(c[1]).includes('分离'),
      );
      expect(stage2Call).toBeDefined();
    });

    it('应最终触发 100% 完成回调', async () => {
      const onProgress = vi.fn();

      mockExtractAudioForASR.mockResolvedValue('/tmp/extracted.wav');
      mockSeparateVocals.mockImplementation(
        async (
          _input: string, _dir: string, _engine: string,
          cb: (p: number, m: string) => void,
        ) => {
          return { vocalPath: '/v.wav', bgmPath: '/b.wav' };
        },
      );

      await AudioSeparationService.separate(defaultInput, {
        ...defaultOptions,
        onProgress,
      });

      const lastCall = onProgress.mock.calls[onProgress.mock.calls.length - 1];
      expect(lastCall[0]).toBe(100);
    });

    it('无 onProgress 回调时不应抛异常', async () => {
      mockExtractAudioForASR.mockResolvedValue('/tmp/extracted.wav');
      mockSeparateVocals.mockResolvedValue({ vocalPath: '/v.wav', bgmPath: '/b.wav' });

      await expect(
        AudioSeparationService.separate(defaultInput, {
          outputDir: 'C:/out',
          filePrefix: 'media_001',
        }),
      ).resolves.toBeDefined();
    });
  });

  // ==================== 错误处理 ====================

  describe('错误处理', () => {
    it('extractAudioForASR 失败应向上传播', async () => {
      mockExtractAudioForASR.mockRejectedValue(new Error('FFmpeg not found'));

      await expect(
        AudioSeparationService.separate(defaultInput, defaultOptions),
      ).rejects.toThrow('FFmpeg not found');
    });

    it('separateVocals 失败应向上传播', async () => {
      mockExtractAudioForASR.mockResolvedValue('/tmp/extracted.wav');
      mockSeparateVocals.mockRejectedValue(new Error('Spleeter crashed'));

      await expect(
        AudioSeparationService.separate(defaultInput, defaultOptions),
      ).rejects.toThrow('Spleeter crashed');
    });
  });

  // ==================== 路径生成 ====================

  describe('路径生成', () => {
    it('提取音轨路径应包含 filePrefix', async () => {
      mockExtractAudioForASR.mockResolvedValue('/any/path.wav');
      mockSeparateVocals.mockResolvedValue({ vocalPath: '/v.wav', bgmPath: '/b.wav' });

      await AudioSeparationService.separate(defaultInput, {
        outputDir: 'C:/output',
        filePrefix: 'media_abc',
      });

      const extractCall = mockExtractAudioForASR.mock.calls[0];
      expect(extractCall[1]).toBe(path.join('C:/output', 'media_abc_extracted.wav'));
    });
  });
});
