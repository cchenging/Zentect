# -*- coding: utf-8 -*-
"""
beam_search.py —— 受限束搜索前向排产（§8.2 / §9，Q1/Q2 准绳落地）

定位：
  - 本模块是**调度层**（scheduling），**不产生**贴合判断；第一句候选集合及其代价
    由**供给层**（MatchCost，两层次串行 R1）预计算后注入。
  - 输入：标准候选池（build_context.CandidateContext）+ 每句命中代价矩阵
    （query,chunk）与规则集（rules/）。输出：逐句命中的 MatchResult 装配。

状态与算法（§8.2-项4 写死）：
  状态 ⟨current_chunk_id, win_cursor_ms, prev_shot_scale, continuation_count⟩
  束宽 Beam=3；候选代价注入满足时仍守恒选择；逐句前向推进。
  受限点：
    · 掩码（补丁6，粒度 = **镜头 + 时间窗**，P4 修正）：逐镜头维护本路径的**下一窗入点游标**
      （`BeamPath.win_cursor_ms`，跨场不清零 ⇒ 历史归全局黑名单）。同一镜头可被多句复用，
      但每句只开**新窗**（入点 = 上句窗末 ⇒ 窗序号严格递增，同镜同窗结构性禁复用，防 PPT 化）；
      「Σ 窗长 ≤ 镜头时长」按「剩余窗长 ≥ 本句窗长」判定（`_win_exhausted`），窗用尽则
      该镜头后续句不得再选 —— 杜绝回滚重取 a→b 段（§1.2 剪辑师基准：起点单调不减）。
    · 多样性剪枝（补丁6）：每一层保留的 3 条路径**末端切片互异**，杜绝微小变体霸位。
    · 前向审望资源耗尽惩罚（补丁1）：本句若抢占后句唯一关键主粮，施加过高代价抑制。

关键分解（Q2「少 if 分叉、一个方法只做一件事」）：
    · 违反即 ∞ 的硬门禁（Tier1，补丁21）：长镜头物理单向锁 / 视线跳轴 / 空镜昼夜介质 / 稀有物料强占
    · 仅累加的软阻尼（Tier2，补丁21）：同机位跳斩 / 心跳阻尼 / 景别律动 / 动静
    · 跨场硬清算（补丁19）：文案跨 segmentId 时收敛 Top-1 作唯一物理前驱。
    · 长镜头顺延安全锁（§8.3 + 缺陷2 真配额）：CONTINUE_PREV 句连续顺延 ≤3 句（安全上限）、
      累计窗长 <7s、且 Σ 窗长 ≤ 镜头可用时长，任一越界即强切。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional

from build_context import CandidateContext
from montage_contract import ContractError, has_motion_contrast

# 一票否决的硬门禁代价（补丁21 Tier1）——任何规则返回此值即弃选。
HARD_DENY_COST = float('inf')
# 熔断降级段置信度封顶（落码点2，承接不虚高，对齐 legacy `min(0.85, _prev_conf)` 口径）：
#   一级 hard_relax / 三级 all_beam_death 强挂的候选并非「合法贴合命中」，不得报出「已确认」级
#   置信度（消费端 0.88 阈值下自动判未确认），否则降级段伪装成高可信匹配、掩盖真实贴合缺口。
DEGRADED_CONF_CAP = 0.85
# 长镜头顺延上限（§8.3 无 PPT 化）：连续顺延句数与累计时长。
CONTINUE_MAX_SENTENCES = 3
CONTINUE_MAX_MS = 7000
# 缺陷2 修法（2026-09-30）：顺延真实配额 = floor(镜头可用时长 / 该句所需窗长)，
#   `CONTINUE_MAX_SENTENCES` 降级为**安全上限**（防单镜垄断全片）。逐父镜头累计已承载窗长，
#   与本镜头可用时长比较；0.5ms 仅吸收浮点误差、不放大配额。
CONTINUE_QUOTA_EPS = 0.5
# 窗长缺省口径（P4 镜头+时间窗）：句缺配音时长时按 3s 占一个真实窗 —— 与取料层
#   `SemanticAnalyzeStrategy.buildShotWindowTable` 的 `DEFAULT_WINDOW_MS` 同口径。
#   若按 0 计，窗游标不动 ⇒ 同镜同窗被反复复用（防 PPT 化失效）且窗永不耗尽（镜头可无限吃句）。
WINDOW_FALLBACK_MS = 3000.0
# 长镜头顺延（§4.3/§4.4 拆后门）：CONTINUE_PREV 句的「上一镜」由 build_context 并入本句候选池，
# 在束搜索主核内**镜头级正常参与**——CONTINUE_PREF 同父软偏好 + 镜头窗掩码 + 顺延安全锁共同
# 裁决，求解后不再有独立对账后门；顺延分类（_cont_ok）在装配期由束内真实落点直接判定。
# 束宽（补丁1 写死）。
BEAM_WIDTH = 3

# CONTINUE_PREV 句的主解同父软偏好（软阻尼负向，非硬切）：当本句被场景断言为顺延上一镜
# 且候选与上一镜父镜头一致时，适当降低其成本，使其在“尚未被前句占用”时倾向继续父镜头，
# 从源头保证同父延续（上一镜已在候选池内，无需后置对账）。仅本句候选间相对排序生效，
# 不跨句、不影响前序句，故不会被全局 DP“劫持”NEW_SHOT 句的选取。数值需小于硬门禁、
# 大于仅微差语义抖动。
CONTINUE_PREF = 0.3
# 跨新父源时间邻近软惩罚（P0 时序）：切到新父镜头时，若候选源时间距上一镜落点过远（大跨度
# 跳闪），施加软阻尼让其远离。软阻尼不硬否决（与 Tier-1 硬门禁区分）、上限封顶以免压过语义主分，
# 可经 env `ZENTECT_KM_TIME_PROX` 关闭（0=回退纯语义，缺省 0.5）。窗口/斜率见 `_src_time_prox`。
TIME_PROX_SOFT_MAX = 0.5
TIME_PROX_WINDOW_MS = 4000.0
TIME_PROX_RAMP_MS = 12000.0

# 前向审望资源耗尽惩罚（补丁1，env `ZENTECT_KM_FORWARD_LOOKOUT`，缺省 0=关闭）：
#   本句若抢占「后句唯一可用主粮」，后半句就断供（无料可用）。前瞻窗口内逐句统计该候选在
#   未来句候选池里的剩余可用数 rem（按本路径窗游标计：该镜剩余窗长 ≥ 该未来句窗长即算可用）：
#     rem == 1 → 唯一主粮（本句抢走即后句归零）→ 罚 FORWARD_LOOKOUT_SOLE_MAX；
#     rem == 2 → 濒危（仅剩一席余量，语言学抖动即可压空）→ 罚 FORWARD_LOOKOUT_SCARCE_MAX。
#   逐未来句累加、整趟封顶；纯统计零模型；缺省关 ⇒ 零行为变化、可一键回退（置 0）。
FORWARD_LOOKOUT_SENTENCES = 5
FORWARD_LOOKOUT_SOLE_MAX = 1.2
FORWARD_LOOKOUT_SCARCE_MAX = 0.4
FORWARD_LOOKOUT_TOTAL_MAX = 2.0


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
        win_cursor_ms: 掩码（补丁6，粒度 = **镜头 + 时间窗**）—— {镜头键: 下一窗入点游标 ms}。
            只增不减（跨场不清零）：同一镜头可被多句复用，但每句只开**新窗**（入点 = 上句窗末，
            窗序号严格递增 ⇒ 同镜同窗结构性禁复用）；游标触及镜头末 ⇒ 该镜头用尽、后续句不得再选。
            兄弟路径各持独立副本（`build_path` 拷贝），互不污染。
        prev_scale: 上一镜景别（转移代价输入）。
        continuation_count: 自末次 NEW_SHOT 起连续顺延句数。
        last_shot_commit_ms: 末次强切/新镜的落点时间（顺延 7s 判据）。
        scene_id: 当前所处场次。
        pen: 累计软阻尼代价。
        trace: {shotId: chunkId} 装配痕迹。
    """
    curr_chunk_id: Optional[str] = None
    curr_chunk: Optional[dict] = None
    win_cursor_ms: Dict[str, float] = field(default_factory=dict)
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
               entry_ms: float, need_ms: float) -> BeamPath:
    """造一条落在 chunk 上的新路径（供展开层调用，不掺规则）。

    P4 掩码推进（粒度 = 镜头 + 时间窗）：本句在该镜头上开了一个**新窗**，子路径把父路径的
    窗游标推进到本窗末（`min(镜头末, 入点 + 窗长)`，只增不减）。游标只增 ⇒ 同镜同窗结构性
    禁复用（防 PPT 化）；游标触及镜头末 ⇒ 掩码用尽，后续句在该镜头上开不出窗
    （门禁见 `_win_exhausted`），兑现 §1.2「同一镜头多句复用时窗口单调前移」且 Σ 窗长 ≤ 镜头时长。

    Args:
        path: 父路径。
        chunk: 新落点切片（P4 后即物理镜头本体）。
        shot_id: 本句 id。
        scene_id: 本句所属场次。
        entry_ms: 本窗入点（源 ms；首句 = 命中帧强锚/镜头起点，顺延 = 上句窗末）。
        need_ms: 本窗窗长（本句配音时长；缺失按 `WINDOW_FALLBACK_MS`）。

    Returns:
        BeamPath: 子路径（输出到链末）。
    """
    _key = _shot_key(chunk)
    _s0 = float(chunk.get('startMs') or 0.0)
    _e0 = float(chunk.get('endMs') or 0.0)
    _win_cursor = dict(path.win_cursor_ms)
    _cursor_new = float(entry_ms) + float(need_ms)
    if _e0 > _s0:
        # 余量不足整窗 ⇒ 只把游标推到镜头末（取料层按新窗重算变速，与 TS clamp 同口径）。
        _cursor_new = min(max(_cursor_new, _s0), _e0)
    _win_cursor[_key] = max(float(path.win_cursor_ms.get(_key, _s0)), _cursor_new)
    new_path = BeamPath(
        curr_chunk_id=chunk.get('id'),
        curr_chunk=chunk,
        win_cursor_ms=_win_cursor,
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
            # 缺陷2：本镜头已承载的顺延窗长累计（换镜头由 _apply_continuation 归零）。
            'cont_used_ms': float(path.state.get('cont_used_ms', 0.0)),
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


def _shot_key(chunk: dict) -> str:
    """镜头键（P4 键域 = **镜头 id**）：候选单元已收敛为物理镜头（`parentChunkId` = 自身
    scene id），取 `parentChunkId` 优先、退回自身 id —— 两者在 P4 后同指该镜头；对无父字段的
    切片退回自身 id，保证同一镜头恒映射到同一键（掩码/状态/规则卡共用同一键域）。
    """
    return str(chunk.get('parentChunkId') or chunk.get('id') or '')


def _win_need_ms(target_ms) -> float:
    """本句所需窗长（ms）：配音时长缺失/非正时按 `WINDOW_FALLBACK_MS` 占一个真实窗。

    与取料层 `buildShotWindowTable` 的 `neededMs > EPS ? neededMs : DEFAULT_WINDOW_MS` 同口径。
    """
    v = float(target_ms or 0.0)
    return v if v > 0.0 else WINDOW_FALLBACK_MS


def _win_residual_ms(chunk: dict, cursor: Optional[float]) -> float:
    """本镜剩余可开窗时长（ms）：入点 = 本路径窗游标（未开窗时按镜头起点），余量 = 镜头末 − 入点。

    `endMs` 缺失（≤ `startMs`）时无从按游标扣减，退回该切片的可用时长口径（`_chunk_avail_ms`）。
    """
    s0 = float(chunk.get('startMs') or 0.0)
    e0 = float(chunk.get('endMs') or 0.0)
    if e0 <= s0:
        return _chunk_avail_ms(chunk)
    entry = s0 if cursor is None else max(float(cursor), s0)
    return max(0.0, e0 - entry)


def _win_exhausted(chunk: dict, cursor: Optional[float], need_ms: float) -> bool:
    """掩码门禁（补丁6，P4 粒度 = 镜头 + 时间窗）：该镜窗用尽 ⇒ 本句不得再选。

    判据：本路径已在该镜开过窗（游标有值）、且剩余窗长 < 本句所需窗长
    （即 Σ 窗长 + 本句窗长 已越过镜头时长）。首窗（游标无值）不预判 —— 首窗入点由取料层按
    命中帧定、余量不足时截短而非弃选；时长字段缺失（可用时长 ≤ 0）时「无从约束」不误杀。
    """
    if cursor is None or _chunk_avail_ms(chunk) <= 0.0:
        return False
    return _win_residual_ms(chunk, cursor) < float(need_ms) - CONTINUE_QUOTA_EPS


def _win_entry_ms(path: BeamPath, chunk: dict, anchor_ms: Optional[float]) -> float:
    """本句在该镜头上开窗的入点（源 ms）。

    优先本路径窗游标（= 上句窗末 ⇒ 顺延，只增不减）；否则取命中帧强锚（**锚点须确在本镜头
    区间内**，跨界锚不得借用 —— 错就错，不造假入点）；再退回镜头起点。取料层
    `buildShotWindowTable.allocate` 按同一口径（cursor ?? hit ?? startMs）开窗，两侧入点一致。

    Args:
        path: 本路径（读 `win_cursor_ms`）。
        chunk: 本句候选镜头。
        anchor_ms: 本句真实参考帧时间（仅 matched 强锚 / 开关 on 的 block_first 弱锚非 None）。

    Returns:
        float: 本窗入点（源 ms）。
    """
    s0 = float(chunk.get('startMs') or 0.0)
    cursor = path.win_cursor_ms.get(_shot_key(chunk))
    if cursor is not None:
        return max(float(cursor), s0)
    if anchor_ms is not None:
        a = float(anchor_ms)
        e0 = float(chunk.get('endMs') or 0.0)
        if a >= s0 and (e0 <= s0 or a <= e0):
            return a
    return s0


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
    # 装配期切片回查：注入全局索引，供 _pick_best_for_shot 末帧漂移时取完整切片（含 parentChunkId）。
    global CHUNK_INDEX_CALLBACK
    CHUNK_INDEX_CALLBACK = ctx.chunk_by_id.get
    # K1 熔断标记：{shotId: 熔断层级}，最终结果据此打 isDegraded + degradeKind。
    degraded_marks: Dict[str, str] = {}
    # 掩码（补丁6，P4 粒度 = 镜头 + 时间窗）落在每条路径的 `BeamPath.win_cursor_ms`
    # （{镜头键: 下一窗入点}，只增不减、跨场不清零），不再有全局位掩码索引。
    # 前向审望（补丁1）开关与诊断计数：缺省 0 = 关闭（零行为变化档，置 0 即一键回退）。
    # 整趟只读一次 env，避免逐候选重复读；off 档不构造前瞻池、不累加计数（零开销）。
    fl_weight = _read_forward_lookout()
    # 顺延权重生效诊断（A/B 复测，2026-10-15，临时）：一次打印「生效权重 + 本 run CONTINUE_PREV 句数」，
    # 用于区分「env 未生效」与「该项目无 CONTINUE_PREV 可顺延」两类 A/B 零变化成因。验证后可整块删除。
    _fl_diag('[continue-pref] 生效权重=%.2f ｜ CONTINUE_PREV=%d/%d' % (
        _read_continue_pref(),
        sum(1 for _q in ctx.queries if str(_q.get('shotMode') or '') == 'CONTINUE_PREV'),
        len(ctx.queries),
    ))
    fl_stats: Dict[str, int] = {'hits': 0, 'cost': 0.0, 'step': 0, 'pool_empty': 0,
                                'probe': 0, 'guard': 0, 'miss_pool': 0, 'wide': 0,
                                'scarce': 0, 'sole': 0}
    # 弱锚接线（丙①，落码点3）开关与诊断计数：缺省 off = 零行为变化（block_first 锚仍不参与）。
    #   集合按 shotId 去重计数（_expand_paths 熔断时会被多次调用，直接计数会虚高）。
    _block_anchor = _read_block_anchor()
    _anc_shots: set = set()

    for qi, query in enumerate(ctx.queries):
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
        # 前向审望（补丁1）前瞻池：仅开关 on 时构造（off 档零开销、零行为变化）。
        future_pools = (_forward_lookout_pools(ctx.queries, ctx.cands_by_shotid, qi,
                                               tts_duration_ms)
                        if fl_weight > 0.0 else [])
        if fl_weight > 0.0:
            # 诊断：空池步占比——区分「窗口内后句压根没候选池」与「未相交/池宽裕」两类零命中根因。
            _bump(fl_stats, 'step')
            if not future_pools:
                _bump(fl_stats, 'pool_empty')

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
            # 本句所需窗长：配音时长缺失按 WINDOW_FALLBACK_MS 占一个真实窗（与取料层同口径）。
            _need = _win_need_ms(tts_duration_ms.get(sid))
            # 强锚解析（B域动作3）：matched 强锚恒生效；block_first（母块首帧，真实源坐标）为**弱锚**，
            #   仅在开关 on 时接线（丙①，落码点3）。须先于规则执行——补丁11 单向锁按「本窗入点」判据
            #   （由 rctx['entryMs'] 注入）。弱锚只改单向锁起算点，不掺任何代价/门禁。
            _anchor_ms = None
            _rf = float(query.get('refFrameTimeMs') or 0)
            if _rf > 0:
                _src_kind = str(query.get('refFrameSource') or '')
                if _src_kind == 'matched':
                    _anchor_ms = _rf
                elif _src_kind == 'block_first' and _block_anchor:
                    _anchor_ms = _rf
                    _anc_shots.add(sid)
            for path in paths:
                prev_chunk = path.curr_chunk
                for cand_id, base_cost in scored:
                    cand = ctx.chunk_by_id[cand_id]
                    # 掩码（补丁6，粒度 = 镜头 + 时间窗）：本路径已在该镜开过窗且**剩余窗长不足本句窗长**
                    #   ⇒ 该镜窗用尽，本句不得再选。force=True（三级熔断）忽略掩码，确保「绝不白屏」。
                    if not force and _win_exhausted(
                            cand, path.win_cursor_ms.get(_shot_key(cand)), _need):
                        continue
                    # 本窗入点（源 ms）：路径游标 ?? 命中帧强锚（须确在本镜内）?? 镜头起点，
                    #   与取料层 `buildShotWindowTable.allocate` 同口径（两侧开窗起点一致）。
                    entry = _win_entry_ms(path, cand, _anchor_ms)
                    total = base_cost
                    if not force:
                        # 规则上下文：state / 句 / 跨场首步标记 / 本窗入点（规则卡只读，Δ_advance 写入）。
                        rctx = {'state': path.state, 'query': query,
                                'is_scene_first': is_scene_first, 'entryMs': entry}
                        total += _apply_tier_hard_and_soft(active_rules, prev_chunk, cand, rctx)
                        if total >= HARD_DENY_COST:
                            continue
                        # 前向审望资源耗尽惩罚（补丁1）：本句抢占后句唯一/濒危主粮时加软阻尼，
                        # 把机会留给后句。开关 off 档恒 0（见 _read_forward_lookout）。
                        if fl_weight > 0.0:
                            _fl = _forward_lookout(cand_id, future_pools, path.win_cursor_ms,
                                                   ctx.chunk_by_id, fl_weight, stats=fl_stats)
                            total += _fl
                            if _fl > 0.0:
                                fl_stats['hits'] += 1
                                fl_stats['cost'] += _fl
                        # 跨新父源时间邻近软惩罚（P0 时序）：切到新父且源时间远距上一镜落点则加阻尼。
                        #   只改候选间相对排序，不改束路径推进；权重经 env 可关（A/B 复测）。
                        _tp_w = _read_time_prox()
                        if _tp_w > 0.0:
                            _tp = _src_time_prox(prev_chunk, cand)
                            if _tp > 0.0:
                                # 用权重缩放（缺省 1.0，线性加权），确保默认即生效、可整档关闭。
                                total += _tp * _tp_w
                        # CONTINUE_PREV 同父软偏好：仅对断言顺延上一镜的句生效。候选与上一镜
                        # 父镜头一致时降成本，从源头延续同父（reconcile 兜底）。prev_chunk 即
                        # path.curr_chunk——对每条第路径独立判断，故只影响本句候选间排序。
                        if str(query.get('shotMode') or '') == 'CONTINUE_PREV' and prev_chunk:
                            if prev_chunk.get('parentChunkId') and \
                                    prev_chunk.get('parentChunkId') == cand.get('parentChunkId'):
                                total -= _read_continue_pref()
                    child = build_path(path, cand, sid, scene, entry, _need)
                    # D 域状态推进（补丁11 单向锁 / 补丁13 心跳疲劳），写在子路径副本上。
                    _advance_state(child, prev_chunk, cand, entry)
                    # 长镜头顺延状态继承（CONTINUE_PREV 由模式/规则层驱动真实赋值）。
                    if str(query.get('shotMode') or '') == 'CONTINUE_PREV':
                        _apply_continuation(child, query, tts_duration_ms.get(sid, 0.0), prev_chunk)
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
        chosen = _pick_best_for_shot(paths, query, match_cost.get(sid))
        if chosen:
            # K1：熔断降级句强标记 isDegraded + 熔断层级（供 shadow 对账 / UI「待确认」徽标）。
            if sid in degraded_marks:
                chosen['isDegraded'] = True
                chosen['degradeKind'] = degraded_marks[sid]
                # 承接不虚高（落码点2）：熔断强挂的候选置信度封顶，消费端 0.88 阈值下自动判未确认。
                chosen['confidence'] = round(
                    min(float(chosen.get('confidence') or 0.0), DEGRADED_CONF_CAP), 4)
                chosen['score'] = chosen['confidence']
            results[sid] = chosen

    # 顺延分类（§4.4 拆后门）：CONTINUE_PREV 句已在束搜索主核内「镜头级正常参与」——
    # 上一镜经 build_context 并入本句候选池 + CONTINUE_PREF 同父软偏好 + 镜头窗掩码
    # `_win_exhausted` + 安全锁 `_apply_continuation` 共同裁决，求解落点即最终解。
    # 此处仅按叙事行序把**束内真实落点**如实翻译为消费端权威分类，绝不改写选片。
    _classify_continuation(ctx, results, tts_duration_ms)

    # 前向审望（补丁1）诊断：仅开关 on 时输出（off 档日志零变化，符合「缺省零行为变化」）。
    if fl_weight > 0.0:
        _fl_diag(f'[forward-lookout] 补丁1 前瞻惩罚 on(weight={fl_weight}) '
                 f'窗口={FORWARD_LOOKOUT_SENTENCES}句 句数={len(ctx.queries)} '
                 f'命中候选={fl_stats["hits"]} 累计代价={round(fl_stats["cost"], 3)} ｜ '
                 f'探针={fl_stats["probe"]} 守卫={fl_stats["guard"]} '
                 f'未相交={fl_stats["miss_pool"]} 宽裕={fl_stats["wide"]} '
                 f'濒危={fl_stats["scarce"]} 唯一={fl_stats["sole"]} ｜ '
                 f'空池步={fl_stats["pool_empty"]}/{fl_stats["step"]}')

    # 弱锚接线（丙①，落码点3）诊断：仅开关 on 时输出（off 档日志零变化），与前瞻诊断同落盘口。
    if _block_anchor:
        _fl_diag(f'[block-anchor] 丙① 弱锚接线 on：block_first 句实际锚定 {len(_anc_shots)} 句'
                 f'（matched 强锚不受影响；仅改补丁11 单向锁起算点，不掺代价/门禁）')

    return results


# ===========================================================================
# 子函数（长镜头顺延 / 前向审望 / 结果装配）
# ===========================================================================
def _advance_state(path: BeamPath, prev_chunk: Optional[dict], cand: dict,
                   entry_ms: float) -> None:
    """推进束路径的 D 域状态（补丁11 单向锁 / 补丁13 心跳疲劳）。

    只写在 `path.state` 副本上（build_path 已深拷贝），绝不影响父/兄弟路径。
    规则卡只读本状态，状态推进集中在此单一方法（守「一个方法只做一件事」）。

    B域（§10.2.3 动作3）：补丁11 `maxConsumedTimeMs` 起算点从「切片 startMs」
    改为「**本窗入点**」（`entry_ms`，P4 粒度 = 镜头 + 时间窗）——键域由段 id 收到镜头 id
    （`_shot_key`），基准贴着真实开窗位置（命中帧强锚 ?? 路径游标 ?? 镜头起点）走，
    使单向锁与取料层开窗口径同源（取料层按同一入点开窗）。

    Args:
        path: 目标路径（原地修改 state，返回 None）。
        prev_chunk: 前一镜切片（首镜为 None）。
        cand: 当前落点镜头。
        entry_ms: 本窗入点（源 ms，`_win_entry_ms` 产出）。
    """
    state = path.state
    # -- 补丁11 同源物理单向锁：记录同镜头已消费的最远**窗入点** --
    pid = _shot_key(cand)
    c_start = float(cand.get('startMs') or 0.0)
    _base = float(entry_ms) if entry_ms is not None else c_start
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


def _chunk_avail_ms(chunk: dict) -> float:
    """切片/镜头的可用时长（ms）：优先显式时长字段，回退 `endMs − startMs`。

    用于缺陷2 顺延配额（`floor(镜头可用时长 / 该句所需窗长)`）与 7s 物理锁的时长基准。

    Args:
        chunk: 切片资产（含 durationMs/availableMs/startMs/endMs）。

    Returns:
        float: 可用时长（≥0）；字段皆缺时返回 0（调用方视作「无从约束」）。
    """
    for k in ('availableMs', 'durationMs'):
        v = float(chunk.get(k) or 0)
        if v > 0:
            return v
    s = float(chunk.get('startMs') or 0.0)
    e = float(chunk.get('endMs') or 0.0)
    return max(e - s, 0.0)


def _parent_avail_ms(chunk_by_id: Dict[str, dict]) -> Dict[str, float]:
    """逐镜头可用总时长：其全部切片的源时间跨度 `max(endMs) − min(startMs)`。

    P4 后候选单元=605 物理镜头（键域 = 镜头 id，`_shot_key` 与 `parentChunkId` 同指）时
    即该镜头自身时长；旧段级结构下即母块全跨度（长镜头真实可承载时长）。
    缺 `endMs` 的切片按其自身可用时长外推。

    Args:
        chunk_by_id: 切片资产索引。

    Returns:
        Dict[str, float]: {镜头键: 可用总时长 ms}。
    """
    lo: Dict[str, float] = {}
    hi: Dict[str, float] = {}
    for c in chunk_by_id.values():
        pid = _shot_key(c)
        if not pid:
            continue
        s = float(c.get('startMs') or 0.0)
        e = float(c.get('endMs') or 0.0)
        if e <= 0:
            e = s + _chunk_avail_ms(c)
        if pid not in lo or s < lo[pid]:
            lo[pid] = s
        if pid not in hi or e > hi[pid]:
            hi[pid] = e
    return {pid: max(hi[pid] - lo[pid], 0.0) for pid in lo}


def _classify_continuation(
    ctx: CandidateContext,
    results: Dict[str, dict],
    tts_duration_ms: Dict[str, float],
) -> None:
    """顺延分类（§4.4 拆后门）：把束内**真实落点**如实翻译为消费端权威 `_cont_ok`。

    CONTINUE_PREV 句已在束搜索主核内「镜头级正常参与」——上一镜经 build_context 并入本句
    候选池、`CONTINUE_PREF` 同父软偏好、镜头窗掩码 `_win_exhausted`、安全锁
    `_apply_continuation` 共同裁决，求解落点即最终解。本函数**只读不改**（绝不回写
    chosenChunkId/chunkData/confidence），按叙事行序把每句落点同父与否翻译为六值分类，
    供 shadow 对账消除「数组相邻项读父」误差（CONTINUE_PREV 句之间常夹 NEW_SHOT，
    相邻项父 ≠ 语义上一镜父）。

    六值（与 montage_router 消费端口径一一对应）：
      · continued  = 落点与上一句同父（该续且续上，束内正常参与的直接结果）
      · same       = 兼容保留（本实现下同父即 continued；仅当外部注入时可能出现）
      · time_lock  = 未续因连续顺延累计窗长越 `CONTINUE_MAX_MS`（7s 物理锁，非缺陷）
      · quota_lock = 未续因上一镜窗配额用尽（缺陷2 真配额，非缺陷）
      · limit_3    = 未续因连续顺延句数触顶（`CONTINUE_MAX_SENTENCES` 安全上限，非缺陷）
      · fail       = 该续未续（真失败：非上述任一锁所致）

    归因判据按叙事行序重放：`cont_streak`/`cont_ms` 统计「连续同父顺延」的句数与累计窗长，
    `parent_used` 统计各镜头已承载窗长（含首窗，非顺延句开的第一个窗同样计入），
    任一锁越界即判对应非缺陷因，否则记 fail。

    Args:
        ctx: 标准候选池上下文（chunk_by_id 提供全量切片，queries 提供叙事行序 + shotMode）。
        results: 束搜索已装配结果（{shotId: MatchResult}，只读不改选片）。
        tts_duration_ms: 每句目标时长 {shotId: ms}。

    Returns:
        None（就地写 results 的 `_cont_ok` / `_cont_block`；不改其它字段）。
    """
    prev_parent = ''
    cont_streak = 0
    # 连续顺延累计窗长（7s 物理锁）：续上则累加，本句未续（新镜/强切）即归零。
    cont_ms = 0.0
    # 镜头窗配额（缺陷2）：逐镜头累计各句已开窗长，Σ ≤ 镜头可用时长（含首窗）。
    parent_avail = _parent_avail_ms(ctx.chunk_by_id)
    parent_used: Dict[str, float] = {}

    for query in ctx.queries:
        sid = str(query['shotId'])
        mode = str(query.get('shotMode') or '')
        _need_ms = _win_need_ms(tts_duration_ms.get(sid))
        r = results.get(sid)
        # 落点镜头：优先按 chosenChunkId 回查全局索引（_pick_best_for_shot 末帧漂移时
        # 已注入全局索引回调取完整切片，此回查为双保险）。
        chunk = None
        if r is not None:
            chunk = ctx.chunk_by_id.get(str(r.get('chosenChunkId') or '')) or r.get('chunkData')
        cur_parent = _shot_key(chunk) if chunk else ''
        cont_ok = ''

        if mode == 'CONTINUE_PREV' and prev_parent and chunk is not None:
            # 上一镜（prev_parent）窗配额：已承载窗长 + 本句窗长 ≤ 该镜头可用时长。
            _avail_ms = float(parent_avail.get(prev_parent, 0.0))
            _used_ms = float(parent_used.get(prev_parent, 0.0))
            if cur_parent == prev_parent:
                cont_ok = 'continued'                 # 该续且续上（落点同父）
            elif cont_ms > CONTINUE_MAX_MS:
                cont_ok = 'time_lock'                 # 7s 物理锁强切（非缺陷）
            elif _avail_ms > 0.0 and _used_ms + _need_ms > _avail_ms + CONTINUE_QUOTA_EPS:
                cont_ok = 'quota_lock'                # 缺陷2：上一镜可用时长已用尽（非缺陷）
            elif cont_streak >= CONTINUE_MAX_SENTENCES:
                cont_ok = 'limit_3'                   # 连续顺延触顶强切（非缺陷）
            else:
                cont_ok = 'fail'                      # 该续未续（真失败）
            # 权威标记同时落 _cont_block（兼容旧字段）与 _cont_ok（shadow 主判据）。
            r['_cont_ok'] = cont_ok
            r['_cont_block'] = cont_ok

        # 本句确立为新镜或成功顺延后，都成为下一句可续接的「上一镜」。
        if cur_parent:
            prev_parent = cur_parent
            parent_used[cur_parent] = float(parent_used.get(cur_parent, 0.0)) + _need_ms
        # 连续顺延计数：本句续上则延续加长，否则（新镜/强切/未续）归零重起算。
        if mode == 'CONTINUE_PREV' and cont_ok == 'continued':
            cont_streak += 1
            cont_ms += _need_ms
        else:
            cont_streak = 0
            cont_ms = 0.0


def _apply_continuation(path: BeamPath, query: dict, target_ms: float,
                        prev_chunk: Optional[dict] = None) -> None:
    """长镜头顺延状态赋值 + 安全锁（§8.3 + 缺陷2 修法）。

    三道锁（任一越界即强切，顺延计数与窗长累计清零）：
      · 句数安全上限 `CONTINUE_MAX_SENTENCES`（防单镜垄断全片，由「真配额」降级而来）；
      · **真配额**（缺陷2）：本镜头累计承载窗长 + 本句窗长 > 镜头可用时长 ⇒ 镜头窗用尽；
      · 7s 物理锁：本句落点起点距末次强切 > `CONTINUE_MAX_MS`。

    换镜头（`prev_chunk.id != curr.id`）时窗长累计归零——新镜头重新起算配额。

    Args:
        path: 目标路径（原地修改，返回 None）。
        query: 脚本句。
        target_ms: 本句目标时长（该句所需窗长）。
        prev_chunk: 上一镜切片（用于识别是否换镜头；None 时按换镜处理）。
    """
    cid_now = str(path.curr_chunk.get('id') or '')
    cid_prev = str((prev_chunk or {}).get('id') or '')
    if cid_prev and cid_now != cid_prev:
        # 换镜头 → 本镜头顺延承载窗长重新起算（配额按镜头各自独立）。
        path.state['cont_used_ms'] = 0.0
    _used = float(path.state.get('cont_used_ms', 0.0)) + max(float(target_ms or 0.0), 0.0)
    _avail = _chunk_avail_ms(path.curr_chunk)

    path.continuation_count += 1
    if path.continuation_count > CONTINUE_MAX_SENTENCES \
            or (_avail > 0 and _used > _avail + CONTINUE_QUOTA_EPS):
        # 超安全上限 / 镜头可用时长用尽 → 强制强切，顺延计数与窗长累计清零。
        path.continuation_count = 0
        path.state['cont_used_ms'] = 0.0
        path.last_shot_commit_ms = float(path.curr_chunk.get('startMs') or 0)
        return
    path.state['cont_used_ms'] = _used
    if (float(path.curr_chunk.get('startMs') or 0) - path.last_shot_commit_ms) > CONTINUE_MAX_MS:
        # 超时长（跨过 7s 物理上限）→ 强切。
        path.continuation_count = 0
        path.state['cont_used_ms'] = 0.0
        path.last_shot_commit_ms = float(path.curr_chunk.get('startMs') or 0)


def _read_time_prox() -> float:
    """读取跨新父源时间邻近软惩罚开关（env `ZENTECT_KM_TIME_PROX`，缺省 1.0）。

    0 → 回退纯语义时序（A/B 复测用）；1.0 → 全量施加；中间数值线性缩放阻尼。
    非法值错就错地落 0（不豁免不造假）。

    Returns:
        float: [0, +∞) 的软惩罚权重（0 表示关闭）。
    """
    import os
    raw = os.environ.get('ZENTECT_KM_TIME_PROX', '1.0')
    try:
        w = float(raw)
    except (TypeError, ValueError):
        w = 0.0  # 非法值：不豁免也不造假，按关闭处理（交由主流程暴露）
    return max(0.0, w)


def _read_continue_pref() -> float:
    """读取 CONTINUE_PREV 同父软偏好权重（env `ZENTECT_CONTINUE_PREF`，缺省 0.3）。

    A/B 复测用：调高 ⇒ 更强倾向顺延上一镜（压过更大的语义差）；0 ⇒ 关闭顺延偏好。
    非法值错就错地落回缺省（不豁免不造假）。

    Returns:
        float: [0, +∞) 的顺延偏好权重。
    """
    import os
    raw = os.environ.get('ZENTECT_CONTINUE_PREF', '')
    try:
        return max(0.0, float(raw)) if raw != '' else CONTINUE_PREF
    except (TypeError, ValueError):
        return CONTINUE_PREF


def _src_time_prox(prev_chunk: Optional[dict], cand: dict) -> float:
    """跨新父源时间邻近软惩罚（P0 时序）。

    只有当候选与上一镜**父镜头不同**（真正切镜）时才施加；同父顺延交给 COMMON_DIE 续接机制，
    不在此重复。判据用源时间窗起点差 `|cand.startMs - prev.startMs|`：
      - ≤ TIME_PROX_WINDOW_MS（4s）：视为邻近，零惩罚（镜头间自然过渡不被干扰）；
      - 4s~16s：线性爬升到 TIME_PROX_SOFT_MAX；
      - ≥ 16s：封顶 TIME_PROX_SOFT_MAX（软阻尼封顶，绝不压过语义主分）。
    上下行均对称取绝对值，避免「时间回跳」被单独豁免。

    Args:
        prev_chunk: 上一镜切片（束路径当前落点）；首镜/缺失时返回 0（无从比较）。
        cand: 本句候选切片。

    Returns:
        float: 附加到 transition cost 的软惩罚（0 表示不计或邻近不罚）。
    """
    if prev_chunk is None or cand is None:
        return 0.0
    p_parent = _shot_key(prev_chunk)
    c_parent = _shot_key(cand)
    if p_parent and c_parent and p_parent == c_parent:
        return 0.0  # 同镜：不在此处理（交顺延/续接机制）
    p_start = float(prev_chunk.get('startMs') or 0.0)
    c_start = float(cand.get('startMs') or 0.0)
    if not (p_start > 0 and c_start > 0):
        return 0.0
    gap = abs(c_start - p_start)
    if gap <= TIME_PROX_WINDOW_MS:
        return 0.0
    ramp = TIME_PROX_WINDOW_MS + TIME_PROX_RAMP_MS  # 4s + 12s = 16s 封顶
    return min(TIME_PROX_SOFT_MAX, TIME_PROX_SOFT_MAX * (gap - TIME_PROX_WINDOW_MS) / ramp)


def _read_forward_lookout() -> float:
    """读取前向审望资源耗尽惩罚开关（env `ZENTECT_KM_FORWARD_LOOKOUT`，缺省 0）。

    0 → 关闭（缺省档，零行为变化、可一键回退）；>0 → 按权重线性缩放惩罚值。
    非法值错就错地落 0（不豁免、不造假，交由主流程诊断行暴露）。

    Returns:
        float: [0, +∞) 的惩罚权重（0 表示关闭）。
    """
    import os
    raw = os.environ.get('ZENTECT_KM_FORWARD_LOOKOUT', '0')
    try:
        w = float(raw)
    except (TypeError, ValueError):
        w = 0.0  # 非法值：按关闭处理（不豁免也不造假）
    return max(0.0, w)


def _read_block_anchor() -> bool:
    """读取「母块首帧弱锚」接线开关（env `ZENTECT_KM_BLOCK_ANCHOR`，缺省 off）。

    off（缺省）= 零行为变化：`refFrameSource='block_first'` 的句仍按无锚处理（现状，实测
    本项目 43/43 段该锚完全未参与）。on = 把母块首帧（真实源坐标）接为**弱锚**，仅作
    补丁11 单向锁起算点（与 matched 强锚同管线，不掺代价/门禁），收益需经 L2/L3 裁判验证。

    Returns:
        bool: True 表示接线生效。
    """
    import os
    return str(os.environ.get('ZENTECT_KM_BLOCK_ANCHOR', '0')).strip().lower() in ('1', 'on', 'true')


def _forward_lookout_pools(queries: List[dict], cands_by_shotid: Dict[str, List[str]],
                           qi: int,
                           tts_duration_ms: Optional[Dict[str, float]] = None,
                           window: int = FORWARD_LOOKOUT_SENTENCES) -> List[tuple]:
    """取本句之后 window 句的（候选池, 该句所需窗长）——本句不入池（避免自我抢占被自己判成耗尽）。

    P4 掩码粒度 = 镜头 + 时间窗：后句「可用」与否取决于**该镜剩余窗长 ≥ 该后句窗长**，
    故池须随句带上所需窗长（缺失按 `WINDOW_FALLBACK_MS`，与取料层同口径）。

    Args:
        queries: 全量脚本句（叙事行序）。
        cands_by_shotid: 每句的标准候选镜头 id 列表。
        qi: 本句在 queries 中的下标。
        tts_duration_ms: 每句配音时长 {shotId: ms}（缺省按缺省窗长计）。
        window: 前瞻句数窗口（≤0 时返回空表 ⇒ 等价关闭）。

    Returns:
        List[tuple]: [(候选 id 列表, 所需窗长 ms)]；空池已剔除（不产生假命中）。
    """
    pools: List[tuple] = []
    for nxt in queries[qi + 1: qi + 1 + max(0, window)]:
        nxt_sid = str(nxt.get('shotId'))
        pool = cands_by_shotid.get(nxt_sid) or []
        if pool:
            pools.append((list(pool), _win_need_ms((tts_duration_ms or {}).get(nxt_sid))))
    return pools


def _forward_lookout_remaining(pool: List[str], win_cursor_ms: Optional[Dict[str, float]],
                               chunk_by_id: Dict[str, dict], need_ms: float) -> int:
    """统计某未来句候选池在本路径下的剩余可用数 rem（**该镜剩余窗长 ≥ 该句窗长**即算可用）。

    不可造假门：镜头 id 不在全局索引（数据缺陷）时**不计入可用**——宁可判「更易耗尽」
    （保守少抢），也不虚增可用数放行抢占。

    Args:
        pool: 未来句候选镜头 id 列表。
        win_cursor_ms: 本路径掩码（{镜头键: 下一窗入点 ms}；空/None 表示该镜尚未开窗）。
        chunk_by_id: 全局镜头索引（判剩余窗长用）。
        need_ms: 该未来句所需窗长（ms）。

    Returns:
        int: 剩余可用候选数（≥0）。
    """
    rem = 0
    cursors = win_cursor_ms or {}
    for cid in pool:
        chunk = (chunk_by_id or {}).get(str(cid))
        if chunk is None:
            continue
        if not _win_exhausted(chunk, cursors.get(_shot_key(chunk)), need_ms):
            rem += 1
    return rem


def _forward_lookout(cand_id: str, future_pools: Optional[List[tuple]],
                     win_cursor_ms: Optional[Dict[str, float]],
                     chunk_by_id: Optional[Dict[str, dict]],
                     weight: float,
                     stats: Optional[Dict[str, int]] = None) -> float:
    """前向审望资源耗尽惩罚（补丁1）：本句抢占后句唯一/濒危主粮时的软阻尼。

    设计意图：若某候选是**后句唯一可用主粮**（rem==1），本句抢占会让后句断供 ⇒ 本句需对
    其施加较大代价，把机会留给后句；rem==2 是濒危余量，按较轻罚提示退让。逐未来句累加、
    整趟封顶。判据纯统计（本路径镜头+时间窗游标 × 未来句候选池），零模型、可复现。

    关闭档（weight<=0）、无前瞻池、无索引时恒返回 0.0 ⇒ 缺省零行为变化。

    Args:
        cand_id: 本句候选镜头 id。
        future_pools: 本句之后 window 句的（候选池, 窗长）（见 _forward_lookout_pools）。
        win_cursor_ms: 本路径掩码（{镜头键: 下一窗入点 ms}）。
        chunk_by_id: 全局镜头索引。
        weight: 惩罚权重（env 读取，0=关闭）。
        stats: 可选诊断计数桶（仅开关 on 时由调用方传入；None ⇒ 零开销）。键义：
            probe 探针次数 / guard 守卫短路（无池/无索引）/ miss_pool 未相交
            / wide 相交但最低 rem>=3（池宽裕）/ scarce 最低 rem==2 / sole 最低 rem<=1。

    Returns:
        float: 附加到 transition cost 的软惩罚（关闭档/无命中为 0.0），
        先按 FORWARD_LOOKOUT_TOTAL_MAX 封顶再乘权重。
    """
    if stats is not None:
        _bump(stats, 'probe')
    if weight <= 0.0 or not future_pools or not chunk_by_id:
        if stats is not None:
            _bump(stats, 'guard')
        return 0.0
    total = 0.0
    intersected = 0
    min_rem: Optional[int] = None
    for pool, need_ms in future_pools:
        if cand_id not in pool:
            continue  # 后句用不上本候选：本句抢占它不会造成断供
        rem = _forward_lookout_remaining(pool, win_cursor_ms, chunk_by_id, need_ms)
        intersected += 1
        min_rem = rem if min_rem is None else min(min_rem, rem)
        if rem <= 1:
            total += FORWARD_LOOKOUT_SOLE_MAX
        elif rem == 2:
            total += FORWARD_LOOKOUT_SCARCE_MAX
    if stats is not None:
        # 零命中归因：区分「后句池根本用不上本候选」与「池子宽裕无需退让」两类根因。
        if intersected == 0:
            _bump(stats, 'miss_pool')
        elif min_rem is not None and min_rem <= 1:
            _bump(stats, 'sole')
        elif min_rem == 2:
            _bump(stats, 'scarce')
        else:
            _bump(stats, 'wide')
    return min(total, FORWARD_LOOKOUT_TOTAL_MAX) * weight


def _bump(stats: Dict[str, int], key: str) -> None:
    """诊断计数自增（键缺失按 0 起算）。

    Args:
        stats: 计数桶（原地修改）。
        key: 计数键名。
    """
    stats[key] = int(stats.get(key, 0)) + 1


def _fl_diag(msg: str) -> None:
    """前向审望（补丁1）诊断行：同时写 stderr 与 `%TEMP%/zentect-km-diag.log`。

    print 走 stdout 会被 AppLogger 丢弃，故镜像落盘（与 timeline_solver._km_diag 同文件，
    便于步骤5 跑完一处核对；此处不 import timeline_solver，规避循环依赖）。

    Args:
        msg: 诊断正文（不含前缀，调用方自带 `[forward-lookout]`）。
    """
    import os
    import sys
    import tempfile
    line = msg
    try:
        print(line, file=sys.stderr)
    except Exception:
        pass
    try:
        path = os.path.join(tempfile.gettempdir(), 'zentect-km-diag.log')
        with open(path, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except Exception:
        pass  # 诊断落盘失败不打断求解


def _to_confidence(base_cost) -> float:
    """把供给层「综合代价」换算为契约置信度（落码点2）。

    供给层 `match_cost` 行的口径是 `1 − 综合分`（cost 越小越贴，match_cost.py L310），故
    `1 − base_cost` 即旧 KM 同源的**综合分**，与 legacy 结果项 `confidence` 同一量纲/含义
    （timeline_solver.py L4843 `round(combined_score, 4)`），消费端 0.88 已确认阈值可直接复用。

    Args:
        base_cost: 该句命中候选的综合代价（可能缺失：候选代价行不含本切片）。

    Returns:
        float: [0,1] 置信度；代价缺失/非法如实返回 0.0（绝不造假高置信）。
    """
    if isinstance(base_cost, bool) or not isinstance(base_cost, (int, float)):
        return 0.0
    return round(max(0.0, min(1.0, 1.0 - float(base_cost))), 4)


def _pick_best_for_shot(paths: List[BeamPath], query: dict,
                        cost_row: Optional[Dict[str, float]] = None) -> Optional[dict]:
    """从最终存活路径中取本句命中的最佳切片（代价最小路径优先）。

    Args:
        paths: 最终存活路径。
        query: 脚本句。
        cost_row: 本句供给层代价行 {chunkId: base_cost}（换算 confidence 用；缺省=无代价行）。

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
    # 置信度取「本句命中候选自身的综合分」（非路径累计 pen：pen 含跨句软阻尼与负向奖励，
    # 量纲不可比、恒为负，正是旧实现 score 全 0 不可观测之根因）。
    conf = _to_confidence((cost_row or {}).get(str(chunk_id)))
    return {'shotId': str(query['shotId']), 'chosenChunkId': chunk_id,
            'chunkData': chunk, 'score': conf, 'confidence': conf}