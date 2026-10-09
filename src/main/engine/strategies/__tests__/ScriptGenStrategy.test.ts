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
    ORIGINAL_AUDIO_BRIDGE: '【原声无缝衔接准则】：前段末尾设引出钩子，后段开头承接情绪反转',
  },
}));

import { ScriptGenStrategy, dedupeAdjacentParagraphs, verifyOutlineGrounding } from '../ScriptGenStrategy';
import { AppLogger } from '../../../core/AppLogger';

// ---------- 测试用例 ----------

describe('ScriptGenStrategy - P0 人物角色注入测试', () => {
  let strategy: ScriptGenStrategy;

  beforeEach(() => {
    strategy = new ScriptGenStrategy();
    vi.clearAllMocks();
    // 🎬 三阶段调用序列：call0=阶段A 剧情大纲；call1=LLM 符合度审校；call2=阶段B 主生成
    mockChat
      .mockResolvedValueOnce({
        success: true,
        text: JSON.stringify({
          logline: '张三潜入室内寻找证据，最终直面真相',
          arc: ['开场钩子', '铺垫', '冲突升级', '高潮', '结局'],
          // characterMotives 留空：本组用例会传入不同 roles（含"王五"），避免触发角色名闭包接地违规
          characterMotives: {},
          keyTurns: [{ chunkId: 'chunk_001', turn: '发现关键线索' }],
          hasClearEnding: true,
        }),
      })
      .mockResolvedValueOnce({
        success: true,
        text: JSON.stringify({ fidelity: 0.98, violations: [] }),
      })
      .mockResolvedValue({
        success: true,
        text: JSON.stringify([
          { shotId: 's_01', text: '张三走入画面。', duration: 3.5 },
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
        narrationRatio: 0.7,
        rhythmMode: 'mixed' as const,
        emotionTone: 'neutral' as const,
        hookIntensity: 0.7,
      },
      visionResult: {
        sceneDescriptions: '第1镜: 男子走入室内\n第2镜: 男子拿起杯子',
      } as any,
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

    expect(mockChat).toHaveBeenCalledTimes(3);
    // call0=阶段A（剧情理解），call1=符合度审校，call2=阶段B 主生成 → 断言 calls[2]（阶段B）的 userContent
    const userContent = mockChat.mock.calls[2][0][1].content;
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

    const userContent = mockChat.mock.calls[2][0][1].content;
    // 应有角色写作硬性准则：严禁使用模糊代称
    expect(userContent).toContain('【角色写作硬性准则】');
    expect(userContent).toContain('严禁');
    expect(userContent).toContain('男子/女子/青年/中年人');
  });

  it('未传入 roles 时，userPrompt 不应包含全局角色列表段', async () => {
    const input = buildInput(); // 不传 roles

    await (strategy as any).performTask(input, buildContext(), '/tmp/cache', vi.fn());

    const userContent = mockChat.mock.calls[2][0][1].content;
    expect(userContent).not.toContain('【全局已知角色列表】');
  });

  it('传入空 roles 数组时，userPrompt 不应包含全局角色列表段', async () => {
    const input = buildInput([]);

    await (strategy as any).performTask(input, buildContext(), '/tmp/cache', vi.fn());

    const userContent = mockChat.mock.calls[2][0][1].content;
    expect(userContent).not.toContain('【全局已知角色列表】');
  });

  it('roles 中缺少 name 字段的角色应被过滤', async () => {
    const input = buildInput([
      { id: 'r1', name: '张三' },
      { id: 'r2' }, // 无 name
      { id: 'r3', name: '' }, // 空 name
    ]);

    await (strategy as any).performTask(input, buildContext(), '/tmp/cache', vi.fn());

    const userContent = mockChat.mock.calls[2][0][1].content;
    expect(userContent).toContain('r1 -> 张三');
    // 不应包含无 name 的角色 ID 映射
    expect(userContent).not.toContain('r2 ->');
    expect(userContent).not.toContain('r3 ->');
  });

  it('全局角色列表应在 ContextChunk 之后注入（时序对齐）', async () => {
    const input = buildInput([{ id: 'r1', name: '张三' }]);

    await (strategy as any).performTask(input, buildContext(), '/tmp/cache', vi.fn());

    const userContent = mockChat.mock.calls[2][0][1].content;
    // 阶段1 ContextChunk 在前，阶段2 角色列表在后
    const contextIdx = userContent.indexOf('【多模态上下文片段流（ContextChunk）】');
    const rolesIdx = userContent.indexOf('【全局已知角色列表】');
    expect(contextIdx).toBeGreaterThan(-1);
    expect(rolesIdx).toBeGreaterThan(contextIdx);
  });

  it('roles 无 representative 字段时应安全降级（只显示 ID→名称，无空括号）', async () => {
    const input = buildInput([{ id: 'r1', name: '王五' }]); // 无 representative

    await (strategy as any).performTask(input, buildContext(), '/tmp/cache', vi.fn());

    const userContent = mockChat.mock.calls[2][0][1].content;
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
    expect(result.shots[0].text).toBe('张三走入画面。');
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

    const userContent = mockChat.mock.calls[2][0][1].content;
    // 应使用 downstreamContext 的结构化数据，而非 sceneDescriptions
    expect(userContent).toContain('走入室内');
    expect(userContent).toContain('拿起杯子');
    expect(userContent).toContain('平静');
    expect(userContent).not.toContain('应该被忽略的长文本');
  });

  it('多人物关系字段应透传到 visualContext 供 LLM 消费', async () => {
    const input = buildInput([{ id: 'r1', name: '张三' }]);
    // 多人物结构化数据：主焦点/陪体/交互/场景分类/角色集合
    input.visionResult = {
      downstreamContext: {
        shots: [
          {
            action: '张三举枪质问李四',
            emotion: '阴沉',
            keywords: ['张三', '李四', '对峙'],
            subject: '张三',
            primarySubject: '张三',
            secondarySubjects: ['李四'],
            interaction: '张三举枪质问角落里的李四',
            shotStyle: '双人对峙',
            characters: ['张三', '李四'],
          },
        ],
      },
    };

    await (strategy as any).performTask(input, buildContext(), '/tmp/cache', vi.fn());

    const userContent = mockChat.mock.calls[2][0][1].content;
    // 多人物交互动作应进入 LLM 上下文，而非被丢弃
    expect(userContent).toContain('张三举枪质问角落里的李四');
    expect(userContent).toContain('双人对峙');
    expect(userContent).toContain('张三');
    expect(userContent).toContain('李四');
  });

  it('场景/道具/服装/天气环境字段应透传到 visualContext 供 LLM 消费（剧情的画面事实依据）', async () => {
    const input = buildInput([{ id: 'r1', name: '张三' }]);
    // 步骤2 VLM 结构化产出：场景/关键道具/服装/天气环境
    input.visionResult = {
      downstreamContext: {
        shots: [
          {
            action: '张三在老旧客厅翻找',
            emotion: '紧张',
            keywords: ['客厅', '钥匙'],
            scene: '老旧客厅',
            keyProps: '一把生锈的钥匙',
            costume: '褪色工装',
            weatherEnv: '黄昏暴雨',
          },
        ],
      },
    };

    await (strategy as any).performTask(input, buildContext(), '/tmp/cache', vi.fn());

    const userContent = mockChat.mock.calls[2][0][1].content;
    // 四类字段必须原样进入 LLM 上下文，不得在中途被丢弃（阶段A 剧情接地的事实来源）
    expect(userContent).toContain('老旧客厅');
    expect(userContent).toContain('一把生锈的钥匙');
    expect(userContent).toContain('褪色工装');
    expect(userContent).toContain('黄昏暴雨');
  });
});

// ========== 🎬 两阶段"剧情驱动"解说改造测试 ==========

describe('ScriptGenStrategy - 阶段A 剧情理解（剧情驱动解说）', () => {
  let strategy: ScriptGenStrategy;

  /** 构造标准 step3 输入（剧情驱动测试用） */
  function buildInput() {
    return {
      scriptStyle: '爆款短视频',
      speechRate: 4.5,
      pipelineParams: {
        narrativePerspective: 'third' as const,
        narrationRatio: 0.7,
        rhythmMode: 'mixed' as const,
        emotionTone: 'neutral' as const,
        hookIntensity: 0.7,
      },
      visionResult: {
        sceneDescriptions: '第1镜: 男子走入室内\n第2镜: 男子拿起杯子',
      },
      audioResult: {
        lines: [{ text: '你好', startMs: 1000 }],
      },
    };
  }

  /** 构造执行上下文（剧情驱动测试用） */
  function buildContext() {
    return { bus: new Map(), projectId: 'test' } as any;
  }

  beforeEach(() => {
    strategy = new ScriptGenStrategy();
    vi.clearAllMocks();
    // 阶段A：剧情大纲成功 → 符合度审校通过 → 阶段B：主生成解说数组
    mockChat
      .mockResolvedValueOnce({
        success: true,
        text: JSON.stringify({
          logline: '一个被逼上绝路的人走上复仇之路',
          arc: ['开场钩子', '铺垫', '冲突升级', '高潮', '结局'],
          characterMotives: { 高启强: '从卑微到黑化' },
          keyTurns: [{ chunkId: 'chunk_001', turn: '第一次反抗' }],
          hasClearEnding: true,
        }),
      })
      .mockResolvedValueOnce({
        success: true,
        text: JSON.stringify({ fidelity: 0.98, violations: [] }),
      })
      .mockResolvedValue({
        success: true,
        text: JSON.stringify([{ shotId: 's_01', text: '剧情解说。', duration: 3.0 }]),
      });
  });

  it('应依次调用三次 LLM：阶段A（剧情理解）→ 符合度审校 → 阶段B（主生成）', async () => {
    await (strategy as any).performTask(buildInput(), buildContext(), '/tmp/cache', vi.fn());
    expect(mockChat).toHaveBeenCalledTimes(3);
    // 阶段A 的 userPrompt 应包含"剧情主线"提炼指令与片段流
    const outlineUser = mockChat.mock.calls[0][0][1].content as string;
    expect(outlineUser).toContain('logline');
    expect(outlineUser).toContain('【视频片段流');
    // 阶段A 用低温保证归纳稳定
    expect(mockChat.mock.calls[0][2]).toBe(0.3);
    // 符合度审校为 call1：0 温、max_tokens 1500（判分稳定可复现）
    expect(mockChat.mock.calls[1][2]).toBe(0.0);
    expect(mockChat.mock.calls[1][3]).toEqual({ max_tokens: 1500, response_format: { type: 'json_object' } });
  });

  it('阶段A 成功时，阶段B 的 systemPrompt 应注入【全局剧情大纲】', async () => {
    await (strategy as any).performTask(buildInput(), buildContext(), '/tmp/cache', vi.fn());
    const systemContent = mockChat.mock.calls[2][0][0].content as string;
    // 真正的大纲注入块（buildSystemPrompt 内由 args.plotOutline 条件挂载）
    expect(systemContent).toContain('## 📖 全局剧情大纲');
    expect(systemContent).toContain('【全局剧情大纲】');
    expect(systemContent).toContain('一个被逼上绝路的人走上复仇之路');
    // 剧情思维规则应注入
    expect(systemContent).toContain('贴剧情');
    expect(systemContent).toContain('解读');
  });

  it('阶段A 连续 3 次接地校验不通过（返回数组）时，整条流水线硬失败（不降级、不兜底）', async () => {
    // mockReset 清除 beforeEach 的 mockResolvedValueOnce 队列，避免残留大纲被阶段A 消费
    mockChat.mockReset();
    // 阶段A 恒返回非法格式（数组而非对象）→ 接地校验每次判"大纲不是 JSON 对象"
    mockChat.mockResolvedValue({ success: true, text: JSON.stringify([{ bad: 'array' }]) });
    await expect(
      (strategy as any).performTask(buildInput(), buildContext(), '/tmp/cache', vi.fn()),
    ).rejects.toThrow(/剧情理解失败/);
    // 接地校验在符合度审校之前失败 → 每次尝试仅 1 次 LLM 调用，共重试 MAX_OUTLINE_ATTEMPTS=3 次
    expect(mockChat).toHaveBeenCalledTimes(3);
  });

  it('阶段A 请求失败（success=false）时，重试 3 次后硬失败，告警携带真实错误而非 JSON 契约误报，且 max_tokens 为 8000', async () => {
    // mockReset 清除 beforeEach 的 mockResolvedValueOnce 队列
    mockChat.mockReset();
    // 阶段A 恒返回 success=false（模拟模型加载中 HTTP 503 被适配器吞为失败结果）
    mockChat.mockResolvedValue({ success: false, error: 'HTTP 503: 模型 clip 正在加载' });
    await expect(
      (strategy as any).performTask(buildInput(), buildContext(), '/tmp/cache', vi.fn()),
    ).rejects.toThrow(/剧情理解失败/);
    expect(mockChat).toHaveBeenCalledTimes(3);
    // 🔧 防截断：阶段A 的 max_tokens 应为 8000（第 0 次调用的第 4 个参数）；两阶段需额外输出 chapters 数组，2500 会在长片截断 JSON；response_format 激活 adapter 的 json_object 降级链
    expect(mockChat.mock.calls[0][3]).toEqual({ max_tokens: 8000, response_format: { type: 'json_object' } });
    // 🔧 重试告警应携带真实错误（HTTP 503），而非被吞后的 "Unexpected end of JSON input"
    const warnCalls = vi.mocked(AppLogger.warn).mock.calls;
    const outlineWarn = warnCalls.find((args) => String(args[1]).includes('剧情理解未通过'));
    expect(outlineWarn).toBeDefined();
    const outlineMsg = String(outlineWarn?.[1] ?? '');
    expect(outlineMsg).toContain('HTTP 503: 模型 clip 正在加载');
    expect(outlineMsg).not.toContain('JSON contract damaged');
  });

  it('接地校验不通过时，应把违规明细回灌 prompt 重生成，第二次通过后继续主生成', async () => {
    mockChat.mockReset();
    const badOutline = JSON.stringify({
      logline: '复仇之路', arc: ['开场'], characterMotives: {},
      keyTurns: [{ chunkId: 'chunk_999', turn: '无源转折' }], hasClearEnding: true,
    });
    const goodOutline = JSON.stringify({
      logline: '复仇之路', arc: ['开场'], characterMotives: {},
      keyTurns: [{ chunkId: 'chunk_001', turn: '第一次反抗' }], hasClearEnding: true,
    });
    mockChat
      .mockResolvedValueOnce({ success: true, text: badOutline })   // 第 1 次：chunkId 越界 → 接地失败
      .mockResolvedValueOnce({ success: true, text: goodOutline })  // 第 2 次：修正后接地通过
      .mockResolvedValueOnce({ success: true, text: JSON.stringify({ fidelity: 0.98, violations: [] }) })
      .mockResolvedValue({ success: true, text: JSON.stringify([{ shotId: 's_01', text: '剧情解说。', duration: 3.0 }]) });

    const result = await (strategy as any).performTask(buildInput(), buildContext(), '/tmp/cache', vi.fn());
    expect(result.shots.length).toBeGreaterThan(0);
    // call0=失败大纲，call1=重生成大纲（接地失败时不经审校），call2=审校，call3=阶段B
    expect(mockChat).toHaveBeenCalledTimes(4);
    const retryPrompt = mockChat.mock.calls[1][0][1].content as string;
    expect(retryPrompt).toContain('接地校验未通过');
    expect(retryPrompt).toContain('chunk_999');
  });

  it('剧情符合度低于 95% 时，应把审校违规明细回灌 prompt 重生成，第二次达标后继续主生成', async () => {
    mockChat.mockReset();
    const goodOutline = JSON.stringify({
      logline: '复仇之路', arc: ['开场'], characterMotives: {},
      keyTurns: [{ chunkId: 'chunk_001', turn: '第一次反抗' }], hasClearEnding: true,
    });
    mockChat
      .mockResolvedValueOnce({ success: true, text: goodOutline })
      .mockResolvedValueOnce({ success: true, text: JSON.stringify({ fidelity: 0.5, violations: ['臆造了片段流中不存在的动机'] }) })
      .mockResolvedValueOnce({ success: true, text: goodOutline })
      .mockResolvedValueOnce({ success: true, text: JSON.stringify({ fidelity: 0.98, violations: [] }) })
      .mockResolvedValue({ success: true, text: JSON.stringify([{ shotId: 's_01', text: '剧情解说。', duration: 3.0 }]) });

    const result = await (strategy as any).performTask(buildInput(), buildContext(), '/tmp/cache', vi.fn());
    expect(result.shots.length).toBeGreaterThan(0);
    // call0=大纲，call1=低分审校，call2=重生成大纲，call3=达标审校，call4=阶段B
    expect(mockChat).toHaveBeenCalledTimes(5);
    const retryPrompt = mockChat.mock.calls[2][0][1].content as string;
    expect(retryPrompt).toContain('剧情符合度');
    expect(retryPrompt).toContain('臆造了片段流中不存在的动机');
  });
});

// ========== 🎯 原声无缝衔接规约注入（Step3-D BRIDGE 条件挂载） ==========

describe('ScriptGenStrategy - 原声无缝衔接准则条件注入', () => {
  let strategy: ScriptGenStrategy;

  /** 构造标准 step3 输入（BRIDGE 测试用，narrationRatio 可覆盖） */
  function buildInput(narrationRatio: number) {
    return {
      scriptStyle: '爆款短视频',
      speechRate: 4.5,
      pipelineParams: {
        narrativePerspective: 'third' as const,
        narrationRatio,
        rhythmMode: 'mixed' as const,
        emotionTone: 'neutral' as const,
        hookIntensity: 0.7,
      },
      visionResult: {
        sceneDescriptions: '第1镜: 男子走入室内\n第2镜: 男子拿起杯子',
      },
      audioResult: {
        lines: [{ text: '你好', startMs: 1000 }],
      },
    };
  }

  /** 构造执行上下文（BRIDGE 测试用） */
  function buildContext() {
    return { bus: new Map(), projectId: 'test' } as any;
  }

  beforeEach(() => {
    strategy = new ScriptGenStrategy();
    vi.clearAllMocks();
    // 三阶段：call0=阶段A 大纲成功；call1=符合度审校通过；call2=阶段B 主生成成功
    mockChat
      .mockResolvedValueOnce({
        success: true,
        text: JSON.stringify({
          logline: '复仇之路',
          arc: ['开场', '高潮'],
          characterMotives: {},
          keyTurns: [],
          hasClearEnding: true,
        }),
      })
      .mockResolvedValueOnce({
        success: true,
        text: JSON.stringify({ fidelity: 0.98, violations: [] }),
      })
      .mockResolvedValue({
        // 占位文本需符合碎片化质量校验（assertChapterQuality）要求：
        // 以完结标点收尾且长度 ≥ 4，避免被误判为"碎片化短句"拦截
        success: true,
        text: JSON.stringify([{ shotId: 's_01', text: '这是一段完整的解说词。', duration: 3.0 }]),
      });
  });

  /** 执行 performTask 并返回阶段B 的 systemPrompt 内容 */
  async function getStageBSystemPrompt(input: ReturnType<typeof buildInput>) {
    await (strategy as any).performTask(input, buildContext(), '/tmp/cache', vi.fn());
    // call0=阶段A，call1=符合度审校，call2=阶段B → 取 calls[2]
    return mockChat.mock.calls[2][0][0].content as string;
  }

  it('解说占比 < 100%（留原声空间）时，systemPrompt 应注入【原声无缝衔接准则】', async () => {
    const systemContent = await getStageBSystemPrompt(buildInput(0.7));

    expect(systemContent).toContain('【原声无缝衔接准则】');
    expect(systemContent).toContain('引出钩子');
  });

  it('纯解说覆盖档（占比=1）时，不应浪费 token 注入原声衔接准则', async () => {
    const systemContent = await getStageBSystemPrompt(buildInput(1));

    expect(systemContent).not.toContain('【原声无缝衔接准则】');
    expect(systemContent).not.toContain('keepOriginalAudio');
  });
});

// ========== 🛡️ 碎片化质量校验（assertChapterQuality）回归测试 ==========
// 覆盖用户反馈的两类脏数据：悬空半截句（以汉字收尾无完结标点）+ 完全重复句。
// 命中即抛错触发 LLM 内联重试，绝不静默落库。

describe('ScriptGenStrategy - 碎片化质量校验（assertChapterQuality）', () => {
  let strategy: ScriptGenStrategy;

  /** 构造标准 step3 输入（短时长片段流 → 单阶段） */
  function buildInput() {
    return {
      scriptStyle: '爆款短视频',
      speechRate: 4.5,
      pipelineParams: {
        narrativePerspective: 'third' as const,
        narrationRatio: 0.7,
        rhythmMode: 'mixed' as const,
        emotionTone: 'neutral' as const,
        hookIntensity: 0.7,
      },
      visionResult: {
        sceneDescriptions: '第1镜: 男子走入室内\n第2镜: 男子拿起杯子',
      },
      audioResult: {
        lines: [{ text: '你好', startMs: 1000 }],
      },
    };
  }

  /** 构造执行上下文 */
  function buildContext() {
    return { bus: new Map(), projectId: 'test' } as any;
  }

  /** 阶段A 返回合法大纲 → 符合度审校通过；阶段B 主生成返回自定义分镜数组 */
  function mockStageB(shots: any[]) {
    mockChat
      .mockResolvedValueOnce({
        success: true,
        text: JSON.stringify({
          logline: '复仇之路',
          arc: ['开场', '高潮'],
          characterMotives: {},
          keyTurns: [],
          hasClearEnding: true,
        }),
      })
      .mockResolvedValueOnce({
        success: true,
        text: JSON.stringify({ fidelity: 0.98, violations: [] }),
      })
      .mockResolvedValue({ success: true, text: JSON.stringify(shots) });
  }

  beforeEach(() => {
    strategy = new ScriptGenStrategy();
    vi.clearAllMocks();
  });

  it('悬空半截句（以汉字"却"收尾、无完结标点）应被拦截并抛错', async () => {
    mockStageB([{ shotId: 's_01', text: '传承未断，可崔国明的脚步，却', duration: 3.0 }]);
    await expect(
      (strategy as any).performTask(buildInput(), buildContext(), '/tmp/cache', vi.fn()),
    ).rejects.toThrow(/碎片化半截句/);
  });

  it('悬空半截句（以"在"收尾、无完结标点）应被拦截并抛错', async () => {
    mockStageB([{ shotId: 's_01', text: '这句话，像一盆冷水，浇在', duration: 3.0 }]);
    await expect(
      (strategy as any).performTask(buildInput(), buildContext(), '/tmp/cache', vi.fn()),
    ).rejects.toThrow(/碎片化半截句/);
  });

  it('完全重复句应被拦截并抛错', async () => {
    mockStageB([
      { shotId: 's_01', text: '传承未断，只待春风。', duration: 3.0 },
      { shotId: 's_02', text: '传承未断，只待春风。', duration: 3.0 },
    ]);
    await expect(
      (strategy as any).performTask(buildInput(), buildContext(), '/tmp/cache', vi.fn()),
    ).rejects.toThrow(/完全重复句/);
  });

  it('各段独立完结的合法解说应正常通过（不误伤）', async () => {
    mockStageB([
      { shotId: 's_01', text: '传承未断，只待春风。', duration: 3.0 },
      { shotId: 's_02', text: '脚步却停在了家门口。', duration: 3.0 },
    ]);
    const result = await (strategy as any).performTask(buildInput(), buildContext(), '/tmp/cache', vi.fn());
    expect(result.shots).toBeDefined();
    expect(result.shots.length).toBeGreaterThan(0);
  });

  // ========== 🧹 相邻草稿迭代消歧（deduplicatePrefixIterations）回归测试 ==========
  // 覆盖用户反馈的"同义改写重复"：模型对同一节拍反复打磨写出多个草稿版本，仅保留最终演化版本。

  /** 从 performTask 结果中抽取纯文本序列，便于断言去重后的最终保留版本 */
  function extractTexts(result: any): string[] {
    return (result.shots || []).map((s: any) => (s.text || '').trim());
  }

  it('同义改写草稿迭代："就被叫去→就被人拽→就被人拽住"仅保留最终完整版', async () => {
    mockStageB([
      { shotId: 's_01', text: '崔哥刚歇下，就被叫去', duration: 3.0 },
      { shotId: 's_02', text: '崔哥刚歇下，就被人拽', duration: 3.0 },
      { shotId: 's_03', text: '崔哥刚歇下，就被人拽住，耳边传来怒骂。', duration: 3.0 },
    ]);
    const result = await (strategy as any).performTask(buildInput(), buildContext(), '/tmp/cache', vi.fn());
    expect(extractTexts(result)).toEqual(['崔哥刚歇下，就被人拽住，耳边传来怒骂。']);
  });

  it('渐进展开草稿：多个同前缀版本只保留最终完结句', async () => {
    mockStageB([
      { shotId: 's_01', text: '这话一出，崔哥的儿', duration: 3.0 },
      { shotId: 's_02', text: '这话一出，崔哥的心', duration: 3.0 },
      { shotId: 's_03', text: '这话一出，崔哥的心', duration: 3.0 },
      { shotId: 's_04', text: '这话一出，崔哥的心，彻底定了。', duration: 3.0 },
    ]);
    const result = await (strategy as any).performTask(buildInput(), buildContext(), '/tmp/cache', vi.fn());
    expect(extractTexts(result)).toEqual(['这话一出，崔哥的心，彻底定了。']);
  });

  it('相邻已完结句即使共享长前缀也不误删（保留正常叙事承接）', async () => {
    mockStageB([
      { shotId: 's_01', text: '崔哥刚歇下，就被叫走了。', duration: 3.0 },
      { shotId: 's_02', text: '崔哥刚歇下，就被人拽住。', duration: 3.0 },
    ]);
    const result = await (strategy as any).performTask(buildInput(), buildContext(), '/tmp/cache', vi.fn());
    expect(extractTexts(result).length).toBe(2);
  });

  // ========== 🧩 断句子句级相邻去重（补层）回归测试 ==========
  // 覆盖用户实际投诉：母段落被断句后，其首个子句与上一段逐字相同 ⇒ 该子句被删除（否则 TTS 念 2 遍）。

  it('母段落断句后首个子句与上一段逐字相同 → 该子句被删除，保留后一个子句', async () => {
    mockStageB([
      { shotId: 's_01', text: '电话打不通，接待方人间蒸发，她彻底慌了。', duration: 3.0 },
      { shotId: 's_02', text: '电话打不通，接待方人间蒸发，她彻底慌了。而同一座城里，另一个人的麻烦才刚刚开始。', duration: 5.0 },
    ]);
    const result = await (strategy as any).performTask(buildInput(), buildContext(), '/tmp/cache', vi.fn());
    // 断句后 seg_1 拆成 seg_1_sub_1(=上一段原文) + seg_1_sub_2；首个子句因逐字重复被删
    expect(extractTexts(result)).toEqual([
      '电话打不通，接待方人间蒸发，她彻底慌了。',
      '而同一座城里，另一个人的麻烦才刚刚开始。',
    ]);
    // id 不重排：保留原有的 seg_1_sub_2（跳号属预期），母句 id 体系与 matchUnitId 语义不变
    const ids = (result.shots || []).map((s: any) => s.id);
    expect(ids).toEqual(['seg_0', 'seg_1_sub_2']);
  });

  it('原声段不受断句子句去重影响（空文本上游即剔除；带文本原声段原样保留）', async () => {
    mockStageB([
      { shotId: 's_01', text: '正常解说第一句。', duration: 3.0 },
      { shotId: 's_02', text: '', duration: 3.0, keepOriginalAudio: true },
      { shotId: 's_03', text: '「你给我站住。」', duration: 3.0, keepOriginalAudio: true },
      { shotId: 's_04', text: '正常解说第二句。', duration: 3.0 },
    ]);
    const result = await (strategy as any).performTask(buildInput(), buildContext(), '/tmp/cache', vi.fn());
    // 空文本占位段（原声段空文本）在 normalizeRawShots（deduplicatePrefixIterations）阶段已剔除，
    // 根本不会进入断句去重；带文本的原声段与解说段均原样保留、不受子句去重影响。
    expect(extractTexts(result)).toEqual(['正常解说第一句。', '「你给我站住。」', '正常解说第二句。']);
    const orig = (result.shots || []).filter((s: any) => s.keepOriginalAudio === true);
    expect(orig.length).toBe(1);
  });
});

// ========== 🔇 相邻重复段落去重（dedupeAdjacentParagraphs）回归测试 ==========
// 覆盖生产 bug「台词重复念」：LLM 把同一句解说写进相邻多段，TTS 真的念 2~3 遍。
// 判定：相邻且归一化后完全相同 → 只保留首次出现的那段。

describe('ScriptGenStrategy - 相邻重复段落去重（dedupeAdjacentParagraphs）', () => {
  it('相邻完全相同段落（复读三连）只保留首次出现，返回保留下标', () => {
    const input = [
      { text: '同乡两个字，成了她最后的筹码。' },
      { text: '同乡两个字，成了她最后的筹码。' },
      { text: '同乡两个字，成了她最后的筹码。' },
    ];
    const { paragraphs, keptIndexes } = dedupeAdjacentParagraphs(input);
    expect(paragraphs.map((p) => p.text)).toEqual(['同乡两个字，成了她最后的筹码。']);
    expect(keptIndexes).toEqual([0]);
  });

  it('归一化（trim + 去空白）后相同即视为重复', () => {
    const input = [
      { text: '  电话打不通，接待方人间蒸发，她彻底慌了。  ' },
      { text: '电话打不通，接待方人间蒸发，她彻底慌了。' },
    ];
    const { paragraphs } = dedupeAdjacentParagraphs(input);
    expect(paragraphs.length).toBe(1);
    // 保留下的是首次出现者（含其原始空白形态）
    expect(paragraphs[0].text.trim()).toBe('电话打不通，接待方人间蒸发，她彻底慌了。');
  });

  it('空文本一律保留且不参与比较（连续空原声段不被塌缩）', () => {
    const input = [
      { text: '' },
      { text: '   ' },
      { text: '' },
    ];
    const { paragraphs, keptIndexes } = dedupeAdjacentParagraphs(input);
    expect(paragraphs.length).toBe(3);
    expect(keptIndexes).toEqual([0, 1, 2]);
  });

  it('空文本对相邻判定透明：A / 空 / A 中后一个 A 判为重复被删', () => {
    const input = [{ text: 'A句。' }, { text: '' }, { text: 'A句。' }];
    const { paragraphs, keptIndexes } = dedupeAdjacentParagraphs(input);
    expect(paragraphs.map((p) => p.text)).toEqual(['A句。', '']);
    expect(keptIndexes).toEqual([0, 1]);
  });

  it('非相邻的相同文本不误删（A / B / A 全部保留）', () => {
    const input = [{ text: 'A句。' }, { text: 'B句。' }, { text: 'A句。' }];
    const { paragraphs, keptIndexes } = dedupeAdjacentParagraphs(input);
    expect(paragraphs.map((p) => p.text)).toEqual(['A句。', 'B句。', 'A句。']);
    expect(keptIndexes).toEqual([0, 1, 2]);
  });

  it('无重复时原样返回，keptIndexes 与入参下标一致', () => {
    const input = [{ text: '第一句。' }, { text: '第二句。' }];
    const { paragraphs, keptIndexes } = dedupeAdjacentParagraphs(input);
    expect(paragraphs.map((p) => p.text)).toEqual(['第一句。', '第二句。']);
    expect(keptIndexes).toEqual([0, 1]);
  });
});

// ========== 🧭 阶段A 接地校验（verifyOutlineGrounding）纯函数回归测试 ==========
// 覆盖「剧情必须可回溯到真实 chunk / 角色」的硬约束：任何无源编造（越界 chunkId、
// 角色列表外人名、缺失结局判定、章节结构不齐）都必须被判违规，供上层回灌重生成。

describe('ScriptGenStrategy - 阶段A 接地校验（verifyOutlineGrounding）', () => {
  /** 构造一份单阶段合法大纲（可被各用例覆写特定字段以制造违规） */
  function validOutline(overrides: Record<string, any> = {}) {
    return {
      logline: '张三潜入室内寻找证据，最终直面真相',
      arc: ['开场钩子', '铺垫', '冲突升级', '高潮', '结局'],
      characterMotives: { 张三: '寻找真相' },
      keyTurns: [{ chunkId: 'chunk_001', turn: '发现关键线索' }],
      hasClearEnding: true,
      ...overrides,
    };
  }

  it('单阶段合法大纲（chunkId 与角色名均可回溯）应判通过', () => {
    const r = verifyOutlineGrounding(validOutline(), ['chunk_001', 'chunk_002'], ['张三'], null);
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it('keyTurns 引用片段流中不存在的 chunkId → 判无源编造', () => {
    const r = verifyOutlineGrounding(
      validOutline({ keyTurns: [{ chunkId: 'chunk_999', turn: '无源转折' }] }),
      ['chunk_001', 'chunk_002'],
      ['张三'],
      null,
    );
    expect(r.ok).toBe(false);
    expect(r.violations.join('\n')).toContain('chunk_999');
    expect(r.violations.join('\n')).toContain('无源');
  });

  it('microChunk（chunk_001_1）前缀命中父 chunk → 视为合法（不误伤）', () => {
    const r = verifyOutlineGrounding(
      validOutline({ keyTurns: [{ chunkId: 'chunk_001_1', turn: '细分片段转折' }] }),
      ['chunk_001'],
      ['张三'],
      null,
    );
    expect(r.ok).toBe(true);
  });

  it('keyTurns 缺 chunkId / 缺 turn → 均判违规', () => {
    const r = verifyOutlineGrounding(
      validOutline({ keyTurns: [{ chunkId: '', turn: '' }] }),
      ['chunk_001'],
      ['张三'],
      null,
    );
    expect(r.ok).toBe(false);
    expect(r.violations.join('\n')).toContain('缺 chunkId');
    expect(r.violations.join('\n')).toContain('缺 turn');
  });

  it('characterMotives 出现角色列表之外的人名 → 判凭空创造人物', () => {
    const r = verifyOutlineGrounding(
      validOutline({ characterMotives: { 张三: '寻找真相', 李四: '幕后黑手' } }),
      ['chunk_001'],
      ['张三'],
      null,
    );
    expect(r.ok).toBe(false);
    expect(r.violations.join('\n')).toContain('李四');
    expect(r.violations.join('\n')).toContain('凭空创造人物');
  });

  it('validRoleNames 为空数组时跳过角色项校验（角色列表缺失不误伤）', () => {
    const r = verifyOutlineGrounding(
      validOutline({ characterMotives: { 任意角色: '任意动机' } }),
      ['chunk_001'],
      [],
      null,
    );
    expect(r.ok).toBe(true);
  });

  it('hasClearEnding 非布尔值 → 判结局判定缺失', () => {
    const r = verifyOutlineGrounding(
      validOutline({ hasClearEnding: '是' }),
      ['chunk_001'],
      ['张三'],
      null,
    );
    expect(r.ok).toBe(false);
    expect(r.violations.join('\n')).toContain('hasClearEnding 非布尔值');
  });

  it('logline / arc 缺失 → 均判违规（剧情骨架与阶段脉络缺失）', () => {
    const r = verifyOutlineGrounding(
      validOutline({ logline: '', arc: [] }),
      ['chunk_001'],
      ['张三'],
      null,
    );
    expect(r.ok).toBe(false);
    expect(r.violations.join('\n')).toContain('logline');
    expect(r.violations.join('\n')).toContain('arc');
  });

  it('两阶段 chapters 数量与预划分不符 → 判章节结构未对齐', () => {
    const r = verifyOutlineGrounding(
      validOutline({
        chapters: [
          { index: 1, title: '第一章', summary: '开场' },
          { index: 2, title: '第二章', summary: '结尾' },
        ],
      }),
      ['chunk_001'],
      ['张三'],
      3,
    );
    expect(r.ok).toBe(false);
    expect(r.violations.join('\n')).toContain('chapters 数量应为 3');
  });

  it('两阶段 chapters 编号不连续 / 缺 title / 缺 summary → 逐项判违规', () => {
    const r = verifyOutlineGrounding(
      validOutline({
        chapters: [
          { index: 2, title: '', summary: '有小结无标题' },
          { index: 3, title: '第三章', summary: '' },
        ],
      }),
      ['chunk_001'],
      ['张三'],
      2,
    );
    expect(r.ok).toBe(false);
    const msg = r.violations.join('\n');
    expect(msg).toContain('index 应为 1');
    expect(msg).toContain('index 应为 2');
    expect(msg).toContain('缺 title');
    expect(msg).toContain('缺 summary');
  });

  it('两阶段 chapters 完全对齐 → 判通过', () => {
    const r = verifyOutlineGrounding(
      validOutline({
        chapters: [
          { index: 1, title: '潜入', summary: '张三潜入室内' },
          { index: 2, title: '真相', summary: '直面最终真相' },
        ],
      }),
      ['chunk_001'],
      ['张三'],
      2,
    );
    expect(r.ok).toBe(true);
  });

  it('大纲非 JSON 对象（数组 / null）→ 判违规', () => {
    expect(verifyOutlineGrounding([], ['chunk_001'], ['张三'], null).ok).toBe(false);
    expect(verifyOutlineGrounding(null, ['chunk_001'], ['张三'], null).ok).toBe(false);
    expect(verifyOutlineGrounding([], [], [], null).violations.join('\n')).toContain('不是 JSON 对象');
  });
});
