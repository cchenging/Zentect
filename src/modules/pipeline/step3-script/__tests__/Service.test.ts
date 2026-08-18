// Module: pipeline/step3-script - ScriptGenerator 单元测试

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScriptGenerator } from '../backend/Service';
import { AppError, ErrorCode } from '@modules/infra/error/AppError';
import type { Step3Input } from '../types';

// ---------- helpers ----------

/** 构造合法的 Step3Input */
function makeInput(overrides: Partial<Step3Input> = {}): Step3Input {
  return {
    vlmFrames: [
      { url: '/frames/01.jpg', description: '城市天际线夜景', editing: false, confirmed: true, timeMs: 0 },
      { url: '/frames/02.jpg', description: '繁忙的十字路口', editing: false, confirmed: true, timeMs: 4000 },
      { url: '/frames/03.jpg', description: '人物特写微笑', editing: false, confirmed: false, timeMs: 8000 },
    ],
    scriptStyle: '硬核科普',
    speechRate: 4.5,
    pipelineParams: {
      narrativePerspective: 'third',
      informationLevel: 'deep',
      narrationDensity: 'standard',
      originalAudioStrategy: 'keep_key',
      rhythmMode: 'mixed',
      emotionTone: 'neutral',
      hookIntensity: 0.7,
      audioVisualWeight: 0.6,
    },
    ...overrides,
  };
}

/** 构造模拟的 LLM 返回 JSON */
function makeLLMResponse(
  shots: Array<{ shotId?: string; text?: string; duration?: number; keepOriginalAudio?: boolean }>,
): string {
  return JSON.stringify(shots);
}

// ---------- tests ----------

describe('ScriptGenerator', () => {
  let generator: ScriptGenerator;
  let mockLLM: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockLLM = vi.fn();
    // 🔧 修复 TS2345：vi.fn() 的 Mock 类型与 LLMChatFn 不直接兼容，使用断言对齐
    generator = new ScriptGenerator(mockLLM as any);
  });

  // ==================== buildSceneContext ====================

  describe('buildSceneContext', () => {
    it('应将 VlmFrame[] 转为编号的帧描述', () => {
      const frames = makeInput().vlmFrames;
      const ctx = generator.buildSceneContext(frames);

      expect(ctx).toContain('[Frame 1]');
      expect(ctx).toContain('城市天际线夜景');
      expect(ctx).toContain('[Frame 2]');
      expect(ctx).toContain('[Frame 3]');
    });

    it('description 为空时应有占位文本', () => {
      const frames = [
        { url: '/f.jpg', description: '', editing: false, confirmed: false },
      ];
      const ctx = generator.buildSceneContext(frames);

      expect(ctx).toContain('(无描述)');
    });

    it('空数组应抛出 AI_PROCESS_FAILED', () => {
      expect(() => generator.buildSceneContext([])).toThrow(AppError);
      try {
        generator.buildSceneContext([]);
      } catch (e: any) {
        expect(e.code).toBe(ErrorCode.AI_PROCESS_FAILED);
        expect(e.message).toContain('视觉帧');
      }
    });

    it('undefined 应抛出异常', () => {
      expect(() => generator.buildSceneContext(undefined as any)).toThrow(AppError);
    });
  });

  // ==================== estimateTargetWords ====================

  describe('estimateTargetWords', () => {
    it('3 帧 × 4 秒/帧 × 4.5 字/秒 = 54 字', () => {
      const words = generator.estimateTargetWords(3, 4.5);
      expect(words).toBe(54);
    });

    it('1 帧 × 4 秒/帧 × 3 字/秒 = 12 字', () => {
      const words = generator.estimateTargetWords(1, 3);
      expect(words).toBe(12);
    });

    it('0 帧应返回 0', () => {
      const words = generator.estimateTargetWords(0, 5);
      expect(words).toBe(0);
    });
  });

  // ==================== estimatePerFrameWords ====================

  describe('estimatePerFrameWords', () => {
    it('3 秒帧 × 4.5 字/秒 ≈ 13 字', () => {
      const words = generator.estimatePerFrameWords(3, 4.5);
      expect(words).toBe(13);
    });

    it('5 秒帧 × 4 字/秒 = 20 字', () => {
      const words = generator.estimatePerFrameWords(5, 4);
      expect(words).toBe(20);
    });

    it('0 秒帧返回 0', () => {
      const words = generator.estimatePerFrameWords(0, 5);
      expect(words).toBe(0);
    });
  });

  // ==================== buildSystemPrompt ====================

  describe('buildSystemPrompt', () => {
    it('应包含风格名称', () => {
      const prompt = generator.buildSystemPrompt(makeInput({ scriptStyle: '硬核科普' }));
      expect(prompt).toContain('硬核科普');
    });

    it('应包含融合方案参数百分比（hookIntensity/audioVisualWeight/densityFillRate）', () => {
      const prompt = generator.buildSystemPrompt(
        makeInput({
          pipelineParams: {
            narrativePerspective: 'third',
            informationLevel: 'deep',
            narrationDensity: 'full',
            originalAudioStrategy: 'original_main',
            rhythmMode: 'short_fast',
            emotionTone: 'epic',
            hookIntensity: 0.8,
            audioVisualWeight: 0.3,
          },
        }),
      );

      // hookIntensity=0.8 → 80%
      expect(prompt).toContain('80%');
      // audioVisualWeight 由 originalAudioStrategy 经 SSOT 映射：original_main → 0.2 → 20%
      expect(prompt).toContain('20%');
      // narrationDensity=full(1.0) × original_main 折扣(0.45) → densityFillRate=0.45 → 45%
      expect(prompt).toContain('45%');
    });

    it('应包含语速约束', () => {
      const prompt = generator.buildSystemPrompt(makeInput({ speechRate: 3.5 }));

      // 语速以"时长(秒) × 语速"形式写入字数预算公式
      expect(prompt).toContain('× 3.5 ×');
    });

    it('未知风格应 fallback 为爆款短视频', () => {
      const prompt = generator.buildSystemPrompt(
        makeInput({ scriptStyle: '不存在的风格' as any }),
      );

      expect(prompt).toContain('爆款短视频');
    });

    it('缺失 pipelineParams 应使用默认值（hookIntensity=70%）', () => {
      const input = makeInput();
      delete (input as any).pipelineParams;
      const prompt = generator.buildSystemPrompt(input);

      // 默认 hookIntensity=0.7 → 70%
      expect(prompt).toContain('70%');
    });

    it('缺失 speechRate 应使用默认 4.5', () => {
      const input = makeInput();
      delete (input as any).speechRate;
      const prompt = generator.buildSystemPrompt(input);

      expect(prompt).toContain('× 4.5 ×');
    });

    it('应要求返回 JSON 数组格式', () => {
      const prompt = generator.buildSystemPrompt(makeInput());

      expect(prompt).toContain('JSON');
      expect(prompt).toContain('shotId');
      expect(prompt).toContain('text');
    });

    it('所有 6 种风格应均有映射', () => {
      const styles = ['爆款短视频', '深度解说', '评述视角', '情感叙事', '悬疑推理', '硬核科普'];

      for (const style of styles) {
        const prompt = generator.buildSystemPrompt(makeInput({ scriptStyle: style as any }));
        expect(prompt).toContain(style);
      }
    });

    it('应包含专业解说参数指引（8维参数映射）', () => {
      const prompt = generator.buildSystemPrompt(makeInput());

      // 验证所有参数维度都映射到 prompt
      expect(prompt).toContain('叙事视角');
      expect(prompt).toContain('信息层次');
      expect(prompt).toContain('解说密度');
      expect(prompt).toContain('原声策略');
      expect(prompt).toContain('节奏模式');
      expect(prompt).toContain('情绪基调');
      expect(prompt).toContain('声画权重');
    });

    it('应包含反看图说话与 TTS 口语化准则', () => {
      const prompt = generator.buildSystemPrompt(makeInput());

      expect(prompt).toContain('反看图说话');
      expect(prompt).toContain('TTS口语化');
      expect(prompt).toContain('角色别名轮换');
    });

    it('应采用 Markdown 结构（## Task / 爆款短句卡点规则 / ## Output Format）', () => {
      const prompt = generator.buildSystemPrompt(makeInput());

      expect(prompt).toContain('## Task');
      expect(prompt).toContain('## ⚡ 爆款短句与卡点硬性规则');
      expect(prompt).toContain('## Output Format');
      // 验证卡点规则包含硬性准则
      expect(prompt).toContain('角色名称绝对统一');
      expect(prompt).toContain('单句字数硬限制');
      expect(prompt).toContain('消除视觉幻觉');
      expect(prompt).toContain('拒绝流水账');
    });
  });

  // ==================== buildUserPrompt ====================

  describe('buildUserPrompt', () => {
    it('应包含场景上下文', () => {
      const sceneCtx = '[Frame 1]: 测试画面\n[Frame 2]: 另一画面';
      const prompt = generator.buildUserPrompt(makeInput(), sceneCtx);

      expect(prompt).toContain('原片画面扫描日志');
      expect(prompt).toContain('测试画面');
      expect(prompt).toContain('JSON 数组');
    });
  });

  // ==================== parseScriptResponse ====================

  describe('parseScriptResponse', () => {
    it('应解析合法的 JSON 数组', () => {
      const raw = makeLLMResponse([
        { shotId: 's_01', text: '第一段解说', duration: 3.5 },
        { shotId: 's_02', text: '第二段解说', duration: 4.0 },
      ]);

      const result = generator.parseScriptResponse(raw);
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('s_01');
      expect(result[0].text).toBe('第一段解说');
      expect(result[0].duration).toBe(3.5);
      expect(result[0].editing).toBe(false);
    });

    it('keepOriginalAudio=true 的段落应透传原声标记', () => {
      const raw = makeLLMResponse([
        { shotId: 's_01', text: '这是原声段落', duration: 2.0, keepOriginalAudio: true },
        { shotId: 's_02', text: '普通解说段落', duration: 3.0 },
      ]);

      const result = generator.parseScriptResponse(raw);
      expect(result[0].keepOriginalAudio).toBe(true);
      expect(result[1].keepOriginalAudio).toBe(false);
    });

    it('缺失 shotId 时应自动生成 s_01, s_02...', () => {
      const raw = makeLLMResponse([
        { text: '文案 A', duration: 2 },
        { text: '文案 B', duration: 3 },
      ]);

      const result = generator.parseScriptResponse(raw);
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('s_01');
      expect(result[0].shotId).toBe('s_01');
      expect(result[1].id).toBe('s_02');
    });

    it('缺失 text 时应填充空字符串', () => {
      const raw = makeLLMResponse([{ shotId: 'x', duration: 5 }]);

      const result = generator.parseScriptResponse(raw);
      expect(result[0].text).toBe('');
    });

    it('缺失 duration 时应默认 3 秒', () => {
      const raw = makeLLMResponse([{ shotId: 's1', text: '文案' }]);

      const result = generator.parseScriptResponse(raw);
      expect(result[0].duration).toBe(3);
    });

    it('JSON 外侧有 Markdown 代码块时应正常解析', () => {
      const raw = '```json\n[{"shotId":"s_01","text":"带代码块的文案","duration":2}]\n```';

      const result = generator.parseScriptResponse(raw);
      expect(result).toHaveLength(1);
      expect(result[0].text).toBe('带代码块的文案');
    });

    it('JSON 前后有无关文本时应提取数组部分', () => {
      const raw =
        '这是生成的结果：\n[{"shotId":"s_01","text":"嵌入文本中的 JSON","duration":1}]\n以上是全部内容。';

      const result = generator.parseScriptResponse(raw);
      expect(result).toHaveLength(1);
      expect(result[0].text).toBe('嵌入文本中的 JSON');
    });

    it('空字符串应抛出 AI_PROCESS_FAILED', () => {
      expect(() => generator.parseScriptResponse('')).toThrow(AppError);
      expect(() => generator.parseScriptResponse('   ')).toThrow(AppError);
    });

    it('非 JSON 文本应抛出解析错误', () => {
      expect(() => generator.parseScriptResponse('这不是一个 JSON')).toThrow(AppError);
    });

    it('非数组 JSON 应抛出错误', () => {
      expect(() =>
        generator.parseScriptResponse('{"shotId":"s1","text":"test"}'),
      ).toThrow(AppError);
    });

    it('空数组应正常返回', () => {
      const result = generator.parseScriptResponse('[]');
      expect(result).toHaveLength(0);
    });

    it('应按下标从 vlmFrames 填充 startMs/durationMs（时间轴锚定）', () => {
      const raw = makeLLMResponse([
        { shotId: 's_01', text: '第一段', duration: 3 },
        { shotId: 's_02', text: '第二段', duration: 3 },
        { shotId: 's_03', text: '第三段', duration: 3 },
      ]);
      const frames = [
        { url: '/f1.jpg', description: 'a', editing: false, confirmed: true, timeMs: 0 },
        { url: '/f2.jpg', description: 'b', editing: false, confirmed: true, timeMs: 4000 },
        { url: '/f3.jpg', description: 'c', editing: false, confirmed: true, timeMs: 8000 },
      ];
      const result = generator.parseScriptResponse(raw, 4.5, frames as any);
      expect(result[0].startMs).toBe(0);
      expect(result[0].durationMs).toBe(4000);
      expect(result[1].startMs).toBe(4000);
      expect(result[1].durationMs).toBe(4000);
      expect(result[2].startMs).toBe(8000);
      expect(result[2].durationMs).toBeUndefined();
    });

    it('段落数超出帧数时，超出部分沿用最后一帧时间（锚定不漂移）', () => {
      const raw = makeLLMResponse([
        { shotId: 's_01', text: 'a', duration: 3 },
        { shotId: 's_02', text: 'b', duration: 3 },
        { shotId: 's_03', text: 'c', duration: 3 },
      ]);
      const frames = [
        { url: '/f1.jpg', description: 'a', editing: false, confirmed: true, timeMs: 1000 },
      ];
      const result = generator.parseScriptResponse(raw, 4.5, frames as any);
      expect(result[0].startMs).toBe(1000);
      expect(result[1].startMs).toBe(1000);
      expect(result[2].startMs).toBe(1000);
    });

    it('无 vlmFrames 时 startMs/durationMs 为 undefined（不破坏旧调用）', () => {
      const raw = makeLLMResponse([{ shotId: 's_01', text: 'a', duration: 3 }]);
      const result = generator.parseScriptResponse(raw, 4.5);
      expect(result[0].startMs).toBeUndefined();
      expect(result[0].durationMs).toBeUndefined();
    });
  });

  // ==================== generate ====================

  describe('generate', () => {
    it('完整流程：合法输入 → 调用 LLM → 返回 Step3Output', async () => {
      mockLLM.mockResolvedValue(
        makeLLMResponse([
          { shotId: 's_01', text: '夜幕降临，城市灯火通明', duration: 4.0 },
          { shotId: 's_02', text: '十字路口车水马龙', duration: 3.5 },
          { shotId: 's_03', text: '路人脸上洋溢着微笑', duration: 3.0 },
        ]),
      );

      const output = await generator.generate(makeInput());

      expect(output.scriptParagraphs).toHaveLength(3);
      expect(output.scriptParagraphs[0].text).toBe('夜幕降临，城市灯火通明');
      expect(mockLLM).toHaveBeenCalledTimes(1);

      // 验证传入 LLM 的 prompt 包含了场景描述
      const systemPrompt = mockLLM.mock.calls[0][0] as string;
      const userPrompt = mockLLM.mock.calls[0][1] as string;
      expect(systemPrompt).toContain('硬核科普');
      expect(userPrompt).toContain('城市天际线夜景');
    });

    it('缺失 vlmFrames 应抛出 AI_PROCESS_FAILED', async () => {
      const input = makeInput();
      delete (input as any).vlmFrames;

      await expect(generator.generate(input)).rejects.toMatchObject({
        code: ErrorCode.AI_PROCESS_FAILED,
      });
    });

    it('空 vlmFrames 应抛出异常（进入 buildSceneContext 校验）', async () => {
      await expect(generator.generate(makeInput({ vlmFrames: [] }))).rejects.toMatchObject({
        code: ErrorCode.AI_PROCESS_FAILED,
      });
    });

    it('LLM 返回非法 JSON 时应抛出异常', async () => {
      mockLLM.mockResolvedValue('抱歉，我无法生成');

      await expect(generator.generate(makeInput())).rejects.toMatchObject({
        code: ErrorCode.AI_PROCESS_FAILED,
      });
    });

    it('LLM 调用失败应传播异常', async () => {
      mockLLM.mockRejectedValue(new AppError(ErrorCode.NETWORK_TIMEOUT, 'LLM 超时'));

      await expect(generator.generate(makeInput())).rejects.toMatchObject({
        code: ErrorCode.NETWORK_TIMEOUT,
      });
    });

    it('未注入 llmChat 时应使用默认实现（抛出 AI_SERVICE_OFFLINE）', async () => {
      const defaultGen = new ScriptGenerator();
      await expect(defaultGen.generate(makeInput())).rejects.toMatchObject({
        code: ErrorCode.AI_SERVICE_OFFLINE,
      });
    });

    it('单帧输入应正常生成', async () => {
      mockLLM.mockResolvedValue(
        makeLLMResponse([{ shotId: 's_01', text: '孤独的灯塔', duration: 5.0 }]),
      );

      const input = makeInput({
        vlmFrames: [{ url: '/1.jpg', description: '灯塔', editing: false, confirmed: true }],
      });

      const output = await generator.generate(input);
      expect(output.scriptParagraphs).toHaveLength(1);
    });

    it('多个分镜应全部保留', async () => {
      const shots = Array.from({ length: 10 }, (_, i) => ({
        shotId: `shot_${i}`,
        text: `文案 ${i}`,
        duration: 2 + i * 0.5,
      }));
      mockLLM.mockResolvedValue(makeLLMResponse(shots));

      const output = await generator.generate(makeInput());
      expect(output.scriptParagraphs).toHaveLength(10);
    });

    it('speechRate 应传递到 parseScriptResponse', async () => {
      mockLLM.mockResolvedValue(
        makeLLMResponse([{ shotId: 's1', text: '测试', duration: 3 }]),
      );

      // parseScriptResponse 不过度依赖 speechRate，仅验证不报错
      const output = await generator.generate(makeInput({ speechRate: 3.0 }));
      expect(output.scriptParagraphs).toHaveLength(1);
    });
  });
});
