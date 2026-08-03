// 📁 路径: src/main/engine/strategies/__tests__/ScriptGenStrategy.test.ts
// ScriptGenStrategy 单元测试
// 重点验证 P0 修复：roles 人物角色名单注入到 step3 prompt

import { describe, it, expect, vi, beforeEach } from 'vitest';

// === Mock 依赖链 ===

/** Mock AppLogger */
vi.mock('../../../core/AppLogger', () => ({
  AppLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

/** Mock LogConstants */
vi.mock('@modules/infra/logger/LogConstants', () => ({
  LOG_TAGS: { AI_AGENT: 'AI_AGENT', SCHEDULER: 'SCHEDULER' },
}));

/** Mock LLMFactory — 返回带 spy 的 adapter，用于断言 prompt 内容 */
const { mockChat } = vi.hoisted(() => ({ mockChat: vi.fn() }));
vi.mock('../../adapters/LLMFactory', () => ({
  LLMFactory: {
    createAdapter: vi.fn(() => ({
      adapter: { chat: mockChat },
      modelName: 'qwen-test',
      temperature: 0.7,
    })),
  },
}));

/** Mock LexiconFilter — 直接透传文本，不做敏感词过滤 */
vi.mock('../../lexicon/LexiconFilter', () => ({
  LexiconFilter: class {
    scan(text: string) {
      return {
        original: text,
        cleanText: text,
        flagged: false,
        replaced: false,
        matches: [],
      };
    }
    getAudioSafeText(cleanText: string) {
      return cleanText;
    }
  },
}));

/** Mock NetworkPipeline — strictParseJson 直接解析 */
vi.mock('../../../core/NetworkPipeline', () => ({
  NetworkPipeline: {
    strictParseJson: vi.fn((s: string) => JSON.parse(s)),
  },
}));

/** Mock personas */
vi.mock('../../prompts/personas', () => ({
  PERSONAS: { SCREENWRITER: '你是一名专业的影视解说编剧。' },
}));

/** Mock constraints — 与 constraints.ts 保持一致，覆盖实现中引用的全部约束 */
vi.mock('../../prompts/constraints', () => ({
  CONSTRAINTS: {
    JSON_ONLY: '【致命约束】：仅输出 JSON',
    NO_MERGE_SENTENCES: '【高颗粒度警告】：不得合并句子',
    PRESERVE_ID: '【溯源协议】：保留 sourceShotId',
    ANTI_LITERAL: '【反看图说话准则】：禁止复述画面动作',
    TTS_FRIENDLY: '【TTS口语化准则】：短句+停顿标记',
    ROLE_ALIAS: '【角色别名轮换准则】：严禁模糊代称',
  },
}));

import { ScriptGenStrategy } from '../ScriptGenStrategy';

// ---------- 测试用例 ----------

describe('ScriptGenStrategy - P0 人物角色注入测试', () => {
  let strategy: ScriptGenStrategy;

  beforeEach(() => {
    strategy = new ScriptGenStrategy();
    vi.clearAllMocks();
    // 默认返回合法 JSON 数组
    mockChat.mockResolvedValue({
      success: true,
      text: JSON.stringify([
        { shotId: 's_01', text: '张三走入画面', duration: 3.5 },
      ]),
    });
  });

  /**
   * 构造标准 step3 输入
   * @param roles 可选的人物角色列表
   */
  function buildInput(roles?: any[]) {
    return {
      scriptStyle: '爆款短视频',
      speechRate: 4.5,
      pipelineParams: {
        narrativePerspective: 'third' as const,
        informationLevel: 'deep' as const,
        narrationDensity: 'standard' as const,
        originalAudioStrategy: 'keep_key' as const,
        rhythmMode: 'mixed' as const,
        emotionTone: 'neutral' as const,
        hookIntensity: 0.7,
        audioVisualWeight: 0.6,
      },
      visionResult: {
        sceneDescriptions: '第1镜: 男子走入室内\n第2镜: 男子拿起杯子',
      },
      audioResult: {
        lines: [{ text: '你好', startMs: 1000 }],
      },
      roles,
    };
  }

  /** 构造执行上下文 */
  function buildContext() {
    return { bus: new Map(), projectId: 'test' } as any;
  }

  // ========== P0: 人物角色名单注入 ==========

  it('传入 roles 时，userPrompt 应包含全局角色列表段（ID→名称映射）', async () => {
    const input = buildInput([
      { id: 'r1', name: '张三', representative: { gender: 1, age: 30 } },
      { id: 'r2', name: '李四', representative: { gender: 0, age: 25 } },
    ]);

    await (strategy as any).performTask(input, buildContext(), '/tmp/cache', vi.fn());

    expect(mockChat).toHaveBeenCalledTimes(1);
    // adapter.chat 签名: (messages, modelName, temperature) → calls[0][0] 是 messages 数组
    const userContent = mockChat.mock.calls[0][0][1].content;
    // 应包含全局角色列表段（阶段2：ID→名称显式映射）
    expect(userContent).toContain('【全局已知角色列表】');
    expect(userContent).toContain('r1 -> 张三');
    expect(userContent).toContain('r2 -> 李四');
    // 应包含性别信息
    expect(userContent).toContain('男');
    expect(userContent).toContain('女');
    // 应包含年龄
    expect(userContent).toContain('30岁');
    expect(userContent).toContain('25岁');
  });

  it('传入 roles 时，应包含禁止模糊代称的硬性准则', async () => {
    const input = buildInput([{ id: 'r1', name: '张三' }]);

    await (strategy as any).performTask(input, buildContext(), '/tmp/cache', vi.fn());

    const userContent = mockChat.mock.calls[0][0][1].content;
    // 应有角色写作硬性准则：严禁使用模糊代称
    expect(userContent).toContain('【角色写作硬性准则】');
    expect(userContent).toContain('严禁');
    expect(userContent).toContain('男子/女子/青年/中年人');
  });

  it('未传入 roles 时，userPrompt 不应包含全局角色列表段', async () => {
    const input = buildInput(); // 不传 roles

    await (strategy as any).performTask(input, buildContext(), '/tmp/cache', vi.fn());

    const userContent = mockChat.mock.calls[0][0][1].content;
    expect(userContent).not.toContain('【全局已知角色列表】');
  });

  it('传入空 roles 数组时，userPrompt 不应包含全局角色列表段', async () => {
    const input = buildInput([]);

    await (strategy as any).performTask(input, buildContext(), '/tmp/cache', vi.fn());

    const userContent = mockChat.mock.calls[0][0][1].content;
    expect(userContent).not.toContain('【全局已知角色列表】');
  });

  it('roles 中缺少 name 字段的角色应被过滤', async () => {
    const input = buildInput([
      { id: 'r1', name: '张三' },
      { id: 'r2' }, // 无 name
      { id: 'r3', name: '' }, // 空 name
    ]);

    await (strategy as any).performTask(input, buildContext(), '/tmp/cache', vi.fn());

    const userContent = mockChat.mock.calls[0][0][1].content;
    expect(userContent).toContain('r1 -> 张三');
    // 不应包含无 name 的角色 ID 映射
    expect(userContent).not.toContain('r2 ->');
    expect(userContent).not.toContain('r3 ->');
  });

  it('全局角色列表应在 ContextChunk 之后注入（时序对齐）', async () => {
    const input = buildInput([{ id: 'r1', name: '张三' }]);

    await (strategy as any).performTask(input, buildContext(), '/tmp/cache', vi.fn());

    const userContent = mockChat.mock.calls[0][0][1].content;
    // 阶段1 ContextChunk 在前，阶段2 角色列表在后
    const contextIdx = userContent.indexOf('【多模态上下文片段流（ContextChunk）】');
    const rolesIdx = userContent.indexOf('【全局已知角色列表】');
    expect(contextIdx).toBeGreaterThan(-1);
    expect(rolesIdx).toBeGreaterThan(contextIdx);
  });

  it('roles 无 representative 字段时应安全降级（只显示 ID→名称，无空括号）', async () => {
    const input = buildInput([{ id: 'r1', name: '王五' }]); // 无 representative

    await (strategy as any).performTask(input, buildContext(), '/tmp/cache', vi.fn());

    const userContent = mockChat.mock.calls[0][0][1].content;
    expect(userContent).toContain('r1 -> 王五');
    // 不应有空括号
    expect(userContent).not.toContain('（）');
  });

  // ========== 基础功能回归（确保 P0 改动不破坏现有逻辑） ==========

  it('无 roles 时仍能正常生成脚本', async () => {
    const input = buildInput();

    const result = await (strategy as any).performTask(
      input, buildContext(), '/tmp/cache', vi.fn()
    );

    // 应返回 { shots: [...] } 格式
    expect(result).toBeDefined();
    expect(result.shots).toBeDefined();
    expect(result.shots.length).toBeGreaterThan(0);
    expect(result.shots[0].text).toBe('张三走入画面');
  });

  it('传入 roles 时仍能正常生成脚本', async () => {
    const input = buildInput([{ id: 'r1', name: '张三' }]);

    const result = await (strategy as any).performTask(
      input, buildContext(), '/tmp/cache', vi.fn()
    );

    expect(result).toBeDefined();
    expect(result.shots).toBeDefined();
    expect(result.shots.length).toBeGreaterThan(0);
  });

  it('visionResult.downstreamContext 优先于 sceneDescriptions 消费', async () => {
    const input = buildInput([{ id: 'r1', name: '张三' }]);
    // 覆盖 visionResult，同时含 downstreamContext 和 sceneDescriptions
    input.visionResult = {
      sceneDescriptions: '应该被忽略的长文本',
      downstreamContext: {
        shots: [
          { action: '走入室内', emotion: '平静', keywords: ['室内', '走路'] },
          { action: '拿起杯子', emotion: '专注', keywords: ['杯子', '手部'] },
        ],
      },
    };

    await (strategy as any).performTask(input, buildContext(), '/tmp/cache', vi.fn());

    const userContent = mockChat.mock.calls[0][0][1].content;
    // 应使用 downstreamContext 的结构化数据，而非 sceneDescriptions
    expect(userContent).toContain('走入室内');
    expect(userContent).toContain('拿起杯子');
    expect(userContent).toContain('平静');
    expect(userContent).not.toContain('应该被忽略的长文本');
  });
});
