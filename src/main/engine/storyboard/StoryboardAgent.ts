// 📁 路径: src/main/engine/storyboard/StoryboardAgent.ts
// 🎬 S2 分镜师 Agent（A 系列 A1）：为每个完整句（母句）开一张 C0 ShotSpec 工单（α 真工单）。
//
// 背景（docs/designs/2026-09-19-A系列实施规格.md §1/§3）：
//   B 系列把 daemon 求解器改成「按单硬筛→段内软排→顺延推进」，但**工单来源**缺 S2 一环：
//   β 影子档（B6）只是规则自动开单用于测通路；本模块才是**α 真工单**——分镜师 Agent 用 LLM
//   读场记单 + 母句文案 + 人物注册表 + 可选值枚举，为每个母句产出可被库房满足的 ShotSpec。
//   Node 侧职责：开单（本模块）+ 接线回 query（SemanticAnalyzeStrategy.ts）；解码/校验在 A2。
//
// 🔒 约束（违反任一即返工，见规格 §2）：
//   P1  开关关闭（默认我们全旁路，query 字段集与线上一致）。
//   P2  数量守恒：一母句一工单，工单数≠母句数 ⇨ 判定失败可带错重开 ≤2 次，绝不静默补齐/丢单。
//   P3  可选集硬约束：枚举只能取自 C0 `SHOT_SPEC_ENUMS`、段号∈场记单、fallbackLevel∈0~5；
//       违反即重开，不降级放行。
//   P4  空间类型只能用 C0 `SpatialType` 7 类，不自造类目。
//   P5  禁抽样投票，只允许「带错误信息重开 ≤2 次」。
//   P6  atmosphereNote 只是软排/人读备注，不做开单决策或主检索依据。
//   P7  输出必须严格 JSON 且根为 `{ "shots": ShotSpec[] }`。
//（subjects∈段人物、可满足性、配场存疑 属 A2 展开项，本模块只做"最小结构校验+数量守恒+枚举门"。）

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '@modules/infra/logger/LogConstants';
import { PathManager } from '../../utils/pathManager';
import { promisePool } from '../../utils/async';
import { LLMFactory, FactoryResult } from '../adapters/LLMFactory';
import {
  ShotSpec,
  SHOT_SPEC_ENUMS,
} from '../../../shared/contracts/shotSpec';
import { loadPersonRegistry, PersonRegistry } from '../utils/PersonRegistry';
import {
  validateSubjectsInTopChars,
  aggregateEvaluation,
  sanitizeTopChars,
} from './storyboardValidate';

/* ==================== 枚举常量 ==================== */

/** 开单开关环境变量：取值 `on` 启用 α 真工单（缺省其余一律 off=全旁路）。 */
export const STORYBOARD_OPEN_ENV = 'ZENTECT_STORYBOARD_OPEN';

/**
 * 函数级中文注释：读开单开关 `ZENTECT_STORYBOARD_OPEN`。
 * 仅当显式 `on`（大小写不敏感）时返回 true；其余一切（未设/off/未知）返回 false ⇨ 全旁路（P1）。
 *
 * @returns 是否启用 α 真工单开单
 */
export function resolveStoryboardOpen(): boolean {
  try {
    const proc = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process;
    const raw = proc?.env ? proc.env[STORYBOARD_OPEN_ENV] : undefined;
    return String(raw ?? '').trim().toLowerCase() === 'on';
  } catch {
    return false;
  }
}

/** S3 剪辑改道档位环境变量：`off|shadow|on`，**缺省 `on`（正式 cutover 默认启用）**。
 *  命名对齐 B 系列规格 `ZENTECT_KM_STORYBOARD_MODE`（消费/剪辑改道档），
 *  与生成工单档 `ZENTECT_STORYBOARD_OPEN`（A）分开，各自独立（§24.16 / B 系列 §10）。 */
export const STORYBOARD_MODE_ENV = 'ZENTECT_KM_STORYBOARD_MODE';

/** 档位可选值（与 daemon timeline_solver.py `load_storyboard` 一致）。 */
export type StoryboardMode = 'off' | 'shadow' | 'on';

/**
 * 函数级中文注释：读 S3 剪辑改道档位 `ZENTECT_STORYBOARD_MODE`。
 * - `on`    ：正式启用（缺省）——段域候选池 + 段内分组 KM，主结果即派工结果；
 * - `shadow`：只算不用——双轨对照（B6），统计「段域是否容纳了线上命中」，结果不生效；
 * - `off`   ：完全旁路，daemon 零行为变化（回归对照用）。
 * 解析失败/未知值回退 `on`（正式 cutover 后默认启用，不复刻旧 off 缺省）。
 */
export function resolveStoryboardMode(): StoryboardMode {
  try {
    const proc = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process;
    const raw = String(proc?.env ? proc.env[STORYBOARD_MODE_ENV] : '').trim().toLowerCase();
    if (raw === 'off') return 'off';
    if (raw === 'shadow') return 'shadow';
    return 'on'; // 含未设/未知 → 缺省 on（正式默认启用）
  } catch {
    return 'on';
  }
}

/** `temp/` 下档位标记文件名（与 daemon `load_storyboard` 读取路径严格一致）。 */
const STORYBOARD_MODE_FILE = 'storyboard-mode';

/**
 * 函数级中文注释：把 `resolveStoryboardMode()` 的档位幂等落盘到 `temp/storyboard-mode`。
 * daemon `load_storyboard` 读的是该标记文件（env 不保证进 daemon 子进程的历史约束），
 * Node 侧作为**正式 env 入口**（`ZENTECT_KM_STORYBOARD_MODE`），在进 KM 前把档位同步过去，
 * daemon 读取路径不变、零 Python 改动。
 * 文件内容与目标档位一致则跳过写盘（避免每次步骤5 都触发磁盘写）。
 */
export function syncStoryboardModeFile(): StoryboardMode {
  const mode = resolveStoryboardMode();
  try {
    const dir = path.join(process.cwd(), 'temp');
    const file = path.join(dir, STORYBOARD_MODE_FILE);
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8').trim().toLowerCase() : '';
    if (existing !== mode) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, mode, 'utf-8');
      AppLogger.info(LOG_TAGS.AI_AGENT,
        `[storyboard] S3 档位落盘 → ${file} = ${mode}`);
    }
  } catch (e) {
    // 落盘失败不阻断主流程：daemon 侧若已有档位文件则沿用，否则按 off 兜底零行为变化
    AppLogger.warn(LOG_TAGS.AI_AGENT, `[storyboard] 档位落盘失败（沿用既有档位）：${(e as Error)?.message || e}`);
  }
  return mode;
}

/** Prompt 版本：随推理链/约束更新 +1，缓存 key 随之失效（防止旧 prompt 压中的工单被长期复用）。 */
const PROMPT_VERSION = 'a1-v1';

/** 单批母句数的缺省值（超长文案 LLM 易截断 JSON，分批收敛；场记单每批都给全量）。 */
const DEFAULT_BATCH_SIZE = 20;

/** 批次 LLM 调用最大并发数（规格 §5.1：并发 3~5）。 */
const OPEN_CONCURRENCY = 4;

/** 带错误信息的最大重开次数（P2/P3/P5：≤2）。 */
const MAX_RETRY_ON_INVALID = 2;

/* ==================== 类型 ==================== */

/** A1 消费的「母句级轻量输入」（自步骤5 allQueries 提取，不新建数据模型）。 */
export interface MotherClauseInput {
  /** 唯一主键：完整句的 matchUnitId（与 ShotSpec.matchUnitId 同源，溯源用） */
  matchUnitId: string;
  /** 完整句正文 */
  text: string;
  /** 画面意图（视觉描述，仅供分镜参考；非开单硬依据） */
  visualIntent?: string;
  /** 情绪（文案侧原始值；LLM 映射到 C0 ShotEmotion 枚举） */
  emotion?: string;
  /** 是否原声段（true ⇒ 工单 audioMode=original 并锁说话人、不参与变速） */
  keepOriginalAudio?: boolean;
  /** 完整句承载的 TTS/原声时长（毫秒，仅供分镜参考） */
  audioDurationMs?: number;
}

/** 场记单段落摘要（loadSegments 读 `segments.json`，字段对齐 S1 段对象；缺字段给空不崩溃）。 */
export interface SegmentSummary {
  segmentId: number;
  startMs: number;
  endMs: number;
  parentIds: string[];
  parentCount: number;
  chunkCount: number;
  locClass: string;
  locPurity: number;
  locRaw: Array<[string, number]>;
  topChars: string[];
  shotDist: Record<string, number>;
  repDesc: string;
}

/** openOrders 配置项。 */
export interface StoryboardOpenOptions {
  /** 每批母句数（缺省 20） */
  batchSize?: number;
  /** 带错误信息最大重开次数（缺省 2，P2/P5） */
  maxRetryOnInvalid?: number;
}

/** 单批开单结果（内部）。 */
interface BatchOpenResult {
  orders: ShotSpec[];
  retries: number;
  /** 本批是否因连续超重开被废弃（⇒ 该批工单不产出，交给上层 warn） */
  discarded: boolean;
}

/** 内存缓存：projectId 级 key → 工单（重跑步骤5 不重复调 LLM，规格 §5.1 缓存）。 */
const memoryCache = new Map<string, ShotSpec[]>();

/**
 * S2 分镜师 Agent：A1 开单主体。全部函数为纯 Node 侧，不接 IPC、不改 daemon。
 * 对外唯一入口 `openOrders`；其余均为内部实现细节（按规格 §5.1 逐个落地）。
 */
export class StoryboardAgent {
  // ==================== 对外入口 ====================

  /**
   * 函数级中文注释：为每个母句开一张 ShotSpec 工单（α 真工单）。
   *
   * 流程（规格 §3/§5.1）：
   *   ① loadSegments 场记单（缺失返回 [] 并告警，缺文件则直接回退）；
   *   ② buildMotherClauses 把 allQueries 提取为母句级轻量结构；
   *   ③ 命中缓存（母句文案↔场记单摘要↔prompt 版本）则直接复用；
   *   ④ batchMotherClauses 分批 → promisePool 并发调 LLM
   *      （每批 buildPrompt→callOpen→parseShotsJson→validateShotSpecShape→assertOnePerMotherClause，
   *        带错误信息重开 ≤2 次，连续超次废弃该批并告警）；
   *   ⑤ 成功全部批次后落缓存（磁盘+内存双写）并回读。
   *
   * @param allQueries 步骤5 `buildMatchQueries` 产物（母句级，每完整句一条，含 matchUnitId）
   * @param projectId  项目 id（定位场记单/注册表/缓存文件）
   * @param opts       配置（batchSize / maxRetryOnInvalid）
   * @returns 工单数组（按母句顺序稳定）；场记单缺失 / 母句为空 / 全部批次废弃时返回 []
   */
  static async openOrders(
    allQueries: any[],
    projectId?: string,
    opts?: StoryboardOpenOptions,
  ): Promise<ShotSpec[]> {
    const batchSize = Math.max(1, Math.floor(opts?.batchSize || DEFAULT_BATCH_SIZE) || 1);
    const maxRetry = opts?.maxRetryOnInvalid !== undefined
      ? Math.max(0, Math.floor(opts.maxRetryOnInvalid) || 0)
      : MAX_RETRY_ON_INVALID;

    const segments = StoryboardAgent.loadSegments(projectId);
    if (segments.length === 0) {
      // 规格 §5.1：缺文件不阻塞整个步骤5，返回空由上层回退既有链路
      AppLogger.warn(LOG_TAGS.AI_AGENT,
        `[开单] 场记单 segments.json 缺失（projectId=${projectId || ''}），α 真工单跳过，回退既有链路（P1 零影响）`);
      return [];
    }

    const mothers = StoryboardAgent.buildMotherClauses(allQueries);
    if (mothers.length === 0) {
      AppLogger.warn(LOG_TAGS.AI_AGENT, '[开单] 母句序列为空，α 真工单跳过');
      return [];
    }

    // —— topChars 幻觉清洗（读边界，P1 零影响：仅 α 开单链路触达）——
    // segments.json 的 topChars 由 S1 场记生成、常混入道具/物体/占位/注册表外幻觉性名
    // （如"李民浩""窗外路灯"），若直接作 prompt 取值源 + A2 白名单，会以脏为据放行幻觉工单。
    // 这里载注册表后**就地清洗每段 topChars**，且**先清洗再算 cacheKey**：既保证 prompt 与
    // 白名单门（P3）同用清洗后主体，又让旧"脏"缓存指纹失效、重跑步骤5 强制重开。
    const topCharsBefore = segments.reduce((n, s) => n + (Array.isArray(s.topChars) ? s.topChars.length : 0), 0);
    const registry = loadPersonRegistry(projectId);
    for (const seg of segments) {
      seg.topChars = sanitizeTopChars(seg.topChars, registry);
    }
    const topCharsAfter = segments.reduce((n, s) => n + (Array.isArray(s.topChars) ? s.topChars.length : 0), 0);
    if (topCharsBefore !== topCharsAfter) {
      AppLogger.info(LOG_TAGS.AI_AGENT,
        `[开单] topChars 幻觉清洗：${topCharsBefore}→${topCharsAfter}（剔除 ${topCharsBefore - topCharsAfter} 个道具/物体/占位/幻觉主体）`);
    }

    // 命中缓存直接复用（缺省默认不读磁盘缓存以外的错误容忍，见 loadCache）
    const cacheKey = StoryboardAgent.cacheKey(mothers, segments);
    const cached = StoryboardAgent.loadCache(projectId, cacheKey);
    // 🎯 缓存回填数量守恒（ADR-⑧）：命中且工单数 = 当前母句数才复用；不符（上游句子数变化）则视为 miss 重新开单，
    //   保证不"缺单"。cacheKey 已含 text 全文（改文案天然失效），此为二次加固。
    if (cached && cached.length === mothers.length) {
      AppLogger.info(LOG_TAGS.AI_AGENT,
        `[开单] 缓存命中：${cached.length} 张工单（母句 ${mothers.length} 句，prompt ${PROMPT_VERSION}）`);
      // 🎬 展示透传：缓存工单同样补回母句 text/visualIntent（老缓存文件可能缺，统一回填）
      return StoryboardAgent.attachMotherFields(cached, mothers);
    }
    if (cached && cached.length !== mothers.length) {
      AppLogger.warn(LOG_TAGS.AI_AGENT,
        `[开单] 缓存数量不符（缓存 ${cached.length} 张 ≠ 母句 ${mothers.length} 句），忽略缓存重新开单`);
    }

    const batches = StoryboardAgent.batchMotherClauses(mothers, batchSize);

    // 并发调 LLM（并发窗口保证不把下游打爆）；任一适配器配置失败整个开单回退
    let factory: FactoryResult;
    try {
      factory = LLMFactory.createAdapter('script'); // 与 JSON 产出主链路同通道（response_format 降级链完整）
    } catch (e: any) {
      AppLogger.warn(LOG_TAGS.AI_AGENT, `[开单] LLM 通道未配置，跳过 α 真工单：${e?.message || e}`);
      return [];
    }

    const tasks = batches.map((b) => () =>
      StoryboardAgent.openOneBatch(b, segments, registry, factory, maxRetry));
    const results = await promisePool(tasks, Math.max(1, OPEN_CONCURRENCY));

    let orders: ShotSpec[] = [];
    let totalRetries = 0;
    let discarded = 0;
    for (const r of results) {
      orders = orders.concat(r.orders);
      totalRetries += r.retries;
      if (r.discarded) discarded++;
    }
    if (discarded > 0) {
      // 规格 §7 末行：连续 3 次重开仍非法 → 该批废弃并告警（不静默降级为规则单）
      AppLogger.warn(LOG_TAGS.AI_AGENT,
        `[开单] ${discarded}/${results.length} 批经 ${maxRetry} 次重开仍非法，已废弃（不降级为规则单）；产出 ${orders.length}/${mothers.length} 张工单`);
    }

    // 数量守恒（P2）：只要没有整批废弃，工单数必须=母句数
    if (discarded === 0) StoryboardAgent.assertOnePerMotherClause(orders, mothers);

    // 🎬 展示透传：先补回母句 text/visualIntent，再落缓存（storyboard_orders.json 含文案供前端展示）
    orders = StoryboardAgent.attachMotherFields(orders, mothers);

    if (orders.length > 0) StoryboardAgent.saveCache(projectId, cacheKey, orders);
    StoryboardAgent.logDiagnostics(orders.length, mothers.length, totalRetries, discarded, results.length);
    return orders;
  }

  /**
   * 函数级中文注释：开单诊断一次性输出（规格 §5.2「开单数=母句数/一次通过率/重开次数」）。
   * @param open 实际工单数
   * @param mothers 母句总数
   * @param totalRetries 累计重开次数
   * @param discarded 废弃批数
   * @param batches 总批数
   */
  private static logDiagnostics(
    open: number, mothers: number, totalRetries: number, discarded: number, batches: number,
  ): void {
    // 一次通过批次 = 总批 − 重开过的批（重开>0 即非一次通过，近似口径，够诊断用）
    const oncePass = totalRetries === 0 ? batches - discarded : Math.max(0, batches - discarded - (totalRetries > 0 ? 1 : 0));
    AppLogger.info(LOG_TAGS.AI_AGENT,
      `[开单] ★ 开单诊断：工单=${open}/母句=${mothers}｜批次=${batches}（废弃=${discarded}）` +
      `｜累计重开=${totalRetries}次｜结构一次通过率≈${batches > 0 ? ((oncePass / batches) * 100).toFixed(1) : '-'}%`);
  }

  // ==================== 输入构建 ====================

  /**
   * 函数级中文注释：读 `data/projects/<projectId>/segments.json`（缺省经 PathManager 解析项目目录；
   * dev 兜底 `temp/scene-log/segments.json`），归一为 SegmentSummary[]。
   * 缺文件 / 解析失败返回 [] 并 warn（绝不让开单拖垮步骤5）。
   *
   * @param projectId 项目 id
   * @returns 场记单段落摘要数组（顺序按 segments.json 原序）
   */
  static loadSegments(projectId?: string): SegmentSummary[] {
    const candidates: string[] = [];
    if (projectId && projectId.trim()) {
      try {
        candidates.push(path.join(PathManager.getProjectDir(projectId.trim()), 'segments.json'));
      } catch (e: any) {
        AppLogger.warn(LOG_TAGS.AI_AGENT, `[开单] 解析项目目录失败，跳过项目级场记单：${e?.message || e}`);
      }
    }
    // dev-only 兜底（temp/ 目录不随发版发布）
    candidates.push(path.join(process.cwd(), 'temp', 'scene-log', 'segments.json'));

    for (const file of candidates) {
      try {
        if (!fs.existsSync(file)) continue;
        const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (!Array.isArray(raw)) continue;
        const segs: SegmentSummary[] = raw
          .filter((s) => s && typeof s.segmentId !== 'undefined')
          .map((s) => ({
            segmentId: Number(s.segmentId) || 0,
            startMs: Number(s.startMs) || 0,
            endMs: Number(s.endMs) || 0,
            parentIds: Array.isArray(s.parentIds) ? s.parentIds.map(String) : [],
            parentCount: Number(s.parentCount) || (Array.isArray(s.parentIds) ? s.parentIds.length : 0),
            chunkCount: Number(s.chunkCount) || 0,
            locClass: String(s.locClass || '').trim(),
            locPurity: Number(s.locPurity) || 0,
            locRaw: Array.isArray(s.locRaw) ? s.locRaw as Array<[string, number]> : [],
            topChars: Array.isArray(s.topChars) ? s.topChars.map(String) : [],
            shotDist: s.shotDist && typeof s.shotDist === 'object' ? s.shotDist as Record<string, number> : {},
            repDesc: String(s.repDesc || '').trim(),
          }));
        AppLogger.info(LOG_TAGS.AI_AGENT, `[开单] 场记单已加载：${file}（${segs.length} 段）`);
        return segs;
      } catch (e: any) {
        AppLogger.warn(LOG_TAGS.AI_AGENT, `[开单] 场记单解析失败（${file}）：${e?.message || e}`);
      }
    }
    AppLogger.info(LOG_TAGS.AI_AGENT, '[开单] 未找到场记单（segments.json），本次跳过 α 真工单');
    return [];
  }

  /**
   * 函数级中文注释：把 allQueries 提取为母句级轻量结构（按 matchUnitId 去重，保持首次出现顺序）。
   * 与 ShotSpec.matchUnitId 同源（sentence 档=完整句 id；legacy 档退化为 query.shotId）。
   *
   * @param allQueries 步骤5 buildMatchQueries 产物
   * @returns 母句序列（顺序稳定，无重复主键）
   */
  static buildMotherClauses(allQueries: any[]): MotherClauseInput[] {
    const seen = new Set<string>();
    const mothers: MotherClauseInput[] = [];
    for (const q of Array.isArray(allQueries) ? allQueries : []) {
      const key = String((q as any)?.matchUnitId || q?.shotId || '').trim();
      if (!key || seen.has(key)) continue; // 去重：sentence 档同一完整句只出现一次，绝不重复开单
      seen.add(key);
      // 🎯 文案剥离画面意图后缀（ADR-⑧）：上游 query.text 形如 "{完整句} | {visualIntent}"（KM 需拼 intent），
      //   但开单/展示只需干净文案——按 q.visualIntent 精确剥离该后缀，mother.text 即纯文案；visualIntent 独立持有。
      const visualIntent = String((q as any)?.visualIntent || '').trim();
      const rawText = String(q?.text || '').trim();
      const text = visualIntent && rawText.endsWith(` | ${visualIntent}`)
        ? rawText.slice(0, rawText.length - ` | ${visualIntent}`.length)
        : rawText;
      mothers.push({
        matchUnitId: key,
        text,
        visualIntent: visualIntent || undefined,
        emotion: String(q?.emotion || '').trim() || undefined,
        keepOriginalAudio: q?.keepOriginalAudio === true,
        audioDurationMs: Number((q as any)?.audioDurationMs) || undefined,
      });
    }
    return mothers;
  }

  /**
   * 函数级中文注释：把母句按序切批（规格 §4 以「相邻母句分批」替代章归并）。
   * @param mothers 母句序列
   * @param batchSize 每批母句数
   * @returns 分批后的母句数组的数组（顺序稳定）
   */
  static batchMotherClauses(mothers: MotherClauseInput[], batchSize: number): MotherClauseInput[][] {
    const size = Math.max(1, Math.floor(batchSize) || 1);
    const batches: MotherClauseInput[][] = [];
    for (let i = 0; i < mothers.length; i += size) batches.push(mothers.slice(i, i + size));
    return batches;
  }

  // ==================== LLM 开单（单批） ====================

  /**
   * 函数级中文注释：单个批次的开单主循环。
   * 带错误信息重开 ≤2 次（P2/P3/P5）：工单数≠母句数或最小结构校验不过（enum/段号/必填越界）
   * ⇒ 把错误拼进 user prompt 重开；连续超次废弃该批（规格 §7 末行）。
   *
   * @param mothers 本批母句
   * @param segments 全片场记单摘要
   * @param registry 人物注册表（canonical/别名，供 prompt 参考）
   * @param factory 复用 LLM 通道（避免逐批重建）
   * @param maxRetry 最大重开次数
   * @returns 本批结果（工单 + 重开数 + 是否废弃）
   */
  private static async openOneBatch(
    mothers: MotherClauseInput[],
    segments: SegmentSummary[],
    registry: PersonRegistry | null,
    factory: FactoryResult,
    maxRetry: number,
  ): Promise<BatchOpenResult> {
    const prevContext = StoryboardAgent.buildPrevContext(segments);
    const maxSegmentId = segments.reduce((m, s) => Math.max(m, s.segmentId), 0);
    // A2：段号 → 段摘要 查表（供白名单门 + 可满足性/配场存疑 共用，见 storyboardValidate.ts）
    const segById = new Map<number, SegmentSummary | null>();
    for (const s of segments) if (s && Number.isInteger(s.segmentId)) segById.set(s.segmentId, s);
    let lastErrors = '';

    for (let attempt = 0; attempt <= maxRetry; attempt++) {
      const prompt = StoryboardAgent.buildPrompt(mothers, segments, registry, prevContext, lastErrors);
      let raw: string;
      try {
        raw = await StoryboardAgent.callOpen(factory, prompt);
      } catch (e: any) {
        AppLogger.warn(LOG_TAGS.AI_AGENT,
          `[开单] 批次 ${mothers.length} 句 LLM 调用失败（第 ${attempt + 1} 次）：${e?.message || e}`);
        if (attempt < maxRetry) continue;
        return { orders: [], retries: attempt, discarded: true };
      }

      const { shots, errors } = StoryboardAgent.parseShotsJson(raw);
      const orders = StoryboardAgent.ensureShots(shots, maxSegmentId);
      if (orders.length === 0) {
        // 解析失败/根非 {"shots":[...]}（P7）或无合法工单 → 带错重开
        lastErrors = errors.length > 0 ? errors.join('；') : '根结构非 {"shots":ShotSpec[]} 或字段非法';
        continue;
      }

      // 数量守恒（P2）+ 枚举/段号门（P3，A1 最小结构校验）
      try {
        StoryboardAgent.assertOnePerMotherClause(orders, mothers);
      } catch (e: any) {
        lastErrors = String(e?.message || e);
        if (attempt < maxRetry) continue;
        return { orders: [], retries: attempt, discarded: true };
      }

      // A2·① 白名单门（subjects∈段 topChars，P3）：任一越白名单 → 带错重开 ≤2 次
      let whitelistErr = '';
      for (let i = 0; i < orders.length; i++) {
        const o = orders[i];
        const errs = validateSubjectsInTopChars(o, segById.get(Number(o.segmentId))?.topChars ?? null, registry);
        if (errs.length > 0) whitelistErr += `工单#${i + 1}: ${errs.join('，')}；`;
      }
      if (whitelistErr) {
        lastErrors = `主体白名单越界：${whitelistErr}`;
        if (attempt < maxRetry) continue;
        AppLogger.warn(LOG_TAGS.AI_AGENT, `[开单] 批次${mothers.length}句白名单门持续不过，已废弃（3次重开仍非法）`);
        return { orders: [], retries: attempt, discarded: true };
      }

      // A2·②③ 可满足性 + 配场存疑（纯计算，不重开，标 unresolved 进诊断表）
      const summary = aggregateEvaluation(orders, segById, registry);
      AppLogger.info(LOG_TAGS.AI_AGENT,
        `[开单] 本批可满足率=${summary.satisfiableCount}/${summary.total}` +
        `（${(summary.total ? (summary.satisfiableCount / summary.total * 100) : 0).toFixed(1)}%）` +
        `｜配场存疑=${summary.suspiciousCount}/${summary.total}` +
        `${summary.points.some((p) => p.reason) ? `｜${summary.points.filter((p) => p.reason).map((p) => `#${p.orderIndex}${p.reason}`).join('；')}` : ''}`);
      return { orders, retries: attempt, discarded: false };
    }
    return { orders: [], retries: maxRetry, discarded: true };
  }

  /**
   * 函数级中文注释：调 LLM 产出 JSON 文本（失败重试 1 次，见规格 §5.1）。
   * 使用 `LLMFactory.createAdapter('script')` 统一通道 + `response_format:{type:'json_object'}`，
   * 适配器自带 json_object 三级降级链，保证尽量返回合法 JSON（P7）。
   *
   * @param factory 复用通道（adapter/modelName/temperature）
   * @param prompt  已组装好的 system+user
   * @returns LLM 返回的原始文本（可能含 markdown 围栏，交由 parseShotsJson 净化）
   */
  private static async callOpen(factory: FactoryResult, prompt: { system: string; user: string }): Promise<string> {
    const { adapter, modelName, temperature } = factory;
    let resp;
    try {
      resp = await adapter.chat(
        [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        modelName,
        temperature,
        { response_format: { type: 'json_object' } },
      );
    } catch (e: any) {
      // 网层抛错（断连/429）：重试一次再抛出
      resp = await adapter.chat(
        [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        modelName,
        temperature,
        { response_format: { type: 'json_object' } },
      );
    }
    if (!resp || !resp.success) {
      throw new Error(resp?.error || 'LLM 返回失败');
    }
    if (!resp.text || !String(resp.text).trim()) {
      throw new Error('LLM 返回 content 为空');
    }
    return String(resp.text);
  }

  // ==================== 解析 + 校验 ====================

  /**
   * 函数级中文注释：解析 `{ "shots": ShotSpec[] }`（P7）。
   * 净化 markdown 围栏后 JSON.parse；根非对象或 shots 非数组即判失败。
   * 逐条先做最小结构校验（enum+段号+必填），收集错误返回；不做可满足性（属 A2）。
   *
   * @param raw LLM 原始文本
   * @returns { shots: 解析出的原始工单项, errors: 校验错误列表 }
   */
  static parseShotsJson(raw: string): { shots: any[]; errors: string[] } {
    const errors: string[] = [];
    let text = String(raw || '').trim();
    // 去 markdown 围栏（```json ... ``` 可能带 BOM/语言标签）
    text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    let root: any;
    try {
      root = JSON.parse(text);
    } catch (e: any) {
      return { shots: [], errors: [`JSON 解析失败：${e?.message || e}`] };
    }
    if (root === null || typeof root !== 'object' || Array.isArray(root)) {
      return { shots: [], errors: ['根结构非 JSON 对象'] };
    }
    if (!Array.isArray(root.shots)) {
      return { shots: [], errors: ['根对象缺 shots 数组（P7）'] };
    }
    return { shots: root.shots, errors };
  }

  /**
   * 函数级中文注释：把 parseShotsJson 的原始项收束为合法 ShotSpec[]（A1 最小结构校验）。
   * 对每一项做字段必备 + 枚举门（P3/P4）+ 段号∈场记单；非法项剔除并记错（触发重开）。
   *
   * @param shots 解析出的原始工单项数组
   * @param maxSegmentId 场记单最大合法段号
   * @returns 通过结构校验的 ShotSpec[]（顺序稳定；非法项被剔除）
   */
  static ensureShots(shots: any[], maxSegmentId: number): ShotSpec[] {
    const out: ShotSpec[] = [];
    const errors: string[] = [];
    for (let i = 0; i < shots.length; i++) {
      const errs = StoryboardAgent.validateShotSpecShape(shots[i], maxSegmentId);
      if (errs.length > 0) {
        errors.push(`工单#${i + 1}: ${errs.join('，')}`);
        continue;
      }
      const sp = shots[i] as ShotSpec;
      out.push({
        matchUnitId: String(sp.matchUnitId ?? '').trim(),
        mode: sp.mode,
        segmentId: Number(sp.segmentId),
        spatialType: sp.spatialType,
        targetSubjects: Array.isArray(sp.targetSubjects) ? sp.targetSubjects.map(String) : [],
        preferredShot: sp.preferredShot,
        cameraDynamic: sp.cameraDynamic,
        emotion: sp.emotion,
        audioMode: sp.audioMode,
        fallbackLevel: Number(sp.fallbackLevel) as ShotSpec['fallbackLevel'],
        ...(sp.actionType ? { actionType: String(sp.actionType).trim() } : {}),
        ...(sp.keyProp ? { keyProp: String(sp.keyProp).trim() } : {}),
        ...(sp.atmosphereNote ? { atmosphereNote: String(sp.atmosphereNote).trim() } : {}),
      });
    }
    if (errors.length > 0) {
      AppLogger.info(LOG_TAGS.AI_AGENT, `[开单] 结构校验剔除 ${errors.length} 项（${errors.join('；')}），将触发重开`);
    }
    return out;
  }

  /**
   * 函数级中文注释：把母句的「文案原文 / 画面意图」按 matchUnitId 回填到工单（展示透传，非开单依据）。
   *
   * 背景：工单只快照镜头字段，未含该完整句的 text/visualIntent，前端分镜单卡片无法对照
   * 「这句台词 → 这个分镜」。母句信息在 buildMotherClauses 已提取，这里统一补回。
   *
   * 规则：
   *  - 以 mothers 建 matchUnitId → mother 映射，遍历 orders 补 `text`/`visualIntent`；
   *  - 目标字段已存在（LLM 或上游已写）则跳过，不覆盖；
   *  - 母句缺失（脏数据）或字段为空则保持 undefined，不写入。
   * 适用于缓存命中与非缓存两条路径，调用方在 openOrders 返回前统一调用。
   *
   * @param orders  待回填的工单数组（原地不改，返回新数组）
   * @param mothers 母句序列（含 text/visualIntent）
   * @returns 回填完成后的工单数组（顺序与入参一致）
   */
  static attachMotherFields(orders: ShotSpec[], mothers: MotherClauseInput[]): ShotSpec[] {
    if (!Array.isArray(orders) || orders.length === 0 || !Array.isArray(mothers)) return orders;
    const motherByUnit = new Map<string, MotherClauseInput>();
    for (const m of mothers) {
      const key = String(m?.matchUnitId || '').trim();
      if (key) motherByUnit.set(key, m);
    }
    return orders.map((o) => {
      if (!o) return o;
      const m = motherByUnit.get(String(o.matchUnitId || '').trim());
      if (!m) return o;
      const next = { ...o };
      if (!next.text && typeof m.text === 'string' && m.text.trim()) next.text = m.text.trim();
      if (!next.visualIntent && typeof m.visualIntent === 'string' && m.visualIntent.trim()) {
        next.visualIntent = m.visualIntent.trim();
      }
      return next;
    });
  }

  /**
   * 函数级中文注释：A1 最小结构校验（对齐 `shot_spec.py validate_shot_spec` 的 TS 版）。
   * 校验：必填字段（matchUnitId/mode/segmentId/spatialType/preferredShot/cameraDynamic/emotion/audioMode/fallbackLevel）
   *      + 枚举门（P4 不引第二套空间枚举）+ 段号∈场记单 + fallbackLevel∈0~5。
   * 明确**不含**：subjects∈段人物、可满足性、配场存疑（属 A2 展开项，见规格 §8）。
   *
   * @param sp 原始工单项
   * @param maxSegmentId 场记单最大合法段号
   * @returns 错误列表（空=合法）
   */
  static validateShotSpecShape(sp: any, maxSegmentId: number): string[] {
    if (!sp || typeof sp !== 'object') return ['工单非对象'];
    const errs: string[] = [];
    const has = (k: string): boolean => sp[k] !== undefined && sp[k] !== null && String(sp[k]).trim() !== '';
    const inEnum = <T extends string>(k: string, values: readonly T[]): boolean =>
      values.includes(String(sp[k]) as T);

    if (!has('matchUnitId')) errs.push('缺 matchUnitId');
    if (!inEnum('mode', SHOT_SPEC_ENUMS.mode)) errs.push(`mode 越枚举(${SHOT_SPEC_ENUMS.mode.join('/')})`);
    const seg = Number(sp.segmentId);
    if (!Number.isInteger(seg) || seg < 1 || seg > maxSegmentId) {
      errs.push(`segmentId 非法(${String(sp.segmentId)}，合法∈[1,${maxSegmentId}])`);
    }
    if (!inEnum('spatialType', SHOT_SPEC_ENUMS.spatialType)) errs.push(`spatialType 越枚举(${SHOT_SPEC_ENUMS.spatialType.join('/')})`);
    if (!Array.isArray(sp.targetSubjects)) errs.push('targetSubjects 须为数组');
    if (!inEnum('preferredShot', SHOT_SPEC_ENUMS.preferredShot)) errs.push(`preferredShot 越枚举`);
    if (!inEnum('cameraDynamic', SHOT_SPEC_ENUMS.cameraDynamic)) errs.push(`cameraDynamic 越枚举`);
    if (!inEnum('emotion', SHOT_SPEC_ENUMS.emotion)) errs.push(`emotion 越枚举(${SHOT_SPEC_ENUMS.emotion.join('/')})`);
    if (!inEnum('audioMode', SHOT_SPEC_ENUMS.audioMode)) errs.push(`audioMode 越枚举(${SHOT_SPEC_ENUMS.audioMode.join('/')})`);
    const fbl = Number(sp.fallbackLevel);
    if (!Number.isInteger(fbl) || fbl < 0 || fbl > 5) errs.push(`fallbackLevel 非法(${String(sp.fallbackLevel)}，∈[0,5])`);
    return errs;
  }

  /**
   * 函数级中文注释：数量守恒断言（P2：一母句一工单）。
   * 工单数 ≠ 母句数 → 抛错（由上层判定失败可重开），绝不静默补齐/丢单。
   *
   * @param specs 已收束工单
   * @param mothers 母句序列
   */
  private static assertOnePerMotherClause(specs: ShotSpec[], mothers: MotherClauseInput[]): void {
    if (specs.length !== mothers.length) {
      throw new Error(
        `模块订单数量守恒失败：工单 ${specs.length} ≠ 母句 ${mothers.length}`,
      );
    }
  }

  // ==================== Prompt 组装 ====================

  /**
   * 函数级中文注释：组装配场 prompt（规格 §5.1 buildPrompt，落实 §24.11-D 三步推理链 + §24.11-E 连续性纪律 + P3 可选集约束 + 反模式）。
   *
   * @param batchMothers 本批母句
   * @param segments 全片场记单摘要
   * @param registry 人物注册表（canonical/别名，供参考，非硬约束）
   * @param prevContext 上一批的段上下文（段大体递增纪律用；首批为空串）
   * @param lastErrors 上一轮重开带入的错误信息（重新开单依据，P2/P3/P5）
   * @returns { system, user } 两段 prompt
   */
  static buildPrompt(
    batchMothers: MotherClauseInput[],
    segments: SegmentSummary[],
    registry: PersonRegistry | null,
    prevContext: string,
    lastErrors: string,
  ): { system: string; user: string } {
    const system = `你是分镜师。为解说词逐句开"剪辑工单"（Shot Spec），指挥画面剪辑如何匹配原片镜头。
你只能依据给定的场记单（每个段含可用的父镜头/地点/人物/景别分布/代表镜头）做局部开单，不得编造场记单里不存在的地点、人物或景别。

【三步推理链，每句都走完】
① 通读场记单，按"场景延续 + 剧情我们提供的文案意图"圈定本句最可能的候选段；
② 逐句开单：确定 模式 / 段号 / 空间类型 / 主体 / 动作类别 / 关键道具 / 景别 / 运镜 / 情绪 / 音频模式 / 降级级别；
③ 自检：该段里有没有能满足的画面（主体在该段主要人物里？景别取自该段实际分布？），不满足就重选段或收紧，绝不跨段凑。

【连续性纪律】
- 段号大体递增，尽量承接上一批已用段（上一批段号：${prevContext || '（首批无）'}），避免相邻句反复跳段；
- 相邻两句不要用重复段（除非剧情明确同场连续）；
- 连续三句以上建议换景别/运镜注（软排参考，非硬门禁）；
- 评论/过渡/抒情/原声句：若**不需要开新镜**则 mode=CONTINUE_PREV（沿用上一镜所在段），并尽量把 audioMode 置 narration；
- 原声句（keepOriginalAudio=true）：audioMode 必须= original（锁说话人、不参与变速）。

【可选值硬约束】（P3，越界即整单判废重开）
- spatialType ∈ ${SHOT_SPEC_ENUMS.spatialType.join('/')}
- preferredShot ∈ ${SHOT_SPEC_ENUMS.preferredShot.join('/')}
- cameraDynamic ∈ ${SHOT_SPEC_ENUMS.cameraDynamic.join('/')}
- emotion ∈ ${SHOT_SPEC_ENUMS.emotion.join('/')}
- audioMode ∈ ${SHOT_SPEC_ENUMS.audioMode.join('/')}
- fallbackLevel ∈ 0~5 整数（0 最严，5 最松；段地点纯度低或画面稀缺才给高值）
- targetSubjects ⊆ 该段 topChars（段里实际出场的人物/主体）
- spatialType 只能取 C0 7 类，不得自造空间类目（P4）。

【反模式】（禁犯）
- 禁止为了凑时长选语义无关段；
- atmosphereNote 只是给剪辑师看的软备注，不得作为开单决策或检索依据（P6）；
- 禁止抽样投票 / 多次采样挑"更好"，你必须一次给出确定答案。

【输出】
严格输出单个 JSON 对象，根为 {"shots": [ ... 每个母句一条 ShotSpec ... ]}，不要多余字段、不要 markdown 围栏。
每个 ShotSpec 字段：
{ "matchUnitId": "与输入一致", "mode": "NEW_SHOT|CONTINUE_PREV", "segmentId": 数字, "spatialType": "枚举", "targetSubjects": ["子串，取自段topChars"], "actionType": "动作类别(可空)", "keyProp": "关键道具(可空)", "preferredShot": "枚举", "cameraDynamic": "枚举", "emotion": "枚举", "audioMode": "narration|original", "fallbackLevel": 0~5, "atmosphereNote": "散文备注(可空)" }`;

    const segmentsText = StoryboardAgent.renderSegments(segments);
    const mothersText = batchMothers
      .map((m, i) =>
        `[${i + 1}] matchUnitId=${m.matchUnitId}${m.keepOriginalAudio ? '（原声）' : ''} durationMs=${m.audioDurationMs ?? '-'}\n` +
        `      正文：${m.text}${m.visualIntent ? `\n      画面意图：${m.visualIntent}` : ''}${m.emotion ? `\n      情绪：${m.emotion}` : ''}`,
      )
      .join('\n');

    let user = `—— 场记单（按段） ——\n${segmentsText}\n\n—— 本批母句（每句一条工单，共 ${batchMothers.length} 句） ——\n${mothersText}\n`;
    if (registry && Array.isArray(registry.chars) && registry.chars.length > 0) {
      const identities = registry.chars
        .map((c) => `${c.canonical || c.charId}${c.gatingAllowed ? '*' : ''}`)
        .filter(Boolean)
        .join('、');
      user += `\n—— 人物注册表（canonical，仅供参考是否有此人；工单主体仍须取自段 topChars） ——\n${identities}\n`;
    }
    if (lastErrors) {
      user += `\n—— 上一轮工单被判无效，错误如下，请在重开时修正（不得重复同样错误） ——\n${lastErrors}\n`;
    }
    return { system, user };
  }

  /**
   * 函数级中文注释：把场记单渲染成给 LLM 的紧凑文本（每段一行，截断代表描写控 token）。
   * @param segments 场记单摘要
   * @returns 多行文本
   */
  private static renderSegments(segments: SegmentSummary[]): string {
    return segments
      .map((s) => {
        const time = `${s.startMs}~${s.endMs}ms`;
        const dist = s.shotDist && Object.keys(s.shotDist).length > 0
          ? JSON.stringify(s.shotDist)
          : '（无）';
        const reps = s.repDesc ? (s.repDesc.length > 120 ? s.repDesc.slice(0, 120) + '…' : s.repDesc) : '（无）';
        return `S${String(s.segmentId).padStart(2, '0')}｜${time}｜${s.parentCount}父/${s.chunkCount}切片｜地点=${s.locClass}(纯度${s.locPurity})` +
          `｜主要人物=${s.topChars.join(',') || '无'}｜景别=${dist}｜代表镜头=${reps}`;
      })
      .join('\n');
  }

  /**
   * 函数级中文注释：连续筹备上一批的已用段号上下文（段大体递增纪律用）。
   * 首批/无段时返回空串。
   * @param segments 场记单
   * @returns 如 "S02-S05"
   */
  private static buildPrevContext(segments: SegmentSummary[]): string {
    if (!Array.isArray(segments) || segments.length === 0) return '';
    const ids = segments.map((s) => `S${String(s.segmentId).padStart(2, '0')}`).slice(0, 8);
    return ids.join('-');
  }

  // ==================== 缓存 ====================

  /**
   * 函数级中文注释：缓存 key = hash(母句文案 ↔ 场记单指纹 ↔ prompt 版本)（规格 §5.1 cacheKey）。
   * 任一维变化即失效，命中后重跑步骤5 不重复调 LLM。
   *
   * @param mothers 母句序列
   * @param segments 场记单
   * @returns 稳定十六进制 key
   */
  static cacheKey(mothers: MotherClauseInput[], segments: SegmentSummary[]): string {
    const motherFp = mothers
      .map((m) => `${m.matchUnitId}\u0001${m.text}\u0001${m.keepOriginalAudio ? 1 : 0}`)
      .join('\u0002');
    const segFp = segments
      .map((s) => `${s.segmentId}\u0001${s.locClass}\u0001${s.locPurity}\u0001${s.topChars.join(',')}`)
      .join('\u0002');
    return createHash('sha1').update(`${PROMPT_VERSION}\u0000${motherFp}\u0000${segFp}`, 'utf8').digest('hex');
  }

  /**
   * 函数级中文注释：读缓存（内存优先 → 磁盘 `data/projects/<pid>/storyboard_orders.json` 带回 key/version 复用）。
   * @param projectId 项目 id
   * @param key 本次希望命中 key
   * @returns 命中且 key 一致的工单数组；未命中返回 null
   */
  static loadCache(projectId?: string, key?: string): ShotSpec[] | null {
    if (key && memoryCache.has(key)) return memoryCache.get(key)!;
    if (!projectId || !projectId.trim()) return null;
    try {
      const file = path.join(PathManager.getProjectDir(projectId.trim()), 'storyboard_orders.json');
      if (!fs.existsSync(file)) return null;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (parsed && parsed.key === key && parsed.version === PROMPT_VERSION && Array.isArray(parsed.orders)) {
        const orders = parsed.orders as ShotSpec[];
        if (key) memoryCache.set(key, orders);
        return orders;
      }
    } catch (e: any) {
      AppLogger.warn(LOG_TAGS.AI_AGENT, `[开单] 读缓存失败（按未命中处理）：${e?.message || e}`);
    }
    return null;
  }

  /**
   * 函数级中文注释：写缓存（内存 + 磁盘双写，key/version 对齐，供后续重跑复用）。
   * @param projectId 项目 id
   * @param key 缓存 key
   * @param orders 工单数组
   */
  static saveCache(projectId: string | undefined, key: string, orders: ShotSpec[]): void {
    memoryCache.set(key, orders);
    if (!projectId || !projectId.trim()) return;
    try {
      const file = path.join(PathManager.getProjectDir(projectId.trim()), 'storyboard_orders.json');
      fs.writeFileSync(file, JSON.stringify({ key, version: PROMPT_VERSION, orders }, null, 2), 'utf-8');
    } catch (e: any) {
      AppLogger.warn(LOG_TAGS.AI_AGENT, `[开单] 写缓存失败（仅内存缓存生效）：${e?.message || e}`);
    }
  }
}