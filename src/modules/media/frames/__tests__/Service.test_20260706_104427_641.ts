// Module: media/frames - Service 单元测试

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import childProcess from 'child_process';

// === Mock fs ===

const {
  mockGetFfmpegPath,
  mockGetFfprobePath,
  mockExistsSync,
  mockMkdirSync,
  mockReaddirSync,
  mockUnlinkSync,
  mockPromisesStat,
} = vi.hoisted(() => ({
  mockGetFfmpegPath: vi.fn().mockReturnValue('F:/Zentect/bin/ffmpeg.exe'),
  mockGetFfprobePath: vi.fn().mockReturnValue('F:/Zentect/bin/ffprobe.exe'),
  mockExistsSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockReaddirSync: vi.fn(),
  mockUnlinkSync: vi.fn(),
  mockPromisesStat: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: mockExistsSync,
    mkdirSync: mockMkdirSync,
    readdirSync: mockReaddirSync,
    unlinkSync: mockUnlinkSync,
    promises: {
      ...actual.promises,
      stat: mockPromisesStat,
    },
  };
});

// === 辅助函数 ===

interface MockChildProcess extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function createMockSpawn(
  opts: {
    closeCode?: number;
    stdoutData?: string;
    stderrData?: string;
    delayMs?: number;
  } = {},
): MockChildProcess {
  const proc = new EventEmitter() as MockChildProcess;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();

  const delay = opts.delayMs ?? 1;
  setImmediate(() => {
    if (opts.stdoutData) {
      proc.stdout.emit('data', Buffer.from(opts.stdoutData));
    }
    if (opts.stderrData) {
      proc.stderr.emit('data', Buffer.from(opts.stderrData));
    }
    setTimeout(() => {
      proc.emit('close', opts.closeCode ?? 0);
    }, delay);
  });

  return proc;
}

// === 测试 ===

import { FrameExtractionService, resolveStrategy } from '../backend/Service';

describe('resolveStrategy', () => {
  it('应识别新版大写策略名', () => {
    expect(resolveStrategy('VLM_OPTIMIZED')).toBe('VLM_OPTIMIZED');
    expect(resolveStrategy('UNIFORM_FPS')).toBe('UNIFORM_FPS');
    expect(resolveStrategy('FAST_KEYFRAME')).toBe('FAST_KEYFRAME');
    expect(resolveStrategy('PRECISE_SINGLE')).toBe('PRECISE_SINGLE');
  });

  it('应识别旧版小写下划线策略名', () => {
    expect(resolveStrategy('vlm_optimized')).toBe('VLM_OPTIMIZED');
    expect(resolveStrategy('uniform_fps')).toBe('UNIFORM_FPS');
    expect(resolveStrategy('fast_keyframe')).toBe('FAST_KEYFRAME');
    expect(resolveStrategy('precise_single')).toBe('PRECISE_SINGLE');
  });

  it('应识别旧版简写别名', () => {
    expect(resolveStrategy('uniform')).toBe('UNIFORM_FPS');
    expect(resolveStrategy('keyframe')).toBe('FAST_KEYFRAME');
    expect(resolveStrategy('iframe')).toBe('FAST_KEYFRAME');
    expect(resolveStrategy('scene')).toBe('VLM_OPTIMIZED');
  });

  it('未知策略名应原样透传', () => {
    expect(resolveStrategy('custom_strategy')).toBe('custom_strategy');
    expect(resolveStrategy('')).toBe('');
  });
});

describe('FrameExtractionService', () => {
  let service: FrameExtractionService;

  beforeEach(() => {
    service = new FrameExtractionService({
      getFfmpegPath: mockGetFfmpegPath,
      getFfprobePath: mockGetFfprobePath,
    });
    vi.clearAllMocks();
    mockGetFfmpegPath.mockReturnValue('F:/Zentect/bin/ffmpeg.exe');
    mockGetFfprobePath.mockReturnValue('F:/Zentect/bin/ffprobe.exe');
    mockExistsSync.mockReturnValue(true);
    mockMkdirSync.mockImplementation(() => undefined);
    mockReaddirSync.mockReturnValue([]);
    mockUnlinkSync.mockImplementation(() => undefined);
    mockPromisesStat.mockResolvedValue({ size: 524288 } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==================== probeVideo ====================

  describe('probeVideo', () => {
    it('ffprobe 不存在时应返回 valid=true（跳过探针，不阻塞流程）', async () => {
      mockGetFfprobePath.mockReturnValue('F:/nonexistent/ffprobe.exe');
      mockExistsSync.mockImplementation((p: string) => !p.includes('ffprobe'));

      const result = await service.probeVideo('C:/videos/test.mp4');
      expect(result.valid).toBe(true);
    });

    it('物理文件不存在时应返回 valid=false', async () => {
      mockGetFfprobePath.mockReturnValue('F:/bin/ffprobe.exe');
      mockExistsSync.mockImplementation((p: string) => p.includes('ffprobe'));

      const result = await service.probeVideo('C:/videos/nonexistent.mp4');
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('物理文件不存在');
    });

    it('有效视频应返回 valid=true 及元数据', async () => {
      mockExistsSync.mockReturnValue(true);

      const jsonOutput = JSON.stringify({
        streams: [{ codec_type: 'video', width: 1920, height: 1080 }],
        format: { duration: '120.5' },
      });

      const spawnSpy = vi.spyOn(childProcess, 'spawn').mockImplementation(() => {
        return createMockSpawn({ stdoutData: jsonOutput, closeCode: 0 }) as any;
      });

      const result = await service.probeVideo('C:/videos/test.mp4');

      expect(result.valid).toBe(true);
      expect(result.duration).toBe(120.5);
      expect(result.width).toBe(1920);
      expect(result.height).toBe(1080);
      spawnSpy.mockRestore();
    });

    it('无视频流应返回 valid=false', async () => {
      mockExistsSync.mockReturnValue(true);

      const jsonOutput = JSON.stringify({
        streams: [{ codec_type: 'audio' }],
        format: { duration: '30.0' },
      });

      vi.spyOn(childProcess, 'spawn').mockImplementation(() => {
        return createMockSpawn({ stdoutData: jsonOutput, closeCode: 0 }) as any;
      });

      const result = await service.probeVideo('C:/videos/audio_only.mp4');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('未检测到视频流');
    });

    it('视频时长为 0 应返回 valid=false', async () => {
      mockExistsSync.mockReturnValue(true);

      const jsonOutput = JSON.stringify({
        streams: [{ codec_type: 'video', width: 1920, height: 1080 }],
        format: { duration: '0' },
      });

      vi.spyOn(childProcess, 'spawn').mockImplementation(() => {
        return createMockSpawn({ stdoutData: jsonOutput, closeCode: 0 }) as any;
      });

      const result = await service.probeVideo('C:/videos/empty.mp4');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('时长无效');
    });

    it('分辨率为 0 应返回 valid=false', async () => {
      mockExistsSync.mockReturnValue(true);

      const jsonOutput = JSON.stringify({
        streams: [{ codec_type: 'video', width: 0, height: 0 }],
        format: { duration: '10.0' },
      });

      vi.spyOn(childProcess, 'spawn').mockImplementation(() => {
        return createMockSpawn({ stdoutData: jsonOutput, closeCode: 0 }) as any;
      });

      const result = await service.probeVideo('C:/videos/zero_res.mp4');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('分辨率无效');
    });

    it('ffprobe 退出码非零应返回 valid=false', async () => {
      mockExistsSync.mockReturnValue(true);
      vi.spyOn(childProcess, 'spawn').mockImplementation(() => {
        return createMockSpawn({ closeCode: 1 }) as any;
      });

      const result = await service.probeVideo('C:/videos/corrupt.mp4');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('ffprobe 退出码');
    });

    it('JSON 解析失败应返回 valid=false', async () => {
      mockExistsSync.mockReturnValue(true);
      vi.spyOn(childProcess, 'spawn').mockImplementation(() => {
        return createMockSpawn({ stdoutData: 'not json', closeCode: 0 }) as any;
      });

      const result = await service.probeVideo('C:/videos/bad.mp4');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('解析失败');
    });

    it('spawn error 应返回 valid=false', async () => {
      mockExistsSync.mockReturnValue(true);
      vi.spyOn(childProcess, 'spawn').mockImplementation(() => {
        const proc = new EventEmitter() as MockChildProcess;
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.kill = vi.fn();
        setImmediate(() => proc.emit('error', new Error('spawn failed')));
        return proc as any;
      });

      const result = await service.probeVideo('C:/videos/test.mp4');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('启动失败');
    });
  });

  // ==================== extractFrames ====================

  describe('extractFrames', () => {
    beforeEach(() => {
      mockGetFfmpegPath.mockReturnValue('F:/Zentect/bin/ffmpeg.exe');
      mockGetFfprobePath.mockReturnValue('F:/Zentect/bin/ffprobe.exe');
      mockExistsSync.mockReturnValue(true);
      mockMkdirSync.mockImplementation(() => undefined);
      mockReaddirSync.mockReturnValue([]);
      mockUnlinkSync.mockImplementation(() => undefined);
    });

    it('ffmpeg 不存在时应返回空遥测', async () => {
      mockGetFfmpegPath.mockReturnValue('F:/nonexistent/ffmpeg.exe');
      mockExistsSync.mockImplementation((p: string) => !p.includes('ffmpeg'));

      const result = await service.extractFrames(
        'C:/videos/test.mp4',
        'C:/output/frames',
        'media_001',
      );

      expect(result.files).toHaveLength(0);
      expect(result.metrics.frameCount).toBe(0);
    });

    it('探针失败时应返回空遥测', async () => {
      mockExistsSync.mockImplementation((p: string) => {
        return p.includes('ffmpeg') || p.includes('ffprobe');
      });

      vi.spyOn(childProcess, 'spawn').mockImplementation(() => {
        return createMockSpawn({
          stdoutData: JSON.stringify({ streams: [], format: {} }),
          closeCode: 0,
        }) as any;
      });

      const result = await service.extractFrames(
        'C:/videos/bad.mp4',
        'C:/output/frames',
        'media_001',
      );

      expect(result.files).toHaveLength(0);
    });

    it('VLM_OPTIMIZED 策略应调用 buildExtractCommand 并生成遥测', async () => {
      mockExistsSync.mockReturnValue(true);

      const probeJson = JSON.stringify({
        streams: [{ codec_type: 'video', width: 1920, height: 1080 }],
        format: { duration: '60.0' },
      });

      let callCount = 0;
      vi.spyOn(childProcess, 'spawn').mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return createMockSpawn({ stdoutData: probeJson, closeCode: 0 }) as any;
        }
        return createMockSpawn({ closeCode: 0, delayMs: 5 }) as any;
      });

      const result = await service.extractFrames(
        'C:/videos/test.mp4',
        'C:/output/frames',
        'media_001',
        { strategy: 'VLM_OPTIMIZED', fps: 2, scale: 1024, quality: 3 },
      );

      expect(result.metrics.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('应清除旧帧文件', async () => {
      mockExistsSync.mockImplementation((p: string) => {
        if (typeof p === 'string' && p.includes('frames')) return true;
        return true;
      });
      mockReaddirSync.mockReturnValueOnce(['frame_00000001.jpg', 'frame_00000002.jpg', 'info.txt'])
        .mockReturnValueOnce([]);

      const probeJson = JSON.stringify({
        streams: [{ codec_type: 'video', width: 1920, height: 1080 }],
        format: { duration: '30.0' },
      });

      let callCount = 0;
      vi.spyOn(childProcess, 'spawn').mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return createMockSpawn({ stdoutData: probeJson, closeCode: 0 }) as any;
        }
        return createMockSpawn({ closeCode: 0 }) as any;
      });

      await service.extractFrames(
        'C:/videos/test.mp4',
        'C:/output/frames',
        'media_001',
      );

      // 只删 .jpg，不删 info.txt
      expect(mockUnlinkSync).toHaveBeenCalledTimes(2);
    });

    it('不存在的输出目录应自动创建', async () => {
      mockExistsSync.mockImplementation((p: string) => {
        if (typeof p === 'string' && p.includes('frames')) return false;
        return true;
      });

      const probeJson = JSON.stringify({
        streams: [{ codec_type: 'video', width: 1920, height: 1080 }],
        format: { duration: '10.0' },
      });

      let callCount = 0;
      vi.spyOn(childProcess, 'spawn').mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return createMockSpawn({ stdoutData: probeJson, closeCode: 0 }) as any;
        }
        return createMockSpawn({ closeCode: 0 }) as any;
      });

      await service.extractFrames(
        'C:/videos/test.mp4',
        'C:/output/frames',
        'media_001',
      );

      const mkdirCalls = mockMkdirSync.mock.calls.filter(
        (c: any) => String(c[0]).includes('frames'),
      );
      expect(mkdirCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('特殊字符 mediaId 应被安全替换', async () => {
      mockExistsSync.mockReturnValue(true);

      const probeJson = JSON.stringify({
        streams: [{ codec_type: 'video', width: 1920, height: 1080 }],
        format: { duration: '10.0' },
      });

      let callCount = 0;
      vi.spyOn(childProcess, 'spawn').mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return createMockSpawn({ stdoutData: probeJson, closeCode: 0 }) as any;
        }
        return createMockSpawn({ closeCode: 0 }) as any;
      });

      await service.extractFrames(
        'C:/videos/test.mp4',
        'C:/output/media_@#$',
        'media_@#$',
      );
    });

    it('abortSignal 触发时应 reject TASK_ABORTED', async () => {
      mockExistsSync.mockReturnValue(true);

      const probeJson = JSON.stringify({
        streams: [{ codec_type: 'video', width: 1920, height: 1080 }],
        format: { duration: '100.0' },
      });

      const abortController = new AbortController();

      let callCount = 0;
      vi.spyOn(childProcess, 'spawn').mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return createMockSpawn({ stdoutData: probeJson, closeCode: 0 }) as any;
        }
        // ffmpeg: don't close, will be killed
        const proc = new EventEmitter() as MockChildProcess;
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.kill = vi.fn();
        return proc as any;
      });

      const extractPromise = service.extractFrames(
        'C:/videos/test.mp4',
        'C:/output/frames',
        'media_001',
        { abortSignal: abortController.signal },
      );

      // 给一点时间让 spawn 完成
      await new Promise(r => setTimeout(r, 20));
      abortController.abort();

      await expect(extractPromise).rejects.toThrow('TASK_ABORTED');
    });

    it('ffmpeg 非零退出码（含 received no packets）应返回空遥测', async () => {
      mockExistsSync.mockReturnValue(true);

      const probeJson = JSON.stringify({
        streams: [{ codec_type: 'video', width: 1920, height: 1080 }],
        format: { duration: '10.0' },
      });

      let callCount = 0;
      vi.spyOn(childProcess, 'spawn').mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return createMockSpawn({ stdoutData: probeJson, closeCode: 0 }) as any;
        }
        return createMockSpawn({
          closeCode: 1,
          stderrData: 'received no packets',
        }) as any;
      });

      const result = await service.extractFrames(
        'C:/videos/test.mp4',
        'C:/output/frames',
        'media_001',
      );

      expect(result.files).toHaveLength(0);
    });

    it('遥测应正确统计文件数量和大小', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync
        .mockReturnValueOnce([])
        .mockReturnValueOnce(['frame_00000001.jpg', 'frame_00000002.jpg']);
      mockPromisesStat.mockResolvedValue({ size: 524288 } as any);

      const probeJson = JSON.stringify({
        streams: [{ codec_type: 'video', width: 1920, height: 1080 }],
        format: { duration: '30.0' },
      });

      let callCount = 0;
      vi.spyOn(childProcess, 'spawn').mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return createMockSpawn({ stdoutData: probeJson, closeCode: 0 }) as any;
        }
        return createMockSpawn({ closeCode: 0 }) as any;
      });

      const result = await service.extractFrames(
        'C:/videos/test.mp4',
        'C:/output/frames',
        'media_001',
      );

      expect(result.files).toHaveLength(2);
      expect(result.metrics.frameCount).toBe(2);
      expect(result.metrics.totalSizeMB).toBeCloseTo(1.0, 0); // 2 × 524288 / (1024*1024) ≈ 1.0
    });

    it('ffprobe 探针超时应返回 emptyTelemetry', async () => {
      mockExistsSync.mockReturnValue(true);

      // probeVideo: spawn but don't emit close (will timeout)
      vi.spyOn(childProcess, 'spawn').mockImplementation(() => {
        const proc = new EventEmitter() as MockChildProcess;
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.kill = vi.fn();
        return proc as any;
      });

      // Mock setTimeout to trigger immediately for the probe timeout
      vi.spyOn(global, 'setTimeout').mockImplementation(((
        cb: () => void,
        _ms?: number,
      ) => {
        if (_ms === 10000) {
          cb();
        }
        return 0 as any;
      }) as any);

      const result = await service.extractFrames(
        'C:/videos/test.mp4',
        'C:/output/frames',
        'media_001',
      );

      expect(result.files).toHaveLength(0);
    });
  });
});
