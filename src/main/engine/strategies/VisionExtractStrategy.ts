// 📁 路径：src/main/engine/strategies/VisionExtractStrategy.ts
// 🚀 画面描述策略：批量发送所有帧给 VLM（按模型最大接收能力）+ 并发分块 + 流式推送
// 核心理念：qwen3.7-plus 支持单次 2048 张图，flash/plus 系列支持 256 张
//           76 帧视频应一次性全打包发送，而非逐帧 76 次调用
import fs from 'fs';
import path from 'path';
import { BaseNodeStrategy } from './BaseNodeStrategy';
import type { ExecutionContext } from './BaseNodeStrategy';
import { VisionProcessor } from '../media/VisionProcessor';
import { LLMFactory } from '../adapters/LLMFactory';
import { PromptBuilder } from '../prompts/PromptBuilder';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '@modules/infra/logger/LogConstants';
import { dehydrateMagicPath } from '../utils/pathUtils';
import { PerceptualHasher } from '../media/PerceptualHasher';
import { VlmFrameCacheRepository } from '../../database/repositories/VlmFrameCacheRepository';
import type { VlmCacheRecord } from '../../database/repositories/VlmFrameCacheRepository';
import { ContactSheetBuilder } from '../media/ContactSheetBuilder';
import type { MatrixLayout } from '../media/ContactSheetBuilder';

export interface VisionExtractInput {
  mediaId: string;
  mediaPath: string;
  modelName?: string;
  framesMode?: 'fps' | 'scene';
  framesValue?: number;
  /** 预抽取的帧路径列表（来自步骤1 素材分析），提供时跳过抽帧步骤 */
  framePaths?: string[];
  /** 项目 ID，用于 context.bus 读取 ASR 数据 */
  projectId?: string;
  /** 前端注入的 ASR 台词（step2 单独执行时 context.bus 无 asr-result，需从 input 读取） */
  audioResult?: { lines: any[] };
  /**
   * step1 识别出的人物角色列表，注入到 step2 VLM prompt 中
   * 让 VLM 知道画面中可能出现的人物名称，描述时直接用名称而非"男子/女子"
   * 元素结构：{ id, name, avatar?, representative?, faces? }
   */
  roles?: Array<{ id: string; name: string; avatar?: string; representative?: any; faces?: any[] }>;
  /**
   * 🎭 P0.5 帧级角色锚定：frameIdx → 该帧检测到的人物名称列表
   * 由 step1 基于 role.faces[].frame_index 构建，step2 用于逐帧精确锚定
   * 例如 { 0: ['张三'], 5: ['张三','李四'] } 表示第 0 帧有张三，第 5 帧有张三和李四
   * 注入 prompt 后 VLM 无需猜测画面中是谁，直接用姓名描述
   *
   * 若不传入，step2 会自动从 input.roles[].faces[].frame_index 推导
   * （基于 faceFrames@1fps 与 VLM 帧 estimatedInterval 的时间对齐）
   */
  frameRoles?: Record<number, string[]>;
  /**
   * P2 视觉分析模式（VLM 矩阵策略）
   * - 'auto': 智能自动（默认），根据帧间隔自动选择 2x2/3x3
   * - '2x2' / '3x3': 拼图为网格图后单张发送，节省 Token
   * - '1x1': 独立发送（不拼图）
   */
  matrixMode?: 'auto' | '2x2' | '3x3' | '1x1';
}

export interface FrameDetail {
  url: string;
  description: string;
  asrText: string;
  asrTime: string;
  /** 该帧在视频中的绝对时间（毫秒） */
  timeMs: number;
  /** 该帧绝对时间的可读格式，如 "00:12.15" */
  timeStr: string;
  editing: boolean;
  confirmed: boolean;
  emotion: string;
  /** P0-3：下游瘦身字段，供 step3 消费，避免 step3 重新解析长文本 */
  downstream?: {
    action: string;
    emotion: string;
    keywords: string[];
  };
  /**
   * 🎭 P0.5 帧级锚定：该帧已检测到的人物名称列表
   * 来源：effectiveFrameRoles[i]（基于 step1 roles.faces.frame_index 自动推导）
   * 供下游 step3/step4 消费，无需重新解析画面描述猜测人物
   * 未检测到人物时为空数组，未启用帧级锚定时为 undefined
   */
  characters?: string[];
}

/**
 * P3 分层两阶段分析 — 全局场景上下文
 * Stage 1 提取的全局信息，注入到 Stage 2 每批次的 prompt 中
 * 让 VLM 无需重复描述背景，只输出增量动作，Output Token 降低 60%+
 */
export interface GlobalSceneContext {
  /** 场景地点（如"室内办公室"、"户外公园"） */
  location: string;
  /** 主体人物特征（如"穿黑西装的年轻男子"、"无人物"） */
  subject: string;
  /** 主色调与光影（如"暖色调、柔和光线"） */
  colorTone: string;
  /** 叙事基调（如"轻松日常"、"紧张严肃"） */
  narrativeTone: string;
}

export interface VisionExtractOutput {
  framesCount: number;
  sceneDescriptions: string;
  framePaths?: string[];
  /** 每帧完整信息，含画面描述和关联台词 */
  frames?: FrameDetail[];
  /** P0-3：下游瘦身上下文，极简结构化数据，供 step3 直接消费 */
  downstreamContext?: {
    shots: { action: string; emotion: string; keywords: string[] }[];
  };
}

/** VLM 并发批次路数（🧪 测试阶段降为 1 避免限流，正式上线可调回 2-3） */
const CONCURRENT_VLM = 1;
/** 🔧 fail fast：连续失败达到此阈值时终止整批任务，避免无效 API 调用 */
const FAIL_FAST_THRESHOLD = 3;
/** 单次 VLM 调用最大图片数（按 qwen3.7-plus 2048 / flash-plus 系列 256 取保守值 256） */
// 🧪 测试阶段临时限制为 10 张/次，验证描述质量后再放开回 256
const MAX_BATCH_IMAGES = 10;

/**
 * 构建人物名单注入段（用于 VLM prompt）
 * @param roles step1 识别出的人物角色列表
 * @returns 拼接好的 prompt 段落；无 roles 或全空时返回空字符串
 *
 * 输出示例：
 * \n\n【已知人物角色】\n画面中可能出现以下人物，描述时请优先使用其名称：\n- 张三（男，30岁）\n- 李四（女，25岁）
 */
function buildRolesContextPrompt(
  roles?: Array<{ id: string; name: string; avatar?: string; representative?: any; faces?: any[] }>,
): string {
  if (!roles || roles.length === 0) return '';
  const roleLines = roles
    .filter(r => r && r.name)
    .map(r => {
      // 附加性别/年龄信息（若有），帮助 VLM 更准确匹配画面中的人物
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
  return `\n\n【已知人物角色】\n画面中可能出现以下人物，描述时请优先使用其名称：\n${roleLines.join('\n')}`;
}

/**
 * 🎭 P0.5 构建逐帧角色锚定 prompt 段
 * 为本批次的每一帧单独列出"已检测到的人物"，让 VLM 无需猜测画面中是谁
 * @param batchFrames 本批次的帧列表（含 idx 绝对索引）
 * @param frameRoles frameIdx → 人物名称列表的映射
 * @returns 锚定段文本，如：
 *   【逐帧角色锚定】
 *   - 第1张（第0帧）：张三
 *   - 第2张（第5帧）：张三、李四
 *   - 第3张（第10帧）：未检测到人物
 */
export function buildFrameRolesAnchoringPrompt(
  batchFrames: { idx: number; path: string }[],
  frameRoles?: Record<number, string[]>,
): string {
  if (!frameRoles) return '';
  // 仅当本批次至少有一帧存在角色锚定时才注入，避免无谓 prompt 膨胀
  const lines = batchFrames.map((f, i) => {
    const names = frameRoles[f.idx];
    if (names && names.length > 0) {
      return `- 第${i + 1}张（第${f.idx}帧）：${names.join('、')}`;
    }
    return `- 第${i + 1}张（第${f.idx}帧）：未检测到人物`;
  });
  // 全部"未检测到人物"时不注入
  if (lines.every(l => l.includes('未检测到人物'))) return '';
  return `\n\n【逐帧角色锚定】\n以下人物由人脸识别系统检测，请在对应帧的描述中强制使用其姓名，严禁使用"男子/女子/青年"等模糊代称：\n${lines.join('\n')}`;
}

/**
 * 🎭 P0.5 自动推导 frameRoles：从 roles[].faces[].frame_index 反推 VLM 帧到人物的映射
 *
 * 时间对齐原理：
 * - step1 人脸检测专用抽帧使用 1fps（1 帧/秒），face.frame_index 表示该人脸在第 N 秒被检测到
 * - step2 VLM 分析的帧间隔为 estimatedInterval（秒），VLM 第 i 帧对应时间点 i * estimatedInterval
 * - 映射规则：face 在第 faceIdx 秒出现 → 落在 VLM 第 floor(faceIdx / estimatedInterval) 帧的时间区间内
 *
 * 边界处理：
 * - estimatedInterval <= 0 或非有限数 → 返回 null（不推导）
 * - face.frame_index 缺失或非数字 → 跳过该 face
 * - 同一 VLM 帧上多个人物 → 去重合并为数组
 * - VLM 帧索引超过 totalFrameCount - 1 → 截断到最后一帧
 *
 * @param roles step1 识别出的人物角色列表（每个 role 含 faces 数组，face 含 frame_index）
 * @param totalFrameCount VLM 分析的总帧数
 * @param estimatedInterval VLM 帧之间的时间间隔（秒）
 * @returns frameIdx → 人物名称列表的映射；无有效 face.frame_index 时返回 null
 */
export function deriveFrameRolesFromFaces(
  roles: Array<{ id: string; name: string; faces?: any[] }>,
  totalFrameCount: number,
  estimatedInterval: number,
): Record<number, string[]> | null {
  if (!roles || roles.length === 0 || totalFrameCount <= 0) return null;
  if (!Number.isFinite(estimatedInterval) || estimatedInterval <= 0) return null;

  const result: Record<number, string[]> = {};
  let hasAnyValidFace = false;

  for (const role of roles) {
    if (!role.name || !Array.isArray(role.faces) || role.faces.length === 0) continue;
    for (const face of role.faces) {
      const faceIdx = typeof face?.frame_index === 'number' ? face.frame_index
        : (typeof face?.frameIndex === 'number' ? face.frameIndex : undefined);
      if (faceIdx === undefined || !Number.isFinite(faceIdx) || faceIdx < 0) continue;
      hasAnyValidFace = true;

      // face 帧（1fps）对应时间点 faceIdx 秒，映射到 VLM 帧索引
      const vlmFrameIdx = Math.min(
        Math.floor(faceIdx / estimatedInterval),
        totalFrameCount - 1,
      );
      if (vlmFrameIdx < 0) continue;

      if (!result[vlmFrameIdx]) result[vlmFrameIdx] = [];
      // 去重：同一帧上同一人物只出现一次
      if (!result[vlmFrameIdx].includes(role.name)) {
        result[vlmFrameIdx].push(role.name);
      }
    }
  }

  return hasAnyValidFace ? result : null;
}

export class VisionExtractStrategy extends BaseNodeStrategy<VisionExtractInput, VisionExtractOutput> {
  public readonly nodeType = 'vision-extract';

  protected async validate(input: VisionExtractInput): Promise<void> {
    const physicalPath = dehydrateMagicPath(input.mediaPath);
    if (!physicalPath || !fs.existsSync(physicalPath)) throw new Error('视觉提取失败：未找到原始媒体文件');
  }

  /**
   * 执行视觉提取任务
   * 每帧独立VLM分析：场景模式提取的关键帧本身就是场景边界，独立分析最准确
   * 5路并发保证速度，流式推送实现打字机效果
   */
  protected async performTask(
    input: VisionExtractInput, 
    context: ExecutionContext, 
    cacheDir: string,
    onProgress: (p: number, s: string, _results?: any) => void
  ): Promise<VisionExtractOutput> {
    
    /** 解析帧列表：优先使用预抽取帧，否则从视频中提取 */
    const physicalMediaPath = dehydrateMagicPath(input.mediaPath);
    let physicalFrames: string[];
    if (input.framePaths && input.framePaths.length > 0) {
      physicalFrames = input.framePaths
        .map((p: string) => dehydrateMagicPath(p))
        .filter((p: string) => {
          try { return fs.existsSync(p); } catch { return false; }
        });
      if (physicalFrames.length === 0) {
        throw new Error('画面描述失败：未找到已提取的关键帧，请先完成步骤1「素材分析」');
      }
      onProgress(5, `复用步骤1已有帧 ${physicalFrames.length} 张，启动 VLM 逐帧分析...`);
    } else {
      const framesDir = path.join(cacheDir, `${input.mediaId}_frames`);
      const mode = input.framesMode || 'scene';
      const value = input.framesValue || 0.3;
      onProgress(5, '启动物理视神经，正在扫描视频画面...');
      physicalFrames = await VisionProcessor.extractKeyframes(
        physicalMediaPath, framesDir, mode, value,
        (percent) => onProgress(5 + Math.floor(percent * 0.25), `画面解码中: ${percent}%`)
      );

      /** 抽帧降级回退：scene 模式帧数<3 时自动切到 fps 模式 */
      if (mode === 'scene' && physicalFrames.length < 3) {
        AppLogger.warn(LOG_TAGS.MEDIA_ENGINE,
          `[VisionExtract] Scene 模式仅产出 ${physicalFrames.length} 帧，自动降级到 FPS 模式`);
        const fpsFramesDir = path.join(cacheDir, `${input.mediaId}_frames_fps`);
        physicalFrames = await VisionProcessor.extractKeyframes(
          physicalMediaPath, fpsFramesDir, 'fps', 1,
          (percent) => onProgress(5 + Math.floor(percent * 0.25), `降级FPS解码: ${percent}%`)
        );
      }

      if (physicalFrames.length === 0) throw new Error('未能从视频中提取到任何有效画面');
      onProgress(30, `抽取完成，共 ${physicalFrames.length} 个关键帧，启动逐帧 VLM 分析...`);
    }

    /** 从 input.audioResult 或 context.bus 读取 ASR 台词，用于帧-台词时间对齐 */
    let asrLines: { startTime: number; endTime: number; text: string }[] = [];
    try {
      // 🔧 修复：step2 单独执行时 context.bus 无 asr-result，优先从 input.audioResult 读取
      const asrResult = input.audioResult || context.bus.get('asr-result');
      if (asrResult) {
        const rawLines = asrResult.lines || asrResult.asrLines || [];
        asrLines = rawLines.filter((l: any) => l.originalText || l.text).map((l: any) => {
          // 优先使用毫秒字段，转换为秒；兜底解析字符串
          let startTime: number, endTime: number;
          if (l.startMs !== undefined) {
            startTime = l.startMs / 1000;
          } else if (typeof l.start === 'number') {
            startTime = l.start;
          } else if (typeof l.startTime === 'number') {
            startTime = l.startTime;
          } else {
            const parts = String(l.start || '0').split(':').map(Number);
            startTime = parts.length >= 2 ? parts[0] * 60 + parts[1] : 0;
          }
          if (l.endMs !== undefined) {
            endTime = l.endMs / 1000;
          } else if (typeof l.end === 'number') {
            endTime = l.end;
          } else if (typeof l.endTime === 'number') {
            endTime = l.endTime;
          } else {
            const parts = String(l.end || '0').split(':').map(Number);
            endTime = parts.length >= 2 ? parts[0] * 60 + parts[1] : startTime + 3;
          }
          return { startTime, endTime, text: l.originalText || l.text || '' };
        });
      }
    } catch (e: any) {
      AppLogger.warn(LOG_TAGS.AI_AGENT, `[画面描述] 从 context.bus 读取 ASR 失败: ${e.message}`);
    }

    let allFrames = physicalFrames;
    // 🧪 测试阶段：仅取前 10 帧验证 VLM 描述效果，调试完移除 .slice(0, 10) 放开
    const TEST_FRAME_LIMIT = 10;
    if (allFrames.length > TEST_FRAME_LIMIT) {
      allFrames = allFrames.slice(0, TEST_FRAME_LIMIT);
      AppLogger.warn(LOG_TAGS.AI_AGENT, `[画面描述] 🧪 测试模式：仅分析前 ${TEST_FRAME_LIMIT} 帧（实际抽取 ${physicalFrames.length} 帧）`);
    }
    const totalFrameCount = allFrames.length;

    /** 计算每帧的估算时间点 */
    const estimatedInterval = totalFrameCount > 0 && asrLines.length > 0
      ? (asrLines[asrLines.length - 1].endTime || 7200) / totalFrameCount
      : 4;

    AppLogger.info(LOG_TAGS.AI_AGENT, `[画面描述] 帧数: ${totalFrameCount}, ASR台词: ${asrLines.length}, 估算间隔: ${estimatedInterval.toFixed(1)}s, 并发: ${CONCURRENT_VLM}`);

    // ========== 🎭 P0.5 自动推导 frameRoles ==========
    // 当 input.frameRoles 未传入但 input.roles[].faces[].frame_index 存在时，
    // 基于 faceFrames@1fps（face 的 frame_index 对应 1 帧/秒）与 VLM 帧 estimatedInterval
    // 的时间对齐，自动构建 frameIdx → 人物名称列表 的映射
    let effectiveFrameRoles = input.frameRoles;
    if (!effectiveFrameRoles && input.roles && input.roles.length > 0 && totalFrameCount > 0) {
      const derived = deriveFrameRolesFromFaces(input.roles, totalFrameCount, estimatedInterval);
      if (derived) {
        effectiveFrameRoles = derived;
        const anchoredCount = Object.values(derived).filter(arr => arr.length > 0).length;
        AppLogger.info(LOG_TAGS.AI_AGENT,
          `[画面描述] 🎭 P0.5 自动推导 frameRoles 成功：${anchoredCount}/${totalFrameCount} 帧锚定人物（基于 roles.faces.frame_index @1fps → VLM 帧 × estimatedInterval）`);
      }
    }

    const { adapter, modelName: resolvedModel } = LLMFactory.createAdapter('visual');
    /** 💥 修复：优先使用用户在设置中配置的 VLM 模型，不再硬编码 qwen-vl-max */
    const model = input.modelName || resolvedModel;

    /** 每帧的描述和JSON数据存储（提前声明，供 P1-1/P1-2 使用，避免 TDZ） */
    const frameDescriptions: string[] = new Array(totalFrameCount).fill('');
    const frameJsonItems: (any | null)[] = new Array(totalFrameCount).fill(null);

    // ========== P1-1: pHash 视觉去重 ==========
    // 计算相邻帧的感知哈希，静态镜头（Hamming 距离 < 5）跳过 VLM，复用前一帧描述
    const pHashResults = PerceptualHasher.batchComputePHash(allFrames);
    /** 需要跳过 VLM 的帧索引集合（静态镜头，复用前一帧描述） */
    const skipFrameIndices = new Set<number>();
    for (let i = 1; i < pHashResults.length; i++) {
      if (PerceptualHasher.isStaticShot(pHashResults[i - 1].hash, pHashResults[i].hash)) {
        skipFrameIndices.add(i);
      }
    }
    if (skipFrameIndices.size > 0) {
      AppLogger.info(LOG_TAGS.AI_AGENT, `[画面描述] P1-1 pHash 去重：${skipFrameIndices.size} 帧为静态镜头，将复用前一帧描述`);
    }

    // ========== P1-2: L2 SQLite 缓存查询 ==========
    // 按 frame_hash + model_name + prompt_version 查询，命中的帧直接复用缓存结果
    const vlmCache = new VlmFrameCacheRepository();
    const contentHashMap = PerceptualHasher.batchComputeContentHash(allFrames);
    /** framePath → 帧在 allFrames 中的索引 */
    const framePathToIdx = new Map<string, number>();
    allFrames.forEach((p, i) => framePathToIdx.set(p, i));
    const allHashes = Array.from(contentHashMap.values());
    const cachedRecords = vlmCache.batchGet(allHashes, model);
    /** 命中缓存的帧索引集合 */
    const cachedFrameIndices = new Set<number>();
    for (const [framePath, contentHash] of contentHashMap) {
      const idx = framePathToIdx.get(framePath);
      if (idx === undefined) continue;
      const cached = cachedRecords.get(contentHash);
      if (cached) {
        cachedFrameIndices.add(idx);
        // 直接从缓存恢复描述
        try {
          const parsedItem = JSON.parse(cached.resultJson);
          frameJsonItems[idx] = parsedItem;
          frameDescriptions[idx] = cached.description;
        } catch {
          cachedFrameIndices.delete(idx);
        }
      }
    }
    if (cachedFrameIndices.size > 0) {
      AppLogger.info(LOG_TAGS.AI_AGENT, `[画面描述] P1-2 L2 缓存命中：${cachedFrameIndices.size}/${totalFrameCount} 帧，跳过 VLM 调用`);
    }

    /** LRU Base64 缓存 */
    const MAX_BASE64_IN_MEMORY = 60;
    const base64Cache = new Map<string, string>();
    const getBase64 = (framePath: string): string => {
      if (base64Cache.has(framePath)) {
        const val = base64Cache.get(framePath)!;
        base64Cache.delete(framePath);
        base64Cache.set(framePath, val);
        return val;
      }
      const base64 = fs.readFileSync(framePath, 'base64');
      if (base64Cache.size >= MAX_BASE64_IN_MEMORY) {
        const oldest = base64Cache.keys().next().value;
        if (oldest) base64Cache.delete(oldest);
      }
      base64Cache.set(framePath, base64);
      return base64;
    };

    let completedFrames = 0;
    /** 🔧 fail fast：连续失败计数，成功时清零 */
    let consecutiveFailures = 0;
    /** fail fast 触发后的终止信号 */
    let aborted = false;
    let abortError = '';
    const framePathsOriginal = input.framePaths || physicalFrames;

    /** 秒 → MM:SS.mm 格式 */
    const formatTimeStr = (sec: number) => {
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
    };

    /** 构建单帧的流式推送数据 */
    const buildPartialFrames = (): FrameDetail[] => {
      const details: FrameDetail[] = [];
      for (let fi = 0; fi < totalFrameCount; fi++) {
        if (!frameDescriptions[fi]) continue;
        const frameTimeSec = fi * estimatedInterval;
        const frameEndSec = frameTimeSec + estimatedInterval;
        const matchedAsr = asrLines.filter(line =>
          line.startTime <= frameEndSec && line.endTime >= frameTimeSec
        );
        const idx = physicalFrames.indexOf(allFrames[fi]);
        const url = (framePathsOriginal.length > 0 && idx >= 0) ? framePathsOriginal[idx] : allFrames[fi];
        details.push({
          url,
          description: frameDescriptions[fi],
          asrText: matchedAsr.map(l => l.text).join(' '),
          asrTime: matchedAsr.length > 0
            ? `${matchedAsr[0].startTime.toFixed(1)}s-${matchedAsr[matchedAsr.length - 1].endTime.toFixed(1)}s`
            : '',
          timeMs: Math.round(frameTimeSec * 1000),
          timeStr: formatTimeStr(frameTimeSec),
          editing: false,
          confirmed: true,
          emotion: frameJsonItems[fi]?.emotionTone || '',
        });
      }
      return details;
    };

    // ========== P3: 分层两阶段分析 ==========
    /** Stage 1 全局场景上下文（初始 null，buildGlobalContext 完成后赋值） */
    let globalContext: GlobalSceneContext | null = null;

    /**
     * VLM response_format 能力级别（首次调用检测，后续直接复用，避免重复失败）
     * 1 = json_schema（最严格，OpenAI/部分服务商支持）
     * 2 = json_object（多数服务商支持）
     * 3 = 无 response_format（纯 prompt 约束，兼容所有服务商）
     */
    let vlmFormatLevel: 1 | 2 | 3 = 1;

    /**
     * 按 vlmFormatLevel 调用 VLM
     * 首次失败自动降级并缓存级别，后续批次直接用有效级别，不重复浪费 API 调用
     */
    const callVlmWithFallback = async (
      msgs: any[], mdl: string, temp: number, fmt: any,
    ): Promise<string> => {
      /** 按当前级别构造 options */
      const buildOpts = (level: 1 | 2 | 3): any => {
        if (level === 1) return { response_format: fmt };
        if (level === 2) return { response_format: { type: 'json_object' } };
        return {};
      };

      /** 从返回值提取文本 */
      const extractText = (r: any): string => {
        if (r && typeof r === 'object') {
          if (r.success === false) {
            throw new Error(`VLM 调用失败: ${r.error || '未知错误'}`);
          }
          return r.text || '';
        }
        return typeof r === 'string' ? r : '';
      };

      /** 判断是否为 response_format 不兼容错误 */
      const isFormatError = (e: any): boolean => {
        const msg = String(e?.message || e);
        return /response_format|json_schema|json_object|unknown_parameter|400/i.test(msg);
      };

      // 尝试当前级别，失败则降级（最多降 2 次：1→2→3）
      while (vlmFormatLevel <= 3) {
        try {
          const r = await adapter.chat(msgs, mdl, temp, buildOpts(vlmFormatLevel));
          return extractText(r);
        } catch (e: any) {
          if (vlmFormatLevel < 3 && isFormatError(e)) {
            AppLogger.warn(LOG_TAGS.AI_AGENT,
              `[画面描述] VLM 不支持 Level ${vlmFormatLevel}，降级到 Level ${vlmFormatLevel + 1}`);
            vlmFormatLevel = (vlmFormatLevel + 1) as 1 | 2 | 3;
            continue;
          }
          throw e; // 非格式错误或已到 Level 3，直接抛出
        }
      }
      // 理论上不会走到（while 循环已覆盖）
      throw new Error('VLM 调用失败: 未知错误');
    };

    /**
     * P3 Stage 1: 构建全局场景摘要
     * 从待分析帧中均匀采样 4 帧代表帧 → 直接发送 4 张图给 VLM 获取全局场景信息
     * （不拼图，避免与 P2 批次拼图逻辑耦合；全局摘要仅 1 次调用 4 帧，拼图收益微小）
     * 获取的全局上下文将注入到 Stage 2 每批次的 prompt，让 VLM 无需重复描述背景
     * @param frames 待分析帧列表
     * @returns 全局场景上下文；构建失败时返回 null（降级为无全局上下文）
     */
    const buildGlobalContext = async (
      frames: { idx: number; path: string }[],
    ): Promise<GlobalSceneContext | null> => {
      if (frames.length === 0) return null;

      try {
        /** 均匀采样 4 帧作为代表帧（覆盖视频不同时间段） */
        const indices = frames.length <= 4
          ? frames.map((_, i) => i)
          : [0, Math.floor(frames.length / 4), Math.floor(frames.length / 2), Math.floor(frames.length * 3 / 4)];
        const sampleFrames = indices.map(i => frames[i]).filter(Boolean);

        /** 全局摘要 prompt：要求返回结构化场景信息 */
        const summaryPrompt = `你是专业的影视画面解析器。请分析以下4张代表帧（来自同一视频的不同时间段），给出全局场景摘要。\n\n请返回 JSON：{"location":"场景地点（如室内办公室/户外街道）","subject":"主体人物特征（如穿黑西装的男子/无人物）","colorTone":"主色调与光影（如暖色调柔和光线）","narrativeTone":"叙事基调（如轻松日常/紧张严肃）"}`;

        /** 直接发送 4 张图（不拼图，与 P2 批次拼图解耦） */
        const messages = [{
          role: 'user' as const,
          content: [
            { type: 'text' as const, text: summaryPrompt },
            ...sampleFrames.map(f => ({
              type: 'image_url' as const,
              image_url: { url: `data:image/jpeg;base64,${getBase64(f.path)}` },
            })),
          ],
        }];

        /** 全局摘要用低 temperature 确保稳定 */
        const summaryFmt = {
          type: 'json_object' as const,
          json_schema: {
            name: 'global_scene_summary',
            schema: {
              type: 'object',
              properties: {
                location: { type: 'string', description: '场景地点' },
                subject: { type: 'string', description: '主体人物特征' },
                colorTone: { type: 'string', description: '主色调与光影' },
                narrativeTone: { type: 'string', description: '叙事基调' },
              },
              required: ['location', 'subject'],
            },
          },
        };
        const resultText = await callVlmWithFallback(messages, model, 0.3, summaryFmt);

        const cleaned = resultText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
        const parsed = JSON.parse(cleaned);

        const ctx: GlobalSceneContext = {
          location: parsed.location || '',
          subject: parsed.subject || '',
          colorTone: parsed.colorTone || '',
          narrativeTone: parsed.narrativeTone || '',
        };

        AppLogger.info(LOG_TAGS.AI_AGENT,
          `[画面描述] P3 全局摘要: 场景=${ctx.location}, 主体=${ctx.subject}, 色调=${ctx.colorTone}`);
        return ctx;
      } catch (e: any) {
        AppLogger.warn(LOG_TAGS.AI_AGENT,
          `[画面描述] P3 全局摘要构建失败，降级为无全局上下文: ${e.message}`);
        return null;
      }
    };

    /**
     * 🚀 批量分块 VLM 分析
     * - P2 拼图模式（2x2/3x3）：先将本批帧拼成单张网格图再发送，节省 Vision Token
     * - 1x1 模式：多图独立发送（按模型最大接收能力打包）
     */
    const processBatch = async (
      batchIdx: number,
      batchFrames: { idx: number; path: string }[],
      layout: MatrixLayout,
    ): Promise<void> => {
      if (batchFrames.length === 0) return;

      /** 获取该批次所有帧的时间区间和对应 ASR 台词 */
      const startIdx = batchFrames[0].idx;
      const endIdx = batchFrames[batchFrames.length - 1].idx;
      const batchStartSec = startIdx * estimatedInterval;
      const batchEndSec = (endIdx + 1) * estimatedInterval;
      const matchedAsr = asrLines.filter(line =>
        line.startTime <= batchEndSec && line.endTime >= batchStartSec
      );
      const asrText = matchedAsr.map(l => l.text).join(' ');

      /** P0-1：构建精简提示词（防幻觉 + 结构化输出约束）
       * 🎭 注入 roles：让 VLM 知道画面中可能出现的人物名称，描述时直接用名称 */
      const { systemPrompt } = PromptBuilder.buildVisionExtractPrompt(asrText, '', 'vlm_optimized', undefined, input.roles);

      /** 构建帧清单文本：让 VLM 知道每张图的序号和时间 */
      const frameListText = batchFrames.map((f, i) =>
        `第${i + 1}张（视频第${f.idx + 1}帧，时间约${formatTimeStr(f.idx * estimatedInterval)}）`
      ).join('\n');

      // P3: 构建全局上下文注入段（有全局摘要时要求增量描述，减少 Output Token）
      const globalContextPrompt = globalContext
        ? `\n\n【全局场景上下文】\n- 场景: ${globalContext.location}\n- 主体: ${globalContext.subject}\n- 色调: ${globalContext.colorTone}\n- 基调: ${globalContext.narrativeTone}\n\n【增量描述要求】\n- 已知全局背景如上，无需在每帧描述中重复背景信息\n- 只需描述当前帧的具体动作、表情变化和视觉细节`
        : '';

      // 🎭 构建人物名单注入段：让 VLM 在描述时直接使用人物名称
      // 格式示例：【已知人物角色】\n画面中可能出现以下人物，描述时请优先使用其名称：\n- 张三（男，30岁）\n- 李四（女，25岁）
      // 不使用 userPrompt（buildVisionExtractPrompt 返回的 userPrompt 未被消费），独立构建保证拼图/1x1 两条路径都能注入
      const rolesContextPrompt = buildRolesContextPrompt(input.roles);
      // 🎭 P0.5 逐帧角色锚定段：为每帧列出"已检测到的人物"，VLM 无需猜测画面中是谁
      // 当 frameRoles 存在且本批至少一帧有角色时注入，与全局名单互补
      // 使用 effectiveFrameRoles：优先取 input.frameRoles，否则取自动推导结果
      const frameRolesAnchoringPrompt = buildFrameRolesAnchoringPrompt(batchFrames, effectiveFrameRoles);
      // 🎭 人物名称使用指引：仅在有人物名单或帧级锚定时附加，避免无 roles 时出现悬空引用
      const rolesUsageHint = (rolesContextPrompt || frameRolesAnchoringPrompt)
        ? '\n- 若画面中出现【已知人物角色】或【逐帧角色锚定】中的人物，请使用其名称；未在名单中的人物用"男子/女子"等泛称'
        : '';

      // P2: 拼图模式 — 先构建网格图（失败则降级为 1x1 多图独立发送）
      let gridResult: { gridPath: string; frameIndices: number[]; layout: MatrixLayout } | null = null;
      if (layout !== '1x1') {
        gridResult = await ContactSheetBuilder.build(batchFrames, layout, cacheDir);
      }

      /** 构建 user content：拼图模式发单张网格图，1x1 模式发多张独立图 */
      const userContent: any[] = [];

      if (gridResult) {
        /** P2 拼图模式：单张网格图，Token 消耗降至 1/N */
        const gridDesc = layout === '2x2'
          ? '2×2 网格图（4 个子图，按 [1][2][3][4] 编号排列）'
          : '3×3 网格图（9 个子图，按 [1]~[9] 编号排列）';
        userContent.push({
          type: 'text',
          text: `${systemPrompt}${globalContextPrompt}${rolesContextPrompt}${frameRolesAnchoringPrompt}\n\n【网格图分析任务】\n这是一张 ${gridDesc}，每个子图按编号对应：\n${frameListText}\n\n【防幻觉约束】\n- 台词仅供参考，若台词提到的事物在图片中未出现，严禁写入描述\n- 仅描述图片中肉眼可见的内容${rolesUsageHint}\n\n请返回 JSON，格式：{"frames":[{"narrativeAction":"主体动作","emotionalState":"情绪","visualAtmosphere":"光影色调","spatialRelation":"构图空间","keywords":["关键词1","关键词2"]}]}\n- frames 数组长度必须等于 ${batchFrames.length}\n- 顺序与网格编号一一对应`,
        });
        userContent.push({
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${getBase64(gridResult.gridPath)}` },
        });
      } else {
        /** 1x1 模式或拼图降级：多图独立发送 */
        userContent.push({
          type: 'text',
          text: `${systemPrompt}${globalContextPrompt}${rolesContextPrompt}${frameRolesAnchoringPrompt}\n\n【批量帧分析任务】\n共 ${batchFrames.length} 张帧图片，按顺序如下：\n${frameListText}\n\n【防幻觉约束】\n- 台词仅供参考，若台词提到的事物在图片中未出现，严禁写入描述\n- 仅描述图片中肉眼可见的内容${rolesUsageHint}\n\n请返回 JSON，格式：{"frames":[{"narrativeAction":"主体动作","emotionalState":"情绪","visualAtmosphere":"光影色调","spatialRelation":"构图空间","keywords":["关键词1","关键词2"]}]}\n- frames 数组长度必须等于 ${batchFrames.length}\n- 顺序与图片顺序一一对应`,
        });
        for (const f of batchFrames) {
          userContent.push({
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${getBase64(f.path)}` },
          });
        }
      }

      const messages = [
        { role: 'user', content: userContent },
      ];

      /** P0-1：JSON Schema 强制结构化输出，消除格式解析失败 */
      const responseFormat = {
        type: 'json_object' as const,
        json_schema: {
          name: 'vision_frame_analysis',
          schema: {
            type: 'object',
            properties: {
              frames: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    narrativeAction: { type: 'string', description: '主体核心动作/视觉变化' },
                    emotionalState: { type: 'string', description: '主体的微表情/情绪' },
                    visualAtmosphere: { type: 'string', description: '光影/色调/氛围' },
                    spatialRelation: { type: 'string', description: '构图/镜头移动方式' },
                    keywords: { type: 'array', items: { type: 'string' }, description: '画面关键词' },
                  },
                  required: ['narrativeAction', 'emotionalState'],
                },
              },
            },
            required: ['frames'],
          },
        },
      };

      try {
        const resultText = await callVlmWithFallback(messages, model, 0.2, responseFormat);

        /** P0-1：解析 { frames: [...] } 结构（兼容旧版裸数组降级） */
        let parsedItems: any[] = [];
        try {
          const cleaned = resultText
            .replace(/```json\s*/gi, '')
            .replace(/```\s*/g, '')
            .trim();
          const parsed = JSON.parse(cleaned);
          if (Array.isArray(parsed)) {
            parsedItems = parsed;
          } else if (parsed?.frames && Array.isArray(parsed.frames)) {
            parsedItems = parsed.frames;
          } else if (typeof parsed === 'object') {
            parsedItems = [parsed];
          }
        } catch {
          // JSON 解析失败，降级到纯文本
          parsedItems = [];
        }

        /** P0-2：响应式流 — 逐帧写入并立即推送，不等整个批次解析完 */
        for (let i = 0; i < batchFrames.length; i++) {
          const frameIdx = batchFrames[i].idx;
          const parsedItem = parsedItems[i];

          if (parsedItem && typeof parsedItem === 'object') {
            frameJsonItems[frameIdx] = parsedItem;
            /** P0-3：构建 UI 显示描述 */
            const parts = [
              parsedItem.narrativeAction || '',
              parsedItem.emotionalState ? `情绪:${parsedItem.emotionalState}` : '',
              parsedItem.visualAtmosphere ? `光影:${parsedItem.visualAtmosphere}` : '',
              parsedItem.spatialRelation ? `空间:${parsedItem.spatialRelation}` : '',
            ].filter(Boolean);
            frameDescriptions[frameIdx] = parts.join(' ');
          } else {
            frameDescriptions[frameIdx] = resultText.trim().split('\n')[i] || '';
          }

          completedFrames++;
          /** P0-2：每帧解析完立即推送，前端实时渲染打字机效果 */
          const frameProgressPct = 30 + Math.floor((completedFrames / totalFrameCount) * 65);
          onProgress(frameProgressPct, `画面分析 ${completedFrames}/${totalFrameCount} 帧`, {
            partialFrames: buildPartialFrames(),
            completedCount: completedFrames,
            totalCount: totalFrameCount,
          });
        }

        AppLogger.info(LOG_TAGS.AI_AGENT, `[画面描述] 批次 ${batchIdx + 1} 完成，覆盖帧 ${startIdx + 1}-${endIdx + 1}/${totalFrameCount}，JSON: ${parsedItems.length > 0 ? '成功' : '降级纯文本'}`);

        // P1-2: 批次成功后写入 L2 缓存（异步非阻塞，不影响主流程）
        try {
          const cacheRecords: VlmCacheRecord[] = [];
          for (let i = 0; i < batchFrames.length; i++) {
            const parsedItem = parsedItems[i];
            if (!parsedItem || typeof parsedItem !== 'object') continue;
            const contentHash = contentHashMap.get(batchFrames[i].path);
            if (!contentHash) continue;
            const parts = [
              parsedItem.narrativeAction || '',
              parsedItem.emotionalState ? `情绪:${parsedItem.emotionalState}` : '',
              parsedItem.visualAtmosphere ? `光影:${parsedItem.visualAtmosphere}` : '',
              parsedItem.spatialRelation ? `空间:${parsedItem.spatialRelation}` : '',
            ].filter(Boolean);
            cacheRecords.push({
              frameHash: contentHash,
              modelName: model,
              promptVersion: 'v1',
              resultJson: JSON.stringify(parsedItem),
              description: parts.join(' '),
            });
          }
          if (cacheRecords.length > 0) {
            vlmCache.batchSet(cacheRecords);
          }
        } catch (e: any) {
          AppLogger.warn(LOG_TAGS.AI_AGENT, `[画面描述] P1-2 缓存写入失败: ${e.message}`);
        }

        consecutiveFailures = 0;
      } catch (err: any) {
        AppLogger.error(LOG_TAGS.AI_AGENT, `[画面描述] 批次 ${batchIdx + 1} 异常: ${err.message}`);
        consecutiveFailures++;
        if (consecutiveFailures >= FAIL_FAST_THRESHOLD && !aborted) {
          aborted = true;
          abortError = err.message;
          AppLogger.error(LOG_TAGS.AI_AGENT,
            `[画面描述] 连续 ${consecutiveFailures} 批失败，终止剩余任务。最后错误: ${err.message}`);
        }
      } finally {
        // P2: 清理本批次的拼图临时文件
        if (gridResult) ContactSheetBuilder.cleanup(gridResult.gridPath);
      }

      const progressPct = 30 + Math.floor((completedFrames / totalFrameCount) * 65);
      onProgress(progressPct, `画面分析 ${completedFrames}/${totalFrameCount} 帧...`);
    };

    /** 将所有帧分块（P1-1/P1-2：跳过静态帧和缓存命中帧；P2：按 matrixMode 决定批次大小） */
    const framesToAnalyze: { idx: number; path: string }[] = [];
    for (let i = 0; i < totalFrameCount; i++) {
      // P1-1: pHash 判定为静态镜头的帧，跳过 VLM（描述在 VLM 完成后复用前一帧）
      if (skipFrameIndices.has(i) && i > 0) {
        continue;
      }
      // P1-2: 缓存命中的帧已恢复描述，跳过
      if (cachedFrameIndices.has(i)) {
        continue;
      }
      framesToAnalyze.push({ idx: i, path: allFrames[i] });
    }

    // P2: 解析 matrixMode → effectiveLayout
    const rawMatrixMode = input.matrixMode || 'auto';
    const effectiveLayout: MatrixLayout =
      rawMatrixMode === 'auto'
        ? ContactSheetBuilder.autoSelectLayout(estimatedInterval)
        : rawMatrixMode;
    const cellCount = ContactSheetBuilder.getCellCount(effectiveLayout);
    /** 拼图模式下每批 cellCount 帧；1x1 模式下每批 MAX_BATCH_IMAGES 帧 */
    const batchStep = effectiveLayout === '1x1' ? MAX_BATCH_IMAGES : cellCount;

    /** 批次结构：frames + 该批次的布局（不足整除时降级为 1x1） */
    interface Batch { frames: { idx: number; path: string }[]; layout: MatrixLayout; }
    const batches: Batch[] = [];
    for (let i = 0; i < framesToAnalyze.length; i += batchStep) {
      const slice = framesToAnalyze.slice(i, i + batchStep);
      // 拼图模式下，不足 cellCount 的最后一批降级为 1x1 独立发送
      const layout: MatrixLayout =
        effectiveLayout !== '1x1' && slice.length < cellCount ? '1x1' : effectiveLayout;
      batches.push({ frames: slice, layout });
    }

    /** 静态帧 + 缓存命中帧提前计入完成数，确保进度计算正确 */
    const skippedCount = totalFrameCount - framesToAnalyze.length;
    completedFrames = skippedCount;
    if (skippedCount > 0) {
      AppLogger.info(LOG_TAGS.AI_AGENT, `[画面描述] P1 跳过 ${skippedCount} 帧（pHash 静态 ${skipFrameIndices.size} + L2 缓存 ${cachedFrameIndices.size}），实际需分析 ${framesToAnalyze.length} 帧`);
      /** 推送已跳过帧的描述到前端 */
      if (skippedCount > 0) {
        const skipPct = 30 + Math.floor((completedFrames / totalFrameCount) * 65);
        onProgress(skipPct, `画面分析 ${completedFrames}/${totalFrameCount} 帧（含缓存命中）`, {
          partialFrames: buildPartialFrames(),
          completedCount: completedFrames,
          totalCount: totalFrameCount,
        });
      }
    }

    AppLogger.info(LOG_TAGS.AI_AGENT, `[画面描述] 批量模式：${framesToAnalyze.length} 帧分为 ${batches.length} 批，布局 ${effectiveLayout}（cell=${cellCount}），并发 ${CONCURRENT_VLM}`);

    // P3 Stage 1: 构建全局场景摘要（在批次分析前执行，注入到后续所有批次）
    // 阈值：待分析帧数 >= 4（一个 2x2 批次）时才构建，帧数少时一次性分析即可
    const GLOBAL_SUMMARY_MIN_FRAMES = 4;
    if (framesToAnalyze.length >= GLOBAL_SUMMARY_MIN_FRAMES) {
      onProgress(28, '正在构建全局场景摘要...');
      globalContext = await buildGlobalContext(framesToAnalyze);
    }

    /** 并发调度批次 */
    const batchQueue = batches.slice();
    const running: Promise<void>[] = [];
    while (batchQueue.length > 0 || running.length > 0) {
      if (aborted) break;
      while (batchQueue.length > 0 && running.length < CONCURRENT_VLM && !aborted) {
        const batchIdx = batches.length - batchQueue.length;
        const batch = batchQueue.shift()!;
        const promise = processBatch(batchIdx, batch.frames, batch.layout).then(() => {
          const idx = running.indexOf(promise);
          if (idx >= 0) running.splice(idx, 1);
        });
        running.push(promise);
      }
      if (running.length > 0) {
        await Promise.race(running);
      }
    }

    /** 🔧 fail fast：等待已投递的并发任务完成后，若已终止则抛错 */
    if (running.length > 0) {
      await Promise.allSettled(running);
    }
    if (aborted) {
      throw new Error(`画面描述失败：连续 ${FAIL_FAST_THRESHOLD} 批 VLM 调用失败，已终止。请检查 VLM 配置（接口地址/模型名/API Key）。最后错误：${abortError}`);
    }

    /** 释放 LRU 缓存 */
    base64Cache.clear();

    /** P1-1: VLM 完成后，对 pHash 静态镜头帧复用前一帧描述和 JSON 数据 */
    for (let i = 1; i < totalFrameCount; i++) {
      if (skipFrameIndices.has(i)) {
        frameDescriptions[i] = frameDescriptions[i - 1] || '';
        frameJsonItems[i] = frameJsonItems[i - 1] || null;
      }
    }

    const validCount = frameDescriptions.filter(d => d.trim()).length;
    AppLogger.info(LOG_TAGS.AI_AGENT, `[画面描述] 全部完成，总帧数: ${totalFrameCount}，有效描述: ${validCount}，覆盖率: ${((validCount / totalFrameCount) * 100).toFixed(1)}%`);

    /** 构建每帧完整信息 */
    const frameDetails: FrameDetail[] = allFrames.map((fp: string, i: number) => {
      const frameTimeSec = i * estimatedInterval;
      const frameEndSec = frameTimeSec + estimatedInterval;
      const matchedAsr = asrLines.filter(line =>
        line.startTime <= frameEndSec && line.endTime >= frameTimeSec
      );
      const idx = physicalFrames.indexOf(fp);
      const url = (framePathsOriginal.length > 0 && idx >= 0) ? framePathsOriginal[idx] : fp;
      const jsonItem = frameJsonItems[i];

      /** P0-3：提取下游瘦身上下文（action/emotion/keywords），供 step3 直接消费 */
      const downstream = jsonItem ? {
        action: jsonItem.narrativeAction || '',
        emotion: jsonItem.emotionalState || jsonItem.emotionTone || '',
        keywords: Array.isArray(jsonItem.keywords) ? jsonItem.keywords : [],
      } : undefined;

      /**
       * 🎭 P0.5 帧级锚定：从 effectiveFrameRoles 取本帧已检测到的人物名称列表
       * effectiveFrameRoles 已在上方自动推导（基于 roles.faces.frame_index @1fps → VLM 帧 × estimatedInterval）
       * 未启用帧级锚定时 effectiveFrameRoles 为 undefined，characters 字段不写入
       */
      const frameCharacters = effectiveFrameRoles ? (effectiveFrameRoles[i] || []) : undefined;

      return {
        url,
        description: frameDescriptions[i] || '',
        asrText: matchedAsr.map(l => l.text).join(' '),
        asrTime: matchedAsr.length > 0
          ? `${matchedAsr[0].startTime.toFixed(1)}s-${matchedAsr[matchedAsr.length - 1].endTime.toFixed(1)}s`
          : '',
        timeMs: Math.round(frameTimeSec * 1000),
        timeStr: formatTimeStr(frameTimeSec),
        editing: false,
        confirmed: !!(frameDescriptions[i] && frameDescriptions[i].trim()),
        emotion: jsonItem?.emotionalState || jsonItem?.emotionTone || '',
        downstream,
        characters: frameCharacters,
      };
    });

    onProgress(95, '画面感知完成，正在同步系统总线...');

    /** P0-3：构建下游瘦身上下文，供 step3 直接消费，减少 step3 Input Token */
    const downstreamContext = {
      shots: frameDetails.map(f => f.downstream || { action: '', emotion: '', keywords: [] }),
    };

    return {
      framesCount: totalFrameCount,
      sceneDescriptions: frameDescriptions.join('\n'),
      framePaths: frameDetails.map(f => f.url),
      frames: frameDetails,
      downstreamContext,
    };
  }
}
