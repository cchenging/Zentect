// Module: pipeline/step3-script - Script Generation Service

import type { Step3Input, Step3Output, Step3Role } from '../types';
import type { ScriptParagraph, VlmFrame } from '../../../../shared/types/entities/editor';
import { AppError, ErrorCode } from '@modules/infra/error/AppError';
import { breakLongParagraphs } from '../frontend/breakLongParagraphs';

/** 风格到 Prompt 指令的映射（与 ScriptGenStrategy.ts 严格对齐，保证双后端行为一致） */
const STYLE_PROMPTS: Record<string, string> = {
  '爆款短视频': '抖音/快手快剪风格：前3秒必须制造强钩子（悬念/冲突/反转），多用短句快切、网感词（"绝了"、"细思极恐"、"降维打击"），节奏紧凑，每句都为拉高完播率服务。适合短时长高密度内容。',
  '深度解说': 'B站长视频风格：硬核分析镜头语言与导演隐喻，剖析人物动机和剧情结构，善用"命运的齿轮"、"戏剧性的转变"等文学化表达，逻辑层层递进，适合15分钟以上的深度内容。',
  '评述视角': '主观点评风格：输出明确观点与价值判断，善用金句提炼和对比论证，带有强烈的个人立场（"这一波操作我给满分"、"这才是真正的XX"），适合UP主个人IP输出。',
  '情感叙事': '感性叙事风格：以细腻笔触描绘画面中的情绪流动，善用比喻和意象（"他的眼神像熄灭的烟头"），在平淡场景中挖掘深层情感共鸣，适合情感类、文艺类内容。',
  '悬疑推理': '悬疑营造风格：用层层设问和伏笔构建悬念，每一句解说都是线索碎片（"注意看他的手"、"这个细节很多人都忽略了"），引导观众在脑中拼凑真相，节奏张弛有度。',
  '硬核科普': '知识科普风格：以严谨客观的语气进行知识性解说，注重事实准确性和逻辑清晰度，适当引用专业术语但保持通俗易懂，适合科技/历史/自然类内容。',
};

/** 默认语速（字/秒） */
const DEFAULT_SPEECH_RATE = 4.5;

/** 默认参数（融合方案，与前端 DEFAULT_PIPELINE_PARAMS 对齐） */
const DEFAULT_PARAMS: import('../../../../shared/types/entities/editor').PipelineParams = {
  narrativePerspective: 'third',
  narrationRatio: 0.7, // 解说占比 0~1：0.7=解说为主、留 30% 给原声
  rhythmMode: 'mixed',
  emotionTone: 'neutral',
  hookIntensity: 0.7,
  targetNarrationDurationSec: 0,
};

/** LLM 聊天函数签名 */
export type LLMChatFn = (systemPrompt: string, userPrompt: string) => Promise<string>;

/** LLM 返回的原始 shot 结构 */
interface RawShot {
  shotId?: string;
  text?: string;
  duration?: number;
  emotion?: string;
  /** 🎭 P1 角色组合匹配：本段解说词对应的期望角色名单（断句切分后子句原样继承） */
  characters?: string[];
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
      .map((f, i) => {
        // 🎯 P3 时间轴锚定：把帧绝对时间拼进上下文，让 LLM 感知画面时间轴（步骤5 锚定依赖）
        const timeTag = f.timeMs != null
          ? ` (${f.timeStr || `${(f.timeMs / 1000).toFixed(1)}s`})`
          : '';
        return `[Frame ${i + 1}]${timeTag}: ${f.description || '(无描述)'}`;
      })
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

    /**
     * SSOT：densityFillRate / allowOriginalMark 均由 narrationRatio（解说占比 n，0~1）
     * 唯一派生（与 ScriptGenStrategy.ts / View.tsx 保持一致），解说与原声互斥一体，不再分两个参数相乘：
     * - 字数填充系数 = n：n=1(全解说) → 1.0 铺满全片 / n=0.3(原声为主) → 0.3 仅关键节点解说
     * - 允许标记原声段落 = n < 1：留了原声空间才允许 LLM 标记原声段落
     */
    const narrationRatio = Math.max(0, Math.min(1, params.narrationRatio ?? 0.7));
    // 字数预算系数 = 解说占比：单段与总量共用同一填充率（与 ScriptGenStrategy.ts 保持一致）
    const densityFillRate = narrationRatio;

    /**
     * TTS 标点停顿折损系数：按 rhythmMode 差异化取值（之前全局固定 0.85 导致双向失真）
     * - short_fast(短句快切): 频繁逗号/感叹号 → 约 15% 停顿占比 → discountFactor = 0.85
     * - mixed(长短交替): 适度标点 → 约 10% 停顿占比 → discountFactor = 0.90
     * - slow_soothing(长句舒缓): 少标点 + 句号情感节点 → 约 7% 停顿占比 → discountFactor = 0.93
     */
    const DISCOUNT_BY_RHYTHM: Record<string, number> = {
      short_fast: 0.85,
      mixed: 0.90,
      slow_soothing: 0.93,
    };
    const discountFactor = DISCOUNT_BY_RHYTHM[params.rhythmMode] ?? 0.88;

    // 节奏模式 → 单句字数上限（short_fast=12 / mixed=20 / slow_soothing=30）
    const maxSentenceChars = params.rhythmMode === 'short_fast' ? 12
                           : params.rhythmMode === 'slow_soothing' ? 30
                           : 20;

    // 是否允许标记原声段落：解说占比 < 100% 即留了原声空间，才允许 LLM 标记原声段落
    const allowOriginalMark = narrationRatio < 1;
    // 解说占比 → prompt 文本（按解说占比 n 分档描述解说铺陈与留白语义）
    const narrationRatioText = narrationRatio >= 0.95
      ? '全量解说'
      : narrationRatio >= 0.6
      ? `解说为主（解说占比 ${Math.round(narrationRatio * 100)}%）`
      : narrationRatio >= 0.3
      ? `各占一半（解说占比 ${Math.round(narrationRatio * 100)}%）`
      : `原声为主（解说占比 ${Math.round(narrationRatio * 100)}%）`;

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
3. **段落与画面一一对应**：输出段落数量必须与输入 Frame 数量一致，第 N 段解说词对应第 N 个 Frame（含其标注的时间点），严禁合并、跳帧或凭空多输出段落。
4. **角色名称绝对统一**：严格使用【全局已知角色列表】中的姓名，严禁混淆人名或凭空创造角色列表之外的人名。
5. **消除视觉幻觉**：若 ASR 旁白与画面物理描述不一致，以【画面物理描述】为准描绘现场动作，以 ASR 为补充。
6. **拒绝流水账**：严禁描述画面直观已呈现的表面动作，重点剖析言下之意、内心戏与剧情冲突。

【反看图说话准则】：绝不允许复述画面已直观呈现的表面动作！重点剖析言下之意与内心戏。
【TTS口语化准则】：文案必须适合语音朗读，严禁超过25字无标点的长句。关键转折处插入 [pause: 500ms]。
【角色别名轮换准则】：严格基于人物库指代角色，严禁"男子/女子"等模糊代称，但可在真名与身份代词间智能轮换。

## 字数预算与参数指引
【严格字数约束】：考虑 TTS 标点停顿，字数预算需乘以折损系数。
- 单段字数上限 = ⌊ 时长(秒) × ${speechRate} × ${(densityFillRate * 100).toFixed(0)}% × ${discountFactor} ⌋
- 例如一个 3 秒的分镜，解说词应约 ${Math.floor(3 * speechRate * densityFillRate * discountFactor)} 字
- 一个 5 秒的分镜，解说词应约 ${Math.floor(5 * speechRate * densityFillRate * discountFactor)} 字

【专业解说参数指引】：
- 叙事视角：${params.narrativePerspective === 'third' ? '第三人称上帝视角' : params.narrativePerspective === 'first' ? '第一人称沉浸' : '第二人称吐槽'}
- 解说占比：${narrationRatioText}
- 节奏模式：${params.rhythmMode === 'short_fast' ? '短句快切' : params.rhythmMode === 'slow_soothing' ? '长句舒缓' : '长短交替'}
- 情绪基调：${params.emotionTone === 'neutral' ? '客观中立' : params.emotionTone === 'emotional' ? '情感渲染' : params.emotionTone === 'suspense' ? '悬疑营造' : params.emotionTone === 'epic' ? '高燃热血' : '搞笑吐槽'}

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
   * @param vlmFrames 步骤2 的视觉帧（含 timeMs），按下标为段落填充时间轴锚定 startMs/durationMs
   */
  parseScriptResponse(rawText: string, _speechRate?: number, vlmFrames?: VlmFrame[]): ScriptParagraph[] {
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

    // 逐段解析，先构造带 characters 的中间分镜，再统一过断句切分器
    const parsed = rawShots.map((raw, index) => {
      const shotId = raw.shotId || `s_${String(index + 1).padStart(2, '0')}`;
      const text = raw.text || '';
      const duration = raw.duration || 3;
      // 🎯 P3 时间轴锚定：按下标从 vlmFrames 取帧绝对时间作为 startMs（相邻帧差值作为 durationMs）。
      //    段落数超出帧数时，超出部分沿用最后一帧时间（LLM 偶发多输出段落时锚定不漂移）。
      const lastFrame = vlmFrames && vlmFrames[vlmFrames.length - 1];
      const frame = vlmFrames && (vlmFrames[index] || lastFrame);
      const nextFrame = vlmFrames && vlmFrames[index + 1];
      const startMs = frame?.timeMs != null ? Math.round(frame.timeMs) : undefined;
      const durationMs = (frame?.timeMs != null && nextFrame?.timeMs != null)
        ? Math.round(nextFrame.timeMs - frame.timeMs)
        : undefined;
      return {
        __order: index,
        id: shotId,
        shotId,
        text,
        duration,
        emotion: raw.emotion || '',
        /** 🎭 P1 角色继承：父段落的期望角色名单，断句切分后子句原样继承，保证步骤5 Query 端角色对齐不丢失 */
        characters: Array.isArray(raw.characters) ? raw.characters : undefined,
        /** 原声段落标记：切分时保护，不拆分（原声定位依赖整段文本锁时间轴，拆分会破坏） */
        keepOriginalAudio: raw.keepOriginalAudio === true,
        /** 🎯 P3 时间轴锚定：父段落对应帧的时间起点/时长（ms），断句后子句原样继承 */
        startMs,
        durationMs,
      };
    });

    /** 长段落断句：>18 字的文案按标点切成爆款微短句，避免 TTS 超时与画面张冠李戴。
     *  原声段落不参与切分，原样保留。 */
    const broken = breakLongParagraphs(parsed.filter((p) => !p.keepOriginalAudio));
    const originalParagraphs = parsed.filter((p) => p.keepOriginalAudio);

    /** 按原始顺序合并：非原声断句子句 + 原声段落，保持与小洛 LLM 输出顺序一致 */
    const merged = [...broken, ...originalParagraphs].sort((a, b) => {
      const aOrder = (a as any).__order ?? 0;
      const bOrder = (b as any).__order ?? 0;
      return aOrder - bOrder;
    });

    return merged.map((p) => ({
      id: p.id,
      shotId: p.shotId,
      text: p.text,
      duration: p.duration,
      emotion: p.emotion || '',
      editing: false,
      /** 🎭 子句继承父段落的期望角色名单 */
      characters: p.characters,
      /** 原声段落透传：LLM 标记 keepOriginalAudio 的段落下游 TTS 跳过合成、匹配锁定原片时间段 */
      keepOriginalAudio: (p as any).keepOriginalAudio === true,
      /** 🎯 P3 时间轴锚定：子句继承父段落对应帧的时间起点/时长（ms），供步骤5 锚定切片 */
      startMs: (p as any).startMs,
      durationMs: (p as any).durationMs,
    })) satisfies ScriptParagraph[];
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

    // 5. 解析响应（注入 vlmFrames 供时间轴锚定 startMs/durationMs 填充）
    const scriptParagraphs = this.parseScriptResponse(rawResponse, input.speechRate, input.vlmFrames);

    return { scriptParagraphs };
  }
}
