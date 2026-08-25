/**
 * opEdOrchestrator.ts — OP/ED 自动识别编排器（P1→P2 两级流水线，Node 主进程纯逻辑）
 *
 * 入口（供 IPC / 前端按钮调用）：
 *   ├─ runFullDetectPipeline(projectId, mediaId, mediaPath)
 *   │     1) P1_FFMPEG_HEURISTIC：黑场+静音启发（前/后 5 分钟扫）
 *   │     2) P2_CHROMAPRINT_ALIGN：查该项目"其他已配置素材"，取锚点指纹对齐当前素材（0 成本，优先级最高 0.98）
 *   │     3) 汇总 → applyDetectionResult 按优先级/手动锁更新 mediaTrim → 写 DB（projects.extraction_config.mediaTrim）
 *   │     返回：{ config, steps, finalTrim, isLocked }
 *   │
 *   ├─ toggleManualLock(projectId, mediaId, locked)
 *   │     切换手动锁定，手动锁定后自动结果不再覆盖
 *   │
 *   └─ acceptSuggestion(projectId, mediaId, historyIndex)
 *         用户点"接受建议"：把 detectionHistory[index] 以 USER_MANUAL 身份再 apply 一次（必然 adopted=true，并开手动锁）
 *
 * 设计取舍：自动识别置信度低于 MIN_AUTO_CONFIDENCE 时不生效，仅作为"待确认建议"写入 history，
 *   识别不可靠的场景交给用户手动选择（前端候选点一键采纳 / 手动输入 + 锁定）。无 P3 VLM 兜底。
 */
import { AIDaemon } from '../core/AIDaemon';
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '@modules/infra/logger/LogConstants';
import {
  MediaTrimConfig,
  parseMediaTrimConfig,
  applyDetectionResult,
  setManualLock,
  writeMediaTrimToProject,
  isManualLocked,
  resolveMediaTrim,
  getDetectionHistory,
  alignChromaprint,
} from './utils/MediaTrimPolicy';
import { SQLiteConnection } from '../database/core/SQLiteConnection';

const TAG = 'OpEdOrchestrator';

/**
 * 自动识别结果的最低生效置信度阈值。
 * 低于该值的 P1 兜底结果只写入 detectionHistory（adopted=false）作"待确认建议"，
 * 不更新 trim 值 → 避免误判污染 chunks 平移与 ASR 对齐。
 */
const MIN_AUTO_CONFIDENCE = 0.6;

export interface OpEdDetectStepResult {
  source: 'P1_FFMPEG_HEURISTIC' | 'P2_CHROMAPRINT_ALIGN';
  ok: boolean;
  trimStartMs?: number;
  trimEndMs?: number;
  confidence?: number;
  note?: string;
  anchorMediaId?: string;
  error?: string;
  /** P1 启发式 Top3 候选时间点（秒）：自动结果不可靠时供前端展示"候选点一键采纳" */
  opCandidates?: Array<{ sec: number; score: number }>;
  edCandidates?: Array<{ sec: number; score: number }>;
  raw?: any;
}

export interface OpEdDetectPipelineResult {
  projectId: string;
  mediaId: string;
  isLockedBefore: boolean;
  isLockedAfter: boolean;
  steps: OpEdDetectStepResult[];
  finalTrim: { trimStartMs: number; trimEndMs: number };
  finalConfig: MediaTrimConfig;
  history: ReturnType<typeof getDetectionHistory>;
  written: boolean;
  writeError?: string;
}

/** 从 DB 拿当前 mediaTrim 配置（解析好的对象） */
function readCurrentTrimConfig(projectId: string): { cfg: MediaTrimConfig; root: any } {
  const db = SQLiteConnection.getInstance().getDB();
  const row = db.prepare('SELECT extraction_config FROM projects WHERE id = ? AND is_deleted = 0').get(projectId) as any;
  let root: any = {};
  try { root = row?.extraction_config ? (typeof row.extraction_config === 'string' ? JSON.parse(row.extraction_config) : row.extraction_config) : {}; }
  catch { root = {}; }
  return { cfg: parseMediaTrimConfig(root.mediaTrim), root };
}

/**
 * 同项目内找「P2 指纹锚点素材」：
 *   该素材不能是当前 mediaId 本身；
 *   且已有 detectionHistory 中一条 adopted=true & adopted by P1/P2/USER_MANUAL 来源 & confidence>=0.8；
 *   找到就返回它的 { mediaId, trimStartMs }，没有就 null
 */
function pickAnchorMedia(projectId: string, selfMediaId: string): { mediaId: string; trimStartMs: number; trimEndMs: number } | null {
  const { cfg } = readCurrentTrimConfig(projectId);
  if (!cfg.perMedia) return null;
  for (const [mid, val] of Object.entries(cfg.perMedia)) {
    if (mid === selfMediaId) continue;
    const history = val.detectionHistory ?? [];
    const anchor = [...history].reverse().find(r => r.adopted && r.confidence >= 0.8) || null;
    if (anchor && anchor.trimStartMs >= 3000) return { mediaId: mid, trimStartMs: anchor.trimStartMs, trimEndMs: anchor.trimEndMs };
    // 兜底：该素材的 manualOverride 锁定了且 trimStartMs>=3s 也算
    if (val.manualOverride?.enabled && (val.trimStartMs || 0) >= 3000) {
      return { mediaId: mid, trimStartMs: val.trimStartMs || 0, trimEndMs: val.trimEndMs || 0 };
    }
  }
  return null;
}

/**
 * 步骤 P1：黑场+静音启发
 */
async function stepP1(filePath: string): Promise<OpEdDetectStepResult> {
  try {
    const res = await AIDaemon.getInstance().post('/api/media/detect_op_ed', {
      file_path: filePath,
      search_window_sec: 300,
      /** ✅ OP/ED 最短长度 25s（片头曲中间 17s 那种 logo/转场黑场直接被过滤，不再误判成 OP 结尾） */
      min_theme_duration_sec: 25,
      max_theme_duration_sec: 180,
    }, { timeout: 180_000 });
    const r: any = res?.data ?? res ?? {};
    if (!r || r.success === false) return { source: 'P1_FFMPEG_HEURISTIC', ok: false, error: r?.error || 'P1 fail' };
    const op = Math.max(0, Math.round(Number(r.trim_start_ms ?? (r.op_end_sec ? r.op_end_sec * 1000 : 0))));
    const ed = Math.max(0, Math.round(Number(r.trim_end_ms ?? 0)));
    const conf = Number(Math.min(0.99, Math.max(0,
      (Number(r.op_confidence ?? 0.3) + Number(r.ed_confidence ?? 0.3)) / 2
    ))).toFixed(3);
    let note = `OP=${(op / 1000).toFixed(1)}s(置信 ${r.op_confidence ?? '-'}) / ED=${(ed / 1000).toFixed(1)}s(置信 ${r.ed_confidence ?? '-'})`;
    if (typeof r.credits_start_sec === 'number' && r.credits_start_sec !== null) {
      note += ` · 电影credits起点 ${r.credits_start_sec}s(置信 ${r.credits_confidence ?? '-'})${r.credits_confidence && r.credits_confidence > (Number(r.ed_confidence) || 0) ? '→已采信为ED' : ''}`;
    }
    if (r.raw_signals) {
      const fbs = (r.raw_signals.front_blacks || []).length;
      const fss = (r.raw_signals.front_silences || []).length;
      note += ` · 黑场信号 OP区${fbs} / ED区${(r.raw_signals.tail_blacks || []).length}；静音 OP区${fss} / ED区${(r.raw_signals.tail_silences || []).length}`;
    }
    return {
      source: 'P1_FFMPEG_HEURISTIC',
      ok: true,
      trimStartMs: op,
      trimEndMs: ed,
      confidence: parseFloat(conf),
      note,
      // ✅ 透传 P1 的 Top3 候选点：自动结果不可靠时，前端可展示"候选时间点"供用户一键采纳（手动选择衔接）
      opCandidates: Array.isArray(r.op_candidates) ? r.op_candidates.map((c: any) => ({ sec: Number(c?.[0]), score: Number(c?.[1] ?? 0) })).filter((c: any) => isFinite(c.sec)) : [],
      edCandidates: Array.isArray(r.ed_candidates) ? r.ed_candidates.map((c: any) => ({ sec: Number(c?.[0]), score: Number(c?.[1] ?? 0) })).filter((c: any) => isFinite(c.sec)) : [],
      raw: { fromCache: !!r.fromCache, duration_sec: r.duration_sec },
    };
  } catch (e: any) {
    return { source: 'P1_FFMPEG_HEURISTIC', ok: false, error: `${e.name || 'Error'}: ${e.message}` };
  }
}

/** 取一段 chroma 指纹（12 维向量数组）；startSec<0 表示距片尾 |startSec| 秒 */
async function fetchChroma(filePath: string, startSec: number, durationSec: number): Promise<number[][]> {
  const res = await AIDaemon.getInstance().post('/api/media/chromaprint', {
    file_path: filePath, start_sec: startSec, duration_sec: durationSec, segment_sec: 2,
  }, { timeout: 120_000 });
  const segs = (res?.data?.segments || res?.segments || []);
  return Array.isArray(segs) ? segs : [];
}

/**
 * 步骤 P2：跨集指纹对齐（OP + ED 双端）
 *   1) front：target/anchor 前 90s 指纹做最长公共前缀匹配 → OP 结束点 trimStartMs
 *   2) tail：target/anchor 尾部 90s 指纹做最长公共后缀匹配 → ED 长度 trimEndMs
 *   ED 对齐失败（本集 ED 与锚点不同等）时仅返回 OP 结果，trimEndMs=0 交给 P1 兜底。
 */
async function stepP2(
  filePath: string,
  anchor: { mediaId: string; trimStartMs: number },
  projectId: string
): Promise<OpEdDetectStepResult> {
  try {
    // 锚点素材文件路径
    const db = SQLiteConnection.getInstance().getDB();
    const aRow = db.prepare("SELECT file_path FROM media_assets WHERE id = ? AND is_deleted = 0 LIMIT 1").get(anchor.mediaId) as any;
    if (!aRow?.file_path) return { source: 'P2_CHROMAPRINT_ALIGN', ok: false, error: `anchor media(${anchor.mediaId}) path not found` };
    // 并行取 4 组指纹：target/anchor × front(0~90s)/tail(-90~末尾)
    const [targetF, anchorF, targetT, anchorT] = await Promise.all([
      fetchChroma(filePath, 0, 90),
      fetchChroma(aRow.file_path, 0, 90),
      fetchChroma(filePath, -90, 90),
      fetchChroma(aRow.file_path, -90, 90),
    ]);
    if (!targetF.length || !anchorF.length) {
      return { source: 'P2_CHROMAPRINT_ALIGN', ok: false, error: 'chromaprint empty (target/anchor front)', raw: { targetF: targetF.length, anchorF: anchorF.length, projectId } };
    }
    // 3) OP 对齐（front）：同 IP 各集 OP 相同 → 公共前缀即 OP 段
    const opAlign = alignChromaprint({
      anchorSegments: anchorF, targetSegments: targetF, mode: 'front', segmentSec: 2, minMatchCount: 5,
    });
    if (!opAlign || opAlign.suggestedTrimStartMs === undefined) {
      return {
        source: 'P2_CHROMAPRINT_ALIGN', ok: false,
        error: `指纹对齐失败：anchor(${anchor.mediaId.slice(-10)})×target 连续匹配段<5（疑似不同 IP/OP 重剪）`,
        raw: { anchorCount: anchorF.length, targetCount: targetF.length, projectId },
      };
    }
    // 4) ED 对齐（tail）：尾部滚动段/ED 主题曲最长公共后缀
    let trimEndMs = 0;
    let edNote = 'ED 尾部未匹配（依赖 P1）';
    let confFactor = 0.9;
    if (targetT.length && anchorT.length) {
      const edAlign = alignChromaprint({
        anchorSegments: anchorT, targetSegments: targetT, mode: 'tail', segmentSec: 2, minMatchCount: 5,
      });
      if (edAlign && edAlign.suggestedTrimEndMs !== undefined && edAlign.suggestedTrimEndMs > 0) {
        trimEndMs = edAlign.suggestedTrimEndMs;
        edNote = `ED 尾部匹配 ${edAlign.matchedCount} 段 → ED=${(trimEndMs / 1000).toFixed(1)}s(置信 ${edAlign.confidence.toFixed(2)})`;
        confFactor = 1.0;
      }
    }
    const confidence = Math.min(0.99, Number((opAlign.confidence * confFactor).toFixed(3)));
    return {
      source: 'P2_CHROMAPRINT_ALIGN',
      ok: true,
      trimStartMs: opAlign.suggestedTrimStartMs,
      trimEndMs,
      confidence,
      anchorMediaId: anchor.mediaId,
      note: `OP 指纹匹配 ${opAlign.matchedCount} 段(相对偏移 ${opAlign.offsetSec >= 0 ? '+' : ''}${opAlign.offsetSec.toFixed(1)}s) → OP=${(opAlign.suggestedTrimStartMs / 1000).toFixed(1)}s；${edNote}`,
      raw: { offsetSec: opAlign.offsetSec, opMatched: opAlign.matchedCount, edMatched: trimEndMs > 0 ? Math.round(trimEndMs / 2000) : 0, anchorCount: anchorF.length, targetCount: targetF.length, projectId },
    };
  } catch (e: any) {
    return { source: 'P2_CHROMAPRINT_ALIGN', ok: false, error: `${e.name || 'Error'}: ${e.message}` };
  }
}

/**
 * 运行完整 OP/ED 自动识别编排。
 * 返回所有步骤结果 + 最终配置 + 是否写入 DB。
 */
export async function runFullDetectPipeline(projectId: string, mediaId: string, mediaPath: string): Promise<OpEdDetectPipelineResult> {
  AppLogger.info(LOG_TAGS.OPED_DETECT_AUTO, `[${TAG}] 🚀 OP/ED 自动识别编排开始 project=${projectId.slice(-10)} media=${mediaId.slice(-12)}`);
  const { cfg: beforeCfg, root } = readCurrentTrimConfig(projectId);
  const lockedBefore = isManualLocked(beforeCfg, mediaId);
  const steps: OpEdDetectStepResult[] = [];
  let workingCfg: MediaTrimConfig = JSON.parse(JSON.stringify(beforeCfg));

  // Step 1: P1 黑场+静音
  const p1 = await stepP1(mediaPath);
  steps.push(p1);
  if (p1.ok && typeof p1.trimStartMs === 'number') {
    workingCfg = applyDetectionResult(workingCfg, mediaId, {
      source: 'P1_FFMPEG_HEURISTIC',
      trimStartMs: p1.trimStartMs, trimEndMs: p1.trimEndMs || 0,
      confidence: p1.confidence ?? 0.6,
      note: p1.note,
    }, { minConfidenceForAutoAccept: MIN_AUTO_CONFIDENCE });
  }

  // Step 2: P2 指纹对齐（同项目有锚点才跑）
  const anchor = pickAnchorMedia(projectId, mediaId);
  let p2: OpEdDetectStepResult | null = null;
  if (anchor) {
    p2 = await stepP2(mediaPath, anchor, projectId);
    steps.push(p2);
    if (p2.ok && typeof p2.trimStartMs === 'number') {
      workingCfg = applyDetectionResult(workingCfg, mediaId, {
        source: 'P2_CHROMAPRINT_ALIGN',
        trimStartMs: p2.trimStartMs, trimEndMs: p2.trimEndMs || p1.trimEndMs || 0,
        confidence: p2.confidence ?? 0.95,
        note: p2.note,
        anchorMediaId: p2.anchorMediaId,
      }, { minConfidenceForAutoAccept: MIN_AUTO_CONFIDENCE });
    }
  } else {
    steps.push({
      source: 'P2_CHROMAPRINT_ALIGN', ok: false,
      note: '该项目暂无已配置锚点素材，跳过 P2 指纹对齐（首集/单素材场景无锚点）',
    });
  }

  // Step 3: 写入 DB
  let written = false, writeError: string | undefined;
  const writeRes = writeMediaTrimToProject(projectId, workingCfg, root);
  if (writeRes.ok) written = true;
  else writeError = writeRes.error || 'write fail';

  const afterCfg = parseMediaTrimConfig(JSON.parse(JSON.stringify(workingCfg)));
  const finalTrim = resolveMediaTrim(afterCfg, mediaId);
  const lockedAfter = isManualLocked(afterCfg, mediaId);
  AppLogger.info(LOG_TAGS.OPED_TRIM, `[${TAG}] 编排完成: 步骤=${steps.filter(x => x.ok).length}/${steps.length}  生效 OP=${finalTrim.trimStartMs}ms ED=${finalTrim.trimEndMs}ms  写入=${written}  ${lockedAfter ? '(用户手动锁定)' : ''}`);
  return {
    projectId, mediaId,
    isLockedBefore: lockedBefore, isLockedAfter: lockedAfter,
    steps, finalTrim, finalConfig: afterCfg,
    history: getDetectionHistory(afterCfg, mediaId),
    written, writeError,
  };
}

/**
 * 切换手动锁定。锁定后自动检测结果不再覆盖；解锁后再次检测会自动回填。
 */
export async function toggleManualLock(
  projectId: string, mediaId: string, locked: boolean, opts?: { by?: string }
): Promise<{ ok: boolean; isLockedNow: boolean; finalTrim: { trimStartMs: number; trimEndMs: number }; error?: string }> {
  const { cfg, root } = readCurrentTrimConfig(projectId);
  const nextCfg = setManualLock(cfg, mediaId, locked, opts);
  const w = writeMediaTrimToProject(projectId, nextCfg, root);
  if (!w.ok) return { ok: false, isLockedNow: isManualLocked(cfg, mediaId), finalTrim: resolveMediaTrim(cfg, mediaId), error: w.error };
  const latestCfg = parseMediaTrimConfig(JSON.parse(JSON.stringify(nextCfg)));
  return { ok: true, isLockedNow: isManualLocked(latestCfg, mediaId), finalTrim: resolveMediaTrim(latestCfg, mediaId) };
}

/**
 * 用户点"接受建议"：取 detectionHistory[index] 或以外部字面量形式直接给一个 USER_MANUAL 建议值，并开启手动锁。
 * 兼容两种 historySpec：
 *   · number（0-based 历史索引）→ 取对应历史记录以 USER_MANUAL 身份重写
 *   · { trimStartMs, trimEndMs, confidence?, note? }（前端「保存手动值」按钮发送） → 直接按 USER_MANUAL 身份写入最新建议并锁值
 */
export async function acceptSuggestion(
  projectId: string,
  mediaId: string,
  historySpec: number | { trimStartMs: number; trimEndMs: number; confidence?: number; note?: string },
  opts?: { by?: string }
): Promise<{ ok: boolean; finalTrim: { trimStartMs: number; trimEndMs: number }; error?: string }> {
  const { cfg, root } = readCurrentTrimConfig(projectId);
  const sourceTrim: { trimStartMs: number; trimEndMs: number; confidence: number; note: string } =
    typeof historySpec === 'number'
      ? (() => {
          const history = getDetectionHistory(cfg, mediaId);
          if (historySpec < 0 || historySpec >= history.length) {
            // out of range：抛错交由上层返回，这里返回 -1 标记
            return { trimStartMs: -1, trimEndMs: -1, confidence: 0, note: `history index out of range: ${historySpec}/${history.length}` };
          }
          const rec = history[historySpec];
          return {
            trimStartMs: rec.trimStartMs,
            trimEndMs: rec.trimEndMs,
            confidence: 1.0,
            note: `用户接受建议: 原来源=${rec.source}（原置信 ${rec.confidence}）· ${rec.note || ''}`.slice(0, 200),
          };
        })()
      : {
          trimStartMs: Math.max(0, Math.round(Number(historySpec.trimStartMs || 0))),
          trimEndMs: Math.max(0, Math.round(Number(historySpec.trimEndMs || 0))),
          confidence: Math.min(1, Math.max(0, Number(historySpec.confidence ?? 1))),
          note: typeof historySpec.note === 'string' && historySpec.note.trim() ? historySpec.note.slice(0, 200) : '用户手动输入裁剪值并保存',
        };

  if (sourceTrim.trimStartMs < 0) {
    return { ok: false, finalTrim: resolveMediaTrim(cfg, mediaId), error: sourceTrim.note };
  }

  // 以 USER_MANUAL 身份应用（优先级最高，必然 adopted=true）
  let nextCfg = applyDetectionResult(cfg, mediaId, {
    source: 'USER_MANUAL',
    trimStartMs: sourceTrim.trimStartMs,
    trimEndMs: sourceTrim.trimEndMs,
    confidence: sourceTrim.confidence || 1.0,
    note: sourceTrim.note,
  });
  // 开启手动锁（接受建议 = 用户确认值，不会再被自动覆盖）
  nextCfg = setManualLock(nextCfg, mediaId, true, opts);
  const w = writeMediaTrimToProject(projectId, nextCfg, root);
  if (!w.ok) return { ok: false, finalTrim: resolveMediaTrim(cfg, mediaId), error: w.error };
  return { ok: true, finalTrim: resolveMediaTrim(parseMediaTrimConfig(nextCfg), mediaId) };
}

/**
 * 前端初始加载：读取当前素材的 trim 配置 + 手动锁 + 历史（无需跑编排）
 */
export function getMediaTrimState(projectId: string, mediaId: string) {
  const { cfg } = readCurrentTrimConfig(projectId);
  return {
    locked: isManualLocked(cfg, mediaId),
    trim: resolveMediaTrim(cfg, mediaId),
    history: getDetectionHistory(cfg, mediaId),
    config: cfg,
  };
}
