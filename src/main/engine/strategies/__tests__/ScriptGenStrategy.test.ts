// 📁 路径: src/main/engine/strategies/__tests__/ScriptGenStrategy.test.ts
// ScriptGenStrategy 单元测试
// 重点验证 P0 修复：roles 人物角色名单注入到 step3 prompt

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

import {
  ScriptGenStrategy,
  dedupeAdjacentParagraphs,
  dedupeDuplicateOriginalSegments,
  originalWindowSec,
  verifyOutlineGrounding,
} from '../ScriptGenStrategy';
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

    // call0=阶段A，call1=符合度审校，call2=阶段B 主生成，call3=首尾打磨
    expect(mockChat).toHaveBeenCalledTimes(4);
    // 断言 calls[2]（阶段B）的 userContent
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

  it('首尾打磨的角色名取画面识别，不取步骤1 roles（步骤1 人名不准且非剧中角色名）', async () => {
    const input = buildInput([{ id: 'r1', name: '步骤一假名' }]);
    input.visionResult = {
      downstreamContext: {
        shots: [
          { primarySubject: '梦梦', action: '走入室内' },
          { characters: ['丈夫'], action: '拿起杯子' },
        ],
      },
    } as any;

    await (strategy as any).performTask(input, buildContext(), '/tmp/cache', vi.fn());

    // call3 = 首尾打磨
    const polishUser = mockChat.mock.calls[3][0][1].content as string;
    expect(polishUser).toContain('梦梦、丈夫');
    expect(polishUser).not.toContain('步骤一假名');
  });

  it('首尾打磨过滤「角色_0」占位名，并注入 ASR 台词作为真实人名来源', async () => {
    const input = buildInput([{ id: 'r1', name: '步骤一假名' }]);
    input.visionResult = {
      downstreamContext: {
        shots: [
          { primarySubject: '角色_0', action: '走入室内' },
          { characters: ['角色_1', '梦梦'], action: '拿起杯子' },
        ],
      },
    } as any;
    input.audioResult = {
      lines: [
        { text: '情雨，你听我解释', startMs: 0 },
        { text: '梦梦你别走', startMs: 1000 },
      ],
    };

    await (strategy as any).performTask(input, buildContext(), '/tmp/cache', vi.fn());

    const polishUser = mockChat.mock.calls[3][0][1].content as string;
    // 占位编号不得进入可用角色名（否则文案会写出"角色_0以为嫁对了人"）
    expect(polishUser).not.toContain('角色_0');
    expect(polishUser).not.toContain('角色_1');
    expect(polishUser).toContain('梦梦');
    // 真实剧中人名从原片台词来
    expect(polishUser).toContain('原片台词（ASR，人名以此为准）');
    expect(polishUser).toContain('情雨');
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

  it('应依次调用四次 LLM：阶段A（剧情理解）→ 符合度审校 → 阶段B（主生成）→ 首尾打磨', async () => {
    await (strategy as any).performTask(buildInput(), buildContext(), '/tmp/cache', vi.fn());
    expect(mockChat).toHaveBeenCalledTimes(4);
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
    // call0=失败大纲，call1=重生成大纲（接地失败时不经审校），call2=审校，call3=阶段B，call4=首尾打磨
    expect(mockChat).toHaveBeenCalledTimes(5);
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
    // call0=大纲，call1=低分审校，call2=重生成大纲，call3=达标审校，call4=阶段B，call5=首尾打磨
    expect(mockChat).toHaveBeenCalledTimes(6);
    const retryPrompt = mockChat.mock.calls[2][0][1].content as string;
    expect(retryPrompt).toContain('剧情符合度');
    expect(retryPrompt).toContain('臆造了片段流中不存在的动机');
  });

  it('审校输出「不扣」条目时不得压分：分数由扣分项条数机械计算', async () => {
    mockChat.mockReset();
    const goodOutline = JSON.stringify({
      logline: '复仇之路', arc: ['开场'], characterMotives: {},
      keyTurns: [{ chunkId: 'chunk_001', turn: '第一次反抗' }], hasClearEnding: true,
    });
    mockChat
      .mockResolvedValueOnce({ success: true, text: goodOutline })
      // 实测故障形态：逐条写「暂不扣 / 视为成立」，模型仍自评 0.85
      .mockResolvedValueOnce({
        success: true, text: JSON.stringify({
          fidelity: 0.85,
          deductions: [
            { point: '角色_2 命名为刘白', evidence: 'chunk_220 支持，属音译边界，暂不扣' },
            { point: '章节15 东极岛', evidence: 'chunk_675 支持，不扣' },
            { point: '角色_1 动机', evidence: 'chunk_506 支持，视为成立' },
          ],
        }),
      })
      .mockResolvedValue({ success: true, text: JSON.stringify([{ shotId: 's_01', text: '剧情解说。', duration: 3.0 }]) });

    const result = await (strategy as any).performTask(buildInput(), buildContext(), '/tmp/cache', vi.fn());
    expect(result.shots.length).toBeGreaterThan(0);
    // 无扣分项 ⇒ 直接通过，不触发重生成（call0=大纲，call1=审校，call2=阶段B，call3=首尾打磨）
    expect(mockChat).toHaveBeenCalledTimes(4);
  });

  it('审校返回真实扣分项时按条数计分并回灌重生成', async () => {
    mockChat.mockReset();
    const goodOutline = JSON.stringify({
      logline: '复仇之路', arc: ['开场'], characterMotives: {},
      keyTurns: [{ chunkId: 'chunk_001', turn: '第一次反抗' }], hasClearEnding: true,
    });
    const threeDeductions = JSON.stringify({
      deductions: Array.from({ length: 3 }, (_, i) => ({
        point: `无源编造点${i + 1}`, evidence: '片段流与台词中均无依据',
      })),
    });
    mockChat
      .mockResolvedValueOnce({ success: true, text: goodOutline })
      .mockResolvedValueOnce({ success: true, text: threeDeductions })
      .mockResolvedValueOnce({ success: true, text: goodOutline })
      .mockResolvedValueOnce({ success: true, text: JSON.stringify({ deductions: [] }) })
      .mockResolvedValue({ success: true, text: JSON.stringify([{ shotId: 's_01', text: '剧情解说。', duration: 3.0 }]) });

    const result = await (strategy as any).performTask(buildInput(), buildContext(), '/tmp/cache', vi.fn());
    expect(result.shots.length).toBeGreaterThan(0);
    // call0=大纲，call1=扣分审校，call2=重生成大纲，call3=复审议校，call4=阶段B，call5=首尾打磨
    expect(mockChat).toHaveBeenCalledTimes(6);
    const retryPrompt = mockChat.mock.calls[2][0][1].content as string;
    expect(retryPrompt).toContain('剧情符合度 85.0%');
    expect(retryPrompt).toContain('无源编造点1');
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

  it('systemPrompt 应恒注入【开场点题】硬性要求（与钩子强度无关）', async () => {
    const systemContent = await getStageBSystemPrompt(buildInput(0.7));

    expect(systemContent).toContain('开场点题');
    // 反例必须出现在 prompt 里，LLM 才容易规避"只有代词、不说人是谁"的写法
    expect(systemContent).toContain('五周年这天，他放话要宠她一辈子');
    expect(systemContent).toContain('这是谁的故事');
  });

  it('有明确结局时：注入结局收束 + 末段必须是解说', async () => {
    const systemContent = await getStageBSystemPrompt(buildInput(0.7));

    expect(systemContent).toContain('结尾收束');
    expect(systemContent).toContain('故事讲完了');
    expect(systemContent).toContain('最后一段必须是解说');
  });
});

// ========== 🎬 开放式/悬念式结局仍须收束（2026-10-23 用户反馈"结尾戛然而止"） ==========
describe('ScriptGenStrategy - 开放式结局的收尾指令', () => {
  let strategy: ScriptGenStrategy;

  function buildInput() {
    return {
      scriptStyle: '悬疑解说',
      speechRate: 4.5,
      pipelineParams: {
        narrativePerspective: 'third' as const,
        narrationRatio: 0.7,
        rhythmMode: 'mixed' as const,
        emotionTone: 'neutral' as const,
        hookIntensity: 0.7,
      },
      visionResult: { sceneDescriptions: '第1镜: 女子站在门口', chunks: [] },
      audioResult: { lines: [{ text: '你好', startMs: 1000 }] },
    };
  }

  it('hasClearEnding=false 时也必须注入收束口径，禁止纯氛围句戛然而止', async () => {
    strategy = new ScriptGenStrategy();
    vi.clearAllMocks();
    mockChat
      .mockResolvedValueOnce({
        success: true,
        text: JSON.stringify({
          logline: '名字背后的秘密',
          arc: ['开场', '悬念'],
          characterMotives: {},
          keyTurns: [],
          hasClearEnding: false, // 开放式/悬念式结局
        }),
      })
      .mockResolvedValueOnce({
        success: true,
        text: JSON.stringify({ fidelity: 0.98, violations: [] }),
      })
      .mockResolvedValue({
        success: true,
        text: JSON.stringify([{ shotId: 's_01', text: '这是一段完整的解说词。', duration: 3.0 }]),
      });

    await (strategy as any).performTask(buildInput(), { bus: new Map(), projectId: 'test' } as any, '/tmp/cache', vi.fn());
    const systemContent = mockChat.mock.calls[2][0][0].content as string;

    expect(systemContent).toContain('结尾收束');
    expect(systemContent).toContain('开放式/悬念式结局');
    expect(systemContent).toContain('回扣开场抛出的问题');
    expect(systemContent).toContain('严禁引入新人物/新悬念');
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

// ========== 🎙️ P2 原声占比上限（prompt 约束 + 诊断告警） ==========
// 背景：历史原声占比 0% → 53%，根因是 prompt 主动鼓励「过渡/次要镜头一律标记 keepOriginalAudio」，
// 且规则只限「每段解说之间 1~2 个」没有全局上限。本组锁定：① 上限写进 prompt；② 上限可配；
// ③ 最终产出超限时明确告警、未超限打 info 读数。

describe('ScriptGenStrategy - P2 原声占比上限', () => {
  let strategy: ScriptGenStrategy;
  const ENV_KEY = 'ZENTECT_ORIGINAL_RATIO_MAX';

  /** 构造标准 step3 输入（narrationRatio 缺省 0.7 ⇒ allowOriginalMark=true） */
  function buildInput(narrationRatio = 0.7) {
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

  function buildContext() {
    return { bus: new Map(), projectId: 'test' } as any;
  }

  /** 阶段A 大纲 → 审校通过 → 阶段B 返回指定分镜数组 */
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
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it('缺省上限 25% 应写进原声标记规则；连续原声不再设硬性段数上限（台词完整即可连续）', async () => {
    mockStageB([{ shotId: 's_01', text: '这是一段完整的解说词。', duration: 3.0 }]);
    await (strategy as any).performTask(buildInput(), buildContext(), '/tmp/cache', vi.fn());
    const systemContent = mockChat.mock.calls[2][0][0].content as string;
    expect(systemContent).toContain('全片原声段落占比不得超过 25%');
    // 连续原声允许（只要每段台词可听、完整），旧的「连续不得超过 2 段」硬限已移除
    expect(systemContent).toContain('连续原声段落允许');
    expect(systemContent).not.toContain('连续原声不得超过 2 段');
    // 「一律标记留原声」的鼓励性表述已移除（改为有上限的「优先标记」）
    expect(systemContent).not.toContain('一律标记 "keepOriginalAudio": true');
  });

  it('环境变量 ZENTECT_ORIGINAL_RATIO_MAX 可覆盖上限（0.4 → prompt 40%）', async () => {
    process.env[ENV_KEY] = '0.4';
    mockStageB([{ shotId: 's_01', text: '这是一段完整的解说词。', duration: 3.0 }]);
    await (strategy as any).performTask(buildInput(), buildContext(), '/tmp/cache', vi.fn());
    const systemContent = mockChat.mock.calls[2][0][0].content as string;
    expect(systemContent).toContain('全片原声段落占比不得超过 40%');
    expect(systemContent).not.toContain('全片原声段落占比不得超过 25%');
  });

  it('最终产出原声占比超上限时应 warn 并给出 N/M 段读数', async () => {
    mockStageB([
      { shotId: 's_01', text: '第一句解说。', duration: 3.0 },
      { shotId: 's_02', text: '「你给我站住。」', duration: 3.0, keepOriginalAudio: true },
      { shotId: 's_03', text: '「这事没完。」', duration: 3.0, keepOriginalAudio: true },
      { shotId: 's_04', text: '第二句解说。', duration: 3.0 },
    ]);
    await (strategy as any).performTask(buildInput(), buildContext(), '/tmp/cache', vi.fn());
    const warnMsgs = vi.mocked(AppLogger.warn).mock.calls.map((c) => String(c[1]));
    const hit = warnMsgs.find((m) => m.includes('[文案生成][原声]'));
    expect(hit).toBeDefined();
    expect(hit).toContain('（2/4）');
    expect(hit).toContain('时长占比');
    expect(hit).toContain('超上限');
  });

  it('最终产出原声占比未超上限时应打 info 读数（不告警）', async () => {
    mockStageB([
      { shotId: 's_01', text: '第一句解说词写得足够长，把这一段的画面内容完整讲清楚，总量自然就上去了。', duration: 3.0 },
      { shotId: 's_02', text: '第二句解说词同样写得很饱满，交代清楚人物关系和当下的处境变化，节奏也不拖沓。', duration: 3.0 },
      { shotId: 's_03', text: '第三句解说词继续保持信息密度，把冲突的前因后果一次讲明白，观众不用回看也能懂。', duration: 3.0 },
      { shotId: 's_04', text: '第四句解说词收束这一段，留下悬念把观众送往下一幕，语气自然不生硬也不敷衍。', duration: 3.0 },
      { shotId: 's_05', text: '「你给我站住。」', duration: 3.0, keepOriginalAudio: true },
    ]);
    await (strategy as any).performTask(buildInput(), buildContext(), '/tmp/cache', vi.fn());
    const infoMsgs = vi.mocked(AppLogger.info).mock.calls.map((c) => String(c[1]));
    const hit = infoMsgs.find((m) => m.includes('[文案生成][原声]'));
    expect(hit).toBeDefined();
    expect(hit).toContain('段数占比');
    expect(hit).toMatch(/（1\/\d+）/);
    expect(hit).not.toContain('超上限');
    const warnMsgs = vi.mocked(AppLogger.warn).mock.calls.map((c) => String(c[1]));
    expect(warnMsgs.some((m) => m.includes('[文案生成][原声]'))).toBe(false);
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

describe('ScriptGenStrategy._asrSubLines — 原声段逐行字幕取词', () => {
  const subLines = (asrLines: any[], startMs?: number, endMs?: number) =>
    (ScriptGenStrategy as any)._asrSubLines(asrLines, startMs, endMs);
  const asr = [
    { text: '秀恩爱', startMs: 3000, endMs: 4500 },
    { text: '死得快', startMs: 4600, endMs: 6200 },
    { text: '走办大事去', startMs: 20000, endMs: 22000 },
  ];

  it('窗口内多行中文台词 → 逐行保留各自起止时间', () => {
    expect(subLines(asr, 2800, 6500)).toEqual([
      { text: '秀恩爱', startMs: 3000, endMs: 4500 },
      { text: '死得快', startMs: 4600, endMs: 6200 },
    ]);
  });

  it('窗口只覆盖部分台词 → 只取窗口内的行，且裁剪到窗内', () => {
    expect(subLines(asr, 5000, 7000)).toEqual([{ text: '死得快', startMs: 5000, endMs: 6200 }]);
  });

  it('窗口内无 ASR → 返回空数组（导出退回单条整段字幕）', () => {
    expect(subLines(asr, 9000, 12000)).toEqual([]);
    expect(subLines([], 0, 5000)).toEqual([]);
  });

  it('外语台词 → 返回空数组（无法逐字抄录，交回 LLM 中文译句）', () => {
    expect(subLines([{ text: '안녕하세요 여러분', startMs: 0, endMs: 3000 }], 0, 3000)).toEqual([]);
    expect(subLines([{ text: 'Hello everyone', startMs: 0, endMs: 3000 }], 0, 3000)).toEqual([]);
  });

  it('时间轴非法 → 返回空数组', () => {
    expect(subLines(asr, Number.NaN, 5000)).toEqual([]);
    expect(subLines(asr, 6000, 5000)).toEqual([]);
  });
});

describe('dedupeDuplicateOriginalSegments — 原声同窗同文去重', () => {
  const orig = (id: string, startMs: number, endMs: number, transcript: string) => ({
    id,
    keepOriginalAudio: true,
    audioSource: { sourceStartMs: startMs, sourceEndMs: endMs, transcript },
  });

  it('同源窗 + 同台词（滑窗重复产出）→ 只保留首次出现', () => {
    const r = dedupeDuplicateOriginalSegments([
      orig('seg_5', 376238, 380118, '哪只有短短几天的相遇'),
      orig('seg_6', 376238, 380118, '哪只有短短几天的相遇'),
      orig('seg_7', 376238, 380118, ' 哪只有短短几天的相遇 '),
    ]);
    expect(r.paragraphs.map((p) => p.id)).toEqual(['seg_5']);
    expect(r.removedIds).toEqual(['seg_6', 'seg_7']);
  });

  it('同台词但源窗不同（影片不同时间点复现）→ 不误删', () => {
    const r = dedupeDuplicateOriginalSegments([
      orig('seg_1', 1000, 3000, '你来了'),
      orig('seg_2', 50000, 52000, '你来了'),
    ]);
    expect(r.paragraphs).toHaveLength(2);
    expect(r.removedIds).toEqual([]);
  });

  it('解说段（无 audioSource）→ 不参与去重', () => {
    const r = dedupeDuplicateOriginalSegments([
      { id: 'seg_1', text: '同一句解说' },
      { id: 'seg_2', text: '同一句解说' },
    ]);
    expect(r.paragraphs).toHaveLength(2);
  });

  it('源窗非法（缺失/逆序）→ 不参与去重，避免误删', () => {
    const r = dedupeDuplicateOriginalSegments([
      { id: 'seg_1', keepOriginalAudio: true, audioSource: { transcript: '无窗台词' } },
      { id: 'seg_2', keepOriginalAudio: true, audioSource: { sourceStartMs: 900, sourceEndMs: 900, transcript: '无窗台词' } },
    ]);
    expect(r.paragraphs).toHaveLength(2);
  });
});

describe('originalWindowSec — 原声段占用的成片秒数', () => {
  it('优先取 audioSource 源时间窗', () => {
    expect(originalWindowSec({
      audioSource: { sourceStartMs: 1000, sourceEndMs: 4500 },
      duration: 99,
    })).toBeCloseTo(3.5);
  });

  it('缺源窗时回退 duration', () => {
    expect(originalWindowSec({ duration: 4.2 })).toBeCloseTo(4.2);
  });

  it('源窗逆序 / 缺 duration → 返回 0（不参与时长预算）', () => {
    expect(originalWindowSec({ audioSource: { sourceStartMs: 5000, sourceEndMs: 1000 } })).toBe(0);
    expect(originalWindowSec({})).toBe(0);
  });
});

// 🎬 首尾打磨（2026-10-23）：开头按两拍（首 2 段，≈6s）/ 结尾按收束（末 2 段）做定向改写
describe('首尾打磨 polishHeadTail', () => {
  let strategy: ScriptGenStrategy;

  beforeEach(() => {
    strategy = new ScriptGenStrategy();
    mockChat.mockReset();
  });

  /** 6 段片子：0/1 为首（两拍），4/5 为尾，2/3 为中间段 */
  function makeShots() {
    return [
      { id: 'seg_0', text: '五周年这天他放话要宠她一辈子。', duration: 3 },
      { id: 'seg_1', text: '她笑着点头。', duration: 3 },
      { id: 'seg_2', text: '中间段一。', duration: 3 },
      { id: 'seg_3', text: '中间段二。', duration: 3 },
      { id: 'seg_4', text: '她关上门走了。', duration: 3 },
      { id: 'seg_5', text: '一切归于平静。', duration: 3 },
    ];
  }

  function polish(shots: any[]) {
    return (strategy as any).polishHeadTail({
      shots,
      adapter: { chat: mockChat },
      modelName: 'qwen-test',
      temperature: 0.7,
      speechRate: 4.5,
      densityFillRate: 1,
      discountFactor: 1,
    });
  }

  it('只改写首 2 段 / 末 2 段，中间段一字不动；缺完结标点自动补句号', async () => {
    mockChat.mockResolvedValue({
      success: true,
      text: JSON.stringify([
        { id: 'seg_0', text: '新娘林晚在五周年这天听见丈夫要把她宠上天' },
        { id: 'seg_1', text: '可同一趟航班上还坐着另一个女人——她还不知道机票是买给三个人的' },
        { id: 'seg_4', text: '她终于关上门把五年婚姻留在身后。' },
        { id: 'seg_5', text: '那个女人赢了宠爱却输了整个人生。' },
      ]),
    });

    const shots = makeShots();
    const stat = await polish(shots);

    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(stat).toEqual({ total: 4, headRewritten: 2, tailRewritten: 2 });
    expect(shots[0].text).toBe('新娘林晚在五周年这天听见丈夫要把她宠上天。');
    expect(shots[1].text).toBe('可同一趟航班上还坐着另一个女人——她还不知道机票是买给三个人的。');
    expect(shots[2].text).toBe('中间段一。');
    expect(shots[3].text).toBe('中间段二。');
    expect(shots[4].text).toBe('她终于关上门把五年婚姻留在身后。');
    expect(shots[5].text).toBe('那个女人赢了宠爱却输了整个人生。');
  });

  it('首尾为原声段时改写后转为解说（原声结尾=话音一停进黑屏）', async () => {
    mockChat.mockResolvedValue({
      success: true,
      text: JSON.stringify([
        { id: 'seg_0', text: '新娘林晚在婚礼当天被丈夫当众许下承诺。' },
        { id: 'seg_1', text: '她以为自己终于等到了幸福。' },
        { id: 'seg_4', text: '五年后她亲手结束了这段婚姻。' },
        { id: 'seg_5', text: '门在身后关上的那一刻她没有回头。' },
      ]),
    });

    const shots = makeShots() as any[];
    shots[0].keepOriginalAudio = true;
    shots[0].type = 'original_audio';
    shots[0].audioSource = { transcript: '我会宠你一辈子' };
    shots[5].keepOriginalAudio = true;
    shots[5].type = 'original_audio';
    shots[5].audioSource = { transcript: '砰' };

    await polish(shots);

    for (const idx of [0, 5]) {
      expect(shots[idx].keepOriginalAudio).toBe(false);
      expect(shots[idx].type).toBe('narration');
      expect(shots[idx].audioSource).toBeUndefined();
    }
    // 中间段不受影响
    expect(shots[2].keepOriginalAudio).toBeUndefined();
  });

  it('响应只覆盖部分 id 时，未返回的段保留原文', async () => {
    mockChat.mockResolvedValue({
      success: true,
      text: JSON.stringify([{ id: 'seg_0', text: '林晚的五年婚姻从一场承诺开始。' }]),
    });

    const shots = makeShots();
    const stat = await polish(shots);

    expect(stat).toEqual({ total: 1, headRewritten: 1, tailRewritten: 0 });
    expect(shots[0].text).toBe('林晚的五年婚姻从一场承诺开始。');
    expect(shots[1].text).toBe('她笑着点头。');
  });

  it('响应被包进对象（json_object 模式）时仍能按 results 提取', async () => {
    mockChat.mockResolvedValue({
      success: true,
      text: JSON.stringify({
        results: [
          { id: 'seg_0', text: '林晚的婚姻从一场当众承诺开始。' },
          { id: 'seg_5', text: '她把每一张脸都记下，等着算账。' },
        ],
      }),
    });

    const shots = makeShots();
    const stat = await polish(shots);

    expect(stat).toEqual({ total: 2, headRewritten: 1, tailRewritten: 1 });
    expect(shots[0].text).toBe('林晚的婚姻从一场当众承诺开始。');
    expect(shots[5].text).toBe('她把每一张脸都记下，等着算账。');
  });

  it('条目用 shotId / indexInFilm 寻址时也能落位（模型自编号不致命）', async () => {
    mockChat.mockResolvedValue({
      success: true,
      text: JSON.stringify({
        // 未锁死 key；两条用 shotId，两条只有 indexInFilm（1-based）
        data: [
          { shotId: 'seg_0', text: '林晚的婚姻从一场当众承诺开始。' },
          { indexInFilm: 2, text: '她以为这是幸福的开端。' },
          { indexInFilm: 5, text: '她终于关上门把五年留在了身后。' },
          { shotId: 'seg_5', text: '那个女人赢了宠爱却输了人生。' },
        ],
      }),
    });

    const shots = makeShots();
    const stat = await polish(shots);

    expect(stat).toEqual({ total: 4, headRewritten: 2, tailRewritten: 2 });
    expect(shots[1].text).toBe('她以为这是幸福的开端。');
    expect(shots[4].text).toBe('她终于关上门把五年留在了身后。');
    // indexInFilm=5 指向 shots[4]，不得错落到 shots[5]
    expect(shots[5].text).toBe('那个女人赢了宠爱却输了人生。');
  });

  it('响应为 id→text 扁平映射时也能解析', async () => {
    mockChat.mockResolvedValue({
      success: true,
      text: JSON.stringify({
        seg_0: '林晚的婚姻从一场当众承诺开始。',
        seg_5: '那个女人赢了宠爱却输了人生。',
      }),
    });

    const shots = makeShots();
    const stat = await polish(shots);

    expect(stat).toEqual({ total: 2, headRewritten: 1, tailRewritten: 1 });
    expect(shots[0].text).toBe('林晚的婚姻从一场当众承诺开始。');
    expect(shots[5].text).toBe('那个女人赢了宠爱却输了人生。');
  });

  it('解析到内容却一条都落不上时，打印可定位的告警（不静默）', async () => {
    mockChat.mockResolvedValue({
      success: true,
      text: JSON.stringify([{ id: 's_01', text: '自编号开篇。' }, { id: 's_02', text: '自编号结尾。' }]),
    });

    const shots = makeShots();
    const stat = await polish(shots);

    // 条数 2 ≠ 目标 5 ⇒ 顺序兜底不生效，保持原文
    expect(stat).toEqual({ total: 0, headRewritten: 0, tailRewritten: 0 });
    const warn = vi.mocked(AppLogger.warn).mock.calls.find((args) => String(args[1]).includes('响应无法匹配段落'));
    expect(warn).toBeDefined();
    expect(String(warn?.[1])).toContain('s_01');
    expect(String(warn?.[1])).toContain('seg_0');
  });

  it('userPrompt 注入故事主线 / 角色名 / 全片段落顺序（缺了它只能换修辞，改不出点题）', async () => {
    mockChat.mockResolvedValue({
      success: true,
      text: JSON.stringify([{ id: 'seg_0', text: '林晚在五周年这天听见丈夫许下承诺。' }]),
    });

    const shots = makeShots();
    await (strategy as any).polishHeadTail({
      shots,
      adapter: { chat: mockChat },
      modelName: 'qwen-test',
      temperature: 0.7,
      speechRate: 4.5,
      densityFillRate: 1,
      discountFactor: 1,
      filmContext: {
        logline: '林晚发现丈夫的宠爱是一场交易',
        arc: ['承诺', '背叛', '清算'],
        roleNames: ['林晚', '陈默'],
      },
    });

    const userContent = mockChat.mock.calls[0][0][1].content as string;
    expect(userContent).toContain('故事主线：林晚发现丈夫的宠爱是一场交易');
    expect(userContent).toContain('可用角色名（剧情/画面识别）：林晚、陈默');
    expect(userContent).toContain('全片段落顺序：');
    expect(userContent).toContain('中间段一');
    // 结尾硬约束：延后句是实测反例，必须写进 system prompt
    const systemContent = mockChat.mock.calls[0][0][0].content as string;
    expect(systemContent).toContain('答案正在拼齐');
    expect(systemContent).toContain('两拍结构');
    expect(systemContent).toContain('headBeat=1（事件信号拍');
    expect(systemContent).toContain('headBeat=2（证据＋悬念拍');
    expect(systemContent).toContain('照片疑云已悄然逼近');
    expect(systemContent).toContain('出轨、背叛、外面有人');
    expect(systemContent).toContain('【语句规范】');
    expect(systemContent).toContain('丈夫出轨的照片');
  });

  it('开头段 payload 不携带 currentText（避免被旧句锚定成同义句），结尾段保留', async () => {
    mockChat.mockResolvedValue({
      success: true,
      text: JSON.stringify([{ id: 'seg_0', text: '林晚在五周年这天等来的不是礼物。' }]),
    });

    const shots = makeShots();
    await polish(shots);

    const userContent = mockChat.mock.calls[0][0][1].content as string;
    const payload = JSON.parse(userContent.slice(userContent.indexOf('待打磨段落：') + '待打磨段落：'.length)) as any[];
    const headItems = payload.filter((p) => p.position === 'head');
    const tailItems = payload.filter((p) => p.position === 'tail');
    expect(headItems.length).toBe(2);
    expect(headItems.map((p) => p.headBeat)).toEqual([1, 2]);
    // 常规预算 9 字写不下事件信号 → 开头两拍给 18 字下限
    expect(headItems.every((p) => p.charBudget >= 18)).toBe(true);
    expect(headItems.every((p) => p.currentText === undefined)).toBe(true);
    expect(tailItems.every((p) => typeof p.currentText === 'string')).toBe(true);
  });

  it('调用失败时抛错（由调用方 catch 保留原文，不阻断主流程）', async () => {
    mockChat.mockResolvedValue({ success: false, error: 'HTTP 503: 模型加载中' });

    await expect(polish(makeShots())).rejects.toThrow(/HTTP 503/);
  });

  it('空镜头列表不发请求，直接返回零计数', async () => {
    const stat = await polish([]);
    expect(mockChat).not.toHaveBeenCalled();
    expect(stat).toEqual({ total: 0, headRewritten: 0, tailRewritten: 0 });
  });
});
