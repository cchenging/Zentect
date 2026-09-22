/**
 * SliceSearchService — 步骤5 手动替换切片的「按文案语义检索候选」服务
 *
 * 需求：替换弹窗打开时，候选池只需出现"符合这段解说文案"的切片，而不是全部镜头。
 * 方案：复用引擎做「文案↔片段」匹配所用的 TF-IDF 文本相似度口径（中英 bag-of-characters，
 *      与 SemanticAnalyzeStrategy 一致），对预生成的 matchSegments（已继承父镜头描述）打分，
 *      并按所属物理镜头(parentChunkId)去重、聚合成物理切片返回。零额外推理，纯本地同步。
 *
 * 说明：相关候选依赖切片自身带内容描述(description)。历史项目描述覆盖率极低时，
 *      检索结果会很少，前端据此回落"显示全部切片"兜底。
 */
import { VideoChunkRepository } from '../../database/repositories/VideoChunkRepository';

/** 中文/英文停用词：与 SemanticAnalyzeStrategy 的 TF-IDF 口径完全一致，保证检索与匹配评分同频 */
const STOPWORDS = new Set<string>([
  '的', '了', '是', '一', '一个', '我们', '你们', '他们', '和', '与', '及', '或', '在', '有', '也', '都',
  '就', '而', '这', '那', '被', '把', '让', '给', '对', '为', '并', '但', '却', '很', '更', '最', '还', '只',
  '又', '上', '下', '中', '里', '到', '从', '向', '然后', '接着', '之后', 'before', 'after', 'with', 'without',
  'this', 'that', 'these', 'those', 'the', 'a', 'an', 'and', 'or', 'is', 'are', 'was', 'were', 'of', 'to', 'in',
  'on', 'for', 'with', 'by', 'as', 'at', 'it', 'its', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does',
  'did', 'will', 'would', 'could', 'should', 'may', 'might', 'can', 'not', 'no', 'yes', 'so', 'if', 'then', 'else',
  'than', 'when', 'where', 'what', 'which', 'who', 'how', 'i', 'you', 'he', 'she', 'we', 'they', 'me', 'him', 'her',
  'us', 'them', 'my', 'your', 'our', 'their',
]);

/**
 * 中英混合分词：与引擎 normalize 同款。
 * 英文按单词（长度≥2 且非停用词）；中文按字切，单字 + 相邻双字（bag-of-characters，`2:` 前缀区分双字）。
 * @param raw 原始文本
 * @returns 词元数组
 */
function normalize(raw: string): string[] {
  if (!raw) return [];
  const s = String(raw).toLowerCase().replace(/[\s\u3000]+/g, ' ').trim();
  if (!s) return [];
  const tokens: string[] = [];
  const en = s.match(/[a-z0-9]+/g) || [];
  for (const w of en) if (w.length >= 2 && !STOPWORDS.has(w)) tokens.push(w);
  const zhSeg = Array.from(s.replace(/[a-z0-9\s\p{P}\p{S}]/gu, ''));
  for (let i = 0; i < zhSeg.length; i++) {
    const ch = zhSeg[i];
    if (!ch || STOPWORDS.has(ch)) continue;
    tokens.push(ch);
    if (i + 1 < zhSeg.length) {
      const bi = ch + zhSeg[i + 1];
      if (!STOPWORDS.has(bi)) tokens.push(`2:${bi}`);
    }
  }
  return tokens;
}

/** 稀疏 tf-idf 向量的余弦相似度：只在两向量词元交集上累加，除以 L2 范数积 */
function cosine(a: Map<string, number>, aNorm: number, b: Map<string, number>, bNorm: number): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  small.forEach((w, tok) => {
    const bw = big.get(tok);
    if (bw !== undefined) dot += w * bw;
  });
  const d = aNorm * bNorm;
  return d <= 0 ? 0 : Math.max(0, Math.min(1, dot / d));
}

/** 检索请求入参 */
export interface SliceSearchRequest {
  /** 素材/媒体 id，用于定位该素材预生成的切片候选池 */
  mediaId: string;
  /** 当前段解说词文案（query 文本） */
  text: string;
  /** 期望返回的候选切片数量（默认 24） */
  topN?: number;
}

/** 检索结果：单个候选切片 = 物理镜头切片 + 得分 + 命中描述片段数 */
export interface SliceSearchHit {
  /** 物理切片对象（与步骤5 候选 videoChunk 同构，含 id/封面/源时间窗） */
  chunk: any;
  /** 归一化相似度 0~1 */
  score: number;
  /** 该切片下命中的候选段数量（判读覆盖面） */
  segHits: number;
}

/**
 * 按一句文案检索某素材的语义相关切片。
 * 读取该素材缓存的 matchSegments（已继承父镜头描述），TF-IDF 打分后按 parentChunkId 聚合成物理切片，
 * 取每物理切片最高分的命中段分数，返回 topN。
 *
 * 数据缺失保护：
 * - 素材无缓存（未跑过匹配）/ 文案为空 → 返回空数组，前端据此回落"显示全部"。
 * - 切片描述稀疏（相关候选少）是预期行为，不抛错。
 * @param req 检索请求
 * @returns 命中的物理切片候选列表（按相似度降序）
 */
export class SliceSearchService {
  static search(req: SliceSearchRequest): SliceSearchHit[] {
    const text = (req.text || '').trim();
    if (!text) return [];

    const cached = new VideoChunkRepository().getByMediaId(req.mediaId);
    const segs = cached?.matchSegments || [];
    const chunks = cached?.chunks || [];
    if (segs.length === 0 || chunks.length === 0) return [];

    /** 按 parentChunkId 索引物理切片，供候选段聚合并拿到原对象 */
    const chunkByParent = new Map<string, any>();
    for (const c of chunks) chunkByParent.set(String(c.parentChunkId || c.id), c);

    /** query 向量（仅文案，与引擎 query 拼接口径对齐） */
    const qTok = normalize(text);
    const qTf = new Map<string, number>();
    for (const t of qTok) qTf.set(t, (qTf.get(t) || 0) + 1);
    /** query L2 范数（一次性算好，供与各切片余弦共用） */
    let qNorm = 0;
    qTf.forEach((f) => { qNorm += f * f; });
    qNorm = Math.sqrt(qNorm) || 1;

    /** 建 chunk 语料：doc = 候选段 desc/emotion/shotType/scene/characters/keywords 拼接（与引擎 addDoc 一致） */
    const segText = (seg: any): string =>
      [seg.description || '', seg.emotion || '', seg.shotType || '', seg.scene || '',
       Array.isArray(seg.characters) ? (seg.characters as string[]).join(' ') : '',
       Array.isArray(seg.keywords) ? (seg.keywords as string[]).join(' ') : '']
        .filter(Boolean).join(' ');

    /** 逐段余弦打分，按物理切片聚合成 map：切片id → { maxScore, segHits } */
    const scoredByChunk = new Map<string, { score: number; segHits: number; chunk: any }>();
    for (const seg of segs) {
      const t = segText(seg);
      if (!t) continue; // 无内容描述的候选段不参与文本检索
      const parent = chunkByParent.get(String(seg.parentChunkId));
      if (!parent) continue;
      const tokens = normalize(t);
      const tf = new Map<string, number>();
      for (const tok of tokens) tf.set(tok, (tf.get(tok) || 0) + 1);
      if (tf.size === 0) continue;
      let nn = 0;
      tf.forEach((f) => { nn += f * f; });
      const s = cosine(qTf, qNorm, tf, Math.sqrt(nn) || 1);
      if (s <= 0) continue;
      const key = String(parent.parentChunkId || parent.id);
      const prev = scoredByChunk.get(key);
      if (!prev) {
        scoredByChunk.set(key, { score: s, segHits: 1, chunk: parent });
      } else {
        prev.segHits += 1;
        if (s > prev.score) prev.score = s;
      }
    }

    const topN = Math.max(1, req.topN || 24);
    return Array.from(scoredByChunk.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, topN)
      .map((v) => ({ chunk: v.chunk, score: v.score, segHits: v.segHits }));
  }
}