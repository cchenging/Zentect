// 📁 路径：src/main/engine/strategies/ScriptGenStrategy.ts
import { BaseNodeStrategy, ExecutionContext } from './BaseNodeStrategy';
import { LLMFactory } from '../adapters/LLMFactory';
import { AppLogger } from '../../core/AppLogger';
import { LexiconFilter } from '../lexicon/LexiconFilter';
import { NetworkPipeline } from '../../core/NetworkPipeline';
import { PERSONAS } from '../prompts/personas';
import { CONSTRAINTS } from '../prompts/constraints';

export interface ScriptGenInput {
  modelName?: string;
  theme?: string;
  customPrompt?: string;
  /** 用户选择的文案风格 */
  scriptStyle?: string;
  /** 融合方案的解说控制参数（替代旧版 R/S/T/P） */
  pipelineParams?: import('../../../shared/types/entities/editor').PipelineParams;
  /** 用户选择的语速（字/秒） */
  speechRate?: number;
  /** 上游视觉结果 */
  visionResult?: any;
  /** 上游听觉/ASR 结果 */
  audioResult?: any;
  /**
   * 🎭 step1 识别出的人物角色列表，注入到 step3 prompt 中
   * 让 LLM 生成解说词时使用统一人物名称，避免"男子/女子"等模糊代称
   * 元素结构：{ id, name, representative?, mergedRoles? }
   */
  roles?: Array<{ id: string; name: string; representative?: any; mergedRoles?: any[] }>;
}

export interface LexiconMark {
  word: string;
  level: 'high' | 'medium' | 'low';
  replaced: boolean;
}

export interface GeneratedShot {
  shotId: string;
  text: string;
  cleanText: string;
  audioSafeText: string;
  flagged: boolean;
  replaced: boolean;
  lexiconMarks: LexiconMark[];
  duration: number;
  emotion?: string;
}

/** 风格到 Prompt 指令的映射（重写：去掉废话文学，改为专业解说方向） */
const STYLE_PROMPTS: Record<string, string> = {
  '爆款短视频': '抖音/快手快剪风格：前3秒必须制造强钩子（悬念/冲突/反转），多用短句快切、网感词（"绝了"、"细思极恐"、"降维打击"），节奏紧凑，每句都为拉高完播率服务。适合短时长高密度内容。',
  '深度解说': 'B站长视频风格：硬核分析镜头语言与导演隐喻，剖析人物动机和剧情结构，善用"命运的齿轮"、"戏剧性的转变"等文学化表达，逻辑层层递进，适合15分钟以上的深度内容。',
  '评述视角': '主观点评风格：输出明确观点与价值判断，善用金句提炼和对比论证，带有强烈的个人立场（"这一波操作我给满分"、"这才是真正的XX"），适合UP主个人IP输出。',
  '情感叙事': '感性叙事风格：以细腻笔触描绘画面中的情绪流动，善用比喻和意象（"他的眼神像熄灭的烟头"），在平淡场景中挖掘深层情感共鸣，适合情感类、文艺类内容。',
  '悬疑推理': '悬疑营造风格：用层层设问和伏笔构建悬念，每一句解说都是线索碎片（"注意看他的手"、"这个细节很多人都忽略了"），引导观众在脑中拼凑真相，节奏张弛有度。',
  '硬核科普': '知识科普风格：以严谨客观的语气进行知识性解说，注重事实准确性和逻辑清晰度，适当引用专业术语但保持通俗易懂，适合科技/历史/自然类内容。',
};

/** 将毫秒格式化为 HH:MM:SS.mmm 字符串（用于 ContextChunk.timeRange） */
function formatMsToTime(ms: number): string {
  const totalSec = ms / 1000;
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  const mmm = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(mmm).padStart(3, '0')}`;
}

export class ScriptGenStrategy extends BaseNodeStrategy<ScriptGenInput, GeneratedShot[]> {
  readonly nodeType = 'script-gen';

  protected async validate(_input: ScriptGenInput): Promise<void> {
  }

  protected async performTask(
    input: ScriptGenInput,
    context: ExecutionContext,
    _cacheDir: string,
    onProgress: (p: number, s: string) => void
  ): Promise<GeneratedShot[]> {
    onProgress(10, '正在收集上游视觉与听觉感知数据...');

    // 读取用户选择的语速（字/秒），默认 4.5
    const speechRate = input.speechRate || 4.5;

    // 融合方案参数：枚举按钮组 + 连续值协同（替代旧版 R/S/T/P 滑块）
    const DEFAULT_PARAMS: import('../../../shared/types/entities/editor').PipelineParams = {
      narrativePerspective: 'third',
      informationLevel: 'deep',
      narrationDensity: 'standard',
      originalAudioStrategy: 'keep_key',
      rhythmMode: 'mixed',
      emotionTone: 'neutral',
      hookIntensity: 0.7,
      audioVisualWeight: 0.6,
    };
    const params = input.pipelineParams || context.pipelineParams || DEFAULT_PARAMS;
    const hookIntensity = params.hookIntensity ?? 0.7;
    const audioVisualWeight = params.audioVisualWeight ?? 0.6;

    // 解说密度 → 字数填充系数（0-1）：满配1.0 / 标准0.65 / 留白0.5
    const densityFillRate = params.narrationDensity === 'full' ? 1.0
                          : params.narrationDensity === 'sparse' ? 0.5
                          : 0.65;

    // TTS 标点停顿折损系数：逗号 ~200ms / 句号 ~500ms，100 字累计停顿 3~6 秒，需扣除 15%
    const discountFactor = 0.85;

    // ========== 阶段1：ContextChunk 结构化数据组装（时序对齐 + 角色锚定） ==========
    // 收集上游视觉数据（downstreamContext 优先）和 ASR 字幕数据
    const upstreamNodeIds = Array.from(context.bus.keys()).filter(
      id => id !== 'source_root'
    );

    let visualShots: any[] = []; // 结构化视觉片段（含 action/emotion/keywords）
    let sceneDescriptions = '';   // 兼容：原始画面描述长文本
    let asrLines: any[] = [];     // ASR 台词行（含时间戳）

    for (const nodeId of upstreamNodeIds) {
      const busData = context.bus.get(nodeId);
      if (!busData) continue;
      // 优先使用 downstreamContext.shots（5维结构化数据，比长文本省 70% Token）
      if (visualShots.length === 0 && busData.downstreamContext?.shots?.length) {
        visualShots = busData.downstreamContext.shots;
      }
      if (!sceneDescriptions && busData.sceneDescriptions) {
        sceneDescriptions = busData.sceneDescriptions;
      }
      if (asrLines.length === 0) {
        const rawLines = busData.asrLines || busData.lines || [];
        if (rawLines.length > 0) asrLines = rawLines;
        else if (busData.asrText && typeof busData.asrText === 'string') {
          asrLines = [{ text: busData.asrText, startMs: 0 }];
        }
      }
    }
    // 兼容 input 直接传入的数据
    if (visualShots.length === 0 && input.visionResult?.downstreamContext?.shots?.length) {
      visualShots = input.visionResult.downstreamContext.shots;
    } else if (!sceneDescriptions && input.visionResult?.sceneDescriptions) {
      sceneDescriptions = input.visionResult.sceneDescriptions;
    }
    if (asrLines.length === 0 && input.audioResult?.lines && Array.isArray(input.audioResult.lines)) {
      asrLines = input.audioResult.lines;
    }

    // 构建 ContextChunk JSON 数组：将视觉片段与 ASR 台词按时序对齐
    // 每个 chunk 含 chunkId/timeRange/durationMs/anchoredCharacters/asrContext/visualContext
    const contextChunks: any[] = [];
    const totalShots = visualShots.length || (sceneDescriptions ? sceneDescriptions.split('\n').filter((l: string) => l.trim()).length : 0) || 1;

    // 按 ASR 时间戳计算每个 chunk 的近似时长（阶段4：真实时间轴字数预算）
    // 若无 ASR 时间戳，fallback 到每镜 4 秒硬编码
    const hasAsrTimestamps = asrLines.length > 0 && asrLines.some(l => l.startMs !== undefined || l.start !== undefined);

    for (let i = 0; i < totalShots; i++) {
      const shot = visualShots[i] || {};
      // 时间轴：用 ASR 行的时间戳估算每个 chunk 的时长
      let chunkStartMs = 0;
      let chunkDurationMs = 4000; // 默认 4 秒
      if (hasAsrTimestamps && asrLines.length > 0) {
        const linesPerChunk = Math.max(1, Math.floor(asrLines.length / totalShots));
        const startLine = asrLines[Math.min(i * linesPerChunk, asrLines.length - 1)];
        const endLine = asrLines[Math.min((i + 1) * linesPerChunk - 1, asrLines.length - 1)];
        const startMs = startLine?.startMs ?? (typeof startLine?.start === 'number' ? startLine.start : 0);
        const endMs = endLine?.endMs ?? (endLine?.end !== undefined ? (typeof endLine.end === 'number' ? endLine.end : startMs + 4000) : startMs + 4000);
        chunkStartMs = startMs;
        chunkDurationMs = Math.max(1000, endMs - startMs); // 至少 1 秒
      }

      // 角色锚定：从 shot.characters 或 shot.keywords 提取该片段出现的人物
      const anchoredCharacters: string[] = [];
      if (Array.isArray(shot.characters)) {
        anchoredCharacters.push(...shot.characters.filter((c: any) => typeof c === 'string' && c));
      }

      // ASR 上下文：找到时间轴范围内的台词
      const chunkAsrLines = hasAsrTimestamps
        ? asrLines.filter(l => {
            const lStart = l.startMs ?? (typeof l.start === 'number' ? l.start : 0);
            return lStart >= chunkStartMs && lStart < chunkStartMs + chunkDurationMs;
          })
        : asrLines.slice(i * Math.max(1, Math.floor(asrLines.length / totalShots)), (i + 1) * Math.max(1, Math.floor(asrLines.length / totalShots)));
      const asrContext = chunkAsrLines.map(l => l.text || l.content || '').filter(Boolean).join(' ') || '';

      contextChunks.push({
        chunkId: `chunk_${String(i + 1).padStart(3, '0')}`,
        timeRange: `${formatMsToTime(chunkStartMs)} -> ${formatMsToTime(chunkStartMs + chunkDurationMs)}`,
        startMs: chunkStartMs,
        durationMs: chunkDurationMs,
        durationSec: parseFloat((chunkDurationMs / 1000).toFixed(1)),
        anchoredCharacters,
        asrContext: asrContext ? `原声：${asrContext}` : '',
        visualContext: {
          action: shot.action || (sceneDescriptions ? sceneDescriptions.split('\n')[i] || '' : ''),
          atmosphere: shot.atmosphere || shot.lighting || '',
          emotionTone: shot.emotion || shot.emotionTone || '',
          keywords: shot.keywords || [],
        },
      });
    }

    // ========== 阶段1.5：微 chunk 切分 — 单 chunk 时间上限 5 秒 ==========
    // step2 输出的 shot 粒度可能很粗(45~72秒)，导致 LLM 生成 100+ 字长段落
    // step3 自己按时间上限切分，每个子 chunk 继承父 visualContext，但 ASR 按各自时间段重新筛选
    const MAX_CHUNK_SEC = 5;
    const microChunks: any[] = [];
    for (const chunk of contextChunks) {
      if (chunk.durationSec <= MAX_CHUNK_SEC) {
        microChunks.push(chunk);
        continue;
      }
      // 按 MAX_CHUNK_SEC 切分长 chunk
      const subCount = Math.ceil(chunk.durationSec / MAX_CHUNK_SEC);
      const subDurationMs = Math.floor(chunk.durationMs / subCount);
      const baseChunkId = chunk.chunkId;
      for (let s = 0; s < subCount; s++) {
        const subStartMs = chunk.startMs + s * subDurationMs;
        const subEndMs = s === subCount - 1 ? chunk.startMs + chunk.durationMs : subStartMs + subDurationMs;
        const subDurationMsActual = subEndMs - subStartMs;
        // 重新筛选该时间段的 ASR 台词：按台词时间中点归属，避免跨越分割点的台词被硬裁剪
        const subAsrLines = hasAsrTimestamps
          ? asrLines.filter(l => {
              const lStart = l.startMs ?? (typeof l.start === 'number' ? l.start : 0);
              const lEnd = l.endMs ?? (typeof l.end === 'number' ? l.end : lStart);
              const midPoint = (lStart + lEnd) / 2;
              return midPoint >= subStartMs && midPoint < subEndMs;
            })
          : [];
        const subAsrContext = subAsrLines.map(l => l.text || l.content || '').filter(Boolean).join(' ') || '';
        microChunks.push({
          chunkId: `${baseChunkId}_${s + 1}`,
          timeRange: `${formatMsToTime(subStartMs)} -> ${formatMsToTime(subEndMs)}`,
          startMs: subStartMs,
          durationMs: subDurationMsActual,
          durationSec: parseFloat((subDurationMsActual / 1000).toFixed(1)),
          anchoredCharacters: chunk.anchoredCharacters,
          asrContext: subAsrContext ? `原声：${subAsrContext}` : '',
          visualContext: chunk.visualContext,
        });
      }
    }
    // 用微 chunk 替换粗 chunk
    contextChunks.length = 0;
    contextChunks.push(...microChunks);

    // 计算总时长（秒）用于字数预算（阶段4：真实时间轴替代 sceneLineCount*4 硬编码）
    const totalDurationSec = contextChunks.reduce((sum, c) => sum + c.durationSec, 0) || (totalShots * 4);

    // 使用 LLMFactory.createAdapter 自动读取用户配置的模型和 API Key
    const { adapter, modelName, temperature } = LLMFactory.createAdapter('script');

    onProgress(30, '正在组装剧本 Prompt 并设定创作逻辑...');

    // 动态注入用户选择的风格
    const style = input.scriptStyle || '爆款短视频';
    const styleInstruction = STYLE_PROMPTS[style] || STYLE_PROMPTS['爆款短视频'];

    // 叙事视角 → prompt 指令
    const perspectiveMap: Record<string, string> = {
      'third': '第三人称上帝视角："画面中，张三走进房间..." — 客观叙述，俯视全局',
      'first': '第一人称沉浸视角："我推开门，看见了..." — 代入主角内心，主观体验',
      'second': '第二人称吐槽视角："换作是你，看到桌上这三十万，你敢接吗？" — 与观众建立交互问答',
    };
    // 信息层次 → prompt 指令
    const infoLevelMap: Record<string, string> = {
      'plot': '剧情复述：讲发生了什么（"张三拿起了刀"），平铺直叙',
      'deep': '深度解读：分析为什么（"张三拿起刀，因为他已经别无选择"），剖析动机与因果',
      'roast': '吐槽点评：主观评价（"张三拿起刀，这波操作我给满分"），带有个人立场',
    };
    // 解说密度 → prompt 指令（含字数填充率）
    const densityMap: Record<string, string> = {
      'full': `满配（填充率${(densityFillRate * 100).toFixed(0)}%）：每秒都有解说，信息密度最大，适合硬核科幻、高智商犯罪剧情`,
      'standard': `标准（填充率${(densityFillRate * 100).toFixed(0)}%）：关键画面有解说，过渡段静音让画面说话`,
      'sparse': `留白（填充率${(densityFillRate * 100).toFixed(0)}%）：大量留白，只在关键节点点睛，适合纪录片/文艺向，让位给BGM和画面纯享`,
    };
    // 原声策略 → prompt 指令
    const audioStrategyMap: Record<string, string> = {
      'cover': '全量覆盖：忽略ASR原声，LLM全力重新编排旁白',
      'keep_key': '关键台词保留：识别ASR中高压/冲突台词区间，在该时间段暂停解说留出原声出场',
      'original_main': '原声为主：原声保留，解说仅辅助过渡',
    };
    // 节奏模式 → prompt 指令（含TTS标记规范）
    const rhythmMap: Record<string, string> = {
      'short_fast': '短句快切：严格使用微型短句。每句末尾强制使用逗号或感叹号。适合极速快切。密集注入 [pause: 200ms]',
      'mixed': '长短交替：短句铺垫+长句叙事。节奏抑扬顿挫。关键转折处插入 [pause: 400ms]',
      'slow_soothing': '长句舒缓：使用优美长句与分词，多用句号。关键情感节点后追加 [pause: 800ms] 标记',
    };
    // 节奏模式 → 单句字数上限（short_fast=12 / mixed=20 / slow_soothing=30）
    const maxSentenceChars = params.rhythmMode === 'short_fast' ? 12
                           : params.rhythmMode === 'slow_soothing' ? 30
                           : 20;
    // 情绪基调 → prompt 词库
    const emotionToneMap: Record<string, string> = {
      'neutral': '客观中立：平铺直叙，不刻意渲染情绪，多用"隐喻"、"戏剧性的转变"等文学化表达',
      'emotional': '情感渲染：感性共鸣，善用比喻和意象，"他的眼神像熄灭的烟头"',
      'suspense': '悬疑营造：层层设问，"注意看他的手"、"这个细节很多人都忽略了"',
      'epic': '高燃热血：情绪卡点必须高燃，多用"绝了"、"降维打击"、"全网泪目"等情绪助推词',
      'comedy': '搞笑吐槽：网络流行语和反转梗，"这波操作我给满分"，让观众会心一笑',
    };

    // 钩子强度 → 开头指令
    const hookInstruction = hookIntensity >= 0.7
      ? `【黄金3秒钩子（强度${(hookIntensity * 100).toFixed(0)}%）】：第一句必须制造极大悬念或冲突！示例："谁能想到，这个在菜市场被按在地上摩擦的卖鱼佬，三年后竟然成了全省最大的黑老大！"`
      : hookIntensity >= 0.4
      ? `【开头钩子（强度${(hookIntensity * 100).toFixed(0)}%）】：第一句设置适度悬念吸引观众。示例："这个故事，要从一杯水说起。"`
      : `【开头风格（强度${(hookIntensity * 100).toFixed(0)}%）】：平铺直叙开场，适合纪录片。示例："今天给大家讲讲高启强的故事。"`;

    const systemPrompt = `${PERSONAS.SCREENWRITER}

## Task
你将收到一份经过物理切片与视觉分析的视频片段流（含有时间轴、角色锚定、ASR原声及画面描述）。
请据此撰写一份具有高吸引力、节奏感强、声画高度契合的解说文案。

## 创作风格
${style}：${styleInstruction}

${hookInstruction}

## ⚡ 爆款短句与卡点硬性规则 (Core Short-Sentence Rules)
1. **单句字数硬限制**：每个单句（两个标点之间的文字）绝对不能超过 ${maxSentenceChars} 字！多用动词、感叹句与极速短句（如："死死盯住！"、"眼神杀气顿显！"）。
2. **镜头级微切分**：每个输入 chunk 的解说词字数必须严格 ≤ 单段字数上限，绝不能把多个动作揉合成大段落。
3. **角色名称绝对统一**：严格使用【全局已知角色列表】中的姓名，严禁混淆人名或凭空创造角色列表之外的人名。
4. **消除视觉幻觉**：若 ASR 旁白与画面物理描述不一致，以【画面物理描述】为准描绘现场动作，以 ASR 为补充。
5. **拒绝流水账**：严禁描述画面直观已呈现的表面动作，重点剖析言下之意、内心戏与剧情冲突。

${CONSTRAINTS.ANTI_LITERAL}
${CONSTRAINTS.TTS_FRIENDLY}
${CONSTRAINTS.ROLE_ALIAS}
${CONSTRAINTS.NO_MERGE_SENTENCES}
${CONSTRAINTS.JSON_ONLY}

## 字数预算与参数指引
【严格字数约束】：考虑 TTS 标点停顿，字数预算需乘以 0.85 折损系数。
- 单段字数上限 = ⌊ 时长(秒) × ${speechRate} × ${(densityFillRate * 100).toFixed(0)}% × 0.85 ⌋
- 例如一个 3 秒的分镜，解说词应约 ${Math.floor(3 * speechRate * densityFillRate * discountFactor)} 字
- 一个 5 秒的分镜，解说词应约 ${Math.floor(5 * speechRate * densityFillRate * discountFactor)} 字
- 视频总时长约 ${totalDurationSec.toFixed(1)} 秒，解说词总量绝对严禁超过 ${Math.floor(totalDurationSec * speechRate * densityFillRate * discountFactor)} 字

【专业解说参数指引】：
- 叙事视角：${perspectiveMap[params.narrativePerspective] || perspectiveMap.third}
- 信息层次：${infoLevelMap[params.informationLevel] || infoLevelMap.deep}
- 解说密度：${densityMap[params.narrationDensity] || densityMap.standard}
- 原声策略：${audioStrategyMap[params.originalAudioStrategy] || audioStrategyMap.keep_key}
- 节奏模式：${rhythmMap[params.rhythmMode] || rhythmMap.mixed}
- 情绪基调：${emotionToneMap[params.emotionTone] || emotionToneMap.neutral}
- 声画权重：${(audioVisualWeight * 100).toFixed(0)}%（${audioVisualWeight > 0.5 ? '偏向视觉，主要依据画面描述描绘微表情和动作细节' : '偏向原声，解说词主要起提炼对白核心逻辑的作用'}）

## Output Format
请严格按照以下 JSON 数组格式返回结果，切勿包含任何 Markdown 格式化标记或额外解释：
[
  { "shotId": "s_01", "text": "解说词内容", "duration": 3.5 }
]`;

    // ========== 组装用户 Prompt：ContextChunk JSON + 角色ID映射 ==========
    // 阶段1：用 ContextChunk JSON 替代旧的松散文本拼接，让 LLM 看到结构化的时序数据
    let userPrompt = `【多模态上下文片段流（ContextChunk）】：
${JSON.stringify(contextChunks, null, 2)}`;

    // 阶段2：角色实体消歧 — 显式 ID→名称映射，禁止 LLM 凭空创造人名
    if (input.roles && input.roles.length > 0) {
      const roleMapLines = input.roles
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
          return `- ${r.id} -> ${r.name}${attrStr}`;
        });
      if (roleMapLines.length > 0) {
        userPrompt += `\n\n【全局已知角色列表】：
${roleMapLines.join('\n')}

【角色写作硬性准则】：
1. 当 chunk 的 anchoredCharacters 标明存在某角色 ID 时，文案必须使用对应的真实姓名或代词"他/她"。
2. 严禁凭空创造角色列表之外的人名。
3. 严禁使用"男子/女子/青年/中年人"等模糊代称。
4. 可在真实姓名与合乎情理的身份代词之间智能轮换，避免听觉疲劳。`;
      }
    }

    userPrompt += `\n\n【附加指令】：${input.customPrompt || '自由发挥'}\n\n请直接输出 JSON 数组：`;

    onProgress(45, `正在呼叫 [${modelName}] 引擎进行创造性脑暴...`);

    const response = await adapter.chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ], modelName, temperature);

    onProgress(90, '正在对生成的剧本进行反序列化...');

    let rawShots: Array<{ shotId: string; text: string; duration: number }> = [];
    try {
      rawShots = NetworkPipeline.strictParseJson(response.text || '');
      if (!Array.isArray(rawShots)) {
        throw new Error('大模型未返回预期的数组格式');
      }
    } catch (e) {
      AppLogger.error('ScriptGenStrategy', 'Failed to parse JSON from LLM', { error: String(e) });
      throw new Error(`剧本解析失败，大模型输出了脏数据: ${(response.text || '').substring(0, 50)}...`);
    }

    onProgress(93, '正在执行三级敏感词扫描...');

    const lexiconFilter = new LexiconFilter();
    const parsedShots: GeneratedShot[] = rawShots.map((raw) => {
      const scanResult = lexiconFilter.scan(raw.text || '');

      // 节奏模式影响分镜时长 — 短句快切缩短，长句舒缓加长，长短交替不变
      const baseDuration = raw.duration || 3;
      const paceAdjustedDuration = params.rhythmMode === 'short_fast'
        ? baseDuration * 0.8   // 短句快切：duration 缩短 20%
        : params.rhythmMode === 'slow_soothing'
        ? baseDuration * 1.3   // 长句舒缓：duration 加长 30%
        : baseDuration;        // 长短交替：不变

      return {
        shotId: raw.shotId || `shot_${Math.random().toString(36).slice(2, 8)}`,
        text: scanResult.original,
        cleanText: scanResult.cleanText,
        audioSafeText: lexiconFilter.getAudioSafeText(scanResult.cleanText, scanResult.original),
        flagged: scanResult.flagged,
        replaced: scanResult.replaced,
        lexiconMarks: scanResult.matches.map(m => ({
          word: m.word,
          level: m.level,
          replaced: m.replaced,
        })),
        duration: paceAdjustedDuration,
      } as GeneratedShot;
    });

    const flaggedCount = parsedShots.filter(s => s.flagged).length;
    const replacedCount = parsedShots.filter(s => s.replaced).length;
    if (flaggedCount > 0) {
      AppLogger.info('ScriptGenStrategy', `敏感词扫描完成: ${flaggedCount} 条标记, ${replacedCount} 条已替换`);
    }

    onProgress(100, `剧本重铸成功，共计 ${parsedShots.length} 幕分镜！`);
    // 返回 Object 而非裸数组，兼容前端 mapPipelineResultToState 的 { shots: [...] } 格式
    return { shots: parsedShots } as unknown as GeneratedShot[];
  }
}
