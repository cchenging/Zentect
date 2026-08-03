// Module: pipeline/step2-vision - VisionExtractStrategy 单元测试
// 验证 P0-1(JSON Schema)、P0-2(响应式流)、P0-3(下游瘦身) 三项优化

import { describe, it, expect, vi, beforeEach } from 'vitest';

// === Mock 依赖链 ===

/** Mock AppLogger */
vi.mock('../../../../main/core/AppLogger', () => ({
  AppLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

/** Mock LogConstants */
vi.mock('../../../../infra/logger/LogConstants', () => ({
  LOG_TAGS: { AI_AGENT: 'AI_AGENT', MEDIA_ENGINE: 'MEDIA_ENGINE' },
}));

/** Mock pathUtils — dehydrateMagicPath 原样返回路径 */
vi.mock('../../../../main/engine/utils/pathUtils', () => ({
  dehydrateMagicPath: vi.fn((p: string) => p),
}));

/** Mock fs — existsSync 返回 true，readFileSync 返回伪 base64 */
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(() => 'mock_base64_data'),
  },
}));

/** Mock LLMFactory — 返回带 spy 的 adapter，用于断言调用参数 */
const { mockChat } = vi.hoisted(() => ({ mockChat: vi.fn() }));
vi.mock('../../../../main/engine/adapters/LLMFactory', () => ({
  LLMFactory: {
    createAdapter: vi.fn(() => ({
      adapter: { chat: mockChat },
      modelName: 'qwen-vl-test',
    })),
  },
}));

/** Mock VisionProcessor — 不会走到（因为传了 framePaths） */
vi.mock('../../../../main/engine/media/VisionProcessor', () => ({
  VisionProcessor: {
    extractKeyframes: vi.fn(),
  },
}));

/** P1-1 Mock: PerceptualHasher — 默认所有帧都不同（动态），不触发去重 */
const { mockBatchComputePHash, mockIsStaticShot, mockBatchComputeContentHash } = vi.hoisted(() => ({
  mockBatchComputePHash: vi.fn(() => []),
  mockIsStaticShot: vi.fn(() => false),
  mockBatchComputeContentHash: vi.fn(() => new Map()),
}));
vi.mock('../../../../main/engine/media/PerceptualHasher', () => ({
  PerceptualHasher: {
    computePHash: vi.fn(),
    batchComputePHash: mockBatchComputePHash,
    hammingDistance: vi.fn(() => 0),
    isStaticShot: mockIsStaticShot,
    isDynamicShot: vi.fn(() => true),
    computeContentHash: vi.fn(),
    batchComputeContentHash: mockBatchComputeContentHash,
  },
}));

/** P1-2 Mock: VlmFrameCacheRepository — 默认无缓存命中 */
const { mockCacheBatchGet, mockCacheBatchSet } = vi.hoisted(() => ({
  mockCacheBatchGet: vi.fn(() => new Map()),
  mockCacheBatchSet: vi.fn(),
}));
vi.mock('../../../../main/database/repositories/VlmFrameCacheRepository', () => ({
  VlmFrameCacheRepository: class {
    batchGet = mockCacheBatchGet;
    batchSet = mockCacheBatchSet;
    invalidate = vi.fn();
    clearAll = vi.fn();
  },
}));

/** P2 Mock: ContactSheetBuilder — 默认不拼图（返回 null 表示降级为 1x1） */
const { mockSheetBuild, mockSheetCleanup, mockSheetCellCount, mockSheetAutoLayout } = vi.hoisted(() => ({
  mockSheetBuild: vi.fn(() => null),
  mockSheetCleanup: vi.fn(),
  mockSheetCellCount: vi.fn((layout: string) => (layout === '2x2' ? 4 : layout === '3x3' ? 9 : 1)),
  mockSheetAutoLayout: vi.fn(() => '3x3' as const),
}));
vi.mock('../../../../main/engine/media/ContactSheetBuilder', () => ({
  ContactSheetBuilder: {
    build: mockSheetBuild,
    cleanup: mockSheetCleanup,
    getCellCount: mockSheetCellCount,
    autoSelectLayout: mockSheetAutoLayout,
  },
}));

import { VisionExtractStrategy } from '../../../../main/engine/strategies/VisionExtractStrategy';

// ---------- 测试用例 ----------

describe('VisionExtractStrategy - P0 优化测试', () => {
  let strategy: VisionExtractStrategy;

  beforeEach(() => {
    strategy = new VisionExtractStrategy();
    vi.clearAllMocks();
  });

  /**
   * 构造 3 帧的测试输入
   * @param vlmResponse VLM 返回的 JSON 文本
   */
  function buildInput(vlmResponse: string) {
    const input = {
      mediaId: 'test-media',
      mediaPath: '/test/video.mp4',
      framePaths: ['/test/frame1.jpg', '/test/frame2.jpg', '/test/frame3.jpg'],
    };
    const context = { bus: new Map(), projectId: 'test' } as any;
    const onProgress = vi.fn();
    mockChat.mockResolvedValue({ success: true, text: vlmResponse });
    return { input, context, onProgress };
  }

  /** 标准的 3 帧 VLM 响应 */
  const STANDARD_RESPONSE = JSON.stringify({
    frames: [
      {
        narrativeAction: '男子走入画面',
        emotionalState: '平静',
        visualAtmosphere: '暖色调',
        spatialRelation: '中景',
        keywords: ['室内', '男子', '走路'],
      },
      {
        narrativeAction: '男子拿起杯子',
        emotionalState: '专注',
        visualAtmosphere: '柔和光线',
        spatialRelation: '近景',
        keywords: ['杯子', '手部', '特写'],
      },
      {
        narrativeAction: '男子微笑饮茶',
        emotionalState: '愉悦',
        visualAtmosphere: '明亮',
        spatialRelation: '特写',
        keywords: ['微笑', '饮茶', '面部'],
      },
    ],
  });

  // ========== P0-1: JSON Schema 强制结构化输出 ==========

  describe('P0-1: JSON Schema 强制结构化输出', () => {
    it('adapter.chat 应收到 response_format 参数', async () => {
      const { input, context, onProgress } = buildInput(STANDARD_RESPONSE);

      await (strategy as any).performTask(input, context, '/tmp/cache', onProgress);

      expect(mockChat).toHaveBeenCalledTimes(1);
      const callArgs = mockChat.mock.calls[0];
      // 第 4 个参数是 options，应包含 response_format
      const options = callArgs[3];
      expect(options).toBeDefined();
      expect(options.response_format).toBeDefined();
      expect(options.response_format.type).toBe('json_object');
      expect(options.response_format.json_schema).toBeDefined();
      expect(options.response_format.json_schema.name).toBe('vision_frame_analysis');
    });

    it('JSON Schema 应包含 frames 数组定义和 required 字段', async () => {
      const { input, context, onProgress } = buildInput(STANDARD_RESPONSE);

      await (strategy as any).performTask(input, context, '/tmp/cache', onProgress);

      const schema = mockChat.mock.calls[0][3].response_format.json_schema.schema;
      expect(schema.properties.frames).toBeDefined();
      expect(schema.properties.frames.type).toBe('array');
      expect(schema.required).toContain('frames');
      // 子项应包含 keywords 字段（P0-3 需要）
      const itemProps = schema.properties.frames.items.properties;
      expect(itemProps.narrativeAction).toBeDefined();
      expect(itemProps.emotionalState).toBeDefined();
      expect(itemProps.keywords).toBeDefined();
    });

    it('应正确解析 { frames: [...] } 结构的响应', async () => {
      const { input, context, onProgress } = buildInput(STANDARD_RESPONSE);

      const result = await (strategy as any).performTask(input, context, '/tmp/cache', onProgress);

      expect(result.frames).toHaveLength(3);
      expect(result.frames[0].description).toContain('男子走入画面');
      expect(result.frames[0].description).toContain('情绪:平静');
      expect(result.frames[2].description).toContain('男子微笑饮茶');
    });

    it('应兼容旧版裸数组响应（降级兼容）', async () => {
      const legacyArrayResponse = JSON.stringify([
        { narrativeAction: '帧1动作', emotionalState: '开心' },
        { narrativeAction: '帧2动作', emotionalState: '平静' },
        { narrativeAction: '帧3动作', emotionalState: '严肃' },
      ]);
      const { input, context, onProgress } = buildInput(legacyArrayResponse);

      const result = await (strategy as any).performTask(input, context, '/tmp/cache', onProgress);

      expect(result.frames).toHaveLength(3);
      expect(result.frames[0].description).toContain('帧1动作');
      expect(result.frames[2].description).toContain('帧3动作');
    });
  });

  // ========== P0-2: 响应式流单帧推送 ==========

  describe('P0-2: 响应式流单帧推送', () => {
    it('每帧解析完应立即推送 onProgress，而非等批次完成', async () => {
      const { input, context, onProgress } = buildInput(STANDARD_RESPONSE);

      await (strategy as any).performTask(input, context, '/tmp/cache', onProgress);

      // onProgress 调用次数应 >= 帧数（每帧至少 1 次推送 + 其他进度更新）
      const progressCalls = onProgress.mock.calls.length;
      expect(progressCalls).toBeGreaterThanOrEqual(3);

      // 找到带 partialFrames 的推送调用（onProgress 签名: p, s, results，results 在 index 2）
      const partialPushes = onProgress.mock.calls.filter(
        (call: any[]) => call[2] && call[2].partialFrames
      );
      // 应至少有 3 次 partialFrames 推送（每帧一次）
      expect(partialPushes.length).toBeGreaterThanOrEqual(3);
    });

    it('第一次 partialFrames 推送应只包含 1 帧（增量推送）', async () => {
      const { input, context, onProgress } = buildInput(STANDARD_RESPONSE);

      await (strategy as any).performTask(input, context, '/tmp/cache', onProgress);

      const partialPushes = onProgress.mock.calls.filter(
        (call: any[]) => call[2] && call[2].partialFrames
      );
      // 第一次推送应只有 1 帧有描述
      expect(partialPushes[0][2].partialFrames.length).toBe(1);
      // 最后一次推送应有 3 帧
      const lastPush = partialPushes[partialPushes.length - 1];
      expect(lastPush[2].partialFrames.length).toBe(3);
    });

    it('推送的 completedCount 应递增（1, 2, 3）', async () => {
      const { input, context, onProgress } = buildInput(STANDARD_RESPONSE);

      await (strategy as any).performTask(input, context, '/tmp/cache', onProgress);

      const partialPushes = onProgress.mock.calls.filter(
        (call: any[]) => call[2] && call[2].completedCount !== undefined
      );
      const counts = partialPushes.map((c: any[]) => c[2].completedCount);
      // 应出现 1, 2, 3 的递增序列
      expect(counts).toContain(1);
      expect(counts).toContain(2);
      expect(counts).toContain(3);
    });
  });

  // ========== P0-3: 下游瘦身 downstreamPayload ==========

  describe('P0-3: 下游瘦身 downstreamPayload', () => {
    it('输出应包含 downstreamContext 字段', async () => {
      const { input, context, onProgress } = buildInput(STANDARD_RESPONSE);

      const result = await (strategy as any).performTask(input, context, '/tmp/cache', onProgress);

      expect(result.downstreamContext).toBeDefined();
      expect(result.downstreamContext.shots).toHaveLength(3);
    });

    it('downstreamContext.shots 应包含 action/emotion/keywords', async () => {
      const { input, context, onProgress } = buildInput(STANDARD_RESPONSE);

      const result = await (strategy as any).performTask(input, context, '/tmp/cache', onProgress);

      const shot1 = result.downstreamContext.shots[0];
      expect(shot1.action).toBe('男子走入画面');
      expect(shot1.emotion).toBe('平静');
      expect(shot1.keywords).toEqual(['室内', '男子', '走路']);
    });

    it('每帧 frameDetail 应包含 downstream 字段', async () => {
      const { input, context, onProgress } = buildInput(STANDARD_RESPONSE);

      const result = await (strategy as any).performTask(input, context, '/tmp/cache', onProgress);

      expect(result.frames[0].downstream).toBeDefined();
      expect(result.frames[0].downstream.action).toBe('男子走入画面');
      expect(result.frames[1].downstream.keywords).toEqual(['杯子', '手部', '特写']);
    });

    it('VLM 未返回 keywords 时应降级为空数组', async () => {
      const noKeywordsResponse = JSON.stringify({
        frames: [
          { narrativeAction: '动作1', emotionalState: '开心' },
          { narrativeAction: '动作2', emotionalState: '平静' },
          { narrativeAction: '动作3', emotionalState: '严肃' },
        ],
      });
      const { input, context, onProgress } = buildInput(noKeywordsResponse);

      const result = await (strategy as any).performTask(input, context, '/tmp/cache', onProgress);

      expect(result.frames[0].downstream.keywords).toEqual([]);
      expect(result.downstreamContext.shots[0].keywords).toEqual([]);
    });
  });

  // ========== 综合 ==========

  describe('综合行为', () => {
    it('测试模式应限制只分析前 10 帧', async () => {
      // 构造 15 帧输入
      const framePaths = Array.from({ length: 15 }, (_, i) => `/test/frame${i + 1}.jpg`);
      const input = {
        mediaId: 'test-media',
        mediaPath: '/test/video.mp4',
        framePaths,
      };
      const context = { bus: new Map(), projectId: 'test' } as any;
      const onProgress = vi.fn();

      const response15 = JSON.stringify({
        frames: Array.from({ length: 10 }, (_, i) => ({
          narrativeAction: `动作${i + 1}`,
          emotionalState: '平静',
          keywords: [`关键词${i + 1}`],
        })),
      });
      mockChat.mockResolvedValue({ success: true, text: response15 });

      const result = await (strategy as any).performTask(input, context, '/tmp/cache', onProgress);

      // 应只分析 10 帧
      expect(result.framesCount).toBe(10);
      expect(result.frames).toHaveLength(10);
    });
  });

  // ========== P1-1: pHash 视觉去重 ==========

  describe('P1-1: pHash 视觉去重', () => {
    it('pHash 判定为静态镜头的帧应跳过 VLM，复用前一帧描述', async () => {
      // 构造 3 帧，第 2、3 帧判定为静态（复用第 1 帧描述）
      mockBatchComputePHash.mockReturnValue([
        { framePath: '/test/frame1.jpg', hash: 0b1111n },
        { framePath: '/test/frame2.jpg', hash: 0b1111n }, // 与第1帧相同
        { framePath: '/test/frame3.jpg', hash: 0b1111n }, // 与第2帧相同
      ]);
      mockIsStaticShot.mockReturnValue(true); // 所有相邻帧都判为静态

      // 只会为第 1 帧调用 VLM
      const response = JSON.stringify({
        frames: [{ narrativeAction: '动作1', emotionalState: '开心', keywords: ['k1'] }],
      });
      const input = {
        mediaId: 'test-media',
        mediaPath: '/test/video.mp4',
        framePaths: ['/test/frame1.jpg', '/test/frame2.jpg', '/test/frame3.jpg'],
      };
      const context = { bus: new Map(), projectId: 'test' } as any;
      const onProgress = vi.fn();
      mockChat.mockResolvedValue({ success: true, text: response });

      const result = await (strategy as any).performTask(input, context, '/tmp/cache', onProgress);

      // VLM 只调用 1 次（第 2、3 帧被去重跳过）
      expect(mockChat).toHaveBeenCalledTimes(1);
      // 第 2、3 帧应复用第 1 帧描述
      expect(result.frames[0].description).toContain('动作1');
      expect(result.frames[1].description).toContain('动作1');
      expect(result.frames[2].description).toContain('动作1');
    });

    it('所有帧都动态时应全部调用 VLM（不去重）', async () => {
      mockBatchComputePHash.mockReturnValue([
        { framePath: '/test/frame1.jpg', hash: 0b0000n },
        { framePath: '/test/frame2.jpg', hash: 0b1111n },
        { framePath: '/test/frame3.jpg', hash: 0b1010n },
      ]);
      mockIsStaticShot.mockReturnValue(false); // 所有相邻帧都判为动态

      const { input, context, onProgress } = buildInput(STANDARD_RESPONSE);
      await (strategy as any).performTask(input, context, '/tmp/cache', onProgress);

      expect(mockChat).toHaveBeenCalledTimes(1); // 3 帧 1 批
    });
  });

  // ========== P1-2: L2 SQLite 缓存 ==========

  describe('P1-2: L2 SQLite 缓存', () => {
    it('缓存命中的帧应跳过 VLM，直接复用缓存描述', async () => {
      // 构造 3 帧的 contentHash，其中第 1、3 帧命中缓存
      const contentHashMap = new Map([
        ['/test/frame1.jpg', 'hash1'],
        ['/test/frame2.jpg', 'hash2'],
        ['/test/frame3.jpg', 'hash3'],
      ]);
      mockBatchComputeContentHash.mockReturnValue(contentHashMap);

      const cachedMap = new Map([
        ['hash1', {
          frameHash: 'hash1', modelName: 'qwen-vl-test', promptVersion: 'v1',
          resultJson: JSON.stringify({ narrativeAction: '缓存动作1', emotionalState: '缓存情绪' }),
          description: '缓存动作1 情绪:缓存情绪',
        }],
        ['hash3', {
          frameHash: 'hash3', modelName: 'qwen-vl-test', promptVersion: 'v1',
          resultJson: JSON.stringify({ narrativeAction: '缓存动作3', emotionalState: '缓存情绪' }),
          description: '缓存动作3 情绪:缓存情绪',
        }],
      ]);
      mockCacheBatchGet.mockReturnValue(cachedMap);

      // 第 2 帧未命中，需要 VLM 返回
      const response = JSON.stringify({
        frames: [{ narrativeAction: 'VLM动作2', emotionalState: 'VLM情绪', keywords: ['k2'] }],
      });
      const input = {
        mediaId: 'test-media',
        mediaPath: '/test/video.mp4',
        framePaths: ['/test/frame1.jpg', '/test/frame2.jpg', '/test/frame3.jpg'],
      };
      const context = { bus: new Map(), projectId: 'test' } as any;
      const onProgress = vi.fn();
      mockChat.mockResolvedValue({ success: true, text: response });

      const result = await (strategy as any).performTask(input, context, '/tmp/cache', onProgress);

      // VLM 只调用 1 次（只为第 2 帧调用，第 1、3 帧命中缓存）
      expect(mockChat).toHaveBeenCalledTimes(1);
      // 第 1、3 帧应使用缓存描述
      expect(result.frames[0].description).toContain('缓存动作1');
      expect(result.frames[2].description).toContain('缓存动作3');
      // 第 2 帧应使用 VLM 返回
      expect(result.frames[1].description).toContain('VLM动作2');
    });

    it('VLM 分析成功后应写入 L2 缓存', async () => {
      const contentHashMap = new Map([
        ['/test/frame1.jpg', 'hash1'],
        ['/test/frame2.jpg', 'hash2'],
        ['/test/frame3.jpg', 'hash3'],
      ]);
      mockBatchComputeContentHash.mockReturnValue(contentHashMap);
      mockCacheBatchGet.mockReturnValue(new Map()); // 无缓存命中

      const { input, context, onProgress } = buildInput(STANDARD_RESPONSE);
      await (strategy as any).performTask(input, context, '/tmp/cache', onProgress);

      // 应调用 batchSet 写入缓存
      expect(mockCacheBatchSet).toHaveBeenCalledTimes(1);
      const records = mockCacheBatchSet.mock.calls[0][0];
      expect(records).toHaveLength(3);
      expect(records[0].frameHash).toBe('hash1');
      expect(records[0].modelName).toBe('qwen-vl-test');
      expect(records[0].description).toContain('男子走入画面');
    });

    it('全部帧命中缓存时应跳过所有 VLM 调用', async () => {
      const contentHashMap = new Map([
        ['/test/frame1.jpg', 'hash1'],
        ['/test/frame2.jpg', 'hash2'],
        ['/test/frame3.jpg', 'hash3'],
      ]);
      mockBatchComputeContentHash.mockReturnValue(contentHashMap);

      const cachedMap = new Map([
        ['hash1', { frameHash: 'hash1', modelName: 'qwen-vl-test', promptVersion: 'v1',
          resultJson: JSON.stringify({ narrativeAction: '动作1', emotionalState: '情绪1' }),
          description: '动作1 情绪:情绪1' }],
        ['hash2', { frameHash: 'hash2', modelName: 'qwen-vl-test', promptVersion: 'v1',
          resultJson: JSON.stringify({ narrativeAction: '动作2', emotionalState: '情绪2' }),
          description: '动作2 情绪:情绪2' }],
        ['hash3', { frameHash: 'hash3', modelName: 'qwen-vl-test', promptVersion: 'v1',
          resultJson: JSON.stringify({ narrativeAction: '动作3', emotionalState: '情绪3' }),
          description: '动作3 情绪:情绪3' }],
      ]);
      mockCacheBatchGet.mockReturnValue(cachedMap);

      const input = {
        mediaId: 'test-media',
        mediaPath: '/test/video.mp4',
        framePaths: ['/test/frame1.jpg', '/test/frame2.jpg', '/test/frame3.jpg'],
      };
      const context = { bus: new Map(), projectId: 'test' } as any;
      const onProgress = vi.fn();

      const result = await (strategy as any).performTask(input, context, '/tmp/cache', onProgress);

      // VLM 完全不调用
      expect(mockChat).not.toHaveBeenCalled();
      // 不写入缓存（已全部命中）
      expect(mockCacheBatchSet).not.toHaveBeenCalled();
      // 结果应来自缓存
      expect(result.frames[0].description).toContain('动作1');
      expect(result.frames[2].description).toContain('动作3');
    });
  });

  // ========== P2: 动态网格拼图（Contact Sheet） ==========

  describe('P2: 动态网格拼图', () => {
    beforeEach(() => {
      // 重置 P1 相关 mock（vi.clearAllMocks 不清除 implementation，需显式重置）
      mockBatchComputePHash.mockReturnValue([]);
      mockBatchComputeContentHash.mockReturnValue(new Map());
      mockIsStaticShot.mockReturnValue(false);
      mockCacheBatchGet.mockReturnValue(new Map());
      // 重置 ContactSheetBuilder mock
      mockSheetBuild.mockResolvedValue(null);
      mockSheetCleanup.mockClear();
      mockSheetCellCount.mockImplementation((layout: string) =>
        layout === '2x2' ? 4 : layout === '3x3' ? 9 : 1,
      );
      mockSheetAutoLayout.mockReturnValue('3x3');
    });

    it('matrixMode=1x1 时不调用拼图，走多图独立发送', async () => {
      const { input, context, onProgress } = buildInput(STANDARD_RESPONSE);
      (input as any).matrixMode = '1x1';

      await (strategy as any).performTask(input, context, '/tmp/cache', onProgress);

      expect(mockSheetBuild).not.toHaveBeenCalled();
      expect(mockChat).toHaveBeenCalledTimes(1);
    });

    it('matrixMode=2x2 且拼图成功时，应调用 ContactSheetBuilder.build', async () => {
      // 构造 4 帧输入（刚好一个 2x2 批次，同时满足全局摘要阈值 4）
      const framePaths = ['/test/f1.jpg', '/test/f2.jpg', '/test/f3.jpg', '/test/f4.jpg'];
      const input = {
        mediaId: 'm', mediaPath: '/test/v.mp4', framePaths,
        matrixMode: '2x2' as const,
      };
      const context = { bus: new Map(), projectId: 'p' } as any;
      const onProgress = vi.fn();
      const response = JSON.stringify({
        frames: Array.from({ length: 4 }, (_, i) => ({
          narrativeAction: `动作${i + 1}`,
          emotionalState: '平静',
          keywords: [`k${i + 1}`],
        })),
      });
      // 4 帧触发 P3 全局摘要：第一次全局摘要，第二次批次拼图分析
      mockChat
        .mockResolvedValueOnce({ success: true, text: JSON.stringify({ location: '室内', subject: '人物', colorTone: '暖色', narrativeTone: '日常' }) })
        .mockResolvedValueOnce({ success: true, text: response });
      // 模拟拼图成功
      mockSheetBuild.mockResolvedValue({
        gridPath: '/tmp/grid.jpg',
        frameIndices: [0, 1, 2, 3],
        layout: '2x2' as const,
      });

      await (strategy as any).performTask(input, context, '/tmp/cache', onProgress);

      // 应调用拼图（2x2 布局）
      expect(mockSheetBuild).toHaveBeenCalledTimes(1);
      expect(mockSheetBuild.mock.calls[0][1]).toBe('2x2');
      // 应清理临时文件
      expect(mockSheetCleanup).toHaveBeenCalledWith('/tmp/grid.jpg');
      // VLM 调用 2 次：1次全局摘要 + 1次批次拼图分析
      expect(mockChat).toHaveBeenCalledTimes(2);
      // 第二次调用（批次拼图）只发 1 张图（拼图），返回 4 个子项
      const userContent = mockChat.mock.calls[1][0][0].content;
      const images = userContent.filter((c: any) => c.type === 'image_url');
      expect(images).toHaveLength(1); // 拼图模式只发 1 张图
      // prompt 应包含"网格图"字样
      expect(userContent[0].text).toContain('网格图');
    });

    it('matrixMode=3x3 时每批应收集 9 帧', async () => {
      // 构造 9 帧输入（刚好一个 3x3 批次）
      const framePaths = Array.from({ length: 9 }, (_, i) => `/test/f${i + 1}.jpg`);
      const input = {
        mediaId: 'm', mediaPath: '/test/v.mp4', framePaths,
        matrixMode: '3x3' as const,
      };
      const context = { bus: new Map(), projectId: 'p' } as any;
      const onProgress = vi.fn();
      const response = JSON.stringify({
        frames: Array.from({ length: 9 }, (_, i) => ({
          narrativeAction: `动作${i + 1}`,
          emotionalState: '平静',
        })),
      });
      mockChat.mockResolvedValue({ success: true, text: response });
      mockSheetBuild.mockResolvedValue({
        gridPath: '/tmp/grid9.jpg',
        frameIndices: Array.from({ length: 9 }, (_, i) => i),
        layout: '3x3' as const,
      });

      const result = await (strategy as any).performTask(input, context, '/tmp/cache', onProgress);

      // 应调用 3x3 拼图
      expect(mockSheetBuild).toHaveBeenCalledTimes(1);
      expect(mockSheetBuild.mock.calls[0][1]).toBe('3x3');
      // 应解析出 9 帧描述
      expect(result.frames).toHaveLength(9);
      expect(result.frames[0].description).toContain('动作1');
      expect(result.frames[8].description).toContain('动作9');
    });

    it('拼图失败时应降级为 1x1 多图独立发送', async () => {
      const { input, context, onProgress } = buildInput(STANDARD_RESPONSE);
      (input as any).matrixMode = '2x2';
      // 拼图失败返回 null（3 帧不足 4，build 返回 null）
      mockSheetBuild.mockResolvedValue(null);

      await (strategy as any).performTask(input, context, '/tmp/cache', onProgress);

      // 仍应调用 VLM（降级为多图）
      expect(mockChat).toHaveBeenCalledTimes(1);
      const userContent = mockChat.mock.calls[0][0][0].content;
      const images = userContent.filter((c: any) => c.type === 'image_url');
      // 3 帧独立发送（非拼图）
      expect(images.length).toBe(3);
      // prompt 应走"批量帧分析任务"分支（非"网格图"）
      expect(userContent[0].text).toContain('批量帧分析任务');
    });

    it('matrixMode=auto 时应根据帧间隔自动选择布局', async () => {
      // 帧间隔 >= 1.0s 应选 2x2；< 1.0s 应选 3x3
      mockSheetAutoLayout.mockReturnValue('2x2');
      mockSheetBuild.mockResolvedValue(null); // 不实际拼图，只验证布局选择

      const { input, context, onProgress } = buildInput(STANDARD_RESPONSE);
      (input as any).matrixMode = 'auto';

      await (strategy as any).performTask(input, context, '/tmp/cache', onProgress);

      // 应调用 autoSelectLayout
      expect(mockSheetAutoLayout).toHaveBeenCalled();
      // 注意：3 帧不足 4（2x2 的 cellCount），批次会降级为 1x1，不会调用 build
      // 这里只验证 autoSelectLayout 被调用即可
    });

    it('拼图模式下 VLM 返回的子项应按 frameIndices 回填到正确帧', async () => {
      // 构造 4 帧，验证拼图后各帧描述正确回填
      const framePaths = ['/test/f1.jpg', '/test/f2.jpg', '/test/f3.jpg', '/test/f4.jpg'];
      const input = {
        mediaId: 'm', mediaPath: '/test/v.mp4', framePaths,
        matrixMode: '2x2' as const,
      };
      const context = { bus: new Map(), projectId: 'p' } as any;
      const onProgress = vi.fn();
      const response = JSON.stringify({
        frames: [
          { narrativeAction: '第一帧动作', emotionalState: '开心' },
          { narrativeAction: '第二帧动作', emotionalState: '平静' },
          { narrativeAction: '第三帧动作', emotionalState: '严肃' },
          { narrativeAction: '第四帧动作', emotionalState: '兴奋' },
        ],
      });
      mockChat.mockResolvedValue({ success: true, text: response });
      mockSheetBuild.mockResolvedValue({
        gridPath: '/tmp/grid.jpg',
        frameIndices: [0, 1, 2, 3],
        layout: '2x2' as const,
      });

      const result = await (strategy as any).performTask(input, context, '/tmp/cache', onProgress);

      expect(result.frames).toHaveLength(4);
      expect(result.frames[0].description).toContain('第一帧动作');
      expect(result.frames[1].description).toContain('第二帧动作');
      expect(result.frames[2].description).toContain('第三帧动作');
      expect(result.frames[3].description).toContain('第四帧动作');
    });
  });

  // ========== P3: 分层两阶段分析（全局摘要 + 增量描述） ==========

  describe('P3: 分层两阶段分析', () => {
    beforeEach(() => {
      // 重置 P1/P2 相关 mock
      mockBatchComputePHash.mockReturnValue([]);
      mockBatchComputeContentHash.mockReturnValue(new Map());
      mockIsStaticShot.mockReturnValue(false);
      mockCacheBatchGet.mockReturnValue(new Map());
      mockSheetBuild.mockResolvedValue(null);
      mockSheetCleanup.mockClear();
      mockSheetCellCount.mockImplementation((layout: string) =>
        layout === '2x2' ? 4 : layout === '3x3' ? 9 : 1,
      );
      mockSheetAutoLayout.mockReturnValue('3x3');
    });

    /** 全局摘要的标准响应 */
    const GLOBAL_SUMMARY_RESPONSE = JSON.stringify({
      location: '室内办公室',
      subject: '穿白衬衫的男子',
      colorTone: '暖色调柔和光线',
      narrativeTone: '轻松日常',
    });

    it('全局摘要构建成功时，应先调用全局摘要再调用批次分析', async () => {
      // 构造 4 帧输入（满足全局摘要最小帧数阈值 4）
      const framePaths = ['/test/f1.jpg', '/test/f2.jpg', '/test/f3.jpg', '/test/f4.jpg'];
      const input = {
        mediaId: 'm', mediaPath: '/test/v.mp4', framePaths,
        matrixMode: '1x1' as const,
      };
      const context = { bus: new Map(), projectId: 'p' } as any;
      const onProgress = vi.fn();
      const response4 = JSON.stringify({
        frames: Array.from({ length: 4 }, (_, i) => ({
          narrativeAction: `动作${i + 1}`, emotionalState: '平静', keywords: [`k${i + 1}`],
        })),
      });
      // 第一次调用返回全局摘要，第二次返回帧分析
      mockChat
        .mockResolvedValueOnce({ success: true, text: GLOBAL_SUMMARY_RESPONSE })
        .mockResolvedValueOnce({ success: true, text: response4 });

      await (strategy as any).performTask(input, context, '/tmp/cache', onProgress);

      // VLM 应被调用 2 次：1次全局摘要 + 1次批次分析
      expect(mockChat).toHaveBeenCalledTimes(2);
    });

    it('全局摘要成功时，批次 prompt 应包含全局场景上下文和增量描述要求', async () => {
      // 构造 4 帧输入（满足全局摘要最小帧数阈值 4）
      const framePaths = ['/test/f1.jpg', '/test/f2.jpg', '/test/f3.jpg', '/test/f4.jpg'];
      const input = {
        mediaId: 'm', mediaPath: '/test/v.mp4', framePaths,
        matrixMode: '1x1' as const,
      };
      const context = { bus: new Map(), projectId: 'p' } as any;
      const onProgress = vi.fn();
      const response4 = JSON.stringify({
        frames: Array.from({ length: 4 }, (_, i) => ({
          narrativeAction: `动作${i + 1}`, emotionalState: '平静', keywords: [`k${i + 1}`],
        })),
      });
      mockChat
        .mockResolvedValueOnce({ success: true, text: GLOBAL_SUMMARY_RESPONSE })
        .mockResolvedValueOnce({ success: true, text: response4 });

      await (strategy as any).performTask(input, context, '/tmp/cache', onProgress);

      // 第二次调用（批次分析）的 prompt 应包含全局上下文
      const batchCallArgs = mockChat.mock.calls[1];
      const batchUserContent = batchCallArgs[0][0].content;
      const batchText = batchUserContent[0].text;
      expect(batchText).toContain('全局场景上下文');
      expect(batchText).toContain('室内办公室');
      expect(batchText).toContain('穿白衬衫的男子');
      expect(batchText).toContain('增量描述要求');
    });

    it('全局摘要构建失败时应降级，批次 prompt 不含全局上下文', async () => {
      // 构造 4 帧输入（满足全局摘要最小帧数阈值 4）
      const framePaths = ['/test/f1.jpg', '/test/f2.jpg', '/test/f3.jpg', '/test/f4.jpg'];
      const input = {
        mediaId: 'm', mediaPath: '/test/v.mp4', framePaths,
        matrixMode: '1x1' as const,
      };
      const context = { bus: new Map(), projectId: 'p' } as any;
      const onProgress = vi.fn();
      const response4 = JSON.stringify({
        frames: Array.from({ length: 4 }, (_, i) => ({
          narrativeAction: `动作${i + 1}`, emotionalState: '平静', keywords: [`k${i + 1}`],
        })),
      });
      // 全局摘要 VLM 调用失败（success: false）
      mockChat
        .mockResolvedValueOnce({ success: false, error: '全局摘要调用失败' })
        .mockResolvedValueOnce({ success: true, text: response4 });

      await (strategy as any).performTask(input, context, '/tmp/cache', onProgress);

      // VLM 调用 2 次：1次失败的全局摘要 + 1次批次分析
      expect(mockChat).toHaveBeenCalledTimes(2);
      // 第二次（批次分析）的 prompt 不应包含全局上下文
      const batchText = mockChat.mock.calls[1][0][0].content[0].text;
      expect(batchText).not.toContain('全局场景上下文');
    });

    it('无待分析帧时不应构建全局摘要', async () => {
      // 所有帧命中缓存 → framesToAnalyze 为空
      const contentHashMap = new Map([
        ['/test/frame1.jpg', 'hash1'],
        ['/test/frame2.jpg', 'hash2'],
        ['/test/frame3.jpg', 'hash3'],
      ]);
      mockBatchComputeContentHash.mockReturnValue(contentHashMap);
      mockCacheBatchGet.mockReturnValue(new Map([
        ['hash1', { frameHash: 'hash1', modelName: 'qwen-vl-test', promptVersion: 'v1',
          resultJson: JSON.stringify({ narrativeAction: '动作1', emotionalState: '情绪1' }),
          description: '动作1 情绪:情绪1' }],
        ['hash2', { frameHash: 'hash2', modelName: 'qwen-vl-test', promptVersion: 'v1',
          resultJson: JSON.stringify({ narrativeAction: '动作2', emotionalState: '情绪2' }),
          description: '动作2 情绪:情绪2' }],
        ['hash3', { frameHash: 'hash3', modelName: 'qwen-vl-test', promptVersion: 'v1',
          resultJson: JSON.stringify({ narrativeAction: '动作3', emotionalState: '情绪3' }),
          description: '动作3 情绪:情绪3' }],
      ]));

      const input = {
        mediaId: 'test-media',
        mediaPath: '/test/video.mp4',
        framePaths: ['/test/frame1.jpg', '/test/frame2.jpg', '/test/frame3.jpg'],
      };
      const context = { bus: new Map(), projectId: 'test' } as any;
      const onProgress = vi.fn();

      await (strategy as any).performTask(input, context, '/tmp/cache', onProgress);

      // 不应调用 VLM（全部命中缓存，无待分析帧）
      expect(mockChat).not.toHaveBeenCalled();
    });

    it('全局摘要应从待分析帧中均匀采样 4 帧代表帧', async () => {
      // 构造 8 帧输入（验证均匀采样）
      const framePaths = Array.from({ length: 8 }, (_, i) => `/test/f${i + 1}.jpg`);
      const input = {
        mediaId: 'm', mediaPath: '/test/v.mp4', framePaths,
        matrixMode: '1x1' as const,
      };
      const context = { bus: new Map(), projectId: 'p' } as any;
      const onProgress = vi.fn();

      // 全局摘要返回 + 批次分析返回
      mockChat
        .mockResolvedValueOnce({ success: true, text: GLOBAL_SUMMARY_RESPONSE })
        .mockResolvedValueOnce({ success: true, text: JSON.stringify({
          frames: Array.from({ length: 8 }, (_, i) => ({
            narrativeAction: `动作${i + 1}`, emotionalState: '平静',
          })),
        }) });

      await (strategy as any).performTask(input, context, '/tmp/cache', onProgress);

      // 第一次 mockChat 调用是全局摘要，应发送 4 张图（均匀采样）
      const firstCallArgs = mockChat.mock.calls[0];
      const userContent = firstCallArgs[0][0].content;
      const images = userContent.filter((c: any) => c.type === 'image_url');
      expect(images).toHaveLength(4);
      // 应采样到索引 0, 2, 4, 6（8帧的 1/4, 2/4, 3/4 位置）
      // 通过 base64 mock 数据无法直接验证路径，这里验证图片数量为 4 即可
    });
  });

  // ========== 🎭 P4: 人物角色名单注入 ==========

  describe('P4: 人物角色名单注入', () => {
    beforeEach(() => {
      // 重置 P1/P2 相关 mock
      mockBatchComputePHash.mockReturnValue([]);
      mockBatchComputeContentHash.mockReturnValue(new Map());
      mockIsStaticShot.mockReturnValue(false);
      mockCacheBatchGet.mockReturnValue(new Map());
      mockSheetBuild.mockResolvedValue(null);
      mockSheetCleanup.mockClear();
      mockSheetCellCount.mockImplementation((layout: string) =>
        layout === '2x2' ? 4 : layout === '3x3' ? 9 : 1,
      );
      mockSheetAutoLayout.mockReturnValue('3x3');
    });

    it('传入 roles 时，VLM prompt 应包含人物名单段', async () => {
      const { input, context, onProgress } = buildInput(STANDARD_RESPONSE);
      // 注入两个角色
      (input as any).roles = [
        { id: 'r1', name: '张三', representative: { gender: 1, age: 30 } },
        { id: 'r2', name: '李四', representative: { gender: 0, age: 25 } },
      ];

      await (strategy as any).performTask(input, context, '/tmp/cache', onProgress);

      expect(mockChat).toHaveBeenCalledTimes(1);
      const promptText = mockChat.mock.calls[0][0][0].content[0].text;
      // 应包含人物名单段
      expect(promptText).toContain('【已知人物角色】');
      expect(promptText).toContain('张三');
      expect(promptText).toContain('李四');
      // 应包含性别信息（男/女）
      expect(promptText).toContain('男');
      expect(promptText).toContain('女');
      // 应包含年龄
      expect(promptText).toContain('30岁');
      expect(promptText).toContain('25岁');
    });

    it('未传入 roles 时，VLM prompt 不应包含人物名单段', async () => {
      const { input, context, onProgress } = buildInput(STANDARD_RESPONSE);
      // 不设置 roles

      await (strategy as any).performTask(input, context, '/tmp/cache', onProgress);

      const promptText = mockChat.mock.calls[0][0][0].content[0].text;
      expect(promptText).not.toContain('【已知人物角色】');
    });

    it('传入空 roles 数组时，VLM prompt 不应包含人物名单段', async () => {
      const { input, context, onProgress } = buildInput(STANDARD_RESPONSE);
      (input as any).roles = [];

      await (strategy as any).performTask(input, context, '/tmp/cache', onProgress);

      const promptText = mockChat.mock.calls[0][0][0].content[0].text;
      expect(promptText).not.toContain('【已知人物角色】');
    });

    it('roles 中缺少 name 字段的角色应被过滤', async () => {
      const { input, context, onProgress } = buildInput(STANDARD_RESPONSE);
      (input as any).roles = [
        { id: 'r1', name: '张三' },
        { id: 'r2' }, // 无 name
        { id: 'r3', name: '' }, // 空字符串 name
      ];

      await (strategy as any).performTask(input, context, '/tmp/cache', onProgress);

      const promptText = mockChat.mock.calls[0][0][0].content[0].text;
      expect(promptText).toContain('张三');
      // 不应包含无 name 的角色（r2/r3 没有名字文本）
      expect(promptText).not.toContain('r2');
      expect(promptText).not.toContain('r3');
    });

    it('拼图模式下也应注入人物名单', async () => {
      // 构造 4 帧输入（2x2 拼图）
      const framePaths = ['/test/f1.jpg', '/test/f2.jpg', '/test/f3.jpg', '/test/f4.jpg'];
      const input = {
        mediaId: 'm', mediaPath: '/test/v.mp4', framePaths,
        matrixMode: '2x2' as const,
        roles: [
          { id: 'r1', name: '王五', representative: { gender: 1, age: 40 } },
        ],
      };
      const context = { bus: new Map(), projectId: 'p' } as any;
      const onProgress = vi.fn();
      const response = JSON.stringify({
        frames: Array.from({ length: 4 }, (_, i) => ({
          narrativeAction: `动作${i + 1}`,
          emotionalState: '平静',
          keywords: [`k${i + 1}`],
        })),
      });
      mockChat
        .mockResolvedValueOnce({ success: true, text: JSON.stringify({ location: '室内', subject: '人物', colorTone: '暖色', narrativeTone: '日常' }) })
        .mockResolvedValueOnce({ success: true, text: response });
      mockSheetBuild.mockResolvedValue({
        gridPath: '/tmp/grid.jpg',
        frameIndices: [0, 1, 2, 3],
        layout: '2x2' as const,
      });

      await (strategy as any).performTask(input, context, '/tmp/cache', onProgress);

      // 第二次调用（批次拼图）的 prompt 应包含人物名单
      const batchText = mockChat.mock.calls[1][0][0].content[0].text;
      expect(batchText).toContain('【已知人物角色】');
      expect(batchText).toContain('王五');
    });

    it('1x1 模式下也应注入人物名单', async () => {
      const { input, context, onProgress } = buildInput(STANDARD_RESPONSE);
      (input as any).matrixMode = '1x1';
      (input as any).roles = [{ id: 'r1', name: '赵六' }];

      await (strategy as any).performTask(input, context, '/tmp/cache', onProgress);

      const promptText = mockChat.mock.calls[0][0][0].content[0].text;
      expect(promptText).toContain('赵六');
    });

    it('防幻觉约束中应包含人物名称使用指引', async () => {
      const { input, context, onProgress } = buildInput(STANDARD_RESPONSE);
      (input as any).roles = [{ id: 'r1', name: '张三' }];

      await (strategy as any).performTask(input, context, '/tmp/cache', onProgress);

      const promptText = mockChat.mock.calls[0][0][0].content[0].text;
      // 应有指引说明：已知人物用名称，未知人物用泛称
      expect(promptText).toContain('请使用其名称');
      expect(promptText).toContain('男子/女子');
    });
  });
});

