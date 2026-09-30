/**
 * FrameRecallService — 步骤5 **帧级召回 → 上卷镜头候选**（P2 索引 + P3 召回）
 *
 * 定位（spec §4.3 第 1/2 步）：把匹配单元的语义来源从「段复制镜头简介（两次降采样）」
 *   换成「帧释义零损耗召回 → 按归属镜头计票上卷」。核心动机：
 *   - 帧级能分辨**同一镜头内的不同瞬间**（切菜 / 洗碗），段级文本同一镜头内完全同分；
 *   - 上卷后得到的是「确实被命中的镜头清单」，而不是「把镜头简介抄一份到每段」。
 *
 * 检索方式（Q4 拍板）：**BGE 向量**。词袋（TF-IDF/字符袋）分不开同镜头内近邻语义，
 *   故帧释义与 query 都走 BGE 文本通道（`/api/embed_texts`，与 match_cost 语义主分同源）。
 *
 * 数据流：`ensureIndex` 只补缺失帧（复跑秒级命中，编码一次性）→ `recall` 载入本项目全量帧向量、
 *   对每句 query 求余弦、TopN 帧 → 按 chunkId 聚合（Q5：先取最高分）→ 逐句镜头候选白名单。
 *
 * 失败语义：编码通道不可用（daemon 未起 / 模型缺失）时**原样上抛**，由调用方决定是否 fail-fast
 *   —— 帧召回是候选取值的唯一来源，静默返回空集会让全片「匹配不到」并掩盖真实故障。
 */
import { AIDaemon } from '../../core/AIDaemon';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '@modules/infra/logger/LogConstants';
import {
  FrameIndexRepository,
  FRAME_INDEX_MODEL,
  type FrameIndexRecord,
} from '../../database/repositories/FrameIndexRepository';

/** 建索引输入：一帧一行的最小必需字段（归属镜头由调用方按 P0 归属链解析后给出） */
export interface FrameIndexSeed {
  frameHash: string;
  chunkId: string;
  timeMs: number;
  description: string;
}

/** 召回 query：句文案 + 画面意图 + 步骤3 真锚点释义（P1 产物） */
export interface FrameRecallQuery {
  shotId: string;
  text?: string;
  visualIntent?: string;
  refFrameDesc?: string;
}

/** 召回结果：一个候选镜头（= 上卷后的匹配单元） */
export interface ShotRecallHit {
  chunkId: string;
  /** 上卷计票：该镜头命中帧中的最高余弦分（Q5 先取最高分，后续可换累加+命中数加权） */
  score: number;
  /** 落进 TopN 帧集的该镜头帧数（判读覆盖强度） */
  hitCount: number;
  /** 最高分帧的身份：帧 hash + 源时间 —— 供 P4 作为取料入点 */
  bestFrameHash: string;
  bestTimeMs: number;
}

/** 召回参数 */
export interface FrameRecallOptions {
  /** 每句召回帧数（上卷前） */
  topFrames?: number;
  /** 每句上卷后保留的镜头数（写入 candidateIds 的白名单） */
  topShots?: number;
  /** 单次编码请求携带的文本数（控 HTTP 体积） */
  encodeBatch?: number;
}

/** 建索引统计 */
export interface FrameIndexBuildStats {
  total: number;
  reused: number;
  encoded: number;
}

/** query 拼接文本：与帧召回口径一致（句文案 + 画面意图 + 真锚点释义） */
export function buildFrameRecallQueryText(q: FrameRecallQuery): string {
  return [q.text || '', q.visualIntent || '', q.refFrameDesc || '']
    .map((s) => String(s).trim())
    .filter(Boolean)
    .join(' ');
}

export class FrameRecallService {
  /** 单次编码请求携带的文本数（BGE 内部仍按 32 分批，此处仅控 HTTP 单包体积） */
  private static readonly ENCODE_BATCH = 256;

  /**
   * 调用 daemon BGE 通道批量编码，返回 L2 归一化向量（余弦 == 点积）。
   * @param texts 待编码文本
   * @returns 与 texts 等长的向量数组（number[][]）
   */
  private static async encode(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += FrameRecallService.ENCODE_BATCH) {
      const chunk = texts.slice(i, i + FrameRecallService.ENCODE_BATCH);
      const res = await AIDaemon.getInstance().post('/api/embed_texts', { texts: chunk }, { timeout: 300000, retries: 0 });
      const vecs = (res && (res.vectors || (res.data && res.data.vectors))) || [];
      if (!Array.isArray(vecs) || vecs.length !== chunk.length) {
        throw new Error(`[FrameRecall] BGE 编码返回数量不符：期望 ${chunk.length}，实得 ${Array.isArray(vecs) ? vecs.length : 'non-array'}`);
      }
      for (const v of vecs) out.push(v as number[]);
    }
    return out;
  }

  /**
   * 建帧向量索引：只对「本项目域内尚未索引」的帧调用 BGE 编码（复跑秒级命中）。
   * @param seeds 帧行（frameHash/chunkId/timeMs/description）
   * @param projectId 项目 id
   * @param mediaId 素材 id
   * @returns 统计（total/reused/encoded）
   */
  static async ensureIndex(seeds: FrameIndexSeed[], projectId: string, mediaId: string): Promise<FrameIndexBuildStats> {
    const repo = new FrameIndexRepository();
    const total = seeds.length;
    if (total === 0) return { total: 0, reused: 0, encoded: 0 };

    /** 去重：同 hash 多帧（同画面）只留一条，先到先得 */
    const uniq = new Map<string, FrameIndexSeed>();
    for (const s of seeds) {
      if (!s.frameHash || !s.chunkId || !String(s.description || '').trim()) continue;
      if (!uniq.has(s.frameHash)) uniq.set(s.frameHash, s);
    }
    const rows = Array.from(uniq.values());
    const indexed = repo.getIndexedHashes(rows.map((r) => r.frameHash), projectId, mediaId);
    const missing = rows.filter((r) => !indexed.has(r.frameHash));
    if (missing.length === 0) {
      AppLogger.info(LOG_TAGS.AI_AGENT, `[FrameRecall] 帧向量索引全量命中：${rows.length}/${total}（复用=${rows.length}，编码=0，模型=${FRAME_INDEX_MODEL}）`);
      return { total, reused: rows.length, encoded: 0 };
    }

    const vecs = await FrameRecallService.encode(missing.map((r) => r.description));
    const records: FrameIndexRecord[] = missing.map((r, i) => ({
      frameHash: r.frameHash,
      chunkId: r.chunkId,
      projectId,
      mediaId,
      timeMs: r.timeMs,
      description: r.description,
      vec: vecs[i],
    }));
    const written = repo.batchSet(records);
    AppLogger.info(LOG_TAGS.AI_AGENT,
      `[FrameRecall] 帧向量索引构建：去重后 ${rows.length} 帧（原始 ${total}）｜复用 ${rows.length - missing.length}｜新编码落库 ${written}｜模型 ${FRAME_INDEX_MODEL}`);
    return { total, reused: rows.length - missing.length, encoded: written };
  }

  /**
   * 帧召回 + 上卷镜头候选。
   * @param queries 逐句召回 query（shotId + 文案 + visualIntent + refFrameDesc）
   * @param projectId 项目 id
   * @param mediaId 素材 id
   * @param opts topFrames/topShots
   * @returns shotId → 候选镜头（按上卷分降序）；无索引/空句返回空 Map
   */
  static async recall(
    queries: FrameRecallQuery[],
    projectId: string,
    mediaId: string,
    opts?: FrameRecallOptions,
  ): Promise<Map<string, ShotRecallHit[]>> {
    const result = new Map<string, ShotRecallHit[]>();
    const repo = new FrameIndexRepository();
    const frames = repo.queryByProject(projectId, mediaId);
    if (frames.length === 0) {
      AppLogger.warn(LOG_TAGS.AI_AGENT, `[FrameRecall] 本项目无帧向量索引（project=${projectId} media=${mediaId}）⇒ 帧召回返回空集`);
      return result;
    }
    /** 只对有效 query（拼接文本非空）编码，避免空串进 BGE */
    const usable = queries
      .map((q) => ({ q, text: buildFrameRecallQueryText(q) }))
      .filter((x) => x.text.length > 0);
    if (usable.length === 0) return result;

    const qVecs = await FrameRecallService.encode(usable.map((x) => x.text));
    const topFrames = Math.max(1, opts?.topFrames || 40);
    const topShots = Math.max(1, opts?.topShots || 24);

    usable.forEach((x, qi) => {
      const qv = qVecs[qi];
      /** 全局余弦打分（向量已 L2 归一化 ⇒ 点积即余弦） */
      const scored: { chunkId: string; frameHash: string; timeMs: number; score: number }[] = [];
      for (const f of frames) {
        const v = f.vec;
        let dot = 0;
        const n = Math.min(qv.length, v.length);
        for (let i = 0; i < n; i++) dot += qv[i] * v[i];
        scored.push({ chunkId: f.chunkId, frameHash: f.frameHash, timeMs: f.timeMs, score: dot });
      }
      scored.sort((a, b) => b.score - a.score);
      /** 上卷：按 chunkId 聚合，取最高分（Q5），并记命中帧数与最高分帧身份 */
      const byShot = new Map<string, ShotRecallHit>();
      for (const s of scored.slice(0, topFrames)) {
        const prev = byShot.get(s.chunkId);
        if (!prev) {
          byShot.set(s.chunkId, {
            chunkId: s.chunkId, score: s.score, hitCount: 1,
            bestFrameHash: s.frameHash, bestTimeMs: s.timeMs,
          });
        } else {
          prev.hitCount += 1;
          if (s.score > prev.score) {
            prev.score = s.score;
            prev.bestFrameHash = s.frameHash;
            prev.bestTimeMs = s.timeMs;
          }
        }
      }
      result.set(String(x.q.shotId), Array.from(byShot.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, topShots));
    });
    return result;
  }
}