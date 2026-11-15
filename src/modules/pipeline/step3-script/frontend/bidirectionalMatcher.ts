// 📁 路径：src/modules/pipeline/step3-script/frontend/bidirectionalMatcher.ts
// P2 · 段落文案 ↔ 画面帧 双向匹配：给每段解说词推荐可用的 VLM 画面帧。
//   全部纯函数实现，零 I/O、零随机数，可直接在 Node 测试环境调用。
//   口径：时间窗重叠为主（帧是时间点，按「到下一帧」的区间算覆盖），
//         关键词 / 情绪 / 景别为辅；一帧只锁定给一段（双向互斥，避免同一画面被复用）。
import type { ScriptParagraph, VlmFrame } from '../../../../shared/types/entities/editor';

/** 匹配配置 */
export interface BidirectionalMatchConfig {
  /** 段落时间窗外允许的最近帧距离（ms），默认 1500；超出即不进入候选 */
  toleranceMs?: number;
  /** 每段最多返回的候选帧数，默认 4 */
  maxCandidates?: number;
  /** 候选最低综合分（0-1），默认 0.2 */
  minScore?: number;
  /** 每段最多锁定的帧数，默认 1（互斥分配） */
  maxPerParagraph?: number;
}

/** 单个候选帧 */
export interface FrameCandidate {
  /** 帧在输入 vlmFrames 中的下标（回写 / 反向定位用） */
  index: number;
  frame: VlmFrame;
  /** 综合得分 0-1（时间 70% + 语义 30%） */
  score: number;
  /** 时间得分 0-1 */
  timeScore: number;
  /** 语义得分 0-1（关键词 / 情绪 / 景别） */
  textScore: number;
  /** 命中的关键词（供 UI 说明「为什么推荐」） */
  keywordHits: string[];
  /** 本帧是否被双向分配锁定给该段 */
  assigned: boolean;
}

/** 单段匹配结果 */
export interface ParagraphFrameMatch {
  paragraphId: string;
  /** 候选帧，按综合分降序 */
  candidates: FrameCandidate[];
  /** 锁定给本段的最佳帧下标；无可用帧时为 null */
  assignedIndex: number | null;
}

/** 整篇匹配结果 */
export interface BidirectionalMatchResult {
  matches: ParagraphFrameMatch[];
  /** 未被任何段落锁定的帧下标 */
  unassignedFrameIndexes: number[];
}

/** 帧的语义比较文本：关键词 + 情绪 + 景别 */
function frameSemantics(frame: VlmFrame): string[] {
  const tokens: string[] = [];
  const kws = frame.downstream?.keywords;
  if (Array.isArray(kws)) {
    for (const k of kws) {
      const t = (k ?? '').trim();
      if (t.length >= 2) tokens.push(t);
    }
  }
  const emotion = (frame.emotion ?? frame.downstream?.emotion ?? '').trim();
  if (emotion.length >= 2) tokens.push(emotion);
  const shotType = (frame.shotType ?? frame.downstream?.shotType ?? '').trim();
  if (shotType.length >= 2) tokens.push(shotType);
  return tokens;
}

/** 段落的比较文本：解说词正文（原声段用台词）+ 画面意图 */
function paragraphHaystack(p: ScriptParagraph): string {
  const parts: string[] = [];
  if (p.type === 'narration') {
    parts.push(p.text ?? '');
  } else {
    parts.push(p.audioSource?.transcript ?? '');
  }
  if (p.type === 'narration' && p.visualIntent) parts.push(p.visualIntent);
  return parts.join(' ');
}

/** 语义得分：关键词命中为主，情绪一致 / 景别被点名做小加成 */
function scoreSemantics(p: ScriptParagraph, frame: VlmFrame): { score: number; hits: string[] } {
  const haystack = paragraphHaystack(p);
  const tokens = frameSemantics(frame);
  const hits = tokens.filter((t) => haystack.includes(t));

  let score = 0;
  if (hits.length > 0) score += 0.6 + Math.min(0.2, hits.length * 0.1);
  const frameEmotion = (frame.emotion ?? frame.downstream?.emotion ?? '').trim();
  if (frameEmotion && p.emotion && frameEmotion === p.emotion) score += 0.2;
  const shotType = (frame.shotType ?? frame.downstream?.shotType ?? '').trim();
  if (shotType && haystack.includes(shotType)) score += 0.1;

  return { score: Math.min(1, score), hits };
}

/** 帧覆盖区间：本帧时间点 → 下一帧时间点；末帧按中位间隔兜底 */
function buildFrameSpans(frames: VlmFrame[]): Array<{ start: number; end: number }> {
  const times: number[] = [];
  for (const f of frames) {
    const t = typeof f.timeMs === 'number' && !Number.isNaN(f.timeMs) && f.timeMs >= 0 ? f.timeMs : NaN;
    times.push(t);
  }
  const valid = times.filter((t) => !Number.isNaN(t)).sort((a, b) => a - b);
  let gap = 1000;
  if (valid.length >= 2) {
    const diffs: number[] = [];
    for (let i = 1; i < valid.length; i++) diffs.push(valid[i] - valid[i - 1]);
    diffs.sort((a, b) => a - b);
    gap = diffs[Math.floor(diffs.length / 2)] || 1000;
  }
  return times.map((t) => {
    if (Number.isNaN(t)) return { start: NaN, end: NaN };
    return { start: t, end: t + gap };
  });
}

/** 时间得分：与段落时间窗重叠比例；窗外按距离衰减到 0.5 以内 */
function scoreTime(
  windowStart: number,
  windowEnd: number,
  span: { start: number; end: number },
  toleranceMs: number,
): number {
  const len = Math.max(1, windowEnd - windowStart);
  const overlap = Math.max(0, Math.min(windowEnd, span.end) - Math.max(windowStart, span.start));
  if (overlap > 0) return 0.5 + 0.5 * Math.min(1, overlap / len);

  const dist = span.start < windowStart ? windowStart - span.start : span.start - windowEnd;
  if (dist > toleranceMs) return 0;
  return 0.5 * (1 - dist / toleranceMs);
}

/**
 * 段落 ↔ 画面帧 双向匹配。
 *
 * 1) 正向：每段按「时间 70% + 语义 30%」给所有帧打分，过滤低于 minScore 的，取前 maxCandidates 个；
 * 2) 反向：把所有 (段, 帧) 对按分数降序贪心锁定，一帧只归一段、一段最多 maxPerParagraph 帧，
 *    保证同一画面不会被两段重复引用。
 */
export function matchParagraphsToFrames(
  paragraphs: ScriptParagraph[],
  frames: VlmFrame[],
  config: BidirectionalMatchConfig = {},
): BidirectionalMatchResult {
  const toleranceMs = config.toleranceMs ?? 1500;
  const maxCandidates = config.maxCandidates ?? 4;
  const minScore = config.minScore ?? 0.2;
  const maxPerParagraph = config.maxPerParagraph ?? 1;

  if (!Array.isArray(paragraphs) || paragraphs.length === 0 || !Array.isArray(frames) || frames.length === 0) {
    return { matches: [], unassignedFrameIndexes: [] };
  }

  const spans = buildFrameSpans(frames);
  const usable = spans.map((s, i) => (Number.isNaN(s.start) ? -1 : i)).filter((i) => i >= 0);

  // ── 正向打分 ──
  const candidatesByParagraph: FrameCandidate[][] = paragraphs.map((p) => {
    const windowStart = p.startMs;
    const windowEnd = p.startMs + Math.max(1, p.durationMs);
    const list: FrameCandidate[] = [];
    for (const frameIdx of usable) {
      const timeScore = scoreTime(windowStart, windowEnd, spans[frameIdx], toleranceMs);
      if (timeScore <= 0) continue; // 超出容忍距离，直接不候选
      const { score: textScore, hits } = scoreSemantics(p, frames[frameIdx]);
      const score = timeScore * 0.7 + textScore * 0.3;
      if (score < minScore) continue;
      list.push({
        index: frameIdx,
        frame: frames[frameIdx],
        score,
        timeScore,
        textScore,
        keywordHits: hits,
        assigned: false,
      });
    }
    list.sort((a, b) => b.score - a.score || (a.frame.timeMs ?? 0) - (b.frame.timeMs ?? 0));
    return list.slice(0, maxCandidates);
  });

  // ── 反向互斥锁定：全局按分数降序贪心 ──
  const pairs: Array<{ pIdx: number; frameIdx: number; score: number }> = [];
  candidatesByParagraph.forEach((list, pIdx) => {
    for (const c of list) pairs.push({ pIdx, frameIdx: c.index, score: c.score });
  });
  pairs.sort((a, b) => b.score - a.score || a.pIdx - b.pIdx || a.frameIdx - b.frameIdx);

  const frameOwner = new Map<number, number>();
  const assignedOf = new Map<number, number[]>();
  for (const pair of pairs) {
    if (frameOwner.has(pair.frameIdx)) continue;
    const owned = assignedOf.get(pair.pIdx) ?? [];
    if (owned.length >= maxPerParagraph) continue;
    frameOwner.set(pair.frameIdx, pair.pIdx);
    owned.push(pair.frameIdx);
    assignedOf.set(pair.pIdx, owned);
  }

  const matches: ParagraphFrameMatch[] = paragraphs.map((p, pIdx) => {
    const owned = assignedOf.get(pIdx) ?? [];
    const candidates = candidatesByParagraph[pIdx].map((c) => ({
      ...c,
      assigned: owned.includes(c.index),
    }));
    const best = owned.length > 0 ? owned[0] : null;
    return {
      paragraphId: p.id,
      candidates,
      assignedIndex: best,
    };
  });

  const unassignedFrameIndexes = usable.filter((i) => !frameOwner.has(i));
  return { matches, unassignedFrameIndexes };
}
