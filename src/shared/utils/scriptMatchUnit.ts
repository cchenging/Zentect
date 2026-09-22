// 📁 路径：src/shared/utils/scriptMatchUnit.ts
// 🎯 匹配单位（Match Unit）语义的单一事实源：把"按标点切出的碎片"提升为"一个完整句"。
//
// 背景（docs/designs/2026-09-15-步骤5匹配重构优化整体方案-最终态.md §23.12）：
//   步骤3 的断句器 breakLongParagraphs 会把一个完整句按逗号切出 3~4 个碎片（`seg_N_sub_k`），
//   步骤5 buildMatchQueries 对每个碎片 1:1 建一条匹配 query，且碎片强制继承母句的 visualIntent
//   ⇒ 同簇碎片只能给同一答案，理论 Top-1 上限被压到 50%（25 段里 18 段是碎片 = 72%）。
//   修法：匹配单位回到"一个完整句"；碎片仅作 TTS 承载 / 字幕，不再独立参与匹配。
//
// 本文件只做"语义与纯计算"，不掺任何 IO：模式解析（开关）、匹配单位命名、按单位折叠、诊断读数。
// 消费方约定（不改既有 id 映射）：
//   - 断句器在 sentence 档给每个碎片打 `matchUnitId`（= 其所属完整句的稳定 id）；
//   - 步骤5 查询端按 `matchUnitId` 折叠为一个匹配单位（一个完整句一条 query）；
//   - 匹配结果按 `matchUnitId` 回填到该完整句覆盖的全部碎片（碎片 id 仍是既有 `{母句id}_sub_{n}`）。

/**
 * 匹配单位模式：
 * - `sentence`：一个完整句 = 一个匹配单位（新行为，需显式开启）；
 * - `legacy`：每个按标点切出的碎片各算一个匹配单位（线上现状，默认）。
 */
export type ScriptMatchUnitMode = 'sentence' | 'legacy';

/** 开关环境变量名：取值 `sentence` / `legacy`（缺省 legacy）。 */
export const SCRIPT_MATCH_UNIT_ENV = 'ZENTECT_SCRIPT_MATCH_UNIT';

/**
 * 完整句边界标点（句末标点，SSOT）：与断句器 `breakLongParagraphs` 的切分集合保持同源，
 * 保证"匹配单位 = 完整句"的句界与"承载拆分"的句界定义一致（两处不可各自漂移）。
 */
export const SCRIPT_SENTENCE_END_PUNCT = '。！？；.!?;';

/**
 * 函数级中文注释：读取「匹配单位」开关（`ZENTECT_SCRIPT_MATCH_UNIT`）。
 *
 * 规则：
 *  1. 仅当显式取值为 `sentence`（大小写与首尾空白不敏感）时启用新行为；
 *  2. 其余一切情况（未设置、`legacy`、无法识别的值）一律返回 `legacy` —— 保证线上行为零变化；
 *  3. 渲染层没有 Node `process` 时不抛错，按 `legacy` 处理（主进程为唯一权威来源）。
 *
 * @returns 生效的匹配单位模式
 */
export function resolveScriptMatchUnitMode(): ScriptMatchUnitMode {
  try {
    const proc = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process;
    const raw = proc?.env ? proc.env[SCRIPT_MATCH_UNIT_ENV] : undefined;
    return String(raw ?? '').trim().toLowerCase() === 'sentence' ? 'sentence' : 'legacy';
  } catch {
    return 'legacy';
  }
}

/**
 * 函数级中文注释：为一个完整句生成稳定的匹配单位 id。
 *
 * 规则（沿用既有 id 约定，不新造映射表）：
 *  - 母段落只含一个完整句 → 匹配单位 id 直接取母段落 id（`seg_2`），与现状的"未拆分段"同形；
 *  - 母段落含多个完整句 → 以 `{母句id}_s{序号}`（从 1 起）区分（`seg_2_s1` / `seg_2_s2`）。
 *
 * @param parentId 母段落主键（如 `seg_2`）
 * @param sentenceIdx 该完整句在母段落内的下标（从 0 起）
 * @param sentenceCount 母段落切出的完整句总数
 * @returns 该完整句的匹配单位 id
 */
export function buildMatchUnitId(parentId: string, sentenceIdx: number, sentenceCount: number): string {
  return sentenceCount <= 1 ? parentId : `${parentId}_s${sentenceIdx + 1}`;
}

/**
 * 函数级中文注释：统计一段文案包含的完整句数（按句末标点切分，空片不计）。
 * 仅用于诊断读数（碎片率分母），不参与任何产物构造。
 *
 * @param text 文案正文
 * @returns 完整句数（文本为空或全为标点时返回 0）
 */
export function countCompleteSentences(text: string): number {
  const raw = String(text || '');
  if (!raw.trim()) return 0;
  // 与断句器同源：先按句末标点切分，再过滤空片（保留标点归属不影响句数）
  return raw
    .split(new RegExp(`[${SCRIPT_SENTENCE_END_PUNCT}]`))
    .filter((s) => s.trim().length > 0).length;
}

/** 折叠后的一个匹配单位（一个完整句）及其覆盖的全部碎片 */
export interface ScriptMatchUnitGroup<T> {
  /** 匹配单位 id（= 完整句的稳定 id，见 buildMatchUnitId） */
  matchUnitId: string;
  /** 该单位覆盖的全部碎片（sentence 档为子句；legacy 档退化为单元素的自身） */
  shots: T[];
}

/**
 * 函数级中文注释：把按标点切出的碎片按「匹配单位」折叠（一个完整句 = 一个匹配单位）。
 *
 * 分组口径（沿用既有 id 映射，不新造映射表）：
 *  - 优先用碎片上的 `matchUnitId`（sentence 档由断句器写入）；
 *  - 缺失该字段（legacy 档 / 老数据 / 原声段）时退化为"碎片自身即一个单位"（用 `id` 兜底）；
 *  - 按键首次出现顺序返回，保证查询顺序与文案顺序一致（步骤5 依赖时序单调）。
 *
 * @param shots 段落碎片数组（含 id 与可选 matchUnitId）
 * @returns 匹配单位分组数组（顺序稳定）
 */
export function collapseShotsToMatchUnits<T extends { id?: string; shotId?: string; matchUnitId?: string }>(
  shots: T[],
): Array<ScriptMatchUnitGroup<T>> {
  const groups: Array<ScriptMatchUnitGroup<T>> = [];
  const byKey = new Map<string, ScriptMatchUnitGroup<T>>();
  for (const shot of Array.isArray(shots) ? shots : []) {
    const key = String(shot?.matchUnitId || shot?.id || shot?.shotId || '').trim();
    if (!key) continue; // 无主键的脏数据不参与分组（错就错，不造占位单位）
    const existed = byKey.get(key);
    if (existed) {
      existed.shots.push(shot);
    } else {
      const group: ScriptMatchUnitGroup<T> = { matchUnitId: key, shots: [shot] };
      byKey.set(key, group);
      groups.push(group);
    }
  }
  return groups;
}

/** 匹配单位诊断读数（碎片率口径见下方 summarizeScriptMatchUnits） */
export interface ScriptMatchUnitSummary {
  /** 匹配单位数：一个完整句一个（legacy 档退化为碎片数） */
  matchUnits: number;
  /** 子句数：断句器实际产出的碎片数（TTS/字幕承载单位） */
  clauses: number;
  /** 完整句数：文案按句末标点切出的完整句数（碎片率分母的基准） */
  sentences: number;
  /** 碎片率 = (匹配单位数 − 完整句数) / 匹配单位数，∈[0,1]，与方案 §23.12 的 18/25=72% 同口径 */
  fragmentRate: number;
}

/**
 * 函数级中文注释：产出「匹配单位数 / 子句数 / 完整句数 / 碎片率」诊断读数。
 *
 * 碎片率口径（与方案 §23.12 对齐，可离线复算）：
 *   fragmentRate = (匹配单位数 − 完整句数) / 匹配单位数
 *   - legacy 档：匹配单位 = 每个碎片 ⇒ (25 − 7) / 25 = 72%（线上现状）；
 *   - sentence 档：匹配单位 = 完整句 ⇒ (7 − 7) / 7 = 0%（目标 ≤20%）。
 *
 * @param shots 断句后的碎片数组（Narration 段；原声段不计入）
 * @param sentences 完整句数（由 countCompleteSentences 对母段落求和得到）
 * @returns 诊断读数（匹配单位数 > 0 才计算碎片率，否则为 0）
 */
export function summarizeScriptMatchUnits(
  shots: Array<{ id?: string; shotId?: string; matchUnitId?: string }>,
  sentences: number,
): ScriptMatchUnitSummary {
  const clauses = Array.isArray(shots) ? shots.length : 0;
  const matchUnits = collapseShotsToMatchUnits(shots).length;
  const sentenceCount = Math.max(0, Math.floor(sentences) || 0);
  const fragmentRate = matchUnits > 0 ? Math.max(0, (matchUnits - sentenceCount) / matchUnits) : 0;
  return { matchUnits, clauses, sentences: sentenceCount, fragmentRate };
}
