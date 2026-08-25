/**
 * 📁 MediaTrimPolicy.ts — 电视剧 OP/ED 片头片尾裁剪策略（P0 手动 + P1 音视频启发 + P2 跨集指纹）
 * 唯一真源：projects.extraction_config.mediaTrim JSON 字段
 *   结构（最终版）:
 *     export interface MediaTrimConfig {
 *       defaultTrimStartMs?: number;
 *       defaultTrimEndMs?: number;
 *       perMedia?: Record<string, {
 *         trimStartMs?: number; trimEndMs?: number;
 *         manualOverride?: { enabled: boolean; updatedAt?: string; by?: string };
 *         detectionHistory?: MediaTrimDetectionRecord[];
 *       }>;
 *     }
 *
 * 优先级（高→低）：
 *   1. 手动锁定（manualOverride.enabled = true → 永不再自动覆盖）
 *   2. P2_CHROMAPRINT_ALIGN（同 IP 跨集指纹对齐，置信度 0.98，天然精确）
 *   3. P1_FFMPEG_HEURISTIC（黑场+静音启发，置信度 0.9~0.95）
 *
 * 工具列表（零依赖纯函数，便于单元测试）：
 *   - resolveForMedia(projectId, mediaId) -> { trimStartMs, trimEndMs }  // DB 读端
 *   - applyToShots / applyToChunks                                        // 平移/过滤
 *   - applyDetectionResult(cfg, mediaId, record) -> newCfg                // 写入 detectionHistory + 按优先级更新 trim 值
 *   - getDetectionHistory(cfg, mediaId) -> records[]                      // 读检测历史
 *   - isManualLocked(cfg, mediaId) -> bool                                // 判断是否手动锁定
 */
import { SQLiteConnection } from '../../database/core/SQLiteConnection';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '@modules/infra/logger/LogConstants';

/** 检测来源优先级枚举（数字越大优先级越高） */
export type DetectionSource =
  | 'P1_FFMPEG_HEURISTIC'   // 90  黑场+静音启发
  | 'P2_CHROMAPRINT_ALIGN'  // 98  跨集指纹
  | 'USER_MANUAL';          // 999 用户手动值（被 manualOverride 锁定）

export const SOURCE_PRIORITY: Record<DetectionSource, number> = {
  P1_FFMPEG_HEURISTIC: 90,
  P2_CHROMAPRINT_ALIGN: 98,
  USER_MANUAL: 999,
};

/** 一次自动检测（或手动修改）留下的历史记录（每 mediaId 多条） */
export interface MediaTrimDetectionRecord {
  source: DetectionSource;
  trimStartMs: number;
  trimEndMs: number;
  /** 0~1.0，置信度；USER_MANUAL 自动为 1.0 */
  confidence: number;
  createdAt: string;  // ISO 字符串
  /** 人类可读的检测细节（比如「黑场: 18.0s 处连续 1.2s 黑场」） */
  note?: string;
  /** P2 指纹对齐的锚点素材 ID，供追溯 */
  anchorMediaId?: string;
  /** 建议是否被采用（true → 当前生效值就是这条；false → 因优先级/手动锁定被拒） */
  adopted?: boolean;
}

/** 手动锁定元数据 */
export interface MediaTrimManualOverride {
  enabled: boolean;
  updatedAt?: string;
  by?: string;
  /** 锁定当时的 trimStartMs / trimEndMs（冗余但便于读） */
  trimStartMs?: number;
  trimEndMs?: number;
}

/** 单个素材的裁剪配置（毫秒级，P1 扩展） */
export interface MediaTrimPerMedia {
  trimStartMs?: number;
  trimEndMs?: number;
  /** 手动锁定：true 时 orchestrator/UI 自动识别结果不再覆盖 trim 值 */
  manualOverride?: MediaTrimManualOverride;
  /** 检测历史（最多保留最近 12 条） */
  detectionHistory?: MediaTrimDetectionRecord[];
}

/** 全局裁剪配置（挂在 projects.extraction_config.mediaTrim 下） */
export interface MediaTrimConfig {
  /** 默认片头裁剪（适用于项目内所有素材，perMedia 覆盖优先级更高） */
  defaultTrimStartMs?: number;
  /** 默认片尾裁剪 */
  defaultTrimEndMs?: number;
  /** 按素材 ID 精确覆盖（多素材项目每个视频可独立 OP/ED 配置） */
  perMedia?: Record<string, MediaTrimPerMedia>;
}

/** 解析后的裁剪结果（毫秒级，0 表示不裁剪） */
export interface ResolvedTrim {
  trimStartMs: number;
  trimEndMs: number;
  /** 素材原始时长（毫秒）；由 media_assets.duration（秒）×1000 派生。
   *  ED 过滤/截断依赖该字段（effectiveMaxSec = srcDuration - trimStart - trimEnd），
   *  查不到时为 undefined（保持向后兼容：ED 分支退化为仅 OP）。 */
  srcDurationMs?: number;
}

/** 平移/过滤函数的可选断言开关 */
export interface ApplyTrimOptions {
  /**
   * 坐标系契约（模式 A）：
   *   DB / 回写 / 导出一律存【源坐标】（源时间轴绝对位置）；
   *   body 坐标（正剧段内 0 起）仅允许在管线内部瞬时存在，禁止落库与导出。
   * 本文件内 applyToShots / applyToChunks 的输入均须为【源坐标】。
   * expectSource=true 时运行时校验输入坐标确实在源时间轴（>= trimStartSec），
   *   防"已平移过的 body 坐标被二次平移"（缺陷 D3）。
   */
  expectSource?: boolean;
}

const TAG = 'MediaTrimPolicy';
const MAX_HISTORY = 12;

/** 从 projects.extraction_config 读取 mediaTrim（容错：任意非法形状都回退到不裁剪） */
export function parseMediaTrimConfig(raw: unknown): MediaTrimConfig {
  if (!raw || typeof raw !== 'object') return {};
  const obj = raw as any;
  const cfg: MediaTrimConfig = {};
  if (typeof obj.defaultTrimStartMs === 'number' && Number.isFinite(obj.defaultTrimStartMs)) {
    cfg.defaultTrimStartMs = Math.max(0, Math.round(obj.defaultTrimStartMs));
  }
  if (typeof obj.defaultTrimEndMs === 'number' && Number.isFinite(obj.defaultTrimEndMs)) {
    cfg.defaultTrimEndMs = Math.max(0, Math.round(obj.defaultTrimEndMs));
  }
  if (obj.perMedia && typeof obj.perMedia === 'object') {
    cfg.perMedia = {};
    for (const [mid, v] of Object.entries(obj.perMedia)) {
      const vv = v as any;
      const item: MediaTrimPerMedia = {};
      if (typeof vv?.trimStartMs === 'number' && Number.isFinite(vv.trimStartMs)) {
        item.trimStartMs = Math.max(0, Math.round(vv.trimStartMs));
      }
      if (typeof vv?.trimEndMs === 'number' && Number.isFinite(vv.trimEndMs)) {
        item.trimEndMs = Math.max(0, Math.round(vv.trimEndMs));
      }
      if (vv?.manualOverride && typeof vv.manualOverride === 'object') {
        item.manualOverride = {
          enabled: !!vv.manualOverride.enabled,
          updatedAt: typeof vv.manualOverride.updatedAt === 'string' ? vv.manualOverride.updatedAt : undefined,
          by: typeof vv.manualOverride.by === 'string' ? vv.manualOverride.by : undefined,
          trimStartMs: typeof vv.manualOverride.trimStartMs === 'number' ? vv.manualOverride.trimStartMs : undefined,
          trimEndMs: typeof vv.manualOverride.trimEndMs === 'number' ? vv.manualOverride.trimEndMs : undefined,
        };
      }
      if (Array.isArray(vv?.detectionHistory)) {
        item.detectionHistory = vv.detectionHistory
          .filter((x: any) => x && typeof x.source === 'string')
          .map((x: any) => ({
            source: x.source as DetectionSource,
            trimStartMs: Math.max(0, Math.round(Number(x.trimStartMs || 0))),
            trimEndMs: Math.max(0, Math.round(Number(x.trimEndMs || 0))),
            confidence: Math.min(1, Math.max(0, Number(x.confidence ?? (x.source === 'USER_MANUAL' ? 1 : 0.5)))),
            createdAt: typeof x.createdAt === 'string' ? x.createdAt : new Date().toISOString(),
            note: typeof x.note === 'string' ? x.note : undefined,
            anchorMediaId: typeof x.anchorMediaId === 'string' ? x.anchorMediaId : undefined,
            adopted: typeof x.adopted === 'boolean' ? x.adopted : undefined,
          }))
          .slice(-MAX_HISTORY);
      }
      // 至少有一项字段才写入 perMedia（避免空对象污染）
      if (item.trimStartMs || item.trimEndMs || item.manualOverride || (item.detectionHistory && item.detectionHistory.length > 0)) {
        cfg.perMedia[mid] = item;
      }
    }
  }
  return cfg;
}

/** 把配置序列化回纯对象（写 DB 前调用），保证形状稳定 */
export function serializeMediaTrimConfig(cfg: MediaTrimConfig): unknown {
  return JSON.parse(JSON.stringify(cfg));
}

/** 从 mediaTrimConfig 计算指定素材的最终 trim（perMedia 优先 → default 兜底 → 0） */
export function resolveMediaTrim(cfg: MediaTrimConfig, mediaId: string): ResolvedTrim {
  const c = cfg ?? {};
  const per = c.perMedia?.[mediaId];
  const trimStartMs = Math.max(0, Math.round(Number(per?.trimStartMs ?? c.defaultTrimStartMs ?? 0)));
  const trimEndMs = Math.max(0, Math.round(Number(per?.trimEndMs ?? c.defaultTrimEndMs ?? 0)));
  return { trimStartMs, trimEndMs };
}

/** 是否手动锁定（被锁定时自动检测结果不再覆盖） */
export function isManualLocked(cfg: MediaTrimConfig, mediaId: string): boolean {
  return !!cfg?.perMedia?.[mediaId]?.manualOverride?.enabled;
}

/** 读取 detectionHistory（空数组兜底） */
export function getDetectionHistory(cfg: MediaTrimConfig, mediaId: string): MediaTrimDetectionRecord[] {
  return cfg?.perMedia?.[mediaId]?.detectionHistory ?? [];
}

/**
 * 应用检测结果（纯函数）：返回新的 MediaTrimConfig。
 *   · 该素材已 manualOverride → 只追加 history（adopted=false），不更新 trim 值，不解锁
 *   · 否则：按优先级判断是否接受新建议（接受则更新 trim + history adopted=true）
 *   · opts.minConfidenceForAutoAccept：自动来源（非 USER_MANUAL）置信度低于该阈值时强制不生效，
 *      只以 adopted=false 追加 history（待用户确认的"建议"），用于拦截 P1 兜底 0.3 / P3 空壳 0.1 等误判污染下游。
 */
export function applyDetectionResult(
  cfg: MediaTrimConfig,
  mediaId: string,
  record: Omit<MediaTrimDetectionRecord, 'createdAt' | 'adopted'>,
  opts?: { minConfidenceForAutoAccept?: number }
): MediaTrimConfig {
  const newCfg: MediaTrimConfig = JSON.parse(JSON.stringify(cfg || {}));
  newCfg.perMedia = { ...(newCfg.perMedia || {}) };
  const existing = newCfg.perMedia[mediaId] || {};
  const source: DetectionSource = (record as any).source || 'P1_FFMPEG_HEURISTIC';
  const newPriority = SOURCE_PRIORITY[source] ?? 0;
  const current = resolveMediaTrim(newCfg, mediaId);
  const locked = !!existing.manualOverride?.enabled;
  const nowIso = new Date().toISOString();

  let adopted = false;
  if (source === 'USER_MANUAL') {
    // 用户手动操作永远生效（手动即最高优先级，且隐式锁定：写入后自动识别不再覆盖当前值）
    existing.trimStartMs = Math.max(0, Math.round(Number(record.trimStartMs || 0)));
    existing.trimEndMs = Math.max(0, Math.round(Number(record.trimEndMs || 0)));
    adopted = true;
  } else if (!locked) {
    // 判断是否接受：SOURCE_PRIORITY 严格大于当前值 → 接受；否则：
    //  同优先级时，置信度更高 → 接受
    let accept = false;
    // 找出当前生效值的来源（detectionHistory 里最后一条 adopted=true 的，没有就是 USER_MANUAL 兜底）
    const history = existing.detectionHistory ?? [];
    const lastAdopted = [...history].reverse().find(r => r.adopted);
    const curPriority = lastAdopted ? (SOURCE_PRIORITY[lastAdopted.source] ?? -1) : (current.trimStartMs || current.trimEndMs ? 1 : -1);
    if (opts?.minConfidenceForAutoAccept !== undefined && Number(record.confidence) < opts.minConfidenceForAutoAccept) {
      accept = false; // 低置信自动结果 → 仅记录为建议，不生效
    } else if (newPriority > curPriority) accept = true;
    else if (newPriority === curPriority && (Number(record.confidence) > Number(lastAdopted?.confidence ?? 0))) accept = true;
    if (accept) {
      existing.trimStartMs = Math.max(0, Math.round(Number(record.trimStartMs || 0)));
      existing.trimEndMs = Math.max(0, Math.round(Number(record.trimEndMs || 0)));
      adopted = true;
    }
  }
  // 写入 detectionHistory（去重：同一 createdBy+source+trimStartMs+trimEndMs 1 秒内重复的不算）
  const nextRecord: MediaTrimDetectionRecord = {
    ...record,
    source,
    confidence: record.confidence ?? (source === 'USER_MANUAL' ? 1.0 : 0.5),
    createdAt: nowIso,
    adopted,
  };
  const arr = existing.detectionHistory ? [...existing.detectionHistory] : [];
  arr.push(nextRecord);
  // 按时间升序，保留最近 MAX_HISTORY 条
  arr.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  existing.detectionHistory = arr.slice(-MAX_HISTORY);
  newCfg.perMedia[mediaId] = existing;
  return newCfg;
}

/** 设置/取消手动锁定（UI 点「手动锁定值」Toggle → 调用） */
export function setManualLock(
  cfg: MediaTrimConfig,
  mediaId: string,
  locked: boolean,
  opts?: { by?: string }
): MediaTrimConfig {
  const newCfg: MediaTrimConfig = JSON.parse(JSON.stringify(cfg || {}));
  newCfg.perMedia = { ...(newCfg.perMedia || {}) };
  const existing = newCfg.perMedia[mediaId] || {};
  const cur = resolveMediaTrim(newCfg, mediaId);
  if (locked) {
    existing.manualOverride = {
      enabled: true,
      updatedAt: new Date().toISOString(),
      by: opts?.by,
      trimStartMs: cur.trimStartMs,
      trimEndMs: cur.trimEndMs,
    };
    // 追加一条 USER_MANUAL 历史
    return applyDetectionResult(newCfg, mediaId, {
      source: 'USER_MANUAL',
      trimStartMs: cur.trimStartMs,
      trimEndMs: cur.trimEndMs,
      confidence: 1.0,
      note: opts?.by ? `用户 ${opts.by} 开启手动锁定` : '用户开启手动锁定',
    });
  } else {
    existing.manualOverride = { ...(existing.manualOverride || {}), enabled: false, updatedAt: new Date().toISOString() };
    newCfg.perMedia[mediaId] = existing;
    return newCfg;
  }
}

/** 从 media_assets 表读素材原始时长（秒 → 毫秒）。容错：查不到/非法返回 undefined。 */
function resolveSrcDurationMs(db: any, mediaId: string): number | undefined {
  try {
    const row = db.prepare('SELECT duration FROM media_assets WHERE id = ? AND is_deleted = 0').get(mediaId) as any;
    const dur = Number(row?.duration);
    if (Number.isFinite(dur) && dur > 0) return Math.round(dur * 1000);
  } catch {
    /* 只读查询失败静默：srcDurationMs 缺失退化为仅 OP，不影响主流程 */
  }
  return undefined;
}

/**
 * 数据库端：根据 projectId + mediaId 拿到最终裁剪配置。
 *   · 只读，不写；
 *   · 读 projects.extraction_config（JSON 字符串）→ 取 $.mediaTrim → 合并 perMedia[mediaId]
 *   · 附带素材原始时长 srcDurationMs（media_assets.duration），供 ED 过滤/统一窗口派生使用
 */
export function resolveForMedia(projectId: string, mediaId: string): ResolvedTrim {
  try {
    const db = SQLiteConnection.getInstance().getDB();
    const row = db.prepare("SELECT extraction_config FROM projects WHERE id = ? AND is_deleted = 0").get(projectId) as any;
    if (!row?.extraction_config) return { trimStartMs: 0, trimEndMs: 0 };
    let json: any;
    try { json = typeof row.extraction_config === 'string' ? JSON.parse(row.extraction_config) : row.extraction_config; }
    catch { return { trimStartMs: 0, trimEndMs: 0 }; }
    const cfg = parseMediaTrimConfig(json?.mediaTrim);
    const out = resolveMediaTrim(cfg, mediaId);
    const srcDurationMs = resolveSrcDurationMs(db, mediaId);
    if (srcDurationMs !== undefined) out.srcDurationMs = srcDurationMs;
    if (out.trimStartMs || out.trimEndMs) {
      AppLogger.debug(LOG_TAGS.MEDIA, `[${TAG}] 素材 ${mediaId.slice(-8)} 裁剪生效: OP=${out.trimStartMs}ms / ED=${out.trimEndMs}ms${out.srcDurationMs !== undefined ? ` / srcDuration=${out.srcDurationMs}ms` : ''}${isManualLocked(cfg, mediaId) ? ' (手动锁定)' : ''}`);
    }
    return out;
  } catch (e: any) {
    AppLogger.warn(LOG_TAGS.MEDIA, `[${TAG}] resolveForMedia 失败(安全回退不裁剪): ${e.message}`);
    return { trimStartMs: 0, trimEndMs: 0 };
  }
}

/**
 * 数据库端写操作：把新 MediaTrimConfig 写回 projects.extraction_config.mediaTrim 字段。
 *   · 由 orchestrator / UI 保存按钮调用
 *   · 参数传入 rootExtractionConfig 是当前 projects.extraction_config 的对象（可含其他字段），仅覆写 .mediaTrim 键
 */
export function writeMediaTrimToProject(
  projectId: string,
  newMediaTrimCfg: MediaTrimConfig,
  currentExtractionConfig?: any
): { ok: boolean; error?: string; newConfigStr: string } {
  try {
    const db = SQLiteConnection.getInstance().getDB();
    let root = currentExtractionConfig;
    if (!root) {
      const row = db.prepare("SELECT extraction_config FROM projects WHERE id = ? AND is_deleted = 0").get(projectId) as any;
      if (!row) return { ok: false, error: `project not found: ${projectId}`, newConfigStr: '' };
      try { root = row.extraction_config ? (typeof row.extraction_config === 'string' ? JSON.parse(row.extraction_config) : row.extraction_config) : {}; }
      catch { root = {}; }
    }
    const nextRoot = { ...(root || {}), mediaTrim: serializeMediaTrimConfig(newMediaTrimCfg) };
    const nextStr = JSON.stringify(nextRoot);
    const info = db.prepare("UPDATE projects SET extraction_config = ?, update_time = datetime('now','localtime') WHERE id = ?").run(nextStr, projectId);
    if (info.changes < 1) return { ok: false, error: 'update 0 rows', newConfigStr: nextStr };
    AppLogger.info(LOG_TAGS.OPED_TRIM, `[${TAG}] projects(${projectId.slice(-10)}) extraction_config.mediaTrim 已写入数据库`);
    return { ok: true, newConfigStr: nextStr };
  } catch (e: any) {
    AppLogger.warn(LOG_TAGS.MEDIA, `[${TAG}] writeMediaTrimToProject 失败: ${e.message}`);
    return { ok: false, error: e.message, newConfigStr: '' };
  }
}

/** 统一媒体窗口（秒级，body = 正剧段，source = 原素材坐标）。
 * 由 resolveForMedia 的 ResolvedTrim 派生，是所有「源头裁剪」消费方（ASR / 抽帧 / 分离 / 人脸 / 场景）的唯一下游入口。
 * 坐标换算：bodySec = sourceSec - offsetSec；sourceSec = bodySec + offsetSec */
export interface MediaWindow {
  /** 源素材 → body 窗口的时间偏移（= trimStartSec），body 坐标加回该值即源坐标 */
  offsetSec: number;
  /** body 窗口起点（恒为 0，正剧从 0 开始） */
  startSec: number;
  /** body 窗口终点（= srcDuration - offset - trimEndSec）；srcDuration 未知时为 undefined */
  endSec?: number;
  /** 正剧时长（= endSec - startSec），仅 endSec 已知时存在 */
  durationSec?: number;
  /** 源素材总时长（秒） */
  srcDurationSec?: number;
  /** 源坐标 → body 坐标 */
  toBody(sourceSec: number): number;
  /** body 坐标 → 源坐标 */
  toSource(bodySec: number): number;
}

/**
 * 由 ResolvedTrim 派生统一窗口（SSOT 派生函数）。
 * 任何消费方不要自行换算 trimStartMs/trimEndMs，统一走本窗口。
 */
export function toMediaWindow(trim: ResolvedTrim): MediaWindow {
  const offsetSec = Math.max(0, Number(trim.trimStartMs) || 0) / 1000;
  const srcDurationSec = trim.srcDurationMs !== undefined ? Math.max(0, Number(trim.srcDurationMs) || 0) / 1000 : undefined;
  const endSec = srcDurationSec !== undefined
    ? Math.max(0, srcDurationSec - offsetSec - (Math.max(0, Number(trim.trimEndMs) || 0)) / 1000)
    : undefined;
  const w: MediaWindow = {
    offsetSec,
    startSec: 0,
    endSec,
    durationSec: endSec !== undefined ? Math.max(0, endSec - 0) : undefined,
    srcDurationSec,
    toBody: (s: number) => Math.max(0, s - offsetSec),
    toSource: (b: number) => b + offsetSec,
  };
  return w;
}

/**
 * 输入断言（防二次平移，缺陷 D3）：expectSource=true 且命中嫌疑时抛错。
 * @param suspect 返回 true 表示输入坐标疑似已是 body 坐标（落在 OP 区内）
 */
function assertSourceCoord(expectSource: boolean | undefined, count: number, suspect: () => boolean): void {
  if (!expectSource || count === 0) return;
  if (suspect()) {
    throw new Error(
      '[MediaTrimPolicy] 坐标系契约（模式 A）违反：输入坐标疑似已是 body 坐标，禁止二次平移。' +
      '要求输入为源坐标（源时间轴绝对位置），请检查上游是否已调用过 applyToShots/applyToChunks 或回写时未还原源坐标。'
    );
  }
}

/** 裁剪 shots 数组：秒级 start/end 时间戳平移（start -= trimStartMs/1000）+ OP 段丢弃 + ED 段丢弃 */
export function applyToShots<T extends { start: number; end: number }>(
  shots: T[],
  opts: ResolvedTrim & ApplyTrimOptions & { srcDurationMs?: number }
): T[] {
  const { trimStartMs, trimEndMs, srcDurationMs } = opts;
  if (!trimStartMs && !trimEndMs) return shots;
  const trimStartSec = trimStartMs / 1000;
  assertSourceCoord(opts.expectSource, shots.length, () => {
    for (const s of shots) {
      if (s.start < trimStartSec - 0.05) return true; // 输入坐标落在 OP 区内 → 疑似已是 body 坐标
    }
    return false;
  });
  const effectiveMaxSec = typeof srcDurationMs === 'number'
    ? Math.max(0, srcDurationMs / 1000 - trimStartSec - trimEndMs / 1000)
    : Infinity;
  return shots
    .map(s => ({
      ...s,
      start: Math.max(0, s.start - trimStartSec),
      end: Math.max(0, s.end - trimStartSec),
    }))
    .filter(s => {
      if (s.end <= 0) return false;                  // 全落在 OP 区，丢掉
      if (effectiveMaxSec !== Infinity && s.start >= effectiveMaxSec) return false; // 全落在 ED 区，丢掉
      if (effectiveMaxSec !== Infinity) {
        // 部分跨 ED 边界，截断
        if (s.end > effectiveMaxSec) (s as any).end = effectiveMaxSec;
      }
      return s.end - s.start > 0.05; // 残留 <50ms 的无意义片段丢弃
    });
}

/**
 * 裁剪 chunks + matchSegments：毫秒级 startMs/endMs 平移，OP/ED 段过滤，
 *   并返回缓存指纹（写入 video_chunks v3 版本中避免缓存与 trim 值错配）。
 * 支持任意形状 chunk：只要含 startMs/endMs 数字字段就行（Layer1 chunks / Layer2 matchSegments 都兼容）
 *
 * 🎯 关键词内容保护（ContentGuard）：
 *   对含「牌匾/裂开/老字号」等强视觉关键词的 chunk，即使完全落在 OP 尾部或 ED 头部，
 *   只要与 body 窗口距离 < PROTECT_OP_EDGE_MS（默认 5s），也保留并平移进 body 区，
 *   避免 OP/ED 误判导致关键镜头被批量删除（如牌匾裂开恰好落在 OP 结尾 2s 内）。
 */
export function applyToChunks<C extends { startMs: number | string; endMs: number | string; description?: string; keywords?: string[] | string }>(
  chunks: C[],
  opts: ResolvedTrim & ApplyTrimOptions & { srcDurationMs?: number; protectKeywords?: boolean }
): { chunks: C[]; trimFingerprint: string } {
  const { trimStartMs, trimEndMs, srcDurationMs, protectKeywords = true } = opts;
  const fingerprint = `trim_s${trimStartMs}_e${trimEndMs}`;
  if (!trimStartMs && !trimEndMs) return { chunks, trimFingerprint: fingerprint };
  assertSourceCoord(opts.expectSource, chunks.length, () => {
    for (const c of chunks) {
      if (Number(c.startMs) < trimStartMs - 50) return true; // 输入坐标落在 OP 区内 → 疑似已是 body 坐标
    }
    return false;
  });
  const effectiveMaxMs = typeof srcDurationMs === 'number'
    ? Math.max(0, srcDurationMs - trimStartMs - trimEndMs)
    : Infinity;

  /** 关键词内容保护：OP 结尾 PROTECT_OP_EDGE_MS 内的关键 chunk 不删，ED 开头同理
   *  🎯 2026-08-23 从 5s → 15s：实测项目「26年8月21日(1)」OP=77.77s，
   *    chunk_002（65.2-71.6s，手指抚摸牌匾裂纹）距 OP 结束点约 6.17s，5s 保护带漏了它。
   *    扩大到 15s 覆盖「OP 末尾厂标/鸣谢字幕+正剧开头衔接镜头」的常见宽度，
   *    代价是极少数「OP 15s 内恰好出现与正剧关键词同名的纯片头 logo 画面」
   *    会被误保留 —— 但 KM 算法的语义+时长联合打分足以把它排到最后，不会影响匹配结果。 */
  const PROTECT_OP_EDGE_MS = 15000; // OP 尾部 15s 内的关键词 chunk 保留
  const PROTECT_ED_EDGE_MS = 10000; // ED 头部 10s 内的关键词 chunk 保留（ED 侧误判风险更低，10s 足够）
  /** 强视觉关键词命中判定（同步更新 timeline_solver.py 和 preselectTopK 的 KEYWORD_BOOST_PAIRS） */
  const KEYWORD_REGEX = /牌匾|招牌|匾额|老字号|鼎庆楼|门匾|裂|劈开|裂开|劈成|破碎|摔碎|碎裂|一劈为二|裂纹|断裂|折裂|手指|抚摸|触碰|摩挲|光荣|荣耀|辉煌|往昔|鼎盛/;
  const hasKeyContent = (c: C): boolean => {
    if (!protectKeywords) return false;
    const desc = String(c.description || '').trim();
    let kws: string[] = [];
    if (Array.isArray(c.keywords)) kws = c.keywords as string[];
    else if (typeof c.keywords === 'string') kws = [c.keywords];
    const allText = desc + ' ' + kws.join(' ');
    return KEYWORD_REGEX.test(allText);
  };

  const shifted = chunks
    .map((c) => {
      const s = Number(c.startMs) || 0;
      const e = Number(c.endMs) || s;
      // 先平移到 body 坐标系
      let ns = Math.max(0, s - trimStartMs);
      let ne = Math.max(0, e - trimStartMs);
      if (effectiveMaxMs !== Infinity && ne > effectiveMaxMs) ne = effectiveMaxMs;

      // 🎯 关键词内容保护逻辑
      const isProtected = hasKeyContent(c);
      if (isProtected) {
        // 情形 A：原始 chunk 与 OP 结束点距离 < PROTECT_OP_EDGE_MS 且原本会被判定为全落在 OP 区
        // （原始 endMs 靠近 trimStartMs，但在其左边，平移后 ne<=0）→ 强行把它拉进 body 区，
        // 保留原始时长，起点设为 0（相当于把 OP 末尾这段"视为正剧开头"）
        if (ne <= 0 && e >= (trimStartMs - PROTECT_OP_EDGE_MS)) {
          const dur = e - s;
          ns = 0;
          ne = Math.max(dur, 50); // 至少保留 50ms，防止被后续 50ms 门限过滤
          if (effectiveMaxMs !== Infinity && ne > effectiveMaxMs) ne = effectiveMaxMs;
        }
        // 情形 B：原始 chunk 与 ED 开始点距离 < PROTECT_ED_EDGE_MS 且原本会被判定为全落在 ED 区
        // （s - trimStartMs >= effectiveMaxMs）→ 类似处理，终点设为 effectiveMaxMs
        if (effectiveMaxMs !== Infinity && ns >= effectiveMaxMs) {
          const edStartSrc = (typeof srcDurationMs === 'number' ? srcDurationMs : 0) - trimEndMs;
          if (s <= edStartSrc + PROTECT_ED_EDGE_MS) {
            const dur = e - s;
            ne = effectiveMaxMs;
            ns = Math.max(0, ne - dur);
          }
        }
      }

      return { ...(c as any), startMs: ns, endMs: ne, _contentProtected: isProtected };
    })
    .filter((c: any) => {
      const s = Number(c.startMs) || 0;
      const e = Number(c.endMs) || 0;
      if (e <= 0) return false;
      if (s >= effectiveMaxMs) return false;
      return e - s > 50; // 残留 <50ms 丢弃
    }) as C[];
  return { chunks: shifted, trimFingerprint: fingerprint };
}

/** 构建 trim 指纹（外部调用，不用跑 applyToChunks([])） */
export function buildTrimFingerprint(trim: ResolvedTrim): string {
  return `trim_s${Math.max(0, Math.round(Number(trim.trimStartMs) || 0))}_e${Math.max(0, Math.round(Number(trim.trimEndMs) || 0))}`;
}

/** P2 指纹对齐结果 */
export interface ChromaprintAlignResult {
  /** 相对窗口起点的偏移段数（front=target 起点偏移，tail 见内部换算） */
  offsetSec: number;
  /** 连续匹配段数 */
  matchedCount: number;
  /** 0~1 置信度 */
  confidence: number;
  /** mode='front'：目标 OP 结束建议值（毫秒） */
  suggestedTrimStartMs?: number;
  /** mode='tail'：目标 ED 长度建议值（毫秒，即尾部裁剪量） */
  suggestedTrimEndMs?: number;
}

/**
 * P2 指纹对齐工具（纯函数，跨素材比较连续指纹段）。
 * 指纹 = librosa chroma 12 维 L2 归一化向量（每段一个数组）。
 * · mode='front'：取 anchor/target 前 90s 窗口，做「最长公共前缀」匹配（允许 ±2 段 logo 容差），
 *    公共前缀长度 → 目标 OP 结束点 suggestedTrimStartMs = (target 内匹配终点 index) * segmentSec * 1000。
 * · mode='tail'：anchor/target 尾部 90s 窗口反转后做同款前缀匹配（最长公共后缀），
 *    尾部匹配长度 → 目标 ED 长度 suggestedTrimEndMs = (窗口段数 - 匹配终点 index) * segmentSec * 1000。
 *   对称模型假设同 IP 各集 ED 主题曲相同且贴片尾，因此无需知道锚点绝对时长。
 * 段间相似度用余弦（向量已归一化 → 直接点积），>= simThreshold 算命中。
 * 返回 null 表示匹配段数不足（疑似不同 IP / OP 重剪 / ED 不同）。
 */
export function alignChromaprint(opts: {
  anchorSegments: number[][];
  targetSegments: number[][];
  mode?: 'front' | 'tail';
  segmentSec?: number;
  minMatchCount?: number;
  simThreshold?: number;
}): ChromaprintAlignResult | null {
  const { anchorSegments, targetSegments, mode = 'front', segmentSec = 2, minMatchCount = 5, simThreshold = 0.72 } = opts;
  if (!Array.isArray(anchorSegments) || !anchorSegments.length || !Array.isArray(targetSegments) || !targetSegments.length) return null;
  // tail 模式：反转数组，复用 front 的「最长公共前缀」逻辑
  const A = mode === 'tail' ? [...anchorSegments].reverse() : anchorSegments;
  const B = mode === 'tail' ? [...targetSegments].reverse() : targetSegments;
  const cosSim = (a: number[], b: number[]) => {
    if (!a || !b || a.length !== b.length) return 0;
    let d = 0;
    for (let i = 0; i < a.length; i++) d += (a[i] ?? 0) * (b[i] ?? 0);
    return d;
  };
  // 最长公共前缀：A[0] 与 B[shift] 起，逐段连续命中；shift ∈ [-2, 2]（±4s 覆盖 logo/厂标差异）
  let bestRun = -1, bestShift = 0;
  for (let shift = -2; shift <= 2; shift++) {
    let run = 0;
    for (let i = 0; i < A.length; i++) {
      const j = i + shift;
      if (j < 0 || j >= B.length) break;
      if (cosSim(A[i], B[j]) >= simThreshold) run++;
      else break;
    }
    if (run > bestRun) { bestRun = run; bestShift = shift; }
  }
  if (bestRun < minMatchCount) return null;
  const conf = Math.min(0.99, 0.55 + (bestRun / Math.min(A.length, B.length)) * 0.45);
  if (mode === 'tail') {
    // 尾部窗口内 ED 起点 index（原始方向）= 窗口段数 - 匹配终点（反转方向 index）
    const endIdxRev = bestShift + bestRun;
    const startIdxRaw = Math.max(0, targetSegments.length - endIdxRev);
    const suggestedTrimEndMs = Math.max(0, Math.round(startIdxRaw * segmentSec * 1000));
    return { offsetSec: bestShift * segmentSec, matchedCount: bestRun, confidence: conf, suggestedTrimEndMs };
  }
  const endIdx = Math.max(0, bestShift + bestRun);
  const suggestedTrimStartMs = Math.max(0, Math.round(endIdx * segmentSec * 1000));
  return { offsetSec: bestShift * segmentSec, matchedCount: bestRun, confidence: conf, suggestedTrimStartMs };
}
