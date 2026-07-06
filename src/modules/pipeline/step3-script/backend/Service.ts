// Module: pipeline/step3-script - Script Generation Service

import type { Step3Input, Step3Output } from '../types';
import type { ScriptParagraph, VlmFrame } from '../../../shared/types/entities/editor';
import { AppError, ErrorCode } from '../../../../infra/error/AppError';

/** 风格到 Prompt 指令的映射（从 ScriptGenStrategy 提取） */
const STYLE_PROMPTS: Record<string, string> = {
  '赛博现实主义': '擅长使用逻辑悖论和废话文学（例如："这只狗之所以是只狗，是因为它不是猫"）。情绪卡点必须高燃，在看似荒诞的描述中突然拔高立意。',
  '无厘头废话文学': '全程废话文学，用看似有逻辑实则毫无意义的句式推进叙事（例如："之所以如此，是因为如此"）。越荒诞越好，但必须和画面内容有微弱关联。',
  '正经科普': '以严谨客观的语气进行知识性解说，注重事实准确性和逻辑清晰度，适当引用专业术语但保持通俗易懂。',
  '情感叙事': '以细腻感性的笔触描绘画面中的情绪流动，善用比喻和意象，在平淡场景中挖掘深层情感共鸣。',
  '悬疑推理': '用层层设问和伏笔构建悬念，每一句解说都是线索碎片，引导观众在脑中拼凑真相，节奏张弛有度。',
  '轻松幽默': '用轻松诙谐的语气吐槽画面内容，善用网络流行语和反转梗，让观众会心一笑，但不要过度玩梗。',
};

/** 默认语速（字/秒） */
const DEFAULT_SPEECH_RATE = 4.5;

/** 默认 R/S/T/P 参数 */
const DEFAULT_PARAMS = { R: 50, S: 50, T: 50, P: 50 };

/** LLM 聊天函数签名 */
export type LLMChatFn = (systemPrompt: string, userPrompt: string) => Promise<string>;

/** LLM 返回的原始 shot 结构 */
interface RawShot {
  shotId?: string;
  text?: string;
  duration?: number;
}

export class ScriptGenerator {
  private llmChat: LLMChatFn;

  constructor(llmChat?: LLMChatFn) {
    this.llmChat = llmChat || this._defaultLLMChat;
  }

  /** 默认 LLM 实现 — 生产环境应注入真实适配器 */
  private async _defaultLLMChat(
    _systemPrompt: string,
    _userPrompt: string,
  ): Promise<string> {
    throw new AppError(ErrorCode.AI_SERVICE_OFFLINE, 'LLM 适配器未注入，请在构造时提供 llmChat 函数');
  }

  // ===================== 公开方法 =====================

  /**
   * 将 VlmFrame[] 转为 LLM 可读的画面上下文
   */
  buildSceneContext(frames: VlmFrame[]): string {
    if (!frames || frames.length === 0) {
      throw new AppError(ErrorCode.AI_PROCESS_FAILED, '缺少视觉帧数据，无法生成讲解文案');
    }
    return frames
      .map((f, i) => `[Frame ${i + 1}]: ${f.description || '(无描述)'}`)
      .join('\n');
  }

  /**
   * 根据当前输入估算目标总字数
   */
  estimateTargetWords(sceneLineCount: number, speechRate: number): number {
    return Math.floor(sceneLineCount * 4 * speechRate);
  }

  /**
   * 根据语速估算每帧推荐字数
   */
  estimatePerFrameWords(frameDurationSec: number, speechRate: number): number {
    return Math.floor(frameDurationSec * speechRate);
  }

  /**
   * 构建 System Prompt
   */
  buildSystemPrompt(input: Step3Input): string {
    const rawStyle = input.scriptStyle || '赛博现实主义';
    const style = STYLE_PROMPTS[rawStyle] ? rawStyle : '赛博现实主义';
    const styleInstruction = STYLE_PROMPTS[style];
    const speechRate = input.speechRate || DEFAULT_SPEECH_RATE;
    const params = input.pipelineParams || DEFAULT_PARAMS;
    const retainRatio = params.R / 100;
    const silenceRatio = params.S / 100;
    const ttsCoverage = params.T / 100;
    const paceFactor = params.P / 100;

    return `你是专业视频讲解文案生成器。

【创作风格】：${style}
${styleInstruction}

必须输出为一个严谨的 JSON 数组，格式如下：
[
  { "shotId": "s_01", "text": "解说词内容", "duration": 3.5 }
]

【字数约束】：请按 ${speechRate} 字/秒的语速标准，控制每个分镜的解说词长度。
- 例如一个 3 秒的分镜，解说词应约 ${Math.floor(3 * speechRate)} 字
- 一个 5 秒的分镜，解说词应约 ${Math.floor(5 * speechRate)} 字

【参数化创作指引】：
- 经典片段保留度：${(retainRatio * 100).toFixed(0)}%（数值越高，越倾向于保留原始画面的经典叙事片段；越低则越大胆重写）
- 原台词保留度：${(silenceRatio * 100).toFixed(0)}%（数值越高，越倾向于保留原始语音台词；越低则越倾向全量重写解说词）
- TTS 配音覆盖度：${(ttsCoverage * 100).toFixed(0)}%（数值越高，解说词越长越适合 TTS 配音；越低则偏短短语，保留原声比例大）
- 节奏因子：${(paceFactor * 100).toFixed(0)}%（数值越高节奏越快，分镜越短促；越低则节奏舒缓，单镜时长更长）

注意：绝对不要输出 JSON 代码块之外的任何多余字符。`;
  }

  /**
   * 构建 User Prompt
   */
  buildUserPrompt(input: Step3Input, sceneContext: string): string {
    return `【原片画面扫描日志】：\n${sceneContext}\n\n请直接输出 JSON 数组：`;
  }

  /**
   * 解析 LLM 返回的原始 JSON → ScriptParagraph[]
   */
  parseScriptResponse(rawText: string, speechRate?: number): ScriptParagraph[] {
    if (!rawText || rawText.trim().length === 0) {
      throw new AppError(ErrorCode.AI_PROCESS_FAILED, 'LLM 返回了空文本');
    }

    // 尝试提取 JSON 数组
    let jsonText = rawText.trim();
    // 移除可能的 markdown 代码块标记
    jsonText = jsonText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    // 找到第一个 [ 到最后一个 ]
    const startIdx = jsonText.indexOf('[');
    const endIdx = jsonText.lastIndexOf(']');
    if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
      throw new AppError(ErrorCode.AI_PROCESS_FAILED, `LLM 返回内容不是 JSON 数组: ${jsonText.substring(0, 80)}`);
    }
    jsonText = jsonText.substring(startIdx, endIdx + 1);

    let rawShots: RawShot[];
    try {
      rawShots = JSON.parse(jsonText);
    } catch {
      throw new AppError(ErrorCode.AI_PROCESS_FAILED, `LLM JSON 解析失败: ${jsonText.substring(0, 80)}`);
    }

    if (!Array.isArray(rawShots)) {
      throw new AppError(ErrorCode.AI_PROCESS_FAILED, 'LLM 返回的不是数组');
    }

    const rate = speechRate || DEFAULT_SPEECH_RATE;

    return rawShots.map((raw, index) => {
      const shotId = raw.shotId || `s_${String(index + 1).padStart(2, '0')}`;
      const text = raw.text || '';
      const duration = raw.duration || 3;

      return {
        id: shotId,
        shotId,
        text,
        duration,
        editing: false,
      } satisfies ScriptParagraph;
    });
  }

  /**
   * 主入口：从 Step3Input 生成 Step3Output
   */
  async generate(input: Step3Input): Promise<Step3Output> {
    // 1. 输入校验
    if (!input.vlmFrames) {
      throw new AppError(ErrorCode.AI_PROCESS_FAILED, '缺少 vlmFrames 字段');
    }

    // 2. 构建画面上下文
    const sceneContext = this.buildSceneContext(input.vlmFrames);

    // 3. 构建 Prompt
    const systemPrompt = this.buildSystemPrompt(input);
    const userPrompt = this.buildUserPrompt(input, sceneContext);

    // 4. 调用 LLM
    const rawResponse = await this.llmChat(systemPrompt, userPrompt);

    // 5. 解析响应
    const scriptParagraphs = this.parseScriptResponse(rawResponse, input.speechRate);

    return { scriptParagraphs };
  }
}
