// 📁 路径：src/main/engine/strategies/ScriptGenStrategy.ts
import { BaseNodeStrategy, ExecutionContext } from './BaseNodeStrategy';
import { LLMFactory } from '../adapters/LLMFactory';
import { AppLogger } from '../../core/AppLogger';
import { LexiconFilter } from '../lexicon/LexiconFilter';
import { NetworkPipeline } from '../../core/NetworkPipeline';
import { PERSONAS } from '../prompts/personas';
import { CONSTRAINTS } from '../prompts/constraints';
import { LOG_TAGS } from '@modules/infra/logger/LogConstants';
import { breakLongParagraphs } from '@modules/pipeline/step3-script/frontend/breakLongParagraphs';

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
  /** 原声段落标记：文案生成按原声策略标记"留原声"的段落（keep_key/original_main），下游 TTS 跳过合成、匹配锁定原片时间段 */
  keepOriginalAudio?: boolean;
  /** 🎭 P1 角色组合匹配：本段解说词对应的视频片段中出现的人物名集合（来自 step2 VLM 角色锚定），透传到步骤5 Query 端做角色契合匹配 */
  characters?: string[];
  /** 🎯 P3 画面意图：本段解说词"应配什么画面"的画面语言描述（主体/动作/场景/景别/氛围），
   *  步骤5 以此为匹配查询依据，与切片描述做文本↔文本语义匹配（替代解说词文本↔画面的跨空间错位） */
  visualIntent?: string;
  /** 🎯 P3 时间轴锚定：本段解说词对应的画面时间起点（ms），来自步骤2 微切分 chunk，供步骤5 锚定切片 */
  startMs?: number;
  /** 🎯 P3 时间轴锚定：本段解说词对应的画面时长（ms） */
  durationMs?: number;
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

/**
 * 🎬 视觉噪点过滤与 Key-Action 提纯器
 * 输入：step2 downstream.shot 结构（含 action/emotion/keywords/shotType/asrText）
 * 输出：蒸馏后的 keyAction（带【特写】前缀）+ 噪点过滤后的 keywords
 *
 * 设计原则（遵循项目准则"错就错，不降级"）：
 * - 不对 action 做正则兜底（VLM 已通过 JSON Schema 强制输出 narrativeAction，缺失就是缺失，暴露给 LLM）
 * - 不创造默认值掩盖空字段（action 为空时 keyAction 也为空，LLM 会自然依据 ASR 推理）
 * - keywords 噪点过滤是"设计上的多路径"，不是防御性兜底：剔除环境类词以聚焦戏剧冲突
 *
 * @param shot step2 输出的 downstream.shot 结构
 * @returns 蒸馏后的 keyAction 与过滤后的 keywords
 */
function extractKeyVisualAction(shot: any): {
  keyAction: string;
  emotion?: string;
  atmosphere?: string;
  cameraMovement?: string;
  dramaticConflict?: string;
  subject?: string;
  primarySubject?: string;
  secondarySubjects?: string[];
  interaction?: string;
  shotStyle?: string;
  characters?: string[];
  purifiedKeywords: string[];
} {
  // 1. action 直接取自 VLM 结构化输出（narrativeAction），无需正则清洗
  const rawAction: string = shot?.action || '';

  // 2. 组合镜头语言前缀（如：【特写/推】死死盯住冰鱼），让 LLM 一眼看到镜头调度
  const shotType: string = shot?.shotType || '';
  const shotPrefix = shotType ? `【${shotType}】` : '';
  // 🎥 运镜附在景别后（如：【特写/推】），静态镜头不冗余标注"固定"
  const cameraMovement: string = shot?.cameraMovement || '';
  const cameraSuffix = cameraMovement && cameraMovement !== '固定' ? `/${cameraMovement}` : '';
  const keyAction = `${shotPrefix}${cameraSuffix}${rawAction}`;

  // 3. keywords 噪点过滤：剔除环境/材质/颜色类静态词，仅保留动作/情绪/道具/人物关键词
  // 这是"设计上的多路径"（用户需求明确要求聚焦戏剧冲突），不是防御性兜底
  const ENVIRONMENT_NOISE_PATTERNS = [
    // 环境套话：背景/墙面/地板/家具/材质
    /^(背景|墙面|墙壁|地板|地面|天花板|家具|桌子|椅子|沙发|床|门|窗|窗帘|地毯)/,
    // 颜色与材质：白/黑/红/木/金属/塑料 + 墙/地/桌
    /^(白色|黑色|红色|黄色|蓝色|绿色|灰色|木制|木质|金属|塑料|玻璃)/,
    // 静态场景词：室内/户外/房间/客厅/办公室/街道
    /^(室内|户外|房间|客厅|卧室|厨房|办公室|街道|场景|环境)/,
    // 图像说明套话：画面/镜头/图片
    /^(画面|镜头|图片|图像|视角)/,
  ];
  const rawKeywords: string[] = Array.isArray(shot?.keywords) ? shot.keywords : [];
  const purifiedKeywords = rawKeywords.filter((kw: any) => {
    if (typeof kw !== 'string' || !kw.trim()) return false;
    return !ENVIRONMENT_NOISE_PATTERNS.some(pattern => pattern.test(kw.trim()));
  });

  return {
    keyAction,
    emotion: shot?.emotion || undefined,
    atmosphere: shot?.atmosphere || shot?.lighting || undefined,
    cameraMovement: shot?.cameraMovement || undefined,
    dramaticConflict: shot?.dramaticConflict || undefined,
    subject: shot?.subject || undefined,
    // 👥 P0 多人物关系建模透传：供 LLM 理解主宾关系，避免"房间里两个人"式废话
    primarySubject: shot?.primarySubject || undefined,
    secondarySubjects: Array.isArray(shot?.secondarySubjects) ? shot.secondarySubjects : undefined,
    interaction: shot?.interaction || undefined,
    shotStyle: shot?.shotStyle || undefined,
    characters: Array.isArray(shot?.characters) ? shot.characters : undefined,
    purifiedKeywords,
  };
}

/**
 * 🎯 P3 兜底：LLM 漏写 visualIntent 时，基于对应 chunk 的视觉上下文本地拼装
 * 保证步骤5 query 端永远有"画面语言描述"可用（而非回退到解说词跨空间匹配）。
 *
 * 设计原则（错就错不造假）：
 * - 只用视觉分析真实产出的字段（shotType/cameraMovement/keyAction/emotion/atmosphere/characters/keywords）
 * - 不凭空编造动作、情绪；所有字段为空时回退解说词前 20 字 + 标注"【兜底】"
 * - 控制在 20-40 字区间（Netflix 字幕安全框单句≤16字是前端断句器的事，这里控制上限避免 CLIP 截断）
 *
 * @param raw LLM 原始输出（可能缺 visualIntent）
 * @param chunk 对应下标的 contextChunk，含 visualContext（步骤2 downstream + keyAction 提纯） + anchoredCharacters + asrContext
 * @param fallbackText 极端情况下的回退文案（解说词 text，前 20 字截断）
 * @returns 填充好的 visualIntent，保证非空字符串
 */
function ensureVisualIntentFilled(
  raw: { text?: string; emotion?: string; visualIntent?: string },
  chunk: any,
  fallbackText: string,
): string {
  // 已有合法 visualIntent：非空、非占位词 → 直接用
  const existing = String(raw?.visualIntent || '').trim();
  const PLACEHOLDER_RE = /^(无|没有|未指定|未提供|none|null|empty|unknown|n\/a|\/|)$/i;
  if (existing && !PLACEHOLDER_RE.test(existing)) return existing;

  // 基于对应 chunk 的视觉上下文拼装（与步骤2 VLM 输出同源，不会凭空编造画面）
  const vc = chunk?.visualContext || {};
  const parts: string[] = [];

  // 景别 + 运镜前缀（如【特写/推】），给步骤5提供结构化镜头语言锚点
  const shotType = String(vc.shotType || '').trim();
  const camera = String(vc.cameraMovement || '').trim();
  const prefix = (() => {
    if (!shotType && !camera) return '';
    const cam = camera && camera !== '固定' ? `/${camera}` : '';
    return shotType ? `【${shotType}${cam}】` : '';
  })();
  if (prefix) parts.push(prefix);

  // 核心动作（keyAction = 蒸馏后的 narrativeAction，已提纯无环境噪点）
  const keyAction = String(vc.keyAction || '').trim();
  if (keyAction) {
    // keyAction 本身可能带【景别/运镜】前缀，与外部 prefix 重复时取内部更全的那个，或直接拼
    parts.push(keyAction.replace(/^【[^】]*】/, ''));
  }

  // 表情情绪（如：眼神凌厉/面色阴沉）
  const emo = String(raw?.emotion || vc.emotion || '').trim();
  if (emo) parts.push(`情绪：${emo}`);

  // 光影氛围（如：昏暗压抑/柔和光线）
  const atm = String(vc.atmosphere || '').trim();
  if (atm) parts.push(`氛围：${atm}`);

  // 角色锚定：chunk 中明确检测到谁就写谁，让步骤5 角色组合匹配更稳
  const roles: string[] = [];
  if (Array.isArray(chunk?.anchoredCharacters)) {
    for (const r of chunk.anchoredCharacters) if (typeof r === 'string' && r.trim()) roles.push(r.trim());
  }
  if (Array.isArray(vc.characters)) {
    for (const r of vc.characters) if (typeof r === 'string' && r.trim() && !roles.includes(r.trim())) roles.push(r.trim());
  }
  if (roles.length > 0) parts.push(`人物：${roles.join('、')}`);

  // 关键词补位（动作/情绪/道具类，纯视觉关键词）
  const kw: string[] = Array.isArray(vc.keywords) ? vc.keywords.filter((k: any) => typeof k === 'string' && k.trim()).slice(0, 4) : [];
  if (kw.length > 0) parts.push(`关键词：${kw.join('、')}`);

  let result = parts.filter(Boolean).join('，');
  // 控制上限 40 字，避免 CLIP 512 token 截断浪费算力；保留前缀保证镜头语言锚点
  if (result.length > 40) {
    // 先尝试保留【景别】前缀，其余部分 36 字截断
    if (prefix && result.startsWith(prefix)) {
      result = prefix + result.slice(prefix.length).slice(0, 40 - prefix.length);
    } else {
      result = result.slice(0, 40);
    }
  }

  // 极端兜底：视觉上下文全空（例如步骤2 没跑），回退解说词文本前 20 字 + 标注【兜底】
  if (!result) {
    const t = String(fallbackText || raw?.text || '').trim();
    result = t ? `【兜底】${t.slice(0, 20)}` : '【兜底】通用画面';
  }
  return result;
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
      targetNarrationDurationSec: 0,
    };
    const params = input.pipelineParams || context.pipelineParams || DEFAULT_PARAMS;
    const hookIntensity = params.hookIntensity ?? 0.7;

    /**
     * SSOT：audioVisualWeight 由 originalAudioStrategy 唯一映射（与 Service.ts / View.tsx 保持一致）
     * - cover: 0.8（解说全量覆盖，更多依赖视觉画面描写）
     * - keep_key: 0.5（均衡）
     * - original_main: 0.2（解说辅助过渡，更多提炼 ASR 对白）
     */
    const AUDIO_STRATEGY_TO_WEIGHT_MAP: Record<string, number> = {
      cover: 0.8,
      keep_key: 0.5,
      original_main: 0.2,
    };
    const audioVisualWeight = AUDIO_STRATEGY_TO_WEIGHT_MAP[params.originalAudioStrategy] ?? 0.5;

    // 解说密度 → 基础字数填充系数（0-1）：满配1.0 / 标准0.85 / 留白0.6
    // 提示词给 LLM 的"单段字数"以此为准（见 perChunkFillRate），保证每段能写出通顺连贯的句子，
    // 而不是被原声/节奏折扣连环压缩成 7~12 字的碎片。
    const baseDensityFillRate = params.narrationDensity === 'full' ? 1.0
                              : params.narrationDensity === 'sparse' ? 0.6
                              : 0.85;

    /**
     * 原声策略折扣：对 densityFillRate 再打一层折，避免时间轴物理溢出
     * - cover(全量覆盖解说): 1.0（原声时间轴无占用，无需打折）
     * - keep_key(关键台词保留): 0.85（约 15% 时间留给关键原声）
     * - original_main(原声为主): 0.45（约 60%~80% 时间留给高光对白，解说仅辅助串场）
     */
    const AUDIO_STRATEGY_DISCOUNT: Record<string, number> = {
      cover: 1.0,
      keep_key: 0.85,
      original_main: 0.45,
    };
    const audioStrategyDiscount = AUDIO_STRATEGY_DISCOUNT[params.originalAudioStrategy] ?? 1.0;
    // 原声策略折扣只应控制"全片解说总时长/总量"，避免原声时间轴物理溢出；
    // 不应压缩"单个已选中解说段的字数"——否则 keep_key 下每段只剩 7~12 字，无法成句。
    // perChunkFillRate = 单段字数填充系数（解耦原声折扣）；densityFillRate = 全片总量预算系数。
    let perChunkFillRate = baseDensityFillRate;
    // 可变：若用户设置了"目标解说时长"，会在 totalDurationSec 计算后用目标时长覆盖（todo）
    let densityFillRate = baseDensityFillRate * audioStrategyDiscount;

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

    // ========== 阶段1：ContextChunk 结构化数据组装（时序对齐 + 角色锚定） ==========
    // 收集上游视觉数据（downstreamContext 优先）和 ASR 字幕数据
    const upstreamNodeIds = Array.from(context.bus.keys()).filter(
      id => id !== 'source_root'
    );

    let visualShots: any[] = []; // 结构化视觉片段（含 action/emotion/keywords）
    let sceneDescriptions = '';   // 兼容：原始画面描述长文本
    let asrLines: any[] = [];     // ASR 台词行（含时间戳）
    /** 🎬 全片剧情故事线（各帧 action 时序串联），供剧情理解阶段感知全局剧情 */
    let storyLine = '';

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
      if (!storyLine && busData.storyLine) {
        storyLine = busData.storyLine;
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

      // 🎯 角色名对齐：步骤1人脸识别产出权威角色名（input.roles[].name），
      // 步骤2 VLM 输出的角色名可能带后缀/略有出入（如"崔国明（中年）"），
      // 此处统一规范化为步骤1的权威姓名，确保文案与步骤1人脸识别的角色名一致。
      const step1AuthoritativeNames: string[] = (input.roles || [])
        .map((r: any) => (r && r.name ? String(r.name).trim() : ''))
        .filter(Boolean)
        // 自动命名的"角色_N"是机械编号，不参与对齐，VLM 对未命名人物用"男子/女子"泛称即可
        .filter((n: string) => !/^角色_\d+$/.test(n));
      // 归一化辅助：去括号后缀 + 去空白，用于模糊匹配
      const cleanRole = (s: string) => s.replace(/[（(【\[].*?[）)】\]]/g, '').replace(/\s+/g, '');
      // 将 VLM 角色名对齐到步骤1权威姓名；无法匹配时回退 VLM 原名，避免丢角色
      const normalizeRoleName = (v: string): string => {
        const trimmed = v.trim();
        if (!trimmed) return trimmed;
        if (step1AuthoritativeNames.includes(trimmed)) return trimmed;
        const cleanV = cleanRole(trimmed);
        if (!cleanV) return trimmed;
        for (const name of step1AuthoritativeNames) {
          const cleanName = cleanRole(name);
          if (cleanV === cleanName) return name;
          // 双向包含判同：VLM 输出"国明"或"崔国明（中年）"都能命中"崔国明"
          if (cleanV.length >= 2 && (cleanV.includes(cleanName) || cleanName.includes(cleanV))) return name;
        }
        return trimmed;
      };

      // 角色锚定：从 shot.characters / primarySubject / secondarySubjects / subject 提取该片段出现的人物
      // 视觉分析可能只输出 primarySubject（如"崔国明"）而未填 characters，须全部并入，避免 LLM 拿不到角色名而全文用"他"
      const anchoredCharacters: string[] = [];
      // 无效占位值过滤：VLM 可能输出"无/未知/背景/路人/群众"等，需剔除，避免污染角色锚定
      const INVALID_ROLE_PATTERN = /^(无|未知|不清楚|背景|路人|群众|群演|旁白|画外音|观众|unknown|null|none|发现|看到|画面)$/i;
      const collectRole = (v: unknown) => {
        if (typeof v === 'string' && v.trim() && !INVALID_ROLE_PATTERN.test(v.trim())) {
          // 对齐到步骤1人脸识别的权威角色名
          anchoredCharacters.push(normalizeRoleName(v.trim()));
        }
      };
      if (Array.isArray(shot.characters)) {
        shot.characters.forEach(collectRole);
      }
      collectRole(shot.primarySubject);
      if (Array.isArray(shot.secondarySubjects)) {
        shot.secondarySubjects.forEach(collectRole);
      }
      collectRole(shot.subject);
      // 去重且保持顺序
      const seen = new Set<string>();
      const uniqueRoles = anchoredCharacters.filter(r => {
        if (seen.has(r)) return false;
        seen.add(r);
        return true;
      });
      anchoredCharacters.length = 0;
      anchoredCharacters.push(...uniqueRoles);

      // ASR 上下文：找到时间轴范围内的台词
      const chunkAsrLines = hasAsrTimestamps
        ? asrLines.filter(l => {
            const lStart = l.startMs ?? (typeof l.start === 'number' ? l.start : 0);
            return lStart >= chunkStartMs && lStart < chunkStartMs + chunkDurationMs;
          })
        : asrLines.slice(i * Math.max(1, Math.floor(asrLines.length / totalShots)), (i + 1) * Math.max(1, Math.floor(asrLines.length / totalShots)));
      const asrContext = chunkAsrLines.map(l => l.text || l.content || '').filter(Boolean).join(' ') || '';

      // 🎬 视觉噪点过滤与 Key-Action 提纯：剔除"背景是一面墙"等静态水文
      // 仅保留戏剧动作（带【特写】镜头前缀）+ 微表情 + 噑点过滤后的 keywords
      // 让 LLM 注意力聚焦于戏剧冲突，而非环境描写
      const purifiedVisual = extractKeyVisualAction(shot);

      contextChunks.push({
        chunkId: `chunk_${String(i + 1).padStart(3, '0')}`,
        timeRange: `${formatMsToTime(chunkStartMs)} -> ${formatMsToTime(chunkStartMs + chunkDurationMs)}`,
        startMs: chunkStartMs,
        durationMs: chunkDurationMs,
        durationSec: parseFloat((chunkDurationMs / 1000).toFixed(1)),
        anchoredCharacters,
        asrContext: asrContext ? `原声：${asrContext}` : '',
        visualContext: {
          keyAction: purifiedVisual.keyAction,           // 蒸馏后的动作（如：【特写/推】死死盯住冰鱼）
          emotion: purifiedVisual.emotion,                // 表情情绪（如：阴沉/咬牙）
          atmosphere: purifiedVisual.atmosphere,          // 氛围（如：压抑对峙）
          cameraMovement: purifiedVisual.cameraMovement,  // 🎥 运镜（如：推/摇/移）
          dramaticConflict: purifiedVisual.dramaticConflict, // ⚡ 剧情张力/看点（如：发现秘密）
          subject: purifiedVisual.subject,                // 👤 画面核心主体（如：张三）
          // 👥 P0 多人物关系建模：主焦点/陪体/交互/场景分类/角色集合，供 LLM 写主宾明确、有张力的旁白
          primarySubject: purifiedVisual.primarySubject,  // 👥 主焦点（如：张三）
          secondarySubjects: purifiedVisual.secondarySubjects, // 👥 陪体（如：["李四"]）
          interaction: purifiedVisual.interaction,        // 🤝 交互动作（如：张三举枪质问角落里的李四）
          shotStyle: purifiedVisual.shotStyle,            // 🎬 场景分类（如：双人对峙）
          characters: purifiedVisual.characters,          // 🎭 角色集合（供 step3 角色锚定/step5 组合过滤）
          keywords: purifiedVisual.purifiedKeywords,      // 噑点过滤后的关键词
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

    // ========== 阶段1.6：短 chunk 合并 — 消除 1~3 秒碎片，保证每段有足够字数写连贯叙事 ==========
    // 用户反馈：step2 的 shot 时长可能只有 1.2~3 秒，按"每 chunk 一段解说 + 字数硬上限"生成时，
    // 每段只能写 4~15 字，被迫凑成 9~10 字孤立短句，段落间无衔接、无剧情纵深。
    // 方案：把时长 < MIN_CHUNK_SEC(4s) 的连续 chunk 向前合并成更大的叙事单元，
    // 让每段能容纳完整长句/多分句，真正写出"通顺连贯"的解说，再交给断句器按字幕安全框切回。
    const MIN_CHUNK_SEC = 4;
    if (contextChunks.length > 1) {
      const mergedChunks: any[] = [];
      let unit: any = null; // 当前正在累积的叙事单元
      for (const chunk of contextChunks) {
        if (!unit) {
          unit = { ...chunk };
          mergedChunks.push(unit);
          continue;
        }
        // 当前单元时长未达标 → 并入该 chunk，扩展时间轴并拼接 ASR/关键动作上下文
        if (unit.durationSec < MIN_CHUNK_SEC) {
          unit.durationMs += chunk.durationMs;
          unit.durationSec = parseFloat((unit.durationMs / 1000).toFixed(1));
          unit.timeRange = `${unit.timeRange.split(' -> ')[0]} -> ${chunk.timeRange.split(' -> ')[1]}`;
          if (chunk.asrContext) unit.asrContext = [unit.asrContext, chunk.asrContext].filter(Boolean).join(' ');
          const prevKey = unit.visualContext?.keyAction || '';
          const curKey = chunk.visualContext?.keyAction || '';
          if (curKey) unit.visualContext = { ...unit.visualContext, keyAction: [prevKey, curKey].filter(Boolean).join('；') };
        } else {
          unit = { ...chunk };
          mergedChunks.push(unit);
        }
      }
      // 末尾若残留 < 4s 的孤立单元，并入前一段，避免尾部碎片段
      const tail = mergedChunks[mergedChunks.length - 1];
      if (mergedChunks.length > 1 && tail.durationSec < MIN_CHUNK_SEC) {
        mergedChunks.pop();
        const prev = mergedChunks[mergedChunks.length - 1];
        prev.durationMs += tail.durationMs;
        prev.durationSec = parseFloat((prev.durationMs / 1000).toFixed(1));
        prev.timeRange = `${prev.timeRange.split(' -> ')[0]} -> ${tail.timeRange.split(' -> ')[1]}`;
        if (tail.asrContext) prev.asrContext = [prev.asrContext, tail.asrContext].filter(Boolean).join(' ');
        const pk = prev.visualContext?.keyAction || '';
        const ck = tail.visualContext?.keyAction || '';
        if (ck) prev.visualContext = { ...prev.visualContext, keyAction: [pk, ck].filter(Boolean).join('；') };
      }
      contextChunks.length = 0;
      contextChunks.push(...mergedChunks);
    }

    // 计算总时长（秒）用于字数预算（阶段4：真实时间轴替代 sceneLineCount*4 硬编码）
    const totalDurationSec = contextChunks.reduce((sum, c) => sum + c.durationSec, 0) || (totalShots * 4);

    // 目标解说时长覆盖：用户显式指定解说总时长时，用它反推等效填充率，覆盖 narrationDensity 三档
    // 需放在 totalDurationSec 之后（要用视频总时长做除法）。目标时长相对视频总时长 clamp 到 [0,1]，
    // 避免解说超出视频物理溢出。0 / undefined 表示未设置，保持 density 自动逻辑。
    const targetSec = typeof params.targetNarrationDurationSec === 'number' && params.targetNarrationDurationSec > 0
      ? params.targetNarrationDurationSec
      : null;
    if (targetSec !== null && totalDurationSec > 0) {
      densityFillRate = Math.min(1, targetSec / totalDurationSec);
      // 单段字数系数同步跟随，避免"总时长受限但单段仍按 0.85"导致总量超预算
      perChunkFillRate = Math.min(1, Math.max(0.5, densityFillRate * 1.3));
    }

    // 使用 LLMFactory.createAdapter 自动读取用户配置的模型和 API Key
    const { adapter, modelName, temperature } = LLMFactory.createAdapter('script');

    onProgress(30, '正在组装剧本 Prompt 并设定创作逻辑...');

    // ========== 阶段A：剧情理解（剧情驱动解说的前置大纲） ==========
    // 🎬 用户核心诉求：解说应"贴合剧情主线 + 加合理解读"，而非"画面翻译"。
    // 让 LLM 先通读全部片段流 + 角色列表，提炼剧情大纲（logline/arc/动机/转折），
    // 阶段B 带大纲逐段解说，每段都有全局坐标，保证段间因果连贯、转折处有解读。
    // 失败处理（设计上的多路径）：剧情理解是增强路径，失败时明确告警并回退"逐段解说"基础路径
    // （与 BGM 节拍检测失败继续无 BGM 模式同哲学），不静默掩盖。
    let plotOutline: any = null;
    try {
      onProgress(33, '正在理解剧情主线（阶段1/2）...');
      const outlineSystemPrompt = `你是一位顶级的影视剧情分析师。你的任务是从片段流中提炼完整剧情主线，供解说创作者撰写"贴合剧情"的解说文案。
你绝不描述画面细节（那是画面翻译，不是剧情理解），只提炼剧情逻辑：发生了什么、为什么、人物想要什么、转折在哪里。`;
      const roleLinesForOutline = (input.roles || [])
        .filter((r: any) => r && r.name)
        .map((r: any) => `- ${r.name}${r.representative?.gender !== undefined ? (r.representative.gender === 1 || r.representative.gender === 'M' || r.representative.gender === 'male' ? '（男）' : '（女）') : ''}`)
        .join('\n');
      const outlineUserPrompt = `【角色列表】：
${roleLinesForOutline || '（未识别到角色，以片段流中的代称为准）'}
${storyLine ? `\n【全片剧情故事线】（步骤2视觉分析按时间顺序串联的画面动作脉络，供你理解全局剧情走向）：
${storyLine}` : ''}

【视频片段流（含时间轴 / 画面描述 / 原声台词）】：
${JSON.stringify(contextChunks, null, 2)}

请严格输出 JSON（不要 Markdown 包裹，不要解释）：
{
  "logline": "一句话故事梗概（谁 + 想做什么 + 阻碍 + 结果）",
  "arc": ["开场钩子", "铺垫", "冲突升级", "高潮", "结局"],
  "characterMotives": { "角色名": "该角色的目标与动机（无角色则空对象）" },
  "keyTurns": [{ "chunkId": "片段流中的 chunkId", "turn": "剧情转折点描述" }]
}`;
      const outlineResponse = await adapter.chat(
        [
          { role: 'system', content: outlineSystemPrompt },
          { role: 'user', content: outlineUserPrompt },
        ],
        modelName,
        0.3, // 大纲生成用低温，保证剧情归纳稳定
      );
      const parsedOutline = NetworkPipeline.strictParseJson(outlineResponse.text || '');
      if (parsedOutline && typeof parsedOutline === 'object' && !Array.isArray(parsedOutline) && parsedOutline.logline) {
        plotOutline = parsedOutline;
        AppLogger.info(LOG_TAGS.AI_AGENT, `[文案生成] 剧情理解完成：${parsedOutline.logline}`);
      } else {
        AppLogger.warn(LOG_TAGS.AI_AGENT, '[文案生成] 剧情大纲返回格式异常，降级为逐段解说模式');
      }
    } catch (e: any) {
      AppLogger.warn(LOG_TAGS.AI_AGENT, `[文案生成] 剧情理解失败，降级为逐段解说模式: ${e.message}`);
    }

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
    // 解说密度 → prompt 指令（含字数填充率：展示单段填充率，让 LLM 知道每段可写的字数）
    const densityMap: Record<string, string> = {
      'full': `满配（单段填充率${(perChunkFillRate * 100).toFixed(0)}%）：每秒都有解说，信息密度最大，适合硬核科幻、高智商犯罪剧情`,
      'standard': `标准（单段填充率${(perChunkFillRate * 100).toFixed(0)}%）：关键画面有解说，过渡段静音让画面说话`,
      'sparse': `留白（单段填充率${(perChunkFillRate * 100).toFixed(0)}%）：大量留白，只在关键节点点睛，适合纪录片/文艺向，让位给BGM和画面纯享`,
    };
    // 原声策略 → prompt 指令
    const audioStrategyMap: Record<string, string> = {
      'cover': '全量覆盖：忽略ASR原声，LLM全力重新编排旁白',
      'keep_key': '关键台词保留：识别ASR中高压/冲突台词区间，在该时间段暂停解说留出原声出场',
      'original_main': '原声为主：原声保留，解说仅辅助过渡',
    };
    // 原声策略 → 是否允许标记原声段落（cover 模式禁止标记）
    const allowOriginalMark = params.originalAudioStrategy !== 'cover';
    // 节奏模式 → prompt 指令（含TTS标记规范）
    const rhythmMap: Record<string, string> = {
      'short_fast': '短句快切：严格使用微型短句。每句末尾强制使用逗号或感叹号。适合极速快切。密集注入 [pause: 200ms]',
      'mixed': '长短交替：短句铺垫+长句叙事。节奏抑扬顿挫。关键转折处插入 [pause: 400ms]',
      'slow_soothing': '长句舒缓：使用优美长句与分词，多用句号。关键情感节点后追加 [pause: 800ms] 标记',
    };
    // 节奏模式 → 单句字数上限（short_fast=18 / mixed=30 / slow_soothing=40）
    const maxSentenceChars = params.rhythmMode === 'short_fast' ? 18
                           : params.rhythmMode === 'slow_soothing' ? 40
                           : 30;
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
你将收到一份经过物理切片与视觉分析的视频片段流（含有时间轴、角色锚定、ASR原声及画面描述）${plotOutline ? '，以及一份已提炼的【全局剧情大纲】' : ''}。
请据此撰写一份"贴合剧情主线、在关键节点给出合理解读"的高吸引力解说文案。

## 🎬 剧情思维（最高优先级，先于一切形式规则）
1. **贴剧情，不贴画面**：解说不是画面翻译！每一段解说必须回答"这段在剧情中推进了什么"（因果/转折/人物弧线），段与段之间承上启下、逻辑连贯。
2. **合理解读**：每 3~5 段至少 1 段是解读——剖析人物动机、前后呼应、主题升华或现实隐喻。解读必须基于已确认的剧情事实，严禁编造剧情。
3. **剧情优先于形式**：所有短句/卡点/句式规则都是表达手段，不得以牺牲剧情逻辑为代价。宁可放弃一个"金句"，也要保证剧情链条完整。

${plotOutline ? `## 📖 全局剧情大纲（必须首先通读，解说严格贴合以下主线）
${JSON.stringify(plotOutline, null, 2)}` : ''}

## 创作风格
${style}：${styleInstruction}

${hookInstruction}

## ⚡ 爆款短句与卡点硬性规则 (Core Short-Sentence Rules)
1. **单句字数硬限制**：每个单句（两个标点之间的文字）绝对不能超过 ${maxSentenceChars} 字！多用动词、感叹句与极速短句（如："死死盯住！"、"眼神杀气顿显！"）。
2. **镜头级连贯叙事**：每个分镜的解说词应写成通顺完整的句子或短句群，字数尽量贴近单段字数上限（不要刻意压短成碎片）；相邻分镜之间善用衔接词（接着／没想到／于是／然而／下一秒）承上启下，形成连贯的剧情流，避免每段都是孤立无关联的短句。长句交给断句器按字幕安全框自动拆分。
3. **角色名称绝对统一**：严格使用【全局已知角色列表】中的姓名，严禁混淆人名或凭空创造角色列表之外的人名。
4. **消除视觉幻觉**：若 ASR 旁白与画面物理描述不一致，以【画面物理描述】为准描绘现场动作，以 ASR 为补充。
5. **拒绝流水账**：严禁描述画面直观已呈现的表面动作，重点剖析言下之意、内心戏与剧情冲突。

${CONSTRAINTS.ANTI_LITERAL}
${CONSTRAINTS.TTS_FRIENDLY}
${CONSTRAINTS.ROLE_ALIAS}
${CONSTRAINTS.NO_MERGE_SENTENCES}
${CONSTRAINTS.JSON_ONLY}

## 字数预算与参数指引
【严格字数约束】：每个解说段应写成通顺连贯的完整句子或短句群，确保剧情表达完整，不要为了凑字数而碎成几个字。
- 单段字数上限 = ⌊ 时长(秒) × ${speechRate} × ${(perChunkFillRate * 100).toFixed(0)}% × ${discountFactor} ⌋
- 例如一个 3 秒的分镜，解说词应约 ${Math.floor(3 * speechRate * perChunkFillRate * discountFactor)} 字
- 一个 5 秒的分镜，解说词应约 ${Math.floor(5 * speechRate * perChunkFillRate * discountFactor)} 字
- 视频总时长约 ${totalDurationSec.toFixed(1)} 秒，解说词总量绝对严禁超过 ${Math.floor(totalDurationSec * speechRate * densityFillRate * discountFactor)} 字

【专业解说参数指引】：
- 叙事视角：${perspectiveMap[params.narrativePerspective] || perspectiveMap.third}
- 信息层次：${infoLevelMap[params.informationLevel] || infoLevelMap.deep}
- 解说密度：${densityMap[params.narrationDensity] || densityMap.standard}
- 原声策略：${audioStrategyMap[params.originalAudioStrategy] || audioStrategyMap.keep_key}
- 节奏模式：${rhythmMap[params.rhythmMode] || rhythmMap.mixed}
- 情绪基调：${emotionToneMap[params.emotionTone] || emotionToneMap.neutral}
- 声画权重：${(audioVisualWeight * 100).toFixed(0)}%（${audioVisualWeight > 0.5 ? '偏向视觉，主要依据画面描述描绘微表情和动作细节' : '偏向原声，解说词主要起提炼对白核心逻辑的作用'}）

${allowOriginalMark ? `## 原声段落标记规则（Original-Audio Marking）
原声策略要求保留部分原片原声。当某段分镜的核心是"原片台词/标志性对白/冲突声"（观众需要亲耳听到原声），请将该分镜标记为原声段落：
1. 该分镜输出 \`"keepOriginalAudio": true\`，\`text\` 填写原声台词原文（或最贴近的原文引用）。
2. 原声段落字数预算不适用，\`duration\` 填写原声在视频中的实际时长（秒）。
3. 每段解说之间最多允许 1~2 个原声段落，避免整片变成原声；原声段落前后各留一段解说引导。
4. 仅当该段原声与剧情强相关（名场面/冲突高潮/关键台词）才标记，普通背景音不标记。
` : ``}
## 画面意图与情绪标注（Visual Intent & Emotion Marking）
每个分镜除解说词外，必须输出两个辅助字段，供下游画面匹配使用：
1. \`"emotion"\`：本段解说词的情绪基调，从以下类别中选择一个：紧张悬疑 / 悲伤沉重 / 愤怒激昂 / 欢快轻松 / 平静舒缓 / 中性。
2. \`"visualIntent"\`（【必填】禁止空字符串/缺字段/写"无"/写"不需要"）：本段解说词"应该配什么画面"的画面意图描述，用画面语言（非文学语言）概括主体、动作、场景、景别、氛围，20~40 字。必须基于【多模态上下文片段流】中对应 chunk 的画面描述（对应位置的 visualContext.keyAction/shotType/emotion/atmosphere），不得凭空编造画面。✅ 正例：\`"男子面部特写，眼神凌厉，室内昏暗，紧张氛围"\`；❌ 反例：\`""\`、\`"无"\`、整个 JSON 对象缺 visualIntent 字段。

## Output Format
### 必填字段声明（缺任何一项视为无效输出）
- shotId / text / duration / emotion / visualIntent 五个字段**必须全部出现且非空**
${allowOriginalMark ? '- keepOriginalAudio 为可选布尔字段，默认 false 时可省略' : ''}

请严格按照以下 JSON 数组格式返回结果，切勿包含任何 Markdown 格式化标记或额外解释：
[
  { "shotId": "s_01", "text": "解说词内容", "duration": 3.5, "emotion": "紧张悬疑", "visualIntent": "男子面部特写，眼神凌厉，室内昏暗，紧张氛围"${allowOriginalMark ? ', "keepOriginalAudio": false' : ''} }
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

    let rawShots: Array<{ shotId: string; text: string; duration: number; emotion?: string; visualIntent?: string; keepOriginalAudio?: boolean }> = [];
    try {
      rawShots = NetworkPipeline.strictParseJson(response.text || '');
      if (!Array.isArray(rawShots)) {
        throw new Error('大模型未返回预期的数组格式');
      }
    } catch (e) {
      AppLogger.error('ScriptGenStrategy', 'Failed to parse JSON from LLM', { error: String(e) });
      throw new Error(`剧本解析失败，大模型输出了脏数据: ${(response.text || '').substring(0, 50)}...`);
    }

    // 🎯 P3 兜底：对 rawShots 逐段执行 ensureVisualIntentFilled，保证 100% 有画面意图。
    // （LLM 在 json_object 模式下常漏写 visualIntent 字段，导致步骤5 只能回退解说词跨空间匹配，
    //  这里用对应 chunk 的真实视觉上下文（步骤2 VLM 已产出）本地化拼装，不造假，零额外 RPC）
    const filledCount = { value: 0 };
    const rawShotsWithVI = rawShots.map((raw, idx) => {
      const originalVI = String(raw?.visualIntent || '').trim();
      const filled = ensureVisualIntentFilled(raw, contextChunks[idx], raw.text || '');
      if (!originalVI || filled !== originalVI) filledCount.value++;
      return { ...raw, visualIntent: filled };
    });
    if (filledCount.value > 0) {
      AppLogger.info(LOG_TAGS.AI_AGENT,
        `[文案生成] 🎯 P3 visualIntent 兜底填充：${filledCount.value}/${rawShots.length} 段由 chunk 视觉上下文本地拼装（LLM 漏写或写了占位词）`);
    }

    onProgress(93, '正在执行长段落断句与三级敏感词扫描...');

    const lexiconFilter = new LexiconFilter();

    // 画面真实时长优先：LLM 自报的 duration 不受画面约束，常出现超长段落无法匹配画面。
    // 用微切分得到的画面真实时长 contextChunks[idx].durationSec 覆盖 raw.duration，
    // 保证解说时长与画面对齐；contextChunks 按 chunk 下标与 rawShots 一一对应。
    // 节奏模式影响分镜时长 — 短句快切缩短，长句舒缓加长，长短交替不变。
    const paceFactor = params.rhythmMode === 'short_fast'
      ? 0.8   // 短句快切：duration 缩短 20%
      : params.rhythmMode === 'slow_soothing'
      ? 1.3   // 长句舒缓：duration 加长 30%
      : 1.0;  // 长短交替：不变

    // 先构造带 __order 的中间分镜（__order = chunk 下标，供断句后按原始顺序合并、回查 contextChunks）
    const parsed = rawShotsWithVI.map((raw, idx) => {
      const baseDuration = contextChunks[idx]?.durationSec ?? (raw.duration || 3);
      return {
        __order: idx,
        id: raw.shotId || `shot_${Math.random().toString(36).slice(2, 8)}`,
        text: raw.text || '',
        duration: baseDuration * paceFactor,
        /** 原声段落标记：切分时保护，不拆分（原声定位依赖整段文本锁时间轴，拆分会破坏） */
        keepOriginalAudio: raw.keepOriginalAudio === true,
        /** 🎭 P1 角色组合匹配：本段解说词对应的 chunk 锚定角色（按下标一一对应，子句断句后原样继承） */
        characters: contextChunks[idx]?.anchoredCharacters || [],
        /** 🎭 P0 意境维度：段落情绪标签（LLM 生成），断句后子句继承，供步骤5 情绪匹配 */
        emotion: raw.emotion || '',
        /** 🎯 P3 画面意图：已通过 ensureVisualIntentFilled 保证非空，子句继承后供步骤5 语义匹配
         *  （优先取 LLM 原生生成；LLM 漏写/写占位词时由 chunk 视觉上下文本地拼装） */
        visualIntent: raw.visualIntent,
        /** 🎯 P3 时间轴锚定：对应 chunk 的画面时间起点/时长（ms），供步骤5 锚定切片 */
        startMs: contextChunks[idx]?.startMs ?? 0,
        durationMs: contextChunks[idx]?.durationMs ?? 0,
      };
    });

    // 长段落断句：>18 字的文案按标点切成爆款微短句，避免 TTS 超时与画面张冠李戴。
    // 原声段落不参与切分，原样保留（keep_key/original_main 模式下 LLM 标记的 keepOriginalAudio）。
    const broken = breakLongParagraphs(parsed.filter((p) => !p.keepOriginalAudio));
    const originalParagraphs = parsed.filter((p) => p.keepOriginalAudio);

    // 按原始顺序合并：非原声断句子句 + 原声段落，保持与 LLM 输出顺序一致
    const merged = [...broken, ...originalParagraphs].sort((a, b) => {
      const aOrder = (a as any).__order ?? 0;
      const bOrder = (b as any).__order ?? 0;
      return aOrder - bOrder;
    });

    const parsedShots: GeneratedShot[] = merged.map((p) => {
      const scanResult = lexiconFilter.scan(p.text || '');
      return {
        shotId: p.id,
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
        duration: p.duration,
        /** 原声段落透传：keep_key/original_main 模式下 LLM 标记的 keepOriginalAudio 原样保留 */
        keepOriginalAudio: (p as any).keepOriginalAudio === true,
        /** 🎭 P1 角色组合匹配：子句继承父段落的锚定角色（断句后每个子句沿用同一 chunk 的角色名单） */
        characters: (p as any).characters || [],
        /** 🎭 P0 意境维度：子句继承父段落的情绪标签 */
        emotion: (p as any).emotion || '',
        /** 🎯 P3 画面意图：子句继承父段落的画面意图描述 */
        visualIntent: (p as any).visualIntent || '',
        /** 🎯 P3 时间轴锚定：子句继承父段落对应 chunk 的时间起点/时长（ms） */
        startMs: (p as any).startMs ?? 0,
        durationMs: (p as any).durationMs ?? 0,
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
