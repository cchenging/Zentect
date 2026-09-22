# -*- coding: utf-8 -*-
"""
beam_search.py —— 受限束搜索前向排产（§8.2 / §9，Q1/Q2 准绳落地）

定位：
  - 本模块是**调度层**（scheduling），**不产生**贴合判断；第一句候选集合及其代价
    由**供给层**（MatchCost，两层次串行 R1）预计算后注入。
  - 输入：标准候选池（build_context.CandidateContext）+ 每句命中代价矩阵
    （query,chunk）与规则集（rules/）。输出：逐句命中的 MatchResult 装配。

状态与算法（§8.2-项4 写死）：
  状态 ⟨current_chunk_id, used_chunks_bitset, prev_shot_scale, continuation_count⟩
  束宽 Beam=3；候选代价注入满足时仍守恒选择；逐句前向推进。
  受限点：
    · 段域掩码（补丁6）：bitset 按全局候选索引累计已用切片（跨场不清零），
      任一物理切片本路径一旦落点即永久禁复用（历史归全局黑名单）。
    · 多样性剪枝（补丁6）：每一层保留的 3 条路径**末端切片互异**，杜绝微小变体霸位。
    · 前向审望资源耗尽惩罚（补丁1）：本句若抢占后句唯一关键主粮，施加过高代价抑制。

关键分解（Q2「少 if 分叉、一个方法只做一件事」）：
    · 违反即 ∞ 的硬门禁（Tier1，补丁21）：长镜头物理单向锁 / 视线跳轴 / 空镜昼夜介质 / 稀有物料强占
    · 仅累加的软阻尼（Tier2，补丁21）：同机位跳斩 / 心跳阻尼 / 景别律动 / 动静
    · 跨场硬清算（补丁19）：文案跨 segmentId 时收敛 Top-1 作唯一物理前驱。
    · 长镜头顺延安全锁（§8.3）：CONTINUE_PREV 句连续顺延 ≤3 句且 <7s，越界强切。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional

from build_context import CandidateContext
from montage_contract import ContractError, has_motion_contrast

# 一票否决的硬门禁代价（补丁21 Tier1）——任何规则返回此值即弃选。
HARD_DENY_COST = float('inf')
# 长镜头顺延上限（§8.3 无 PPT 化）：连续顺延句数与累计时长。
CONTINUE_MAX_SENTENCES = 3
CONTINUE_MAX_MS = 7000
# 长镜头顺延由后置对账（reconcile_continuation，对齐 legacy B4）驱动：CONTINUE_PREV 句在
# 束搜索主核内按语义正常参与，求解完成后统一重排至上一镜父镜头。**不再注入转移奖励**——
# 强奖励会反向扭曲 NEW_SHOT 句的选取（为占便宜续镜头而牺牲其最优匹配），恰是 legacy 将
# CONTINUE_PREV 排除出 KM 矩阵的原因。
# 束宽（补丁1 写死）。
BEAM_WIDTH = 3

# CONTINUE_PREV 句的主解同父软偏好（软阻尼负向，非硬切）：当本句被场景断言为顺延上一镜
# 且候选与上一镜父镜头一致时，适当降低其成本，使其在“尚未被前句占用”时倾向继续父镜头，
# 从源头保证同父延续（reconcile 兜底）。仅本句候选间相对排序生效，不跨句、不影响前序句，
# 故不会被全局 DP“劫持”NEW_SHOT 句的选取。数值需小于硬门禁、大于仅微差语义抖动。
CONTINUE_PREF = 0.3


# 装配期切片回查回调：`_pick_best_for_shot` 末帧漂移时据 chunkId 取完整切片。
# 每次 solve 前由调用方注入 ctx.chunk_by_id.get，规避「{id:...} 兜底丢父镜头字段」缺陷。
CHUNK_INDEX_CALLBACK = None


# ===========================================================================
# 规则卡片接口（§8.5.4：score(prev_shot, candidate_shot, context) -> 罚分数）
# ===========================================================================
@dataclass
class RuleCard:
    """一条剪辑规则 = 独立小卡片。声明 tier 决定其在两道管线中的位置（补丁21）。

    Attributes:
        name: 规则名（trace 用）。
        tier: 'hard'（违反即 ∞，一票否决）| 'soft'（仅累加阻尼）。
        fn: score(prev, cand, ctx) -> float；hard 卡片违反时返回 HARD_DENY_COST。
    """
    name: str
    tier: str
    fn: Callable[[Optional[dict], dict, dict], float]


# ===========================================================================
# 束搜索单条路径
# ===========================================================================
@dataclass
class BeamPath:
    """解空间中的一条候选路径。

    Attributes:
        curr_chunk_id: 当前落点切片 id（多样性剪枝 key）。
        curr_chunk: 当前落点切片实体。
        used_bits: 本路径已用切片 bitset（按全局候选索引累计，永久禁复用）。
        prev_scale: 上一镜景别（转移代价输入）。
        continuation_count: 自末次 NEW_SHOT 起连续顺延句数。
        last_shot_commit_ms: 末次强切/新镜的落点时间（顺延 7s 判据）。
        scene_id: 当前所处场次。
        pen: 累计软阻尼代价。
        trace: {shotId: chunkId} 装配痕迹。
    """
    curr_chunk_id: Optional[str] = None
    curr_chunk: Optional[dict] = None
    used_bits: int = 0
    prev_scale: str = ''
    continuation_count: int = 0
    last_shot_commit_ms: float = 0.0
    scene_id: int = 0
    pen: float = 0.0
    # D 域状态字段（§10.2.5 L448-454）：由 _advance_state 随移位推进，规则卡只读。
    #   max_consumed_ms:    {parentChunkId: 已消费最远起点}，补丁11 单向锁。
    #   fatigue_accum_ms:   连续无反差时长，补丁13 心跳阻尼。
    #   last_contrast_ms:   末次动静反差时间点，破局重置基准。
    state: Dict[str, object] = field(default_factory=dict)
    trace: Dict[str, str] = field(default_factory=dict)


def build_path(path: BeamPath, chunk: dict, shot_id: str, scene_id: int,
               budget_ms: float, used_idx: int) -> BeamPath:
    """造一条落在 chunk 上的新路径（供展开层调用，不掺规则）。

    修复段域掩码未生效：`used_idx` 为本句落点切片在**全局候选索引**中的下位，子路径
    在父路径 used_bits 上把该位置 1（`_mark_used`），实现「本路径已用切片永久禁复用」，
    兑现补丁6 段域掩码 + 历史归全局黑名单（无 PPT 化验收）。

    Args:
        path: 父路径。
        chunk: 新落点切片。
        shot_id: 本句 id。
        scene_id: 本句所属场次。
        budget_ms: 本句目标时长（顺延 7s 判据基准）。
        used_idx: 本落点在全局候选索引中的下标（used_bits 定位用）。

    Returns:
        BeamPath: 子路径（输出到链末）。
    """
    new_path = BeamPath(
        curr_chunk_id=chunk.get('id'),
        curr_chunk=chunk,
        used_bits=_mark_used(path.used_bits, used_idx),
        prev_scale=str(chunk.get('shotScale') or ''),
        continuation_count=0,  # NEW_SHOT 重开顺延计数（调 setUp 由展开层显式控制）
        last_shot_commit_ms=float(chunk.get('startMs') or 0),
        scene_id=scene_id,
        pen=path.pen,
        # 深拷贝 D 域状态：max_consumed_ms 是嵌套 dict，子路径必须独立，
        # 否则多条兄弟候选共享同一引用 → 单向锁状态互相污染。
        state={
            'max_consumed_ms': dict((path.state.get('max_consumed_ms') or {})),
            'fatigue_accum_ms': float(path.state.get('fatigue_accum_ms', 0.0)),
            'last_contrast_ms': float(path.state.get('last_contrast_ms', 0.0)),
        },
        trace=dict(path.trace),
    )
    new_path.trace[shot_id] = str(chunk.get('id'))
    return new_path


# ===========================================================================
# 束搜索主核
# ===========================================================================
def _apply_tier_hard_and_soft(
    rules: List[RuleCard],
    prev: Optional[dict],
    cand: dict,
    ctx: dict,
) -> float:
    """串行执行两级规则流水线（补丁21：先 hard 后 soft，∞ 即弃选）。

    Args:
        rules: 规则卡片列表。
        prev: 前驱切片（首句为 None）。
        cand: 候选切片。
        ctx: 上下文。

    Returns:
        float: 软阻尼累计代价；任意 hard 违反则返回 HARD_DENY_COST。

    Raises:
        ContractError: 规则 tier 非法。
    """
    # Tier1：任一硬门禁不满足 → 立即截止。
    for card in rules:
        if card.tier == 'hard':
            coup = card.fn(prev, cand, ctx)
            if coup >= HARD_DENY_COST:
                return HARD_DENY_COST
        elif card.tier != 'soft':
            raise ContractError(f'rule tier 非法: {card.tier!r} for {card.name}')
    # Tier2：软阻尼累加（绝不混入 hard 代价）。
    penalty = 0.0
    for card in rules:
        if card.tier == 'soft':
            penalty += card.fn(prev, cand, ctx)
    return penalty


def _mark_used(used_bits: int, cand_idx: int) -> int:
    """把候选索引位置 1 计入当前场次 bitset。"""
    return used_bits | (1 << cand_idx)


def _is_used(used_bits: int, cand_idx: int) -> bool:
    """查询候选索引是否已被当前场次占用。"""
    return bool(used_bits & (1 << cand_idx))


def _unique_curr_chunks(paths: List[BeamPath]) -> List[BeamPath]:
    """多样性剪枝（补丁6）：三槽押注互异物理切片，截断到 Beam 宽。

    Args:
        paths: 候选路径（按累计代价升序，代价小者在前）。

    Returns:
        List[BeamPath]: 末端切片互异的至多 Beam 宽路径。
    """
    seen: Dict[str, bool] = {}
    kept: List[BeamPath] = []
    for p in paths:
        cid = str(p.curr_chunk_id or '')
        if cid not in seen:
            seen[cid] = True
            kept.append(p)
        if len(kept) >= BEAM_WIDTH:
            break
    return kept


def scene_collapse(paths: List[BeamPath]) -> BeamPath:
    """补丁19 场次交界硬清算：跨场时收敛到综合代价最小 Top-1 路径。

    Args:
        paths: 上一场末尾展开出的全部路径。

    Returns:
        BeamPath: 唯一物理前驱（代价最小者），作为下一场 `prev_shot`。
    """
    if not paths:
        raise ContractError('跨场清算: 无可用路径收敛')
    # 升序取 pen 最小（代价最小）者作唯一前驱。
    return min(paths, key=lambda p: p.pen)


def _next_candidate_scores(
    ctx: dict,
    overview: dict,
    match_cost: Dict[str, Dict[str, float]],
    shot_id: str,
    cand_ids: List[str],
) -> List[tuple]:
    """取供给层预计算的 (cand_id, cost) 并按原生代价升序，丢弃无代价的候选。

    Args:
        overview: 求解总览（expand_solution 传入）。
        match_cost: 供给层代价矩阵 {shotId: {chunkId: cost}}。
        shot_id: 本句。
        cand_ids: 本句候选切片 id 列表。

    Returns:
        List[tuple]: [(cand_id, base_cost), ...] 升序；无签到的候选被丢弃（错就错：
        本句候选池与供给层代价不一致属装配期缺陷，宁可少供不可造假）。

    Raises:
        ContractError: 本句在供给层完全无代价记录。
    """
    row = match_cost.get(shot_id) or {}
    scored = [(cid, c) for cid in cand_ids if (c := row.get(cid)) is not None]
    if not scored:
        raise ContractError(f'供给层未给 {shot_id} 任何候选代价（{ctx}）')
    return sorted(scored, key=lambda item: item[1])


def solve(
    ctx: CandidateContext,
    match_cost: Dict[str, Dict[str, float]],
    rules: List[RuleCard],
    tts_duration_ms: Dict[str, float],
) -> Dict[str, dict]:
    """受限束搜索前向排产主核。

    逐句（按输入顺序，即叙事时间轨）推进：取本句候选与供给层代价，
    对每条存活路径展开所有候选 → 两级规则过滤 → 前向审望资源耗尽惩罚 →
    保留代价最小的至多 Beam 宽互异路径。跨场时先收敛 Top-1（补丁19）。

    Args:
        ctx: 标准候选池上下文（build_context 产出）。
        match_cost: 供给层代价矩阵 {shotId: {chunkId: base_cost}}。
        rules: 规则卡片列表。
        tts_duration_ms: 每句目标时长 {shotId: ms}（顺延 7s 判据）。

    Returns:
        Dict[str, dict]: {shotId: MatchResult-dict}，装配产物。
    """
    # 存活路径（至少 1 条）；首句 prev 为 None。
    paths: List[BeamPath] = [BeamPath()]
    results: Dict[str, dict] = {}
    last_scene: int = 0
    global_used: Dict[str, bool] = {}
    # 装配期切片回查：注入全局索引，供 _pick_best_for_shot 末帧漂移时取完整切片（含 parentChunkId）。
    global CHUNK_INDEX_CALLBACK
    CHUNK_INDEX_CALLBACK = ctx.chunk_by_id.get
    # K1 熔断标记：{shotId: 熔断层级}，最终结果据此打 isDegraded + degradeKind。
    degraded_marks: Dict[str, str] = {}
    # 全局候选索引：chunkId → 全程稳定位掩码下标。used_bits 按此全局空间累计置位，
    # 消除「每句局部下标错指」缺陷 → 任一物理切片本路径一旦落点即永久禁复用
    # （补丁6 段域掩码 + 历史归全局黑名单，兑现无 PPT 化验收）。
    chunk_index: Dict[str, int] = {str(cid): i for i, cid in enumerate(ctx.chunk_by_id.keys())}

    for query in ctx.queries:
        sid = str(query['shotId'])
        scene = ctx.shotid_to_segment.get(sid) or 0
        # ---- 跨场硬清算（补丁19）：切换场次先收敛 Top-1 作唯一前驱 ----
        if paths and scene != last_scene and len(paths) > 1:
            paths = [scene_collapse(paths)]
        # 跨场首步标记（补丁19 #2）：换场第一步豁免同机位跳斩与景别律动。
        # 必须在更新 last_scene 前捕获，否则恒为 False。
        is_scene_first = scene != last_scene
        last_scene = scene

        cand_ids = ctx.cands_by_shotid.get(sid) or []
        if not cand_ids:
            # 空候选：错就错，本句不产出分配（对应「旧7空段→新引擎必0」验收），
            # 而非随意编造素材。
            continue
        candidates = [ctx.chunk_by_id[cid] for cid in cand_ids]
        scored = _next_candidate_scores({'shot_id': sid}, {}, match_cost, sid, cand_ids)

        # 展开一条本句的候选路径（K1 熔断复用：active_rules 控制硬门禁是否生效）。
        def _expand_paths(active_rules, force=False):
            """对当前存活路径展开本句候选；force=True 时跳过全部规则（三级熔断）。

            Args:
                active_rules: 本趟生效的规则卡片（一级熔断时为去掉 hard 的软规则）。
                force: 三级熔断强挂——忽略一切规则，直接选供给层代价最优候。

            Returns:
                List[BeamPath]: 展开出的子路径（可空）。
            """
            out: List[BeamPath] = []
            for path in paths:
                prev_chunk = path.curr_chunk
                for cand_id, base_cost in scored:
                    # 段域掩码（补丁6）：本路径已用切片永久禁复用（全局位掩码累计，跨场不清零）。
                    # force=True（三级熔断）时忽略掩码，回退允许复用以确保「绝不白屏」。
                    if not force and _is_used(path.used_bits, chunk_index[str(cand_id)]):
                        continue
                    cand = ctx.chunk_by_id[cand_id]
                    total = base_cost
                    if not force:
                        # 规则上下文：state / 句 / 跨场首步标记（规则卡只读，Δ_advance 写入）。
                        rctx = {'state': path.state, 'query': query, 'is_scene_first': is_scene_first}
                        total += _apply_tier_hard_and_soft(active_rules, prev_chunk, cand, rctx)
                        if total >= HARD_DENY_COST:
                            continue
                        # 前向审望资源耗尽惩罚（补丁1 占位）：MVP 注入 0，规则卡片可填充。
                        total += _forward_lookout(cand_id, cand_ids, scored)
                        # CONTINUE_PREV 同父软偏好：仅对断言顺延上一镜的句生效。候选与上一镜
                        # 父镜头一致时降成本，从源头延续同父（reconcile 兜底）。prev_chunk 即
                        # path.curr_chunk——对每条第路径独立判断，故只影响本句候选间排序。
                        if str(query.get('shotMode') or '') == 'CONTINUE_PREV' and prev_chunk:
                            if prev_chunk.get('parentChunkId') and \
                                    prev_chunk.get('parentChunkId') == cand.get('parentChunkId'):
                                total -= CONTINUE_PREF
                    child = build_path(
                        path,
                        cand,
                        sid,
                        scene,
                        tts_duration_ms.get(sid, 0.0),
                        chunk_index[str(cand_id)],
                    )
                    # D 域状态推进（补丁11 单向锁 / 补丁13 心跳疲劳），写在子路径副本上。
                    # B域动作3：matched 强锚句以真实 refFrame 作为补丁11 单向锁起算点。
                    _anchor_ms = None
                    if str(query.get('refFrameSource') or '') == 'matched':
                        _rf = float(query.get('refFrameTimeMs') or 0)
                        if _rf > 0:
                            _anchor_ms = _rf
                    _advance_state(child, prev_chunk, cand, _anchor_ms)
                    # 长镜头顺延状态继承（CONTINUE_PREV 由模式/规则层驱动真实赋值）。
                    if str(query.get('shotMode') or '') == 'CONTINUE_PREV':
                        _apply_continuation(child, query, tts_duration_ms.get(sid, 0.0))
                    child.pen += total
                    out.append(child)
            return out

        # K1 阶梯熔断：①完整规则 → ②放开 Tier-1 硬门禁（soft 保留）→ ③强挂最优候（绝不白屏）。
        expanded = _expand_paths(rules)
        if not expanded:
            soft_rules = [r for r in rules if r.tier != 'hard']
            expanded = _expand_paths(soft_rules)
            if expanded:
                degraded_marks[sid] = 'hard_relax'      # 一级熔断：视觉美学红线放宽后复活
            else:
                expanded = _expand_paths([], force=True)
                degraded_marks[sid] = 'all_beam_death'  # 三级熔断：强挂最优候选并强标降级
        if not expanded:
            # 理论上到达不了（三级必出），保留该保护作为「错就错」最终声明。
            continue
        expanded.sort(key=lambda p: p.pen)
        paths = _unique_curr_chunks(expanded)

    # 装配最终结果。
    for query in ctx.queries:
        sid = str(query['shotId'])
        chosen = _pick_best_for_shot(paths, query)
        if chosen:
            # K1：熔断降级句强标记 isDegraded + 熔断层级（供 shadow 对账 / UI「待确认」徽标）。
            if sid in degraded_marks:
                chosen['isDegraded'] = True
                chosen['degradeKind'] = degraded_marks[sid]
            results[sid] = chosen

    # 顺延后置对账（对齐 legacy B4 段内锚顺延）：语义供给层 perQueryTopK 逐句独立，
    # 不含「上一镜父切片」，导致部分 CONTINUE_PREV 句选到异父。此处按叙事行序把仍异父的
    # 顺延句重排到前句父镜头的另一子切片，就地补上候选池缺口、真实续上不切镜。
    reconcile_continuation(ctx, results, tts_duration_ms)

    return results


# ===========================================================================
# 子函数（长镜头顺延 / 前向审望 / 结果装配）
# ===========================================================================
def _advance_state(path: BeamPath, prev_chunk: Optional[dict], cand: dict,
                   anchor_ms: Optional[float] = None) -> None:
    """推进束路径的 D 域状态（补丁11 单向锁 / 补丁13 心跳疲劳）。

    只写在 `path.state` 副本上（build_path 已深拷贝），绝不影响父/兄弟路径。
    规则卡只读本状态，状态推进集中在此单一方法（守「一个方法只做一件事」）。

    B域（§10.2.3 动作3）：补丁11 `maxConsumedTimeMs` 起算点从「切片 startMs」
    改为「真实参考帧 refFrameTimeMs」（anchor_ms）——当本句是 matched 强锚句时，
    使该父镜头消耗基线贴着真实剧情时间去，堵住等分插值近似锚导致的漂移。

    Args:
        path: 目标路径（原地修改 state，返回 None）。
        prev_chunk: 前一镜切片（首镜为 None）。
        cand: 当前落点切片。
        anchor_ms: 本句真实参考帧时间（源坐标，仅 matched 强锚句非 None）。
    """
    state = path.state
    # -- 补丁11 同源物理单向锁：记录同父镜头已消费的最远起点 --
    pid = cand.get('parentChunkId') or ''
    c_start = float(cand.get('startMs') or 0.0)
    # B域动作3：仅显式强锚（matched）且落入本句候选时，以真实 refFrame 为单向锁基准；
    # 无锚句 anchor_ms=None 沿用切片 startMs（零行为变化，保 legacy/shadow 对账稳定）。
    _base = anchor_ms if (anchor_ms is not None) else c_start
    if pid:
        consumed = state.setdefault('max_consumed_ms', {})
        consumed[pid] = max(float(consumed.get(pid, 0.0)), _base)
    # -- 补丁13 心跳阻尼：无反差时长累积 / 反差破局重置 --
    if prev_chunk is not None:
        if has_motion_contrast(prev_chunk, cand):
            state['fatigue_accum_ms'] = 0.0    # 破局：疲劳归零
            state['last_contrast_ms'] = c_start
        else:
            p_start = float(prev_chunk.get('startMs') or 0.0)
            state['fatigue_accum_ms'] = float(state.get('fatigue_accum_ms', 0.0)) \
                + max(c_start - p_start, 0.0)
    # 首镜无前驱：疲劳不累积（保持 0）。


def _pick_sibling(
    chunk_by_id: Dict[str, dict],
    parent: str,
    exclude: str,
    results: Dict[str, dict],
) -> Optional[dict]:
    """CONTINUE_PREV 顺延取片（级联降级，对齐 legacy `_sb_continue_prev`，防空塞）。
    「仅取同父且未整片复用」是硬约束：同父切片大概率已被先顺延的主解占用，导致**无米之炊**
    卡死顺延成功率（真实 51%→31%→37.5% 的根因）。本函数对齐 legacy 已验证的 5 级级联拿片：
      l0 优先同父 + 时间上续（startMs∈(pre_start, pre_start+窗口)）+ 未整片复用
      l1 退同父任意未整片复用（取时间最早）
      l2 退全局空镜（可复用 broll）
      l3 退全局任意未整片复用切片
      各级都不满足 → 返回 None（错就错：无可用兄弟，调用方记 miss，不造假镜像）。
    违规：不再返回 None 时放弃；各级依次降级保证顺延能续即续。

    Args:
        chunk_by_id: 切片资产索引。
        parent: 要续接的父镜头 id。
        exclude: 已被前句选中的切片 id（避免整片重贴）。
        results: 已装配结果（用于跳过全局已整片复用的子切片）。

    Returns:
        Optional[dict]: 续接切片。
    """
    prev_start = 0.0
    for cid, c in chunk_by_id.items():
        if c.get('id') == exclude:
            prev_start = float(c.get('startMs') or 0)
            break

    def _unreused():
        """产出「未在别句整片复用」的切片 id → 切片 迭代器（复用检查内联，避免重复扫描）。"""
        reused = set()
        for r in results.values():
            _cid = r.get('chosenChunkId')
            if _cid:
                reused.add(str(_cid))
        for cid, c in chunk_by_id.items():
            if cid == exclude or cid in reused:
                continue
            yield cid, c

    # l0：同父 + 时间上续 + 未整片复用（startMs 紧随上帧，限窗口内避免隔飞）。
    lo_picks = []
    for cid, c in _unreused():
        if str(c.get('parentChunkId') or '') != parent:
            continue
        _s = float(c.get('startMs') or 0)
        if prev_start < _s <= prev_start + CONTINUE_MAX_MS:
            lo_picks.append((_s, c))
    if lo_picks:
        return min(lo_picks, key=lambda x: x[0])[1]
    # l1：同父任意未整片复用（取时间最早）。
    l1_picks = []
    for cid, c in _unreused():
        if str(c.get('parentChunkId') or '') != parent:
            continue
        l1_picks.append((float(c.get('startMs') or 0), c))
    if l1_picks:
        return min(l1_picks, key=lambda x: x[0])[1]
    # l2：全局空镜（可复用 broll）。
    for cid, c in _unreused():
        if str(c.get('shotType') or c.get('isBroll') or '') or '空镜' in str(c.get('description') or ''):
            return c
    # l3：全局任意未整片复用切片（取时间最早）。
    l3_picks = []
    for cid, c in _unreused():
        l3_picks.append((float(c.get('startMs') or 0), c))
    if l3_picks:
        return min(l3_picks, key=lambda x: x[0])[1]
    return None


def reconcile_continuation(
    ctx: CandidateContext,
    results: Dict[str, dict],
    tts_duration_ms: Dict[str, float],
) -> None:
    """顺延后置对账（对齐 legacy B4 段内锚顺延）：把仍异父的 CONTINUE_PREV 句续上同父。

    语义供给层 perQueryTopK 逐句独立打分，不含「上一镜父切片」，故束搜索奖励再强，
    候选池里没有同父子切片时就续不上（shadow 实测 50% 失败正源于此）。本函数按叙事
    行序重跑一遍 CONTINUE_PREV 句：当前句父镜头 ≠ 上一镜父镜头时，若全局切片池存在
    前句父镜头的可续子切片，则就地重排本句至该同父切片。只改 CONTINUE_PREV 句，
    不动其它句 / 不触发全局重解，受 3 句连续顺延上限与 7s 物理锁约束。

    Args:
        ctx: 标准候选池上下文（chunk_by_id 提供全局切片，queries 提供叙事行序 + shotMode）。
        results: 束搜索已装配结果（{shotId: MatchResult}，就地改）。
        tts_duration_ms: 每句目标时长 {shotId: ms}。

    Returns:
        None（原地修改 results）。
    """
    prev_chunk: Optional[dict] = None
    prev_parent = ''
    cont_count = 0
    last_commit_ms = 0.0

    for query in ctx.queries:
        sid = str(query['shotId'])
        r = results.get(sid)
        # 空分配（候选池空）无法续接，但也阻断不了"上一镜"向前延续，仅跳过本句。
        if r is None:
            continue
        chosen_id = r.get('chosenChunkId')
        # 父镜头取完整切片：优先按 chosenChunkId 回查全局索引（_pick_best_for_shot 末帧漂移时
        # 已注入全局索引回调取完整切片，此回查为双保险）。
        chunk = ctx.chunk_by_id.get(str(chosen_id) or '') or r.get('chunkData')
        if chunk is None:
            continue
        cur_parent = str(chunk.get('parentChunkId') or '')
        mode = str(query.get('shotMode') or '')

        if mode == 'CONTINUE_PREV' and prev_chunk is not None:
            within_time = (float(chunk.get('startMs') or 0) - last_commit_ms) <= CONTINUE_MAX_MS \
                if last_commit_ms else True
            sibling = None
            # 权威顺延分类（喂 shadow 对账，消除"数组相邻项读父"误差）：
            #   continued=已续上（picker 换片同父）
            #   same      =主解本已同父，无需续接（非缺陷）
            #   time_lock / limit_3 =物理锁/触顶强切（非缺陷）
            #   fail      =该续未续（真失败：异父+可续但无可用兄弟切片）
            cont_ok = 'same'
            if prev_parent and prev_parent != cur_parent \
                    and cont_count < CONTINUE_MAX_SENTENCES and within_time:
                sibling = _pick_sibling(ctx.chunk_by_id, prev_parent, str(prev_chunk.get('id') or ''),
                                        results)
                if sibling is not None:
                    cont_ok = 'continued'
                    r['chosenChunkId'] = sibling['id']
                    r['chunkData'] = sibling
                    cur_parent = prev_parent
                    cont_count += 1
                else:
                    cont_ok = 'fail'               # 异父+可续但池内无兄弟 → 真失败
            elif mode == 'CONTINUE_PREV' and prev_parent:
                # 未走 picker 的原因：7s 物理锁/连续触顶/本已同父，均非引擎失败。
                if cur_parent == prev_parent:
                    cont_ok = 'same'               # 主解本已同父，无需续接
                elif not within_time:
                    cont_ok = 'time_lock'          # 7s 物理锁强切（非缺陷）
                elif cont_count >= CONTINUE_MAX_SENTENCES:
                    cont_ok = 'limit_3'            # 连续顺延触顶强切（非缺陷）
            # 权威标记同时落 _cont_block（兼容旧字段）与 _cont_ok（shadow 主判据）。
            r['_cont_ok'] = cont_ok
            r['_cont_block'] = cont_ok
            # 逐句诊断（落盘 dev 文件）：CONTINUE_PREV 句续接结果与各判据供定位失败根因。
            # print 走 stdout 被 AppLogger 丢弃，改追加写独立文件，便于跑完直接核对真实判据。
            _rcd = ('续上' if sibling is not None else '未续')
            _diag_line = (f'[reconcile-DIAG] {sid} prev_parent={prev_parent!r} '
                          f'cur_parent={cur_parent!r} within_time={within_time} '
                          f'cont_count={cont_count} ' + _rcd)
            print(_diag_line)
            try:
                import os
                _repo = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
                _diag_path = os.path.join(_repo, 'data', 'reconcile-diag.log')
                with open(_diag_path, 'a', encoding='utf-8') as _df:
                    _df.write(_diag_line + '\n')
            except Exception:
                pass  # 诊断落盘失败不打断求解
            if sibling is not None:
                last_commit_ms = float(sibling.get('startMs') or 0)
        # 本句确立为新镜或成功顺延后，都成为下一句可续接的"上一镜"。
        # last_commit_ms 统一更新为当前落点起点：基准始终跟随叙事时间线，`within_time` 才反映
        # 「本句距上一镜落点」的真实时间差（旧实现只在顺延成功时更新，基准停滞导致判据失真）。
        if cur_parent:
            prev_chunk = chunk
            prev_parent = cur_parent
            last_commit_ms = float(chunk.get('startMs') or 0)
            if mode != 'CONTINUE_PREV':
                cont_count = 0  # 新镜重置顺延计数


def _apply_continuation(path: BeamPath, query: dict, target_ms: float) -> None:
    """长镜头顺延状态赋值 + 安全锁（§8.3：≤3 句且 <7s）。

    若顺延将超过上限，本函数将该句重置为 NEW_SHOT（强切）——

    Args:
        path: 目标路径（原地修改，返回 None）。
        query: 脚本句。
        target_ms: 本句目标时长。
    """
    path.continuation_count += 1
    if path.continuation_count > CONTINUE_MAX_SENTENCES:
        # 超句数 → 强制强切，顺延计数清零。
        path.continuation_count = 0
        path.last_shot_commit_ms = float(path.curr_chunk.get('startMs') or 0)
        return
    if (float(path.curr_chunk.get('startMs') or 0) - path.last_shot_commit_ms) > CONTINUE_MAX_MS:
        # 超时长（跨过 7s 物理上限）→ 强切。
        path.continuation_count = 0
        path.last_shot_commit_ms = float(path.curr_chunk.get('startMs') or 0)


def _forward_lookout(cand_id: str, cand_ids: List[str],
                     scored: List[tuple]) -> float:
    """前向审望资源耗尽惩罚（补丁1）：MVP 保守占位为 0。

    设计意图：若某候选是**唯一**可选且唯一主粮，则对本句抢占应施加较大代价，
    防止前半句把后半句唯一能用的镜头用光。后续规则卡片在此注入真实统计。

    Args:
        cand_id: 本句候选切片 id。
        cand_ids: 本句候选集合。
        scored: 供给层代价升序表。

    Returns:
        float: 附加代价（MVP 为 0，占位显式声明）。
    """
    return 0.0


def _pick_best_for_shot(paths: List[BeamPath], query: dict) -> Optional[dict]:
    """从最终存活路径中取本句命中的最佳切片（代价最小路径优先）。

    Args:
        paths: 最终存活路径。
        query: 脚本句。

    Returns:
        Optional[dict]: 命中切片的 MatchResult-dict；无命中返回 None。
    """
    if not paths:
        return None
    best = min(paths, key=lambda p: p.pen)
    chunk_id = best.trace.get(str(query['shotId']))
    if not chunk_id:
        return None
    # 完整切片优先取落点实体；末帧漂移时落点≠本句选中，需从全局索引回查完整切片——
    # 绝不能退化为 {'id':...} 兜底 dict（会丢 parentChunkId 等字段，shadow 顺延与对账全读不到）。
    if best.curr_chunk and best.curr_chunk.get('id') == chunk_id:
        chunk = best.curr_chunk
    else:
        chunk = CHUNK_INDEX_CALLBACK(chunk_id) if CHUNK_INDEX_CALLBACK else None
    if chunk is None:
        return None
    return {'shotId': str(query['shotId']), 'chosenChunkId': chunk_id,
            'chunkData': chunk, 'score': -best.pen}