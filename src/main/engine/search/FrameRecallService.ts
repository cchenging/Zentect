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
  type FrameIndexRow,
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
  /** 最高分帧的**帧级释义**（2026-10-21 方案 B）：供 daemon 打分侧做「帧描述并入」。
   *  动机（实测）：切片级描述会漏掉镜头内的关键瞬间 —— chunk_084 的切片描述是「女子手持黑色
   *  卡片夹」，而它某一帧的释义是「墙面展示合影照片」；只吃切片描述时，靠帧证据召回的镜头
   *  在打分侧拿不到任何支撑。 */
  bestFrameDesc?: string;
  /** 该镜头是否为「实体定向补召」新增（非语义召回所得）：打分侧据此决定是否吃帧描述 */
  entitySupplemented?: boolean;
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

/**
 * query 拼接文本：句文案 + 画面意图 + 真锚点释义。
 *
 * ⚠️ 这里**刻意重复拼接 visualIntent**：`q.text` 在 SemanticAnalyzeStrategy 已拼成
 *    `${正文} | ${visualIntent}`，故 VI 实际出现两次（与 daemon 语义主分只吃一次不同）。
 *    看似冗余，但 2026-10-10 端到端裁判 A/B（qwen3-vl-plus，64 单位 × 3 采样）实测：
 *    去掉这次重复拼接后均分反而下降（0.1328 → 0.1250，subject 0.4031 → 0.3078），
 *    ⇒ 重复拼接在帧召回里起「往画面意图方向拉」的作用，属实测有效、刻意保留，**勿当 bug 删除**。
 */
export function buildFrameRecallQueryText(q: FrameRecallQuery): string {
  /** 🔧 2026-10-19：移除 refFrameDesc 拼接。
   *  离线实证（本项目 442 帧向量 + bge-small-zh-v1.5 复算 P3 召回）：
   *  参考帧描述是「素材原本是什么画面」，把它拼进召回 query 会把该画面本身及其语义邻域
   *  硬拉进候选白名单，挤占真实候选名额。
   *  典型：seg_2 文案「越经不起一张照片的考验」，其 refFrameDesc=「旁人举手机拍照」
   *  → 选中「手指持握手机浏览屏幕评论」镜头；而该镜头在纯文案召回里只排第 42 名，
   *  本不该进 top-24。visualIntent 已足够表达目标画面，不再叠加来源画面描述。 */
  return [q.text || '', q.visualIntent || '']
    .map((s) => String(s).trim())
    .filter(Boolean)
    .join(' ');
}

// ============================================================================
// 🧩 实体定向补召（方案 A，2026-10-20）
//   问题（实测取证，已离线复现 P3 召回）：seg_2 文案「可越是甜到发腻的誓言，越经不起一张照片的考验。」
//   的帧召回 top-24 池里**一个照片镜头都没有** —— 池内 24 个全是「男女对话 + 情绪」近景。离线用本项目
//   787 条帧向量 + bge-small-zh-v1.5 复算的名次：chunk_084「墙面合影照片」第 48、chunk_195 第 115、
//   chunk_308 第 123、chunk_210「手持拍立得照片特写」第 130 ⇒ **全在召回池外**。
//   后果：后续一切排序手段（语义权重 / 属性阻尼 / 决胜带）都救不了它 —— 池外候选根本不参与打分。
//   根因：召回 query 是「文案 + VI」的长句，BGE 被整体语义（甜到发腻的誓言 / 氛围转向不安）主导，
//   「照片」这类**显式名词**被淹没。
//   做法：query 里命中词表的显式实体词 → 对帧描述做「包含该词」定向匹配 → 命中帧上卷成镜头，
//   **保底补进候选池**（另辟 ENTITY_RESERVED 席，不吃语义召回的席位；池总量恒 topShots 不变）。
//   零行为变化前提：query 未命中任何词表实体词 ⇒ 整段不启用（池与排序逐字节同旧）。
// ============================================================================

/** 实体词表：只收「画面上能被描述出来的具体物」；抽象名词/情绪词一律不入表（避免把池拉向无关镜头）。
 *  命中判据是**帧描述子串**——帧描述带「主体:/场景:/道具:/看点:」字段，实体词会如实落在文本里。 */
const FRAME_ENTITY_LEXICON: readonly string[] = [
  // 影像 / 纸本
  '照片', '相片', '拍立得', '合影', '贺卡', '报纸', '杂志', '卡片', '信封', '信纸', '日记',
  // 通信 / 数码
  '手机', '相机', '电话', '耳机',
  // 凭证 / 文书
  '证书', '票据', '机票', '车票', '登机牌', '护照', '合同', '文件', '名单', '病历', '超声',
  // 随身 / 容器
  '钱包', '现金', '钞票', '钥匙', '门卡', '行李箱', '行囊', '背包', '手提包', '礼物',
  // 餐饮 / 饰品 / 其它
  '酒杯', '酒瓶', '餐具', '咖啡', '戒指', '花束', '玫瑰', '口红', '眼镜', '手表', '药瓶', '绷带',
];

/** 判别力红线：该词命中帧数超过全池帧数的本比例 ⇒ 视为泛化词（如「手机」），不参与补召 */
const ENTITY_MAX_DF_RATIO = 0.05;

/** 候选池里为实体补召保留的最大席位数（只吃「语义召回没捞到」的镜头；已在池内者不占席） */
const ENTITY_RESERVED = 6;

/**
 * 从召回 query 文本里挑出「有判别力」的显式实体词。
 *
 * 判别力红线：该词在本片帧描述里的命中帧数必须落在 [1, ⌊max(3, 帧数×5%)⌋] 内 ——
 * 命中的是「既在文案里被点名、又在片子里真实出现且不泛滥」的词，这类词的镜头才是被漏召的真候选。
 *
 * Args:
 *   queryText: 本句召回 query 文本（= buildFrameRecallQueryText 产物）。
 *   dfByWord: 词 → 本项目帧描述命中帧数（调用方一次性预扫得出）。
 *   frameTotal: 本项目帧总数（定判别力红线上限）。
 *
 * Returns:
 *   string[]: 命中的实体词（按词表顺序，稳定可复现）。
 */
export function pickEntityWords(
  queryText: string,
  dfByWord: Map<string, number>,
  frameTotal: number,
): string[] {
  const maxDf = Math.max(3, Math.floor(frameTotal * ENTITY_MAX_DF_RATIO));
  return FRAME_ENTITY_LEXICON.filter((w) => {
    if (!queryText.includes(w)) return false;
    const df = dfByWord.get(w) || 0;
    return df > 0 && df <= maxDf;
  });
}

/**
 * 合并「语义召回镜头」与「实体补召镜头」为最终候选池。
 *
 * 池总量恒为 topShots：实体补召只占用「语义召回没捞到」的票数（已在语义池内的镜头不重复占席），
 * 且只为真正挤进来的镜头腾出席位 ⇒ 无实体命中时逐字节等于旧行为（`semShots.slice(0, topShots)`）。
 *
 * Args:
 *   semShots: 语义召回上卷后的镜头（按分降序）。
 *   entShots: 实体补召上卷后的镜头（按「命中词数 → query 余弦」降序）。
 *   topShots: 池上限席位。
 *   reserved: 实体补召可用席位数上限。
 *
 * Returns:
 *   ShotRecallHit[]: 最终候选池（语义镜头在前后接补召镜头）。
 */
export function mergeEntityShots(
  semShots: ShotRecallHit[],
  entShots: ShotRecallHit[],
  topShots: number,
  reserved: number = ENTITY_RESERVED,
): ShotRecallHit[] {
  if (entShots.length === 0) return semShots.slice(0, topShots);
  const semIds = new Set(semShots.map((s) => s.chunkId));
  // 补召席位不越界：最多 min(reserved, topShots−1)——语义侧至少保 1 席，池总量恒不超 topShots
  const cap = Math.max(0, Math.min(reserved, topShots - 1));
  const extra = entShots
    .filter((s) => !semIds.has(s.chunkId))
    .slice(0, cap)
    .map((s) => ({ ...s, entitySupplemented: true }));   // 打标：供打分侧识别「帧证据入池」的镜头
  if (extra.length === 0) return semShots.slice(0, topShots);
  const semCap = Math.max(1, topShots - extra.length);
  return [...semShots.slice(0, semCap), ...extra];
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

    // 实体补召索引：**词表每词只扫一遍全池帧描述**（一次预扫，非逐句重复扫）⇒ 逐句零额外 IO。
    const wordHits = new Map<string, FrameIndexRow[]>();
    const dfByWord = new Map<string, number>();
    for (const w of FRAME_ENTITY_LEXICON) {
      const hit = frames.filter((f) => String(f.description || '').includes(w));
      if (hit.length > 0) {
        wordHits.set(w, hit);
        dfByWord.set(w, hit.length);
      }
    }

    const qVecs = await FrameRecallService.encode(usable.map((x) => x.text));
    const topFrames = Math.max(1, opts?.topFrames || 40);
    const topShots = Math.max(1, opts?.topShots || 24);
    // 帧 hash → 帧级释义（方案 B 的取数源：命中帧的释义要随候选一起下发打分侧）
    const descByHash = new Map<string, string>();
    for (const f of frames) descByHash.set(f.frameHash, String(f.description || ''));
    let entityQueryCount = 0;   // 命中词表实体词的句数
    let entityAdded = 0;        // 实体补召「新进池」的镜头数
    const entityExamples: string[] = [];

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
      const scoreByHash = new Map<string, number>();
      for (const s of scored) scoreByHash.set(s.frameHash, s.score);
      /** 上卷：按 chunkId 聚合，取最高分（Q5），并记命中帧数与最高分帧身份 */
      const byShot = new Map<string, ShotRecallHit>();
      for (const s of scored.slice(0, topFrames)) {
        const prev = byShot.get(s.chunkId);
        if (!prev) {
          byShot.set(s.chunkId, {
            chunkId: s.chunkId, score: s.score, hitCount: 1,
            bestFrameHash: s.frameHash, bestTimeMs: s.timeMs,
            bestFrameDesc: descByHash.get(s.frameHash) || '',
          });
        } else {
          prev.hitCount += 1;
          if (s.score > prev.score) {
            prev.score = s.score;
            prev.bestFrameHash = s.frameHash;
            prev.bestTimeMs = s.timeMs;
            prev.bestFrameDesc = descByHash.get(s.frameHash) || '';
          }
        }
      }
      const semShots = Array.from(byShot.values()).sort((a, b) => b.score - a.score);

      /** 实体定向补召（方案 A）：query 命中词表实体 ⇒ 定向捞「描述含该词」的帧 → 上卷成镜头。
       *  仅对**已有语义召回**的句子启用；语义召回为空的句子维持「不设白名单 ⇒ 全域可选」旧语义。 */
      let entShots: ShotRecallHit[] = [];
      const eWords = pickEntityWords(x.text, dfByWord, frames.length);
      if (eWords.length > 0 && semShots.length > 0) {
        const acc = new Map<string, { hit: ShotRecallHit; words: Set<string> }>();
        for (const w of eWords) {
          for (const f of wordHits.get(w) || []) {
            const sc = scoreByHash.get(f.frameHash) ?? 0;
            const cur = acc.get(f.chunkId);
            if (!cur) {
              acc.set(f.chunkId, {
                hit: {
                  chunkId: f.chunkId, score: sc, hitCount: 1,
                  bestFrameHash: f.frameHash, bestTimeMs: f.timeMs,
                  bestFrameDesc: descByHash.get(f.frameHash) || '',
                },
                words: new Set([w]),
              });
            } else {
              cur.hit.hitCount += 1;
              cur.words.add(w);
              if (sc > cur.hit.score) {
                cur.hit.score = sc;
                cur.hit.bestFrameHash = f.frameHash;
                cur.hit.bestTimeMs = f.timeMs;
                cur.hit.bestFrameDesc = descByHash.get(f.frameHash) || '';
              }
            }
          }
        }
        // 排序：命中词数优先（判别力强），同词数按 query 余弦（与整体语义更贴者先）
        entShots = Array.from(acc.values())
          .sort((a, b) => (b.words.size - a.words.size) || (b.hit.score - a.hit.score))
          .map((e) => e.hit);
      }

      const merged = mergeEntityShots(semShots, entShots, topShots);
      const semIds = new Set(semShots.slice(0, topShots).map((s) => s.chunkId));
      const addedNew = merged.filter((s) => !semIds.has(s.chunkId));
      if (addedNew.length > 0) {
        entityQueryCount += 1;
        entityAdded += addedNew.length;
        if (entityExamples.length < 3) {
          entityExamples.push(
            `${String(x.q.shotId)}「${eWords.join('/')}」→ ${addedNew.map((s) => s.chunkId).join(',')}`);
        }
      }
      result.set(String(x.q.shotId), merged);
    });
    AppLogger.info(LOG_TAGS.AI_AGENT,
      entityQueryCount > 0
        ? `[FrameRecall] 🧩 实体定向补召：句 ${entityQueryCount}/${usable.length} 命中词表实体｜`
          + `新进池镜头 ${entityAdded} 个｜例: ${entityExamples.join(' ｜ ')}`
        : `[FrameRecall] 🧩 实体定向补召：0 句命中词表实体 ⇒ 未启用（池与排序零行为变化）`);
    return result;
  }
}