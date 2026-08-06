// Module: pipeline/step3-script - Script Generation Service

import type { Step3Input, Step3Output, Step3Role } from '../types';
import type { ScriptParagraph, VlmFrame } from '../../../../shared/types/entities/editor';
import { AppError, ErrorCode } from '@modules/infra/error/AppError';

/** 风格到 Prompt 指令的映射（与 ScriptGenStrategy 保持一致） */
const STYLE_PROMPTS: Record<string, string> = {
  '爆款短视频': '抖音/快手快剪风格：前3秒必须制造强钩子（悬念/冲突/反转），多用短句快切、网感词，节奏紧凑。',
  '深度解说': 'B站长视频风格：硬核分析镜头语言与导演隐喻，剖析人物动机和剧情结构，逻辑层层递进。',
  '评述视角': '主观点评风格：输出明确观点与价值判断，善用金句提炼和对比论证，带有强烈的个人立场。',
  '情感叙事': '感性叙事风格：以细腻笔触描绘画面中的情绪流动，善用比喻和意象，在平淡场景中挖掘深层情感共鸣。',
  '悬疑推理': '悬疑营造风格：用层层设问和伏笔构建悬念，每一句解说都是线索碎片，引导观众在脑中拼凑真相。',
  '硬核科普': '知识科普风格：以严谨客观的语气进行知识性解说，注重事实准确性和逻辑清晰度，适当引用专业术语。',
};

/** 默认语速（字/秒） */
const DEFAULT_SPEECH_RATE = 4.5;

/** 默认参数（融合方案，与前端 DEFAULT_PIPELINE_PARAMS 对齐） */
const DEFAULT_PARAMS: import('../../../../shared/types/entities/editor').PipelineParams = {
  narrativePerspective: 'third',
  informationLevel: 'deep',
  narrationDensity: 'standard',
  originalAudioStrategy: 'keep_key',
  rhythmMode: 'mixed',
  emotionTone: 'neutral',
  hookIntensity: 0.7,
  audioVisualWeight: 0.6,
};

/** LLM 聊天函数签名 */
export type LLMChatFn = (systemPrompt: string, userPrompt: string) => Promise<string>;

/** LLM 返回的原始 shot 结构 */
interface RawShot {
  shotId?: string;
  text?: string;
  duration?: number;
  /** 原声段落标记（keep_key/original_main 策略时 LLM 可输出 true） */
  keepOriginalAudio?: boolean;
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
   * 构建 System Prompt（与 ScriptGenStrategy 保持一致，简化版用于无上下文调用）
   */
  buildSystemPrompt(input: Step3Input): string {
    const rawStyle = input.scriptStyle || '爆款短视频';
    const style = STYLE_PROMPTS[rawStyle] ? rawStyle : '爆款短视频';
    const styleInstruction = STYLE_PROMPTS[style];
    const speechRate = input.speechRate || DEFAULT_SPEECH_RATE;
    const params = input.pipelineParams || DEFAULT_PARAMS;
    const hookIntensity = params.hookIntensity ?? 0.7;
    const audioVisualWeight = params.audioVisualWeight ?? 0.6;
    // 解说密度 → 字数填充系数
    const densityFillRate = params.narrationDensity === 'full' ? 1.0
                          : params.narrationDensity === 'sparse' ? 0.5
                          : 0.65;

    // TTS 标点停顿折损系数：逗号 ~200ms / 句号 ~500ms，累计需扣除 15%
    const discountFactor = 0.85;

    // 节奏模式 → 单句字数上限（short_fast=12 / mixed=20 / slow_soothing=30）
    const maxSentenceChars = params.rhythmMode === 'short_fast' ? 12
                           : params.rhythmMode === 'slow_soothing' ? 30
                           : 20;

    // 原声策略 → 是否允许标记原声段落（cover 模式禁止标记）
    const allowOriginalMark = params.originalAudioStrategy !== 'cover';

    return `你是顶级影视解说创作者（爆款UP主），擅长将画面素材转化为高留存率的解说旁白。你的任务是根据上游5维视觉语义（动作/情绪/光影/色彩）、人物角色库、原片台词记录，生成符合目标平台调性的解说文案。你必须杜绝"看图说话"的流水账，专注于剖析人物动机、情绪压抑与剧情转折，让文案"画外有音，言下之意"。

## Task
你将收到一份经过物理切片与视觉分析的视频片段流（含有时间轴、角色锚定、ASR原声及画面描述）。
请据此撰写一份具有高吸引力、节奏感强、声画高度契合的解说文案。

## 创作风格
${style}：${styleInstruction}

【黄金3秒钩子（强度${(hookIntensity * 100).toFixed(0)}%）】：第一句必须制造悬念或冲突吸引观众。

## ⚡ 爆款短句与卡点硬性规则 (Core Short-Sentence Rules)
1. **单句字数硬限制**：每个单句（两个标点之间的文字）绝对不能超过 ${maxSentenceChars} 字！多用动词、感叹句与极速短句（如："死死盯住！"、"眼神杀气顿显！"）。
2. **镜头级微切分**：每个输入 chunk 的解说词字数必须严格 ≤ 单段字数上限，绝不能把多个动作揉合成大段落。
3. **角色名称绝对统一**：严格使用【全局已知角色列表】中的姓名，严禁混淆人名或凭空创造角色列表之外的人名。
4. **消除视觉幻觉**：若 ASR 旁白与画面物理描述不一致，以【画面物理描述】为准描绘现场动作，以 ASR 为补充。
5. **拒绝流水账**：严禁描述画面直观已呈现的表面动作，重点剖析言下之意、内心戏与剧情冲突。

【反看图说话准则】：绝不允许复述画面已直观呈现的表面动作！重点剖析言下之意与内心戏。
【TTS口语化准则】：文案必须适合语音朗读，严禁超过25字无标点的长句。关键转折处插入 [pause: 500ms]。
【角色别名轮换准则】：严格基于人物库指代角色，严禁"男子/女子"等模糊代称，但可在真名与身份代词间智能轮换。

## 字数预算与参数指引
【严格字数约束】：考虑 TTS 标点停顿，字数预算需乘以 0.85 折损系数。
- 单段字数上限 = ⌊ 时长(秒) × ${speechRate} × ${(densityFillRate * 100).toFixed(0)}% × 0.85 ⌋
- 例如一个 3 秒的分镜，解说词应约 ${Math.floor(3 * speechRate * densityFillRate * discountFactor)} 字
- 一个 5 秒的分镜，解说词应约 ${Math.floor(5 * speechRate * densityFillRate * discountFactor)} 字

【专业解说参数指引】：
- 叙事视角：${params.narrativePerspective === 'third' ? '第三人称上帝视角' : params.narrativePerspective === 'first' ? '第一人称沉浸' : '第二人称吐槽'}
- 信息层次：${params.informationLevel === 'plot' ? '剧情复述' : params.informationLevel === 'deep' ? '深度解读' : '吐槽点评'}
- 解说密度：${params.narrationDensity === 'full' ? '满配' : params.narrationDensity === 'sparse' ? '留白' : '标准'}（填充率${(densityFillRate * 100).toFixed(0)}%）
- 原声策略：${params.originalAudioStrategy === 'cover' ? '全量覆盖' : params.originalAudioStrategy === 'keep_key' ? '关键台词保留' : '原声为主'}
- 节奏模式：${params.rhythmMode === 'short_fast' ? '短句快切' : params.rhythmMode === 'slow_soothing' ? '长句舒缓' : '长短交替'}
- 情绪基调：${params.emotionTone === 'neutral' ? '客观中立' : params.emotionTone === 'emotional' ? '情感渲染' : params.emotionTone === 'suspense' ? '悬疑营造' : params.emotionTone === 'epic' ? '高燃热血' : '搞笑吐槽'}
- 声画权重：${(audioVisualWeight * 100).toFixed(0)}%（${audioVisualWeight > 0.5 ? '偏向视觉' : '偏向原声'}）

${allowOriginalMark ? `## 原声段落标记规则（Original-Audio Marking）
原声策略要求保留部分原片原声。当某段分镜的核心是"原片台词/标志性对白/冲突声"（观众需要亲耳听到原声），请将该分镜标记为原声段落：
1. 该分镜输出 \`"keepOriginalAudio": true\`，\`text\` 填写原声台词原文（或最贴近的原文引用）。
2. 原声段落字数预算不适用，\`duration\` 填写原声在视频中的实际时长（秒）。
3. 每段解说之间最多允许 1~2 个原声段落，避免整片变成原声；原声段落前后各留一段解说引导。
4. 仅当该段原声与剧情强相关（名场面/冲突高潮/关键台词）才标记，普通背景音不标记。
` : ``}
## Output Format
请严格按照以下 JSON 数组格式返回结果，切勿包含任何 Markdown 格式化标记或额外解释：
[
  { "shotId": "s_01", "text": "解说词内容", "duration": 3.5${allowOriginalMark ? ', "keepOriginalAudio": false' : ''} }
]`;
  }

  /**
   * 🎭 构建人物角色名单注入段
   * 仅注入有 name 的角色；附加性别/年龄信息帮助 LLM 准确匹配画面中的人物
   * 与 ScriptGenStrategy.ts 注入逻辑保持一致，确保主引擎与新模块行为对齐
   * @param roles step1 识别出的人物角色列表
   * @returns 拼接好的人物名单段落；无 roles 或全空时返回空字符串
   */
  private buildRolesPrompt(roles?: Step3Role[]): string {
    if (!roles || roles.length === 0) return '';
    const roleLines = roles
      .filter(r => r && r.name)
      .map(r => {
        const rep = r.representative || {};
        const attrs: string[] = [];
        if (rep.gender !== undefined) {
          const g = rep.gender;
          attrs.push(g === 1 || g === 'M' || g === 'male' ? '男' : '女');
        }
        if (rep.age) attrs.push(`${rep.age}岁`);
        const attrStr = attrs.length > 0 ? `（${attrs.join('，')}）` : '';
        return `- ${r.name}${attrStr}`;
      });
    if (roleLines.length === 0) return '';
    return `\n\n【已知人物角色】：\n画面中可能出现以下人物，解说词中请优先使用其名称，严禁使用"男子/女子/青年/中年人"等模糊代称：\n${roleLines.join('\n')}`;
  }

  /**
   * 构建 User Prompt
   * 🎭 P0 同步：注入人物角色名单，让 LLM 生成解说词时使用统一人物名称
   */
  buildUserPrompt(input: Step3Input, sceneContext: string): string {
    let userPrompt = `【原片画面扫描日志】：\n${sceneContext}`;
    userPrompt += this.buildRolesPrompt(input.roles);
    userPrompt += `\n\n请直接输出 JSON 数组：`;
    return userPrompt;
  }

  /**
   * 解析 LLM 返回的原始 JSON → ScriptParagraph[]
   */
  parseScriptResponse(rawText: string, _speechRate?: number): ScriptParagraph[] {
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
        /** 原声段落透传：LLM 标记 keepOriginalAudio 的段落下游 TTS 跳过合成、匹配锁定原片时间段 */
        keepOriginalAudio: raw.keepOriginalAudio === true,
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
