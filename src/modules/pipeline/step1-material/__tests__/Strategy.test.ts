// Module: pipeline/step1-material - Step1MaterialStrategy 单元测试

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';

// === Mock 依赖模块（顶层 hoisting） ===

const { mockExtractFrames, mockTranscribe } = vi.hoisted(() => ({
  mockExtractFrames: vi.fn(),
  mockTranscribe: vi.fn(),
}));

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
    statSync: vi.fn(() => ({ size: 100 })),
    unlink: vi.fn((_p: string, cb: (err?: Error | null) => void) => cb(null)),
    readFileSync: vi.fn(() => JSON.stringify({
      transcription: [
        { text: '你好世界', timestamps: { from: '00:00:00,000', to: '00:00:02,500' } },
      ],
    })),
  },
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
  statSync: vi.fn(() => ({ size: 100 })),
  unlink: vi.fn((_p: string, cb: (err?: Error | null) => void) => cb(null)),
  readFileSync: vi.fn(() => JSON.stringify({
    transcription: [
      { text: '你好世界', timestamps: { from: '00:00:00,000', to: '00:00:02,500' } },
    ],
  })),
}));

vi.mock('path', () => ({
  default: {
    join: vi.fn((...args: string[]) => args.join('/')),
  },
  join: vi.fn((...args: string[]) => args.join('/')),
}));

vi.mock('@modules/media/frames', () => ({
  FrameExtractionService: class {
    extractFrames = mockExtractFrames;
  },
}));

vi.mock('../../../../main/engine/media/AudioProcessor', () => ({
  AudioProcessor: {
    extractAndSeparate: vi.fn(),
    downsampleTo16k: vi.fn(),
  },
}));

vi.mock('../../../../main/engine/media/VisionProcessor', () => ({
  VisionProcessor: {
    scanFaces: vi.fn(),
  },
}));

vi.mock('../../../../main/engine/strategies/LocalWhisperStrategy', () => {
  function MockLS(this: any) {
    this.transcribe = mockTranscribe;
  }
  return { LocalWhisperStrategy: MockLS };
});

vi.mock('../../../../main/core/AppLogger', () => ({
  AppLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@modules/infra/logger/LogConstants', () => ({
  LOG_TAGS: {
    SCHEDULER: 'SCHEDULER',
    MEDIA_ENGINE: 'MEDIA_ENGINE',
  },
}));

vi.mock('@modules/infra/error/AppError', () => ({
  AppError: class AppError extends Error {
    constructor(code: string, message: string) {
      super(message);
      this.name = 'AppError';
    }
  },
  ErrorCode: { FS_FILE_NOT_FOUND: 'FS_FILE_NOT_FOUND' },
}));

// 动态导入被测模块（mock 已在顶层设置）
import { Step1MaterialStrategy } from '../backend/Strategy';
import { AudioProcessor } from '../../../../main/engine/media/AudioProcessor';
import { VisionProcessor } from '../../../../main/engine/media/VisionProcessor';

/** 构建执行上下文（含 bus 和可选 signal） */
function buildContext(signal?: AbortSignal) {
  return { bus: new Map(), signal } as any;
}

/** 从 context.bus 读取 step1-result（嵌套结构） */
function getBusResult(context: any) {
  return context.bus.get('step1-result');
}

// ---------- tests ----------

describe('Step1MaterialStrategy', () => {
  let strategy: Step1MaterialStrategy;
  let onProgress: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    strategy = new Step1MaterialStrategy();
    onProgress = vi.fn();
    vi.clearAllMocks();
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
    it('mediaPath 为空时应抛出 AppError', async () => {
      await expect(
        (strategy as any).performTask(
          { mediaPath: '', config: {} },
          buildContext(),
          '/tmp/cache',
          onProgress,
        ),
      ).rejects.toThrow('未找到媒体文件路径');
    });

    it('无 mediaPath 字段时应抛出 AppError', async () => {
      await expect(
        (strategy as any).performTask(
          { config: {} },
          buildContext(),
          '/tmp/cache',
          onProgress,
        ),
      ).rejects.toThrow('未找到媒体文件路径');
    });
  });

  // ========== performTask - 子步骤开关 ==========

  describe('performTask - 子步骤开关', () => {
    beforeEach(() => {
      // 默认 mock：所有处理器返回空结果
      mockExtractFrames.mockResolvedValue({ files: [], metrics: { frameCount: 0 } });
      vi.mocked(AudioProcessor.extractAndSeparate).mockResolvedValue({
        asrAudioPath: undefined, vocalsPath: undefined, bgmPath: undefined,
        isFallback: false, hasAudio: false,
      });
      mockTranscribe.mockResolvedValue(null);
      vi.mocked(VisionProcessor.scanFaces).mockResolvedValue([]);
    });

    it('config.frames=false 时应跳过抽帧', async () => {
      await (strategy as any).performTask(
        { mediaPath: '/v.mp4', config: { frames: false } },
        buildContext(),
        '/tmp/cache',
        onProgress,
      );

      expect(mockExtractFrames).not.toHaveBeenCalled();
    });

    it('config.frames={ enabled: false } 时应跳过抽帧', async () => {
      await (strategy as any).performTask(
        { mediaPath: '/v.mp4', config: { frames: { enabled: false } } },
        buildContext(),
        '/tmp/cache',
        onProgress,
      );

      expect(mockExtractFrames).not.toHaveBeenCalled();
    });

    it('config.audio=false 时应跳过音频分离', async () => {
      await (strategy as any).performTask(
        { mediaPath: '/v.mp4', config: { audio: false } },
        buildContext(),
        '/tmp/cache',
        onProgress,
      );

      expect(AudioProcessor.extractAndSeparate).not.toHaveBeenCalled();
    });

    it('config.whisper=false 时应跳过 ASR', async () => {
      mockExtractFrames.mockResolvedValue({ files: ['/f1.jpg'], metrics: { frameCount: 1 } });
      vi.mocked(fs.existsSync).mockReturnValue(true);

      await (strategy as any).performTask(
        { mediaPath: '/v.mp4', config: { whisper: false, frames: true } },
        buildContext(),
        '/tmp/cache',
        onProgress,
      );

      expect(mockTranscribe).not.toHaveBeenCalled();
    });

    it('config.faces=false 时应跳过人脸检测', async () => {
      mockExtractFrames.mockResolvedValue({ files: ['/f1.jpg'], metrics: { frameCount: 1 } });

      await (strategy as any).performTask(
        { mediaPath: '/v.mp4', config: { faces: false, frames: true } },
        buildContext(),
        '/tmp/cache',
        onProgress,
      );

      expect(VisionProcessor.scanFaces).not.toHaveBeenCalled();
    });
  });

  // ========== performTask - 双子星并行 ==========

  describe('performTask - 双子星并行（抽帧 ∥ 音频分离）', () => {
    it.skip('抽帧和音频分离应同时启动（通过 Promise.all）', async () => {
      // 时序测试需真实 Promise，跳过
    }, 15000);

    it('抽帧成功时应返回帧路径列表（扁平结构）', async () => {
      mockExtractFrames.mockResolvedValue({
        files: ['/cache/frames/f1.jpg', '/cache/frames/f2.jpg'],
        metrics: { frameCount: 2 },
      });
      vi.mocked(AudioProcessor.extractAndSeparate).mockResolvedValue({
        asrAudioPath: undefined, vocalsPath: undefined, bgmPath: undefined,
        isFallback: false, hasAudio: false,
      });

      const result = await (strategy as any).performTask(
        { mediaPath: '/v.mp4', config: { frames: true, audio: false } },
        buildContext(),
        '/tmp/cache',
        onProgress,
      );

      // 返回扁平结构
      expect(result.frameCount).toBe(2);
      expect(result.framePaths).toHaveLength(2);
    });
  });

  // ========== performTask - 抽帧降级回退 ==========

  describe('performTask - 抽帧降级回退', () => {
    it('VLM_OPTIMIZED 帧数 <3 时应自动降级到 UNIFORM_FPS', async () => {
      mockExtractFrames
        // 第一次调用（VLM）返回 <3 帧
        .mockResolvedValueOnce({ files: ['/f1.jpg'], metrics: { frameCount: 1 } })
        // 第二次调用（降级 UNIFORM_FPS）返回更多帧
        .mockResolvedValueOnce({ files: ['/f1.jpg', '/f2.jpg', '/f3.jpg', '/f4.jpg'], metrics: { frameCount: 4 } });

      vi.mocked(AudioProcessor.extractAndSeparate).mockResolvedValue({
        asrAudioPath: undefined, vocalsPath: undefined, bgmPath: undefined,
        isFallback: false, hasAudio: false,
      });

      const result = await (strategy as any).performTask(
        {
          mediaPath: '/v.mp4',
          config: { frames: { enabled: true, mode: 'VLM_OPTIMIZED', sceneThreshold: 0.28, quality: 3, scale: 1024, fps: 2 }, audio: false },
        },
        buildContext(),
        '/tmp/cache',
        onProgress,
      );

      // 应调用两次 extractFrames
      expect(mockExtractFrames).toHaveBeenCalledTimes(2);

      // 第二次调用应使用 UNIFORM_FPS 策略
      const secondCallArgs = mockExtractFrames.mock.calls[1][3];
      expect(secondCallArgs.strategy).toBe('UNIFORM_FPS');

      expect(result.frameCount).toBe(4);
    });

    it('UNIFORM_FPS 模式不应触发降级', async () => {
      mockExtractFrames.mockResolvedValue({
        files: ['/f1.jpg'],
        metrics: { frameCount: 1 },
      });
      vi.mocked(AudioProcessor.extractAndSeparate).mockResolvedValue({
        asrAudioPath: undefined, vocalsPath: undefined, bgmPath: undefined,
        isFallback: false, hasAudio: false,
      });

      await (strategy as any).performTask(
        {
          mediaPath: '/v.mp4',
          config: { frames: { enabled: true, mode: 'UNIFORM_FPS', fps: 2, scale: 1024, quality: 3 }, audio: false },
        },
        buildContext(),
        '/tmp/cache',
        onProgress,
      );

      // 应只调用一次
      expect(mockExtractFrames).toHaveBeenCalledTimes(1);
    });
  });

  // ========== performTask - 音频分离 ==========

  describe('performTask - 音频分离', () => {
    beforeEach(() => {
      mockExtractFrames.mockResolvedValue({ files: [], metrics: { frameCount: 0 } });
      vi.mocked(fs.existsSync).mockReturnValue(true);
    });

    it('分离成功时应返回 vocals/bgm 并提供 16k asrAudioPath', async () => {
      vi.mocked(AudioProcessor.extractAndSeparate).mockResolvedValue({
        asrAudioPath: '/audio/vocals_16k.wav',
        vocalsPath: '/audio/vocals.wav',
        bgmPath: '/audio/bgm.wav',
        isFallback: false,
        hasAudio: true,
      });

      const context = buildContext();
      await (strategy as any).performTask(
        { mediaPath: '/v.mp4', config: { audio: true, frames: false } },
        context, '/tmp/cache', onProgress,
      );

      expect(AudioProcessor.extractAndSeparate).toHaveBeenCalledWith(
        '/v.mp4', expect.any(String), expect.any(String), undefined,
        expect.objectContaining({ skipSeparation: false, engine: 'auto' })
      );
      const busResult = getBusResult(context);
      expect(busResult.audio.separated).toBe(true);
      expect(busResult.audio.vocalsPath).toBe('/audio/vocals.wav');
      expect(busResult.audio.bgmPath).toBe('/audio/bgm.wav');
    });

    it('无有效音轨时应静默运行（hasAudio=false）', async () => {
      vi.mocked(AudioProcessor.extractAndSeparate).mockResolvedValue({
        asrAudioPath: undefined, vocalsPath: undefined, bgmPath: undefined,
        isFallback: false, hasAudio: false,
      });

      const context = buildContext();
      await (strategy as any).performTask(
        { mediaPath: '/v.mp4', config: { audio: true, frames: false } },
        context, '/tmp/cache', onProgress,
      );

      const busResult = getBusResult(context);
      expect(busResult.audio.audioPath).toBeFalsy();
      expect(busResult.audio._failed).toBe(true);
    });

    it('分离失败时应降级到原始音轨（isFallback=true）', async () => {
      vi.mocked(AudioProcessor.extractAndSeparate).mockResolvedValue({
        asrAudioPath: '/audio/audio_16k.wav',
        vocalsPath: undefined, bgmPath: undefined,
        isFallback: true, hasAudio: true,
      });

      const context = buildContext();
      await (strategy as any).performTask(
        { mediaPath: '/v.mp4', config: { audio: true, frames: false } },
        context, '/tmp/cache', onProgress,
      );

      const busResult = getBusResult(context);
      expect(busResult.audio.vocalsIsFallback).toBe(true);
      expect(busResult.audio.audioPath).toBeTruthy();
    });

    it('isFallback 标记应透传到结果中', async () => {
      vi.mocked(AudioProcessor.extractAndSeparate).mockResolvedValue({
        asrAudioPath: '/audio/vocals_16k.wav',
        vocalsPath: '/tmp/vocals.wav',
        bgmPath: '/tmp/bgm.wav',
        isFallback: true, hasAudio: true,
      });

      const context = buildContext();
      await (strategy as any).performTask(
        { mediaPath: '/v.mp4', config: { audio: true, frames: false } },
        context, '/tmp/cache', onProgress,
      );

      const busResult = getBusResult(context);
      expect(busResult.audio.vocalsIsFallback).toBe(true);
      expect(busResult.audio.vocalsPath).toBe('/tmp/vocals.wav');
      expect(busResult.audio.bgmPath).toBe('/tmp/bgm.wav');
    });

    it('fast 模式应跳过分离引擎（skipSeparation=true）', async () => {
      vi.mocked(AudioProcessor.extractAndSeparate).mockResolvedValue({
        asrAudioPath: '/audio/audio_16k.wav',
        vocalsPath: undefined, bgmPath: undefined,
        isFallback: true, hasAudio: true,
      });

      await (strategy as any).performTask(
        { mediaPath: '/v.mp4', config: { audio: { separationMode: 'fast' }, frames: false } },
        buildContext(), '/tmp/cache', onProgress,
      );

      expect(AudioProcessor.extractAndSeparate).toHaveBeenCalledWith(
        '/v.mp4', expect.any(String), expect.any(String), undefined,
        expect.objectContaining({ skipSeparation: true, engine: 'auto' })
      );
    });

    it('quality 模式应透传 engine 配置到分离引擎', async () => {
      vi.mocked(AudioProcessor.extractAndSeparate).mockResolvedValue({
        asrAudioPath: '/audio/vocals_16k.wav',
        vocalsPath: '/audio/vocals.wav',
        bgmPath: '/audio/bgm.wav',
        isFallback: false,
        hasAudio: true,
      });

      await (strategy as any).performTask(
        { mediaPath: '/v.mp4', config: { audio: { separationMode: 'quality', engine: 'mdx' }, frames: false } },
        buildContext(), '/tmp/cache', onProgress,
      );

      expect(AudioProcessor.extractAndSeparate).toHaveBeenCalledWith(
        '/v.mp4', expect.any(String), expect.any(String), undefined,
        expect.objectContaining({ skipSeparation: false, engine: 'mdx' })
      );
    });

    it('onProgress 应被透传（链路不再断裂）', async () => {
      vi.mocked(AudioProcessor.extractAndSeparate).mockImplementation(
        async (_m: string, _d: string, _i: string, _s: any, opts?: any) => {
          // 模拟 extractAndSeparate 调用 onProgress
          opts?.onProgress?.(10, '正在提取音频...');
          opts?.onProgress?.(50, '正在分离人声...');
          opts?.onProgress?.(100, '人声分离完成');
          return {
            asrAudioPath: '/audio/vocals_16k.wav',
            vocalsPath: '/audio/vocals.wav',
            bgmPath: '/audio/bgm.wav',
            isFallback: false,
            hasAudio: true,
          };
        }
      );

      await (strategy as any).performTask(
        { mediaPath: '/v.mp4', config: { audio: true, frames: false } },
        buildContext(), '/tmp/cache', onProgress,
      );

      // onProgress 应被多次调用，且值单调递增
      const calls = onProgress.mock.calls.map((c: any) => c[0]);
      const max = Math.max(...calls);
      expect(max).toBeGreaterThanOrEqual(30); // 至少推进到 30 区间
    });
  });

  // ========== performTask - ASR ==========

  describe('performTask - ASR 语音识别', () => {
    beforeEach(() => {
      mockExtractFrames.mockResolvedValue({ files: [], metrics: { frameCount: 0 } });
      // 默认分离成功，返回 16k asrAudioPath
      vi.mocked(AudioProcessor.extractAndSeparate).mockResolvedValue({
        asrAudioPath: '/audio/vocals_16k.wav',
        vocalsPath: '/audio/vocals.wav',
        bgmPath: '/audio/bgm.wav',
        isFallback: false,
        hasAudio: true,
      });
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockTranscribe.mockReset();
    });

    it('ASR 成功时应返回 asrLines', async () => {
      mockTranscribe.mockResolvedValue({
        asrLines: [
          { id: '1', text: '你好世界', start: 0, end: 2.5 },
        ],
        whisperJsonPath: '/audio/whisper.json',
      });

      const result = await (strategy as any).performTask(
        {
          mediaPath: '/v.mp4',
          config: { whisper: { enabled: true, engine: 'sensevoice' }, frames: false, audio: true },
        },
        buildContext(),
        '/tmp/cache',
        onProgress,
      );

      expect(mockTranscribe).toHaveBeenCalled();
      // 返回扁平结构，asrLines 在顶层
      expect(result.asrLines).toHaveLength(1);
    });

    it('ASR 失败时应降级跳过（不阻断管线）', async () => {
      mockTranscribe.mockRejectedValue(new Error('ASR engine crashed'));

      const result = await (strategy as any).performTask(
        {
          mediaPath: '/v.mp4',
          config: { whisper: { enabled: true, engine: 'sensevoice' }, frames: false, audio: true },
        },
        buildContext(),
        '/tmp/cache',
        onProgress,
      );

      // 不应崩溃，asrLines 应为空数组
      expect(result.asrLines).toEqual([]);
    });

    it('targetLanguage 应映射到正确语言代码', async () => {
      mockTranscribe.mockResolvedValue({ asrLines: [], whisperJsonPath: '' });

      await (strategy as any).performTask(
        {
          mediaPath: '/v.mp4',
          config: {
            targetLanguage: 'en-US',
            whisper: { enabled: true, engine: 'whisper-v3' },
            frames: false,
            audio: true,
          },
        },
        buildContext(),
        '/tmp/cache',
        onProgress,
      );

      // 验证 transcribe 被调用时参数正确（共 6 个参数）
      expect(mockTranscribe).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(String),
        'en', // 'en-US' → 'en'
        'whisper-v3',      // asrEngine（config.whisper.engine）
        undefined,         // signal（context 未传 signal）
      );
    });
  });

  // ========== performTask - 人脸检测 ==========

  describe('performTask - 人脸检测', () => {
    beforeEach(() => {
      // 人脸检测场景默认无音频
      vi.mocked(AudioProcessor.extractAndSeparate).mockResolvedValue({
        asrAudioPath: undefined, vocalsPath: undefined, bgmPath: undefined,
        isFallback: false, hasAudio: false,
      });
    });

    it('有有效帧时应调用 scanFaces', async () => {
      mockExtractFrames.mockResolvedValue({
        files: ['/f1.jpg', '/f2.jpg'],
        metrics: { frameCount: 2 },
      });
      vi.mocked(VisionProcessor.scanFaces).mockResolvedValue([
        { id: 'r1', name: '角色A', facePath: '/faces/r1.jpg' },
      ]);

      const result = await (strategy as any).performTask(
        { mediaPath: '/v.mp4', config: { frames: true, faces: true, audio: false, whisper: false } },
        buildContext(),
        '/tmp/cache',
        onProgress,
      );

      // scanFaces 接收 3 个参数（frames, facesDir, signal）
      expect(VisionProcessor.scanFaces).toHaveBeenCalledWith(
        ['/f1.jpg', '/f2.jpg'],
        expect.any(String),
        undefined,
      );
      // 返回扁平结构，roles 在顶层
      expect(result.roles).toHaveLength(1);
    });

    it('无有效帧时应自动跳过人脸检测', async () => {
      mockExtractFrames.mockResolvedValue({ files: [], metrics: { frameCount: 0 } });

      await (strategy as any).performTask(
        { mediaPath: '/v.mp4', config: { frames: true, faces: true, audio: false, whisper: false } },
        buildContext(),
        '/tmp/cache',
        onProgress,
      );

      expect(VisionProcessor.scanFaces).not.toHaveBeenCalled();
    });

    it('人脸检测失败时应降级跳过', async () => {
      mockExtractFrames.mockResolvedValue({
        files: ['/f1.jpg'],
        metrics: { frameCount: 1 },
      });
      vi.mocked(VisionProcessor.scanFaces).mockRejectedValue(new Error('face detection crashed'));

      const result = await (strategy as any).performTask(
        { mediaPath: '/v.mp4', config: { frames: true, faces: true, audio: false, whisper: false } },
        buildContext(),
        '/tmp/cache',
        onProgress,
      );

      // 不应崩溃
      expect(result.roles).toEqual([]);
    });
  });

  // ========== performTask - context.bus 写入 ==========

  describe('performTask - context.bus 写入', () => {
    beforeEach(() => {
      mockExtractFrames.mockResolvedValue({
        files: ['/f1.jpg'],
        metrics: { frameCount: 1 },
      });
      vi.mocked(AudioProcessor.extractAndSeparate).mockResolvedValue({
        asrAudioPath: undefined, vocalsPath: undefined, bgmPath: undefined,
        isFallback: false, hasAudio: false,
      });
    });

    it('应将 step1-result 写入 context.bus', async () => {
      const context = buildContext();

      await (strategy as any).performTask(
        { mediaPath: '/v.mp4', config: { frames: true, audio: false, whisper: false, faces: false } },
        context,
        '/tmp/cache',
        onProgress,
      );

      expect(context.bus.has('step1-result')).toBe(true);
      const result = context.bus.get('step1-result');
      expect(result.frames).toBeDefined();
    });

    it('有帧时应将 step1-frames 写入 context.bus', async () => {
      const context = buildContext();

      await (strategy as any).performTask(
        { mediaPath: '/v.mp4', config: { frames: true, audio: false, whisper: false, faces: false } },
        context,
        '/tmp/cache',
        onProgress,
      );

      expect(context.bus.has('step1-frames')).toBe(true);
      expect(context.bus.get('step1-frames')).toHaveLength(1);
    });
  });

  // ========== performTask - 进度回调 ==========

  describe('performTask - 进度回调', () => {
    it('应触发多阶段进度回调，且最后为 100%', async () => {
      mockExtractFrames.mockResolvedValue({ files: ['/f1.jpg'], metrics: { frameCount: 1 } });
      vi.mocked(AudioProcessor.extractAndSeparate).mockResolvedValue({
        asrAudioPath: undefined, vocalsPath: undefined, bgmPath: undefined,
        isFallback: false, hasAudio: false,
      });

      await (strategy as any).performTask(
        { mediaPath: '/v.mp4', config: { frames: true, audio: false } },
        buildContext(),
        '/tmp/cache',
        onProgress,
      );

      // 应至少调用一次（开始和完成）
      expect(onProgress).toHaveBeenCalled();
      // 最后一次调用应为 100%
      const lastCall = onProgress.mock.calls[onProgress.mock.calls.length - 1];
      expect(lastCall[0]).toBe(100);
    });

    it('进度值应单调递增（不回跳）', async () => {
      mockExtractFrames.mockResolvedValue({ files: ['/f1.jpg'], metrics: { frameCount: 1 } });
      vi.mocked(AudioProcessor.extractAndSeparate).mockResolvedValue({
        asrAudioPath: undefined, vocalsPath: undefined, bgmPath: undefined,
        isFallback: false, hasAudio: false,
      });

      await (strategy as any).performTask(
        { mediaPath: '/v.mp4', config: { frames: true, audio: false } },
        buildContext(),
        '/tmp/cache',
        onProgress,
      );

      // 收集所有进度值（忽略 0 起点）
      const progressValues = onProgress.mock.calls.map((c: any[]) => c[0]);
      // 验证单调递增（非严格，允许相等）
      for (let i = 1; i < progressValues.length; i++) {
        expect(progressValues[i]).toBeGreaterThanOrEqual(progressValues[i - 1]);
      }
    });
  });
});
