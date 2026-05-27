// 📁 路径：src/main/engine/strategies/ScriptGenStrategy.ts
import { BaseNodeStrategy, ExecutionContext } from './BaseNodeStrategy';
import { LLMFactory } from '../adapters/LLMFactory';
import { AppLogger } from '../../core/AppLogger';
import { LexiconFilter } from '../lexicon/LexiconFilter';
import { NetworkPipeline } from '../../core/NetworkPipeline';

export interface ScriptGenInput {
  modelName?: string;
  theme?: string;
  customPrompt?: string;
  // 以下可能由上一个节点通过 globalBus 传入
  visionResult?: any; 
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

    // V1.1: 读取 R/S/T/P 参数
    const params = context.pipelineParams || { R: 50, S: 50, T: 50, P: 50 };
    const retainRatio = params.R / 100;      // 经典片段保留比 (0-1)
    const silenceRatio = params.S / 100;     // 原台词保留比 (0-1)
    const ttsCoverage = params.T / 100;     // TTS 覆盖比 (0-1)
    const paceFactor = params.P / 100;       // 节奏因子 (0-1)

    let sceneContext = '缺乏画面信息。';

    // 从总线按依赖节点ID查找上游数据，而非硬编码字符串
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

    const visionData = input.visionResult;
    if (visionData?.sceneDescriptions) {
      sceneContext = visionData.sceneDescriptions;
    }

    const model = input.modelName || context.modelConfig?.modelName || 'deepseek-chat';
    const provider = context.modelConfig?.provider || 'deepseek';
    const baseUrl = context.modelConfig?.customBaseUrl;
    const adapter = LLMFactory.create(provider as any, '', baseUrl || '');

    onProgress(30, '正在组装爆款剧本 Prompt 并设定高燃逻辑...');

    const systemPrompt = `你是一个拥有20年经验的顶级动画与短视频编剧。
你的任务是根据输入的客观画面描述，重铸一份带有【赛博现实主义】与【无厘头废话文学】风格的高燃解说剧本。
叙事要求：
1. 擅长使用逻辑悖论和废话文学（例如："这只狗之所以是只狗，是因为它不是猫"）。
2. 情绪卡点必须高燃，在看似荒诞的描述中突然拔高立意。
3. 必须输出为一个严谨的 JSON 数组，格式如下：
[
  { "shotId": "s_01", "text": "解说词内容", "duration": 3.5 }
]

【V1.1 参数化创作指引】：
- 经典片段保留度：${(retainRatio * 100).toFixed(0)}%（数值越高，越倾向于保留原始画面的经典叙事片段；越低则越大胆重写）
- 原台词保留度：${(silenceRatio * 100).toFixed(0)}%（数值越高，越倾向于保留原始语音台词；越低则越倾向全量重写解说词）
- TTS 配音覆盖度：${(ttsCoverage * 100).toFixed(0)}%（数值越高，解说词越长越适合 TTS 配音；越低则偏短短语，保留原声比例大）
- 节奏因子：${(paceFactor * 100).toFixed(0)}%（数值越高节奏越快，分镜越短促；越低则节奏舒缓，单镜时长更长）

注意：绝对不要输出 JSON 代码块之外的任何多余字符。`;

    const userPrompt = `【原片画面扫描日志】：\n${sceneContext}\n\n【附加指令】：${input.customPrompt || '自由发挥'}\n\n请直接输出 JSON 数组：`;

    onProgress(45, `正在呼叫 [${model}] 引擎进行创造性脑暴...`);

    const response = await adapter.chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ], model, 0.8);

    onProgress(90, '正在对生成的剧本张量进行反序列化...');

    let rawShots: Array<{ shotId: string; text: string; duration: number }> = [];
    try {
      // 💥 Layer 4: 强制流经数据清洗防线，阻断脏资产向状态层渗透
      rawShots = NetworkPipeline.strictParseJson(response.text || '');
      if (!Array.isArray(rawShots)) {
        throw new Error('大模型未返回预期的数组格式');
      }
    } catch (e) {
      AppLogger.error('ScriptGenStrategy', 'Failed to parse JSON from LLM', { error: String(e) });
      throw new Error(`剧本解析失败，大模型输出了脏数据: ${(response.text || '').substring(0, 50)}...`);
    }

    onProgress(93, '正在执行 V1.1 三级敏感词扫描...');

    const lexiconFilter = new LexiconFilter();
    const parsedShots: GeneratedShot[] = rawShots.map((raw) => {
      const scanResult = lexiconFilter.scan(raw.text || '');

      // V1.1: paceFactor 影响分镜时长 — 快节奏时缩短，慢节奏时加长
      const baseDuration = raw.duration || 3;
      const paceAdjustedDuration = paceFactor < 0.5
        ? baseDuration * (1 + (0.5 - paceFactor))   // 慢节奏加长
        : baseDuration * (1 - (paceFactor - 0.5) * 0.4); // 快节奏缩短，最多缩短 20%

      const gs: GeneratedShot = {
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
      };

      return gs;
    });

    const flaggedCount = parsedShots.filter(s => s.flagged).length;
    const replacedCount = parsedShots.filter(s => s.replaced).length;
    if (flaggedCount > 0) {
      AppLogger.info('ScriptGenStrategy', `敏感词扫描完成: ${flaggedCount} 条标记, ${replacedCount} 条已替换`);
    }

    onProgress(100, `剧本重铸成功，共计 ${parsedShots.length} 幕分镜！`);
    return parsedShots as unknown as GeneratedShot[];
  }
}
