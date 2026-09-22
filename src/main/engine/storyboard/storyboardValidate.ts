// 🎬 A2 两道校验（纯 Node 侧、无副作用、可单测）——分镜师工单 `ShotSpec` 在 A1 最小结构校验之上的展开。
//
// 来源：docs/designs/2026-09-19-A系列实施规格-A2.md（前置 A1：StoryboardAgent.ts 开单 + 最小结构校验）。
// 职责切分（A1 规格 §16 / A2 规格 §1）：
//   · ① 结构校验（schema+枚举+段号+**subjects∈段 topChars 白名单**）——硬门，参与重开（P3）；
//   · ② 可满足性校验——纯计算，标 unresolved 进诊断表，**不重开**（P5/P6）；
//   · ③ 配场存疑校验——纯计算，标 unresolved 进诊断表，**不重开**。
// 本模块全部为纯函数，不写库、不改 daemon、不引第二套空间枚举（P4），供单测全量覆盖。
//
// 🔒 铁前提（A1 规格 §2，A2 延续）：
//   P3  可选集硬约束：targetSubjects ⊆ 该段 topChars（prompt 与校验同源，见 A1 buildPrompt）。
//   P5  禁抽样投票，只允许带错重开 ≤2 次。
//   P6  atmosphereNote 不做软排决策的依据，也不参与可满足/存疑判定。
//   P7  解析失败/缺字段走重开，不静默降级成规则单。

import type { ShotSpec } from '../../../shared/contracts/shotSpec';
import type { SegmentSummary } from './StoryboardAgent';
import type { PersonRegistry } from '../utils/PersonRegistry';

/* ==================== 诊断表类型 ==================== */

/** 单个工单的计算校验点（②可满足性 / ③配场存疑合并为一条，供日志/前端聚合展示）。 */
export interface EvaluationPoint {
  /** 对应工单在批内序号 */
  orderIndex: number;
  /** ②可满足性：该工单是否可被场记单库存满足 */
  satisfiable: boolean;
  /** ③配场存疑：该工单的配场选择是否可疑（无主体仅靠 scene / 高信息位无对应等） */
  suspicious: boolean;
  /** 标注理由（unresolved 的代码化原因，中文可读） */
  reason?: string;
}

/** 聚合诊断汇总（A2 规格 §5.1 TYPE-D）：供验收门「可满足率 ≥85%、配场存疑率 ≤10%」直接读取。 */
export interface EvaluationSummary {
  /** 评估的工单总数 */
  total: number;
  /** 可满足工单数（satisfiable === true） */
  satisfiableCount: number;
  /** 存疑工单数（suspicious === true） */
  suspiciousCount: number;
  /** 每单逐点评估明细 */
  points: EvaluationPoint[];
}

/* ==================== 工具 ==================== */

/**
 * 函数级中文注释：段 topChars 的占位/泛指表述黑名单——无判定价值的占位语，一律剔除。
 * 这些既不是道具也不是可消费的真人主体，属于 VLM 父镜头聚合时的"兜底占位"。
 */
const TOPCHARS_STOPWRDS: ReadonlyArray<string> = [
  '无主体人物',
  '未知人物',
  '无人物',
  '无人物主体',
  '主体不详',
  '无主体',
  '人物不详',
  '无具体人物',
];

/**
 * 人物称谓 / 身份 / 外观描述词正则：命中即视作"按描述归纳的真实在场主体"，予以保留。
 * 只用于区分"外观描述的人物"与"道具/物体/地点的非主体文本"；不覆盖注册表内的裸姓名
 * （裸姓名靠注册表锚点保留，避免误删"宋慧乔""郑智薰"这类真人名）。
 */
const TOPCHARS_PERSON_RE = /(女子|女人|女性|女生|男子|男人|男性|男生|女孩|男孩|少女|少年|老人|阿姨|大叔|姑娘|小伙子|孩子|小孩|小朋友|宝宝|人群|路人|行人|乘客|旅客|职员|店员|工作人员|员工|服务员|护士|医生|患者|病人|警察|刑警|军人|士兵|游客|导游|背影|学生|老师|运动员|情侣|夫妻|一家|两人|三人|几人|多人|男女|群)/;

/**
 * 函数级中文注释：清洗段 topChars，剔除幻觉污染，仅保留「可判定的真实在场主体」。
 *
 * 判定规则（保守：宁可漏判道具，也不误删真人）：
 *   ① 精确命中人物注册表（canonical 或任一 aliasesHigh 字面）→ 保留（真人名/别名，含裸姓名）；
 *   ② 含人物称谓/身份/外观描述词（女子、男子、人群、路人、乘客、背影…）→ 按"描述的真实主体"保留；
 *   ③ 其余一律剔除——道具/物体/地点（门缝、路灯、冰箱物品、纸张、衣物、飞机机身…）、
 *      占位语（TOPCHARS_STOPWRDS）、以及**注册表之外疑似幻觉的虚构性名**（如"李民浩""张根硕"）。
 *
 * 清洗后数组保序、去空、去重。该函数为纯函数、无副作用，可单测。
 *
 * @param topChars 段 topChars 原值（可为 null/undefined）
 * @param registry 人物注册表（可为 null；为 null 时退化为纯称谓启发式，裸姓名无法确认会被剔除）
 * @returns 清洗后的主体集合（空数组 = 该段无明确可消费主体）
 */
export function sanitizeTopChars(
  topChars: string[] | null | undefined,
  registry: PersonRegistry | null,
): string[] {
  const norm = normalizeTopChars(topChars);
  if (norm.length === 0) return norm;

  // ① 注册表锚点：收集全部 canonical + aliasesHigh 字面，精确匹配（不区分 gatingAllowed，
  //    因为保留在段 topChars 里只影响"该主体是否在场"，可由 A2 白名单门用精确匹配再兜底）。
  const registered = new Set<string>();
  if (registry && Array.isArray(registry.chars)) {
    for (const c of registry.chars) {
      if (!c) continue;
      if (c.canonical && c.canonical.trim()) registered.add(c.canonical.trim());
      for (const a of c.aliasesHigh ?? []) {
        const lit = String(a?.literal ?? '').trim();
        if (lit) registered.add(lit);
      }
    }
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of norm) {
    if (TOPCHARS_STOPWRDS.includes(s)) continue;           // 占位语 → 剔除
    if (registered.has(s)) { seen.add(s); out.push(s); continue; }   // ① 注册真人
    if (TOPCHARS_PERSON_RE.test(s)) { seen.add(s); out.push(s); continue; }  // ② 外观/身份描述主体
    // ③ 道具/物体/地点/注册表外性名 → 剔除
  }
  return out;
}

/**
 * 函数级中文注释：把某段 topChars 归一为可匹配的主体集合。
 * A1 `SegmentSummary.topChars` 实为 `string[]`；此处统一 trim、去空、去重，
 * 供白名单门 / 可满足性共用同一取数源（保证 prompt 与校验同源，P3）。
 *
 * @param topChars 段主要人物/主体（可为 null/undefined）
 * @returns 归一化后的主体字符串数组（空数组 = 该段无明确主体）
 */
export function normalizeTopChars(topChars: string[] | null | undefined): string[] {
	if (!Array.isArray(topChars)) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const c of topChars) {
		const s = String(c ?? '').trim();
		if (!s) continue;
		if (seen.has(s)) continue;
		seen.add(s);
		out.push(s);
	}
	return out;
}

/**
 * 函数级中文注释：工单主体归一后的匹配函数。
 * 直接用段 topChars 精确匹配（白名单本体）；若提供了注册表，则额外尝试将
 * 工单主体经 aliasesHigh 别名归一后再与 topChars 对——兼容"工单写的是角色名、
 * topChars 存的是演员名"的表述漂移，但**归一失败不降级放行**（仍按原始字面判定）。
 *
 * @param subject 工单单一主体原文（已 trim）
 * @param topChars 段主体白名单（已归一）
 * @param registry 人物注册表（可为 null，仅做别名扩展，可缺省）
 * @returns 是否命中白名单
 */
export function subjectInTopChars(
	subject: string,
	topChars: string[],
	registry: PersonRegistry | null,
): boolean {
	const s = String(subject ?? '').trim();
	if (!s) return false;
	if (topChars.includes(s)) return true;
	// 别名扩展：注册表里该主体的 canonical/别名若能匹配白名单任一项，也判命中
	if (registry && Array.isArray(registry.chars)) {
		const holders: string[] = [];
		for (const c of registry.chars) {
			if (!c || c.gatingAllowed !== true) continue;
			const aliases = (c.aliasesHigh ?? []).map((a) => String(a?.literal ?? '').trim()).filter(Boolean);
			// 工单主体命中该人物的任意别名 → 该人物所有别名/canonical 都视为候选
			if (c.canonical === s || aliases.includes(s)) {
				if (c.canonical && c.canonical.trim()) holders.push(c.canonical.trim());
				holders.push(...aliases);
			}
		}
		return holders.some((h) => topChars.includes(h));
	}
	return false;
}

/**
 * 函数级中文注释：白名单门（① 结构校验 · subjects∈段 topChars，P3）。
 * 判定：工单 targetSubjects 每一项，经别名归一后必须命中该段 topChars。
 * 这是硬门 → 调用方（重开循环）应把错误信息拼回 prompt 触发带错重开 ≤2 次（P2/P5）。
 *
 * @param spec 已通过 A1 最小结构校验的工单
 * @param topChars 该段主要人物/主体白名单（A1 = topChars，未归一传入亦可）
 * @param registry 人物注册表（别名扩展，可缺省）
 * @returns 错误列表；空 = 白名单校验通过
 */
export function validateSubjectsInTopChars(
	spec: ShotSpec,
	topChars: string[] | null | undefined,
	registry: PersonRegistry | null,
): string[] {
	const subjects = Array.isArray(spec.targetSubjects) ? spec.targetSubjects.map((s) => String(s).trim()).filter(Boolean) : [];
	const whitelist = normalizeTopChars(topChars);
	if (subjects.length === 0) return []; // 无主体要求 → 通过（纯环境句）
	if (whitelist.length === 0) {
		// 段没有任何可判定的主体 → 属"数据缺失"而非"越界"：不进重开硬门，标注（交给可满足性）
		return [];
	}
	const errs: string[] = [];
	for (const s of subjects) {
		if (!subjectInTopChars(s, whitelist, registry)) errs.push(`主体「${s}」不在段topChars内`);
	}
	return errs;
}

/* ==================== ② 可满足性（纯计算，不重开） ==================== */

/**
 * 函数级中文注释：可满足性校验（②，纯计算）。
 * 判定该工单是否能被场记单库存满足：段存在且主体可命中。**只标注、不参与重开**（P5/P6），
 * 避免把软排判断硬化为重开造成死循环。
 *
 * @param spec 已通过全部结构门的工单
 * @param segment 对应场记段摘要（可为 null = 段不存在）
 * @param registry 人物注册表（别名扩展）
 * @returns 是否可满足 + 理由
 */
export function evaluateSatisfiability(
	spec: ShotSpec,
	segment: SegmentSummary | null,
	registry: PersonRegistry | null,
): { satisfiable: boolean; reason?: string } {
	if (!segment) return { satisfiable: false, reason: '段不存在（超出段号）' };
	const subjects = (spec.targetSubjects ?? []).map((s) => String(s).trim()).filter(Boolean);
	const topChars = normalizeTopChars(segment.topChars);
	if (subjects.length === 0) return { satisfiable: true }; // 无主体 → 场景可兜底，视为可满足
	if (topChars.length === 0) {
		// 段主体数据缺失：工单有主体但段未标注 → 无法判定，标"topChars缺失"
		return { satisfiable: false, reason: '段topChars缺失，无法确认主体在场' };
	}
	for (const s of subjects) {
		if (!subjectInTopChars(s, topChars, registry)) {
			return { satisfiable: false, reason: `主体「${s}」不在段topChars内，库存不可满足` };
		}
	}
	return { satisfiable: true };
}

/** 段 shotDist 键中的高信息位景别中文关键词（S1 场记单产物，中文景别名）。 */
const SHOT_DIST_CLOSE_CN: ReadonlyArray<string> = ['特写', '近景', '中近景'];

/**
 * 函数级中文注释：判断段 shotDist 是否含「高信息位景别（特写/近景/中近景）」素材。
 * shotDist 键来自 S1 场记单，为中文景别名（"特写"/"近景"/"中景"/"全景"/"远景"），
 * 故不能用 "包含 SHOT 子串" 判有无景别记录（中文键恒不含 SHOT，会恒判 false）。
 * 此处按中文关键词命中，并兼容英文契约枚举（EXTREME_CLOSE/CLOSE_SHOT/MEDIUM_CLOSE）作为防御。
 * 空/缺省分布返回 false。
 *
 * @param shotDist 段景别分布（键为景别名，值为计数）
 * @returns 是否存在特写/近景类可吸收素材
 */
export function hasCloseLikeFootage(shotDist: Record<string, number> | undefined | null): boolean {
	if (!shotDist) return false;
	for (const raw of Object.keys(shotDist)) {
		const k = String(raw ?? '').trim().toUpperCase();
		if (k === 'EXTREME_CLOSE' || k === 'CLOSE_SHOT' || k === 'MEDIUM_CLOSE') return true;
		if (SHOT_DIST_CLOSE_CN.some((w) => k.includes(w))) return true;
	}
	return false;
}

/* ==================== ③ 配场存疑（纯计算，不重开） ==================== */

/**
 * 函数级中文注释：配场存疑校验（③，纯计算）。
 * 判定该工单的配场选择是否"可疑"（可能满足但置信度低）：
 *   - 工单无主体 但 段有明确主体 → 存疑（无主体仅靠 scene，画面主体可能失焦）；
 *   - 高信息位景别（特写/近景/中近景）但段景别分布不含该类景别 → 存疑。
 * **不参与重开**，只标 unresolved 进诊断表（P5/P6）。
 *
 * @param spec 已通过全部结构门的工单
 * @param segment 对应场记段摘要（可为 null）
 * @returns 是否存疑 + 理由
 */
export function evaluateFittingConcern(
	spec: ShotSpec,
	segment: SegmentSummary | null,
): { suspicious: boolean; reason?: string } {
	if (!segment) return { suspicious: false }; // 段不存在已在可满足性标注，这里不重复标存疑
	const subjects = (spec.targetSubjects ?? []).map((s) => String(s).trim()).filter(Boolean);
	const topChars = normalizeTopChars(segment.topChars);
	if (subjects.length === 0 && topChars.length > 0) {
		return { suspicious: true, reason: '无主体仅靠scene，画面主体可能失焦' };
	}
	// 高信息位景别（特写/近景/中近景）但段素材无该类 → 存疑（真实素材缺口）
		const closeLikes = ['EXTREME_CLOSE', 'CLOSE_SHOT', 'MEDIUM_CLOSE'];
		if (closeLikes.includes(String(spec.preferredShot ?? ''))) {
			const dist = segment.shotDist ?? {};
			if (Object.keys(dist).length === 0) {
				return { suspicious: true, reason: `${spec.preferredShot} 高信息位景别但段shotDist无景别记录` };
			}
			// 段有景别记录但确无特写/近景类素材 → 段内无该类可吸收画面
			if (!hasCloseLikeFootage(dist)) {
				return { suspicious: true, reason: `${spec.preferredShot} 高信息位景别但段shotDist无特写/近景素材` };
			}
		}
		return { suspicious: false };
}

/* ==================== 聚合诊断（TYPE-D） ==================== */

/**
 * 函数级中文注释：聚合全部工单的评估结果（可满足率 + 配场存疑率 + 逐单理由）。
 * 纯计算，供验收门读取与日志输出；不写库（A1 规格 §8 不引入新存储）。
 *
 * @param orders 经校验收束的工单（顺序稳定，orderIndex 按数组下标）
 * @param bySegmentId 段号 → 段摘要 的查表（缺失段返回 null）
 * @param registry 人物注册表（可缺省）
 * @returns 聚合诊断汇总
 */
export function aggregateEvaluation(
	orders: ShotSpec[],
	bySegmentId: Map<number, SegmentSummary | null>,
	registry: PersonRegistry | null,
): EvaluationSummary {
	const points: EvaluationPoint[] = orders.map((spec, i) => {
		const seg = bySegmentId.get(Number(spec.segmentId)) ?? null;
		const sat = evaluateSatisfiability(spec, seg, registry);
		const fit = evaluateFittingConcern(spec, seg);
		const reasonBits: string[] = [];
		if (sat.reason) reasonBits.push(`可满足:${sat.reason}`);
		if (fit.reason) reasonBits.push(`存疑:${fit.reason}`);
		return {
			orderIndex: i,
			satisfiable: sat.satisfiable,
			suspicious: fit.suspicious,
			...(reasonBits.length > 0 ? { reason: reasonBits.join('；') } : {}),
		};
	});
	const total = points.length;
	const satisfiableCount = points.filter((p) => p.satisfiable).length;
	const suspiciousCount = points.filter((p) => p.suspicious).length;
	return { total, satisfiableCount, suspiciousCount, points };
}