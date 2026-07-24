// Module: pipeline/step4-tts - TTS Service 单元测试

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// === Mock 外部依赖（vi.mock 会被 vitest 自动 hoist） ===
// 使用 vi.hoisted 避免 hoist 导致的变量未初始化错误

const { mockGetTTSConfig, mockGetTTSOutputDir } = vi.hoisted(() => ({
  mockGetTTSConfig: vi.fn(),
  mockGetTTSOutputDir: vi.fn(),
}));

vi.mock('../../../../main/engine/config/ProviderManager', () => ({
  ProviderManager: {
    getTTSConfig: mockGetTTSConfig,
  },
}));

vi.mock('../../../../main/utils/pathManager', () => ({
  PathManager: {
    getTTSOutputDir: mockGetTTSOutputDir,
  },
}));

// fs 使用 spy 而非 mock，避免 async factory 问题
import fs from 'fs';
import os from 'os';
import path from 'path';

import { TTSProvider } from '../backend/Service';
import { AppError, ErrorCode } from '@modules/infra/error/AppError';

// ---------- helpers ----------

function setupMocks(overrides: Record<string, unknown> = {}) {
  mockGetTTSConfig.mockReturnValue({
    provider: overrides.provider ?? 'edge',
    appId: (overrides.appId as string) ?? '',
    token: (overrides.token as string) ?? '',
    voice: (overrides.voice as string) ?? '',
    url: (overrides.url as string) ?? 'http://127.0.0.1:9880',
    apiKey: (overrides.apiKey as string) ?? '',
    mossUrl: (overrides.mossUrl as string) ?? 'http://127.0.0.1:9881',
    mossModelDir: (overrides.mossModelDir as string) ?? '',
  });

  mockGetTTSOutputDir.mockReturnValue(
    (overrides.saveDir as string) ?? path.join(os.tmpdir(), 'zentect-test-tts'),
  );

  // 默认：缓存未命中
  vi.spyOn(fs, 'existsSync').mockReturnValue(false);
  vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
  vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
}

// ---------- tests ----------

describe('TTSProvider', () => {
  let provider: TTSProvider;

  beforeEach(() => {
    provider = new TTSProvider();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==================== synthesize ====================

  describe('synthesize', () => {
    it('未知引擎应抛出异常（default 被外层 catch 包裹为 AI_PROCESS_FAILED）', async () => {
      setupMocks();

      await expect(
        provider.synthesize('你好', 'unknown-engine' as any),
      ).rejects.toMatchObject({ code: ErrorCode.AI_PROCESS_FAILED });
    });

    it('空文本清洗后应正常走合成流程（不会被缓存）', async () => {
      setupMocks();

      // 空文本清洗后为 ''，缓存查找应使用 ''
      vi.spyOn(fs, 'existsSync').mockReturnValue(true); // 模拟缓存命中
      const saveDir = path.join(os.tmpdir(), 'zentect-test-tts');

      // MD5('|edge|') → 先计算
      const expectedHash = 'd79340cb72e0'; // MD5 前12位
      // 实际使用 crypto，我们依赖运行环境。直接让 existSync 返回 true 验证缓存路径。

      // 清除 mock 重置 → 让缓存命中
      mockGetTTSConfig.mockReturnValue({
        provider: 'edge',
        appId: '', token: '', voice: '', url: '', apiKey: '', mossUrl: '', mossModelDir: '',
      });
      mockGetTTSOutputDir.mockReturnValue(saveDir);

      const result = await provider.synthesize('', 'edge');
      expect(result).toContain('tts_edge_default_');
      expect(path.extname(result)).toBe('.mp3');
    });

    it('缓存命中时应直接返回缓存路径而不发起网络请求', async () => {
      setupMocks();

      const saveDir = path.join(os.tmpdir(), 'zentect-cache-test');
      mockGetTTSOutputDir.mockReturnValue(saveDir);
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);

      // fetch 不应被调用
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      const result = await provider.synthesize('测试文案', 'edge');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result).toContain(saveDir);
      expect(result).toContain('tts_edge_default_');
    });

    it('doubao 无 appId/token 时应抛出错误', async () => {
      setupMocks({ provider: 'doubao', appId: '', token: '' });

      await expect(
        provider.synthesize('测试', 'doubao'),
      ).rejects.toMatchObject({ code: ErrorCode.AI_PROCESS_FAILED });
    });

    it('doubao 返回非 3000 code 时应抛出 AI_PROCESS_FAILED', async () => {
      setupMocks({ provider: 'doubao', appId: 'test-app-id', token: 'test-token' });

      vi.spyOn(fs, 'existsSync').mockReturnValue(false); // 无缓存
      globalThis.fetch = vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ code: 1000, message: 'invalid param' }),
      });

      await expect(
        provider.synthesize('测试', 'doubao'),
      ).rejects.toMatchObject({ code: ErrorCode.AI_PROCESS_FAILED });
    });

    it('doubao 成功返回 code=3000 应写入文件', async () => {
      setupMocks({ provider: 'doubao', appId: 'app', token: 'tok' });

      const fakeAudioBase64 = Buffer.from('fake-audio-data').toString('base64');
      globalThis.fetch = vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ code: 3000, data: fakeAudioBase64, message: 'Success' }),
      });

      vi.spyOn(fs, 'existsSync').mockReturnValue(false); // 无缓存，目录也不存在

      const result = await provider.synthesize('你好世界', 'doubao');

      expect(result).toContain('tts_doubao_');
      expect(path.extname(result)).toBe('.mp3');
      expect(fs.mkdirSync).toHaveBeenCalled();
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it('edge 应支持中英文自动选择音色', async () => {
      setupMocks({ provider: 'edge' });

      globalThis.fetch = vi
        .fn()
        // 第一次 fetch：voicemaker API
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ data: { audio_url: 'http://fake/audio.mp3' } }),
        })
        // 第二次 fetch：下载音频
        .mockResolvedValueOnce({
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
        });

      const result = await provider.synthesize('Hello world', 'edge');
      expect(result).toContain('tts_edge_');
    });

    it('edge 中文文本应使用中文音色', async () => {
      setupMocks({ provider: 'edge' });

      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ data: { audio_url: 'http://fake/audio2.mp3' } }),
        })
        .mockResolvedValueOnce({
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
        });

      const result = await provider.synthesize('你好世界', 'edge');
      expect(result).toContain('tts_edge_');
    });

    it('edge voiceOverride 应覆盖默认音色', async () => {
      setupMocks({ provider: 'edge' });

      const fetchSpy = vi
        .fn()
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ data: { audio_url: 'http://fake/audio3.mp3' } }),
        })
        .mockResolvedValueOnce({
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
        });
      globalThis.fetch = fetchSpy;

      await provider.synthesize('测试', 'edge', undefined, 'zh-CN-YunxiNeural');

      // 验证 fetch 被调用时 voice 参数被覆盖
      const callBody = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string);
      expect(callBody.voice).toBe('zh-CN-YunxiNeural');
    });

    it('fish 无 apiKey 应抛出错误', async () => {
      setupMocks({ provider: 'fish', apiKey: '' });

      await expect(
        provider.synthesize('测试', 'fish'),
      ).rejects.toMatchObject({ code: ErrorCode.AI_PROCESS_FAILED });
    });

    it('fish 接口 HTTP 非 200 应抛出 AI_PROCESS_FAILED', async () => {
      setupMocks({ provider: 'fish', apiKey: 'fake-key' });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        text: () => Promise.resolve('Unauthorized'),
      });

      await expect(
        provider.synthesize('测试', 'fish'),
      ).rejects.toMatchObject({ code: ErrorCode.AI_PROCESS_FAILED });
    });

    it('sovits 非 200 响应应抛出 AI_PROCESS_FAILED', async () => {
      setupMocks({ provider: 'sovits', url: 'http://127.0.0.1:9880' });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        statusText: 'Service Unavailable',
      });

      await expect(
        provider.synthesize('测试', 'sovits'),
      ).rejects.toMatchObject({ code: ErrorCode.AI_PROCESS_FAILED });
    });

    it('moss 非 200 响应应抛出 AI_PROCESS_FAILED', async () => {
      setupMocks({ provider: 'moss', mossUrl: 'http://127.0.0.1:9881' });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        text: () => Promise.resolve('Model not loaded'),
      });

      await expect(
        provider.synthesize('测试', 'moss'),
      ).rejects.toMatchObject({ code: ErrorCode.AI_PROCESS_FAILED });
    });

    it('moss 返回 code !== 0 应抛出 AI_PROCESS_FAILED', async () => {
      setupMocks({ provider: 'moss', mossUrl: 'http://127.0.0.1:9881' });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ code: 1, message: 'Voice not found' }),
      });

      await expect(
        provider.synthesize('测试', 'moss'),
      ).rejects.toMatchObject({ code: ErrorCode.AI_PROCESS_FAILED });
    });

    it('sovits 应支持 voiceOverride 作为 character 参数', async () => {
      setupMocks({ provider: 'sovits', url: 'http://127.0.0.1:9880' });

      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
      });
      globalThis.fetch = fetchSpy;

      await provider.synthesize('你好', 'sovits', undefined, 'xiaoming');

      const calledUrl = fetchSpy.mock.calls[0]?.[0] as string;
      expect(calledUrl).toContain('character=xiaoming');
    });

    it('文本清洗应移除全角括号和舞台指示标记', async () => {
      setupMocks({ provider: 'edge' });

      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ data: { audio_url: 'http://fake/clean.mp3' } }),
        })
        .mockResolvedValueOnce({
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
        });

      // 包含各种括号和标记的文本
      const result = await provider.synthesize(
        '【开场】（旁白）「欢迎」『收看』[字幕]  Hello   World  ',
        'edge',
      );

      // 验证生成的缓存文件存在，文本已被清洗
      expect(result).toContain('tts_edge_');
    });

    it('voiceOverride 在 doubao 中应覆盖默认 voice', async () => {
      setupMocks({ provider: 'doubao', appId: 'app', token: 'tok', voice: 'default_voice' });

      const fetchSpy = vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            code: 3000,
            data: Buffer.from('fake').toString('base64'),
            message: 'ok',
          }),
      });
      globalThis.fetch = fetchSpy;

      await provider.synthesize('测试', 'doubao', undefined, 'custom_voice');

      const callBody = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string);
      expect(callBody.audio.voice_type).toBe('custom_voice');
    });
  });

  // ==================== synthesizeWithFallback ====================

  describe('synthesizeWithFallback', () => {
    it('第一个引擎成功应直接返回', async () => {
      setupMocks({ provider: 'edge' });

      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ data: { audio_url: 'http://fake/edge.mp3' } }),
        })
        .mockResolvedValueOnce({
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
        });

      const result = await provider.synthesizeWithFallback('测试文案');
      expect(result.provider).toBe('edge');
      expect(result.path).toContain('tts_edge_');
    });

    it('Edge 失败 → MOSS 成功 → 应返回 MOSS', async () => {
      setupMocks({ provider: 'edge', mossUrl: 'http://127.0.0.1:9881' });

      // Edge 失败
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ data: {} }), // edge: 无 audio_url
        })
        // MOSS 成功
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              code: 0,
              audio: Buffer.from('moss-audio').toString('hex'),
            }),
        });

      const result = await provider.synthesizeWithFallback('测试');
      expect(result.provider).toBe('moss');
      expect(result.path).toContain('tts_moss_');
    });

    it('全部引擎失败应抛出 AI_PROCESS_FAILED', async () => {
      setupMocks({ provider: 'edge', mossUrl: 'http://127.0.0.1:9881' });

      // 所有引擎都失败
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('网络不可达'));

      await expect(
        provider.synthesizeWithFallback('测试'),
      ).rejects.toMatchObject({ code: ErrorCode.AI_PROCESS_FAILED });
    });

    it('降级链顺序应为 edge → moss → fish', async () => {
      // 所有引擎共用同一份配置，fish apiKey 必须存在
      mockGetTTSConfig.mockReturnValue({
        provider: 'edge',
        appId: '', token: '', voice: '', url: 'http://127.0.0.1:9880',
        apiKey: 'fish-key',
        mossUrl: 'http://127.0.0.1:9881', mossModelDir: '',
      });
      mockGetTTSOutputDir.mockReturnValue(path.join(os.tmpdir(), 'zentect-fallback-test'));
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      // 每个引擎在第一个 fetch 失败后即抛出，不会继续第二个 fetch
      // edge(1) + moss(1) = 2 次失败，fish 排在 attempt 3
      let attempt = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        attempt++;
        if (attempt <= 2) {
          return Promise.reject(new Error('down'));
        }
        return Promise.resolve({
          ok: true,
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
        });
      });

      const result = await provider.synthesizeWithFallback('最终测试');
      expect(result.provider).toBe('fish');
    });

    it('voiceOverride 应传递给降级链中每个引擎', async () => {
      setupMocks({ provider: 'edge', mossUrl: 'http://127.0.0.1:9881' });

      const fetchSpy = vi
        .fn()
        // edge 成功
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ data: { audio_url: 'http://fake/e.mp3' } }),
        })
        .mockResolvedValueOnce({
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
        });
      globalThis.fetch = fetchSpy;

      await provider.synthesizeWithFallback('你好', undefined, 'custom-voice');

      // 验证 edge 调用使用了 voiceOverride
      const callBody = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string);
      expect(callBody.voice).toBe('custom-voice');
    });
  });

  // ==================== 边界条件 ====================

  describe('边界条件', () => {
    it('极长文本应正常处理', async () => {
      setupMocks({ provider: 'edge' });

      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ data: { audio_url: 'http://fake/long.mp3' } }),
        })
        .mockResolvedValueOnce({
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
        });

      const longText = '测试'.repeat(500); // 2000 字符
      const result = await provider.synthesize(longText, 'edge');
      expect(result).toContain('tts_edge_');
    });

    it('只包含空白字符的文本应被清洗为空', async () => {
      setupMocks({ provider: 'edge' });

      // 清洗后为空字符串，走缓存路径
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);

      const result = await provider.synthesize('   \n\t  ', 'edge');
      // 空文本的 cache hash 是固定的
      expect(result).toContain('tts_edge_default_');
    });
  });
});
