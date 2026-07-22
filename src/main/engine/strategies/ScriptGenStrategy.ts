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
  /** 前端传入的 R/S/T/P 创作参数 */
  pipelineParams?: { R: number; S: number; T: number; P: number };
  /** 用户选择的语速（字/秒） */
  speechRate?: number;
  /** 上游视觉结果 */
  visionResult?: any;
  /** 上游听觉/ASR 结果 */
  audioResult?: any;
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

/** 风格到 Prompt 指令的映射 */
const STYLE_PROMPTS: Record<string, string> = {
  '赛博现实主义': '擅长使用逻辑悖论和废话文学（例如："这只狗之所以是只狗，是因为它不是猫"）。情绪卡点必须高燃，在看似荒诞的描述中突然拔高立意。',
  '无厘头废话文学': '全程废话文学，用看似有逻辑实则毫无意义的句式推进叙事（例如："之所以如此，是因为如此"）。越荒诞越好，但必须和画面内容有微弱关联。',
  '正经科普': '以严谨客观的语气进行知识性解说，注重事实准确性和逻辑清晰度，适当引用专业术语但保持通俗易懂。',
  '情感叙事': '以细腻感性的笔触描绘画面中的情绪流动，善用比喻和意象，在平淡场景中挖掘深层情感共鸣。',
  '悬疑推理': '用层层设问和伏笔构建悬念，每一句解说都是线索碎片，引导观众在脑中拼凑真相，节奏张弛有度。',
  '轻松幽默': '用轻松诙谐的语气吐槽画面内容，善用网络流行语和反转梗，让观众会心一笑，但不要过度玩梗。',
};

/** 将 ASR 台词行的时间戳格式化为 MM:SS 字符串（兼容 Fix 1 毫秒格式与旧 MM:SS 格式） */
function formatAsrTime(l: any): string {
  if (l.startMs !== undefined) {
    const totalSec = Math.floor(l.startMs / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  if (typeof l.start === 'number') {
    const totalSec = Math.floor(l.start / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return l.start || l.begin || '00:00';
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

    // 读取 R/S/T/P 参数：优先使用前端传入的，其次使用 context 中的默认值
    const params = input.pipelineParams || context.pipelineParams || { R: 50, S: 50, T: 50, P: 50 };
    const retainRatio = params.R / 100;      // 经典片段保留比 (0-1)
    const silenceRatio = params.S / 100;     // 原台词保留比 (0-1)
    const ttsCoverage = params.T / 100;      // TTS 覆盖比 (0-1)
    const paceFactor = params.P / 100;       // 节奏因子 (0-1)

    // 收集上游视觉数据
    let sceneContext = '缺乏画面信息。';
    const upstreamNodeIds = Array.from(context.bus.keys()).filter(
      id => id !== 'source_root'
    );
    for (const nodeId of upstreamNodeIds) {
      const busData = context.bus.get(nodeId);
      if (busData?.sceneDescriptions) {
        sceneContext = busData.sceneDescriptions;
        break;
      }
      if (busData?.frames) {
        sceneContext = `共提取 ${busData.frames.length} 个关键帧`;
      }
    }
    // 兼容 input 直接传入的视觉数据
    if (input.visionResult?.sceneDescriptions) {
      sceneContext = input.visionResult.sceneDescriptions;
    }

    // 计算场景行数（用于字数约束）
    const sceneLineCount = sceneContext.split('\n').filter((l: string) => l.trim().length > 0).length || 1;

    // 收集上游 ASR 字幕数据
    let subtitleContext = '';
    for (const nodeId of upstreamNodeIds) {
      const busData = context.bus.get(nodeId);
      const rawLines = busData?.asrLines || busData?.lines || [];
      if (rawLines.length > 0) {
        subtitleContext = rawLines
          .map((l: any) => {
            const timeStr = formatAsrTime(l);
            return `[${timeStr}] ${l.text || l.content || ''}`;
          })
          .join('\n');
        break;
      }
      if (busData?.asrText && typeof busData.asrText === 'string') {
        subtitleContext = busData.asrText;
        break;
      }
    }
    // 兼容 input 直接传入的 ASR 数据
    if (input.audioResult?.lines && Array.isArray(input.audioResult.lines)) {
      subtitleContext = input.audioResult.lines
        .map((l: any) => {
          const timeStr = formatAsrTime(l);
          return `[${timeStr}] ${l.text || l.content || ''}`;
        })
        .join('\n');
    }

    // 使用 LLMFactory.createAdapter 自动读取用户配置的模型和 API Key
    const { adapter, modelName, temperature } = LLMFactory.createAdapter('script');

    onProgress(30, '正在组装剧本 Prompt 并设定创作逻辑...');

    // 动态注入用户选择的风格
    const style = input.scriptStyle || '赛博现实主义';
    const styleInstruction = STYLE_PROMPTS[style] || STYLE_PROMPTS['赛博现实主义'];

    const systemPrompt = `${PERSONAS.SCREENWRITER}

【创作风格】：${style}
${styleInstruction}

${CONSTRAINTS.NO_MERGE_SENTENCES}
${CONSTRAINTS.JSON_ONLY}

必须输出为一个严谨的 JSON 数组，格式如下：
[
  { "shotId": "s_01", "text": "解说词内容", "duration": 3.5 }
]

【字数约束】：请按 ${speechRate} 字/秒的语速标准，控制每个分镜的解说词长度。
- 例如一个 3 秒的分镜，解说词应约 ${Math.floor(3 * speechRate)} 字
- 一个 5 秒的分镜，解说词应约 ${Math.floor(5 * speechRate)} 字
- 总时长约 ${sceneLineCount * 4} 秒，解说词总量控制在 ${Math.floor(sceneLineCount * 4 * speechRate)} 字以内

【参数化创作指引】：
- 经典片段保留度：${(retainRatio * 100).toFixed(0)}%（数值越高，越倾向于保留原始画面的经典叙事片段；越低则越大胆重写）
- 原台词保留度：${(silenceRatio * 100).toFixed(0)}%（数值越高，越倾向于保留原始语音台词；越低则越倾向全量重写解说词）
- TTS 配音覆盖度：${(ttsCoverage * 100).toFixed(0)}%（数值越高，解说词越长越适合 TTS 配音；越低则偏短短语，保留原声比例大）
- 节奏因子：${(paceFactor * 100).toFixed(0)}%（数值越高节奏越快，分镜越短促；越低则节奏舒缓，单镜时长更长）

注意：绝对不要输出 JSON 代码块之外的任何多余字符。`;

    // 组装用户 Prompt，包含画面描述和字幕数据
    let userPrompt = `【原片画面扫描日志】：\n${sceneContext}`;
    if (subtitleContext) {
      userPrompt += `\n\n【原片台词/字幕记录】：\n${subtitleContext}`;
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

      // paceFactor 影响分镜时长 — 快节奏时缩短，慢节奏时加长
      const baseDuration = raw.duration || 3;
      const paceAdjustedDuration = paceFactor < 0.5
        ? baseDuration * (1 + (0.5 - paceFactor))   // 慢节奏加长
        : baseDuration * (1 - (paceFactor - 0.5) * 0.4); // 快节奏缩短，最多缩短 20%

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
