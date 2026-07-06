// Module: pipeline/step1-material - Step1MaterialStrategy 单元测试

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';

// === Mock 依赖模块（顶层 hoisting） ===

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('path', () => ({
  default: {
    join: vi.fn((...args: string[]) => args.join('/')),
  },
  join: vi.fn((...args: string[]) => args.join('/')),
}));

vi.mock('../../../../main/engine/media/VideoProcessor', () => ({
  VideoProcessor: {
    extractFrames: vi.fn(),
  },
}));

vi.mock('../../../../main/engine/media/AudioProcessor', () => ({
  AudioProcessor: {
    separateAudio: vi.fn(),
    separateVocalsBgm: vi.fn(),
  },
}));

vi.mock('../../../../main/engine/media/VisionProcessor', () => ({
  VisionProcessor: {
    scanFaces: vi.fn(),
  },
}));

vi.mock('../../../../main/engine/strategies/LocalWhisperStrategy', () => ({
  LocalWhisperStrategy: vi.fn().mockImplementation(() => ({
    transcribe: vi.fn(),
  })),
}));

vi.mock('../../../../main/core/AppLogger', () => ({
  AppLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../../../infra/logger/LogConstants', () => ({
  LOG_TAGS: {
    SCHEDULER: 'SCHEDULER',
    MEDIA_ENGINE: 'MEDIA_ENGINE',
  },
}));

// 动态导入被测模块（mock 已在顶层设置）
import { Step1MaterialStrategy } from '../backend/Strategy';
import { VideoProcessor } from '../../../../main/engine/media/VideoProcessor';
import { AudioProcessor } from '../../../../main/engine/media/AudioProcessor';
import { VisionProcessor } from '../../../../main/engine/media/VisionProcessor';
import { LocalWhisperStrategy } from '../../../../main/engine/strategies/LocalWhisperStrategy';

// ---------- helpers ----------

/** 创建一个合法的默认 input 对象 */
function makeInput(overrides: Record<string, any> = {}) {
  return {
    mediaPath: '/test/v.mp4',
    config: {},
    ...overrides,
  };
}

/** 模拟抽帧返回 N 帧 */
function mockFrames(files: string[]) {
  vi.mocked(VideoProcessor.extractFrames).mockResolvedValue({
    files,
    metrics: { frameCount: files.length },
  });
}

// ---------- tests ----------

describe('Step1MaterialStrategy', () => {
  let strategy: Step1MaterialStrategy;
  let onProgress: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    strategy = new Step1MaterialStrategy();
    onProgress = vi.fn();

    // 默认安全值：所有 mock 返回空 / false
    mockFrames([]);
    vi.mocked(AudioProcessor.separateAudio).mockResolvedValue(false);
    vi.mocked(AudioProcessor.separateVocalsBgm).mockResolvedValue(null);
    vi.mocked(VisionProcessor.scanFaces).mockResolvedValue([]);
    vi.mocked(LocalWhisperStrategy).mockImplementation(
      () => ({ transcribe: vi.fn().mockResolvedValue(null) }) as any,
    );
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ========== 基础属性 ==========

  describe('基础属性', () => {
    it('nodeType 应为 step1-material', () => {
      expect(strategy.nodeType).toBe('step1-material');
    });

    it('isRecoverable 应为 true', () => {
      expect(strategy.isRecoverable).toBe(true);
    });

    it('应继承自 BaseNodeStrategy（performTask 为函数）', () => {
      expect(typeof (strategy as any).performTask).toBe('function');
    });
  });

  // ========== performTask - 无媒体路径 ==========

  describe('performTask - 无媒体路径', () => {
    it('mediaPath 为空时应返回 _failed', async () => {
      const result = await (strategy as any).performTask(
        makeInput({ mediaPath: '' }),
        { bus: new Map() } as any,
        '/tmp/cache',
        onProgress,
      );

      expect(result._failed).toBe(true);
      expect(result._error).toContain('未找到媒体文件路径');
    });

    it('无 mediaPath 字段时应返回 _failed', async () => {
      const result = await (strategy as any).performTask(
        { config: {} },
        { bus: new Map() } as any,
        '/tmp/cache',
        onProgress,
      );

      expect(result._failed).toBe(true);
    });
  });

  // ========== performTask - 子步骤开关 ==========

  describe('performTask - 子步骤开关', () => {
    it('config.frames=false 时应跳过抽帧', async () => {
      await (strategy as any).performTask(
        makeInput({ config: { frames: false } }),
        { bus: new Map() } as any,
        '/tmp/cache',
        onProgress,
      );

      expect(VideoProcessor.extractFrames).not.toHaveBeenCalled();
    });

    it('config.frames={ enabled: false } 时应跳过抽帧', async () => {
      await (strategy as any).performTask(
        makeInput({ config: { frames: { enabled: false } } }),
        { bus: new Map() } as any,
        '/tmp/cache',
        onProgress,
      );

      expect(VideoProcessor.extractFrames).not.toHaveBeenCalled();
    });

    it('config.audio=false 时应跳过音频分离', async () => {
      await (strategy as any).performTask(
        makeInput({ config: { audio: false } }),
        { bus: new Map() } as any,
        '/tmp/cache',
        onProgress,
      );

      expect(AudioProcessor.separateAudio).not.toHaveBeenCalled();
    });

    it('config.whisper=false 时应跳过 ASR', async () => {
      mockFrames(['/f1.jpg']);
      vi.mocked(fs.existsSync).mockReturnValue(true);

      await (strategy as any).performTask(
        makeInput({ config: { whisper: false, frames: true } }),
        { bus: new Map() } as any,
        '/tmp/cache',
        onProgress,
      );

      // LocalWhisperStrategy 不应被实例化（因为 runWhisper=false 不会进入 ASR 块）
      expect(LocalWhisperStrategy).not.toHaveBeenCalled();
    });

    it('config.faces=false 时应跳过人脸检测', async () => {
      mockFrames(['/f1.jpg']);

      await (strategy as any).performTask(
        makeInput({ config: { faces: false, frames: true } }),
        { bus: new Map() } as any,
        '/tmp/cache',
        onProgress,
      );

      expect(VisionProcessor.scanFaces).not.toHaveBeenCalled();
    });
  });

  // ========== performTask - 双子星并行 ==========

  describe('performTask - 双子星并行（抽帧 ∥ 音频分离）', () => {
    it('抽帧和音频分离均应被调用', async () => {
      mockFrames(['/f1.jpg', '/f2.jpg']);
      vi.mocked(AudioProcessor.separateAudio).mockResolvedValue(true);

      await (strategy as any).performTask(
        makeInput({ config: { frames: true, audio: true } }),
        { bus: new Map() } as any,
        '/tmp/cache',
        onProgress,
      );

      // 两者都应被调用（Promise.all 确保两者都启动）
      expect(VideoProcessor.extractFrames).toHaveBeenCalled();
      expect(AudioProcessor.separateAudio).toHaveBeenCalled();
    });

    it('抽帧成功时应返回帧路径列表', async () => {
      mockFrames(['/cache/frames/f1.jpg', '/cache/frames/f2.jpg']);
      vi.mocked(AudioProcessor.separateAudio).mockResolvedValue(false);

      const result = await (strategy as any).performTask(
        makeInput({ config: { frames: true, audio: false } }),
        { bus: new Map() } as any,
        '/tmp/cache',
        onProgress,
      );

      expect(result.frames.count).toBe(2);
      expect(result.frames.paths).toHaveLength(2);
    });
  });

  // ========== performTask - 抽帧降级回退 ==========

  describe('performTask - 抽帧降级回退', () => {
    it('VLM_OPTIMIZED 帧数 <3 时应自动降级到 UNIFORM_FPS', async () => {
      // 第一次调用（VLM）返回 <3 帧
      vi.mocked(VideoProcessor.extractFrames)
        .mockResolvedValueOnce({ files: ['/f1.jpg'], metrics: { frameCount: 1 } })
        // 第二次调用（降级 UNIFORM_FPS）返回更多帧
        .mockResolvedValueOnce({ files: ['/f1.jpg', '/f2.jpg', '/f3.jpg', '/f4.jpg'], metrics: { frameCount: 4 } });

      const result = await (strategy as any).performTask(
        makeInput({
          config: {
            frames: { enabled: true, mode: 'VLM_OPTIMIZED', sceneThreshold: 0.28, quality: 3, scale: 1024, fps: 2 },
            audio: false,
          },
        }),
        { bus: new Map() } as any,
        '/tmp/cache',
        onProgress,
      );

      // 应调用两次 extractFrames
      expect(VideoProcessor.extractFrames).toHaveBeenCalledTimes(2);

      // 第二次调用应使用 UNIFORM_FPS 策略
      const secondCallArgs = vi.mocked(VideoProcessor.extractFrames).mock.calls[1][3];
      expect(secondCallArgs.strategy).toBe('UNIFORM_FPS');

      expect(result.frames.count).toBe(4);
    });

    it('UNIFORM_FPS 模式不应触发降级', async () => {
      vi.mocked(VideoProcessor.extractFrames).mockResolvedValue({
        files: ['/f1.jpg'],
        metrics: { frameCount: 1 },
      });

      await (strategy as any).performTask(
        makeInput({
          config: {
            frames: { enabled: true, mode: 'UNIFORM_FPS', fps: 2, scale: 1024, quality: 3 },
            audio: false,
          },
        }),
        { bus: new Map() } as any,
        '/tmp/cache',
        onProgress,
      );

      // 应只调用一次
      expect(VideoProcessor.extractFrames).toHaveBeenCalledTimes(1);
    });
  });

  // ========== performTask - 音频分离 ==========

  describe('performTask - 音频分离', () => {
    it('音频分离成功时应尝试 Demucs 人声分离', async () => {
      vi.mocked(AudioProcessor.separateAudio).mockResolvedValue(true);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(AudioProcessor.separateVocalsBgm).mockResolvedValue({
        vocals: '/audio/vocals.wav',
        bgm: '/audio/bgm.wav',
      });

      const result = await (strategy as any).performTask(
        makeInput({ config: { audio: true, frames: false } }),
        { bus: new Map() } as any,
        '/tmp/cache',
        onProgress,
      );

      expect(AudioProcessor.separateVocalsBgm).toHaveBeenCalled();
      expect(result.audio.separated).toBe(true);
      expect(result.audio.vocalsPath).toBe('/audio/vocals.wav');
    });

    it('无有效音轨时应静默运行（hasAudio=false）', async () => {
      vi.mocked(AudioProcessor.separateAudio).mockRejectedValue(new Error('no audio track'));

      const result = await (strategy as any).performTask(
        makeInput({ config: { audio: true, frames: false } }),
        { bus: new Map() } as any,
        '/tmp/cache',
        onProgress,
      );

      expect(result.audio.audioPath).toBeUndefined();
    });

    it('Demucs 不可用时应降级到原始音轨', async () => {
      vi.mocked(AudioProcessor.separateAudio).mockResolvedValue(true);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(AudioProcessor.separateVocalsBgm).mockRejectedValue(new Error('demucs not found'));

      const result = await (strategy as any).performTask(
        makeInput({ config: { audio: true, frames: false } }),
        { bus: new Map() } as any,
        '/tmp/cache',
        onProgress,
      );

      // 不应崩溃，audio 结果仍应有 audioPath
      expect(result.audio.audioPath).toBeTruthy();
    });
  });

  // ========== performTask - ASR ==========

  describe('performTask - ASR 语音识别', () => {
    it('ASR 成功时应返回 asrLines', async () => {
      vi.mocked(AudioProcessor.separateAudio).mockResolvedValue(true);
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const mockTranscribe = vi.fn().mockResolvedValue({
        asrLines: [{ id: '1', text: '你好世界', start: 0, end: 2.5 }],
        whisperJsonPath: '/audio/whisper.json',
      });
      vi.mocked(LocalWhisperStrategy).mockImplementation(
        () => ({ transcribe: mockTranscribe }) as any,
      );

      const result = await (strategy as any).performTask(
        makeInput({
          config: { whisper: { enabled: true, engine: 'sensevoice' }, frames: false, audio: true },
        }),
        { bus: new Map() } as any,
        '/tmp/cache',
        onProgress,
      );

      expect(mockTranscribe).toHaveBeenCalled();
      expect(result.asr.lines).toHaveLength(1);
      expect(result.asr.lines[0].text).toBe('你好世界');
    });

    it('ASR 失败时应降级跳过（不阻断管线）', async () => {
      vi.mocked(AudioProcessor.separateAudio).mockResolvedValue(true);
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const mockTranscribe = vi.fn().mockRejectedValue(new Error('ASR engine crashed'));
      vi.mocked(LocalWhisperStrategy).mockImplementation(
        () => ({ transcribe: mockTranscribe }) as any,
      );

      const result = await (strategy as any).performTask(
        makeInput({
          config: { whisper: { enabled: true, engine: 'sensevoice' }, frames: false, audio: true },
        }),
        { bus: new Map() } as any,
        '/tmp/cache',
        onProgress,
      );

      // 不应崩溃，asr.lines 应为空数组
      expect(result.asr.lines).toEqual([]);
    });

    it('targetLanguage 应映射到正确语言代码', async () => {
      vi.mocked(AudioProcessor.separateAudio).mockResolvedValue(true);
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const mockTranscribe = vi.fn().mockResolvedValue({ asrLines: [], whisperJsonPath: '' });
      vi.mocked(LocalWhisperStrategy).mockImplementation(
        () => ({ transcribe: mockTranscribe }) as any,
      );

      await (strategy as any).performTask(
        makeInput({
          config: {
            targetLanguage: 'en-US',
            whisper: { enabled: true, engine: 'whisper-v3' },
            frames: false,
            audio: true,
          },
        }),
        { bus: new Map() } as any,
        '/tmp/cache',
        onProgress,
      );

      // 验证 transcribe 被调用时语言参数为 'en'（从 'en-US' 映射）
      expect(mockTranscribe).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(String),
        'en',
      );
    });
  });

  // ========== performTask - 人脸检测 ==========

  describe('performTask - 人脸检测', () => {
    it('有有效帧时应调用 scanFaces', async () => {
      mockFrames(['/f1.jpg', '/f2.jpg']);
      vi.mocked(VisionProcessor.scanFaces).mockResolvedValue([
        { id: 'r1', name: '角色A', facePath: '/faces/r1.jpg' },
      ]);

      const result = await (strategy as any).performTask(
        makeInput({ config: { frames: true, faces: true, audio: false, whisper: false } }),
        { bus: new Map() } as any,
        '/tmp/cache',
        onProgress,
      );

      expect(VisionProcessor.scanFaces).toHaveBeenCalledWith(
        ['/f1.jpg', '/f2.jpg'],
        expect.any(String),
      );
      expect(result.faces.roles).toHaveLength(1);
      expect(result.faces.count).toBe(1);
    });

    it('无有效帧时应自动跳过人脸检测', async () => {
      mockFrames([]);

      await (strategy as any).performTask(
        makeInput({ config: { frames: true, faces: true, audio: false, whisper: false } }),
        { bus: new Map() } as any,
        '/tmp/cache',
        onProgress,
      );

      expect(VisionProcessor.scanFaces).not.toHaveBeenCalled();
    });

    it('人脸检测失败时应降级跳过', async () => {
      mockFrames(['/f1.jpg']);
      vi.mocked(VisionProcessor.scanFaces).mockRejectedValue(new Error('face detection crashed'));

      const result = await (strategy as any).performTask(
        makeInput({ config: { frames: true, faces: true, audio: false, whisper: false } }),
        { bus: new Map() } as any,
        '/tmp/cache',
        onProgress,
      );

      // 不应崩溃
      expect(result.faces.roles).toEqual([]);
      expect(result.faces.count).toBe(0);
    });
  });

  // ========== performTask - context.bus 写入 ==========

  describe('performTask - context.bus 写入', () => {
    it('应将 step1-result 写入 context.bus', async () => {
      mockFrames(['/f1.jpg']);

      const bus = new Map();
      const context = { bus } as any;

      await (strategy as any).performTask(
        makeInput({ config: { frames: true, audio: false, whisper: false, faces: false } }),
        context,
        '/tmp/cache',
        onProgress,
      );

      expect(bus.has('step1-result')).toBe(true);
      const result = bus.get('step1-result');
      expect(result.frames).toBeDefined();
    });

    it('有帧时应将 step1-frames 写入 context.bus', async () => {
      mockFrames(['/f1.jpg']);

      const bus = new Map();
      const context = { bus } as any;

      await (strategy as any).performTask(
        makeInput({ config: { frames: true, audio: false, whisper: false, faces: false } }),
        context,
        '/tmp/cache',
        onProgress,
      );

      expect(bus.has('step1-frames')).toBe(true);
      expect(bus.get('step1-frames')).toHaveLength(1);
    });
  });

  // ========== performTask - 进度回调 ==========

  describe('performTask - 进度回调', () => {
    it('应触发多阶段进度回调并以 100 结束', async () => {
      mockFrames(['/f1.jpg']);

      await (strategy as any).performTask(
        makeInput({ config: { frames: true, audio: false } }),
        { bus: new Map() } as any,
        '/tmp/cache',
        onProgress,
      );

      expect(onProgress).toHaveBeenCalled();
      const lastCall = onProgress.mock.calls[onProgress.mock.calls.length - 1];
      expect(lastCall[0]).toBe(100);
    });
  });
});
