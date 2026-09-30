"""
test_beam_search.py — 🔎 步骤5 新引擎 · 束搜索求解核验证（⓪ 单测骨架）

锁定 ⓪ 里与求解核强相关的四处机制（只锁机制、不改算法）：

  1. 束搜索主核 + 掩码（补丁6，P4 粒度 = 镜头 + 时间窗）：逐句前向排产，同镜可换窗续用
     （ab→bc→cd），窗用尽则该镜不得再选（防 PPT 化）
  2. 两级管线（补丁21）：先 hard（违反即 ∞ 一票否决）后 soft（仅累加），非法 tier 契约暴露
  3. K1 阶梯熔断：①完整规则 → ②放开 Tier-1（hard_relax）→ ③强挂最优候（all_beam_death）
  4. 跨场清算（补丁19）：跨场收敛 Top-1 作唯一物理前驱；空路径收敛必须抛错
  （另附束宽多样性剪枝 _unique_curr_chunks 的锁）

运行方式：
  cd resources/scripts
  ..\\ai-env\\python.exe -m __tests__.test_beam_search
  （函数式 test_* + 纯 assert，pytest 亦可收集）
"""
import sys
import os

# 将 scripts 目录加入 path，以便 import 新引擎各模块
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from montage_contract import ContractError, assemble_chunk, assemble_query
from build_context import CandidateContext
from rules import monotonic_lock
from beam_search import (
    BEAM_WIDTH,
    DEGRADED_CONF_CAP,
    HARD_DENY_COST,
    BeamPath,
    RuleCard,
    _apply_tier_hard_and_soft,
    _unique_curr_chunks,
    scene_collapse,
    solve,
)


def _mk_ctx(queries, chunks, cands, seg_of=None):
    """构造最小合法 CandidateContext（只填求解核读取的字段）。"""
    return CandidateContext(
        queries=list(queries),
        chunk_by_id={c['id']: c for c in chunks},
        seg_by_id={},
        cands_by_shotid=dict(cands),
        shotid_to_segment=dict(seg_of or {q['shotId']: 0 for q in queries}),
        batch_orders=[],
    )


# ===========================================================================
# 1. 束搜索主核 + 掩码（补丁6，P4 粒度 = 镜头 + 时间窗）
# ===========================================================================
def test_solve_allows_same_shot_next_window():
    """掩码（补丁6）粒度 = 镜头 + 时间窗：同镜下一句可开**新窗**续用（ab→bc→cd 自然形成）。"""
    q1 = assemble_query({'shotId': 's1', 'text': '句1'})
    q2 = assemble_query({'shotId': 's2', 'text': '句2'})
    # 镜头 c1 时长 3000ms；两句各需 1000ms 窗 ⇒ s2 在 c1 内开第二窗，合法复用、不降级。
    c1 = assemble_chunk({'id': 'c1', 'startMs': 0, 'endMs': 3000})
    ctx = _mk_ctx([q1, q2], [c1], {'s1': ['c1'], 's2': ['c1']})

    out = solve(ctx, {'s1': {'c1': 0.1}, 's2': {'c1': 0.1}}, [], {'s1': 1000.0, 's2': 1000.0})

    assert set(out) == {'s1', 's2'}, f"两句都应产出分配，实际 {set(out)}"
    assert out['s1']['chosenChunkId'] == 'c1' and out['s2']['chosenChunkId'] == 'c1', \
        "同镜换窗（入点随游标前移）应可继续取料，不得被误判为复用而禁选"
    assert not out['s1'].get('isDegraded') and not out['s2'].get('isDegraded'), \
        "正常同镜多窗排产不应带降级标记"
    print("✓ test_solve_allows_same_shot_next_window: 同镜不同窗可继续取料")


def test_solve_blocks_exhausted_shot_window():
    """掩码（补丁6）：镜头窗用尽（剩余窗长 < 本句窗长）⇒ 该镜不得再选，退次优。"""
    q1 = assemble_query({'shotId': 's1', 'text': '句1'})
    q2 = assemble_query({'shotId': 's2', 'text': '句2'})
    # 镜头 P 仅 1000ms（2000→3000）；两句各需 1000ms ⇒ s1 吃掉整镜，s2 不得再在 P 开窗。
    cP = assemble_chunk({'id': 'P', 'startMs': 2000, 'endMs': 3000})
    cQ = assemble_chunk({'id': 'Q', 'startMs': 5000, 'endMs': 8000})
    ctx = _mk_ctx([q1, q2], [cP, cQ], {'s1': ['P'], 's2': ['P', 'Q']})

    out = solve(ctx, {'s1': {'P': 0.1}, 's2': {'P': 0.1, 'Q': 0.2}}, [],
                {'s1': 1000.0, 's2': 1000.0})

    assert out['s1']['chosenChunkId'] == 'P'
    assert out['s2']['chosenChunkId'] == 'Q', \
        "P 窗用尽 ⇒ s2 应退次优 Q（不得回头重放 P）"
    assert not out['s2'].get('isDegraded'), "退次优属正常排产，不应降级"
    print("✓ test_solve_blocks_exhausted_shot_window: 镜头窗用尽禁再选")


def test_unique_curr_chunks_diversity_pruning():
    """多样性剪枝：末端切片互异，同切片只留代价最小那条，且截断到束宽。"""
    paths = [
        BeamPath(curr_chunk_id='c1', pen=0.1),
        BeamPath(curr_chunk_id='c1', pen=0.2),   # 与上条同末端 → 剪掉
        BeamPath(curr_chunk_id='c2', pen=0.3),
        BeamPath(curr_chunk_id='c3', pen=0.4),
        BeamPath(curr_chunk_id='c4', pen=0.5),   # 超束宽 → 截断
    ]
    kept = _unique_curr_chunks(paths)
    assert len(kept) == BEAM_WIDTH == 3, f"应保留束宽 3 条，实际 {len(kept)}"
    assert [p.curr_chunk_id for p in kept] == ['c1', 'c2', 'c3'], \
        f"应保序取互异末端，实际 {[p.curr_chunk_id for p in kept]}"
    print("✓ test_unique_curr_chunks_diversity_pruning: 束宽多样性剪枝正确")


# ===========================================================================
# 2. 两级管线（补丁21）
# ===========================================================================
def test_two_tier_pipeline_hard_first_then_soft():
    """先 hard 后 soft：hard 违反即 ∞ 且短路，soft 仅累加，非法 tier 抛契约错。"""
    hard_pass = RuleCard('fake_hard_pass', 'hard', lambda p, c, x: 0.0)
    hard_deny = RuleCard('fake_hard_deny', 'hard', lambda p, c, x: HARD_DENY_COST)
    soft_a = RuleCard('fake_soft_a', 'soft', lambda p, c, x: 0.25)
    soft_b = RuleCard('fake_soft_b', 'soft', lambda p, c, x: 0.50)
    ctx = {'state': {}, 'query': {}, 'is_scene_first': False}
    cand = {'id': 'c1'}

    assert _apply_tier_hard_and_soft([hard_pass, soft_a, soft_b], None, cand, ctx) == 0.75, \
        "全通过时应为软阻尼累加值"

    # hard 在后也必须先于 soft 执行（两级次序不可倒置）→ 一票否决。
    assert _apply_tier_hard_and_soft([soft_a, hard_deny, soft_b], None, cand, ctx) >= HARD_DENY_COST, \
        "任一 hard 违反即 ∞，软阻尼不得再累加"

    try:
        _apply_tier_hard_and_soft([RuleCard('bad', 'medium', lambda p, c, x: 0.0)],
                                  None, cand, ctx)
    except ContractError:
        pass
    else:
        raise AssertionError("非法 tier 应抛 ContractError（错就错，不静默放过）")
    print("✓ test_two_tier_pipeline_hard_first_then_soft: 两级流水线次序与短路正确")


# ===========================================================================
# 3. K1 阶梯熔断（①完整 → ②hard_relax → ③all_beam_death）
# ===========================================================================
def test_k1_breaker_level1_hard_relax():
    """一级熔断：唯一候选被 Tier-1 硬门禁 ∞ 否决 → 放开硬门禁后复活，标 hard_relax。"""
    q1 = assemble_query({'shotId': 's1', 'text': '句1'})
    q2 = assemble_query({'shotId': 's2', 'text': '句2'})
    c1 = assemble_chunk({'id': 'c1', 'startMs': 1000, 'endMs': 3000})
    c2 = assemble_chunk({'id': 'c2', 'startMs': 5000, 'endMs': 8000})
    ctx = _mk_ctx([q1, q2], [c1, c2], {'s1': ['c1'], 's2': ['c2']})
    cost = {'s1': {'c1': 0.1}, 's2': {'c2': 0.1}}
    # 硬门禁只在 s2 触发（s1 正常过门）：一级熔断放开 Tier-1 后 s2 唯一候选复活。
    deny_s2 = RuleCard(
        'fake_deny_s2', 'hard',
        lambda p, c, x: HARD_DENY_COST if (x.get('query') or {}).get('shotId') == 's2' else 0.0)

    out = solve(ctx, cost, [deny_s2], {'s1': 1000.0, 's2': 1000.0})

    assert out['s1']['chosenChunkId'] == 'c1', "s1 应正常过锁"
    assert not out['s1'].get('isDegraded'), "s1 未触发熔断，不应带降级标记"
    assert out['s2']['chosenChunkId'] == 'c2', "s2 唯一候选应在放开硬门禁后复活"
    assert out['s2'].get('isDegraded') is True, "s2 必须标降级（供 UI 待确认徽标）"
    assert out['s2'].get('degradeKind') == 'hard_relax', \
        f"应为一级熔断 hard_relax，实际 {out['s2'].get('degradeKind')!r}"
    print("✓ test_k1_breaker_level1_hard_relax: 一级熔断（放开 Tier-1）标记正确")


def test_k1_breaker_level3_all_beam_death():
    """三级熔断：镜头窗已用尽 ⇒ 一/二级均无路可走 → 强挂最优候并标 all_beam_death。"""
    q1 = assemble_query({'shotId': 's1', 'text': '句1'})
    q2 = assemble_query({'shotId': 's2', 'text': '句2'})
    # 镜头 c1 仅 1000ms 且两句各需 1000ms：s1 落点后窗用尽，s2 无合规候选。
    c1 = assemble_chunk({'id': 'c1', 'startMs': 1000, 'endMs': 2000})
    ctx = _mk_ctx([q1, q2], [c1], {'s1': ['c1'], 's2': ['c1']})
    cost = {'s1': {'c1': 0.1}, 's2': {'c1': 0.2}}

    out = solve(ctx, cost, [], {'s1': 1000.0, 's2': 1000.0})

    assert out['s1']['chosenChunkId'] == 'c1' and not out['s1'].get('isDegraded')
    assert out['s2']['chosenChunkId'] == 'c1', "三级熔断必须强挂最优候（绝不白屏）"
    assert out['s2'].get('isDegraded') is True
    assert out['s2'].get('degradeKind') == 'all_beam_death', \
        f"应为三级熔断 all_beam_death，实际 {out['s2'].get('degradeKind')!r}"
    print("✓ test_k1_breaker_level3_all_beam_death: 三级熔断（强挂最优候）标记正确")


# ===========================================================================
# 4. 跨场清算（补丁19）
# ===========================================================================
def test_scene_collapse_picks_min_pen_and_rejects_empty():
    """清算取综合代价最小者为唯一物理前驱；无路径可收敛必须抛错（不造假前驱）。"""
    p_hi = BeamPath(curr_chunk_id='c1', pen=0.9)
    p_lo = BeamPath(curr_chunk_id='c2', pen=0.2)
    assert scene_collapse([p_hi, p_lo]) is p_lo, "应收敛到 pen 最小路径"
    try:
        scene_collapse([])
    except ContractError:
        pass
    else:
        raise AssertionError("空路径收敛应抛 ContractError")
    print("✓ test_scene_collapse_picks_min_pen_and_rejects_empty: 跨场清算判据正确")


def test_solve_cross_scene_settlement_keeps_all_shots():
    """跨场集成：前场留存 >1 路径 → 换场收敛 Top-1，后场仍逐句正常排产不丢句。"""
    ids = ['s1', 's2', 's3', 's4']
    queries = [assemble_query({'shotId': sid, 'text': '句' + sid}) for sid in ids]
    chunks = [assemble_chunk({'id': f'c{i}', 'startMs': 1000 * i, 'endMs': 1000 * i + 800})
              for i in range(1, 9)]
    # 每句 2 个专属候选 ⇒ 场末存活路径 >1，换场时真实触发补丁19 清算。
    cands = {'s1': ['c1', 'c2'], 's2': ['c3', 'c4'], 's3': ['c5', 'c6'], 's4': ['c7', 'c8']}
    seg = {'s1': 1, 's2': 1, 's3': 2, 's4': 2}
    cost = {sid: {cid: 0.1 + 0.01 * i for i, cid in enumerate(cands[sid])} for sid in ids}
    ctx = _mk_ctx(queries, chunks, cands, seg)

    out = solve(ctx, cost, [], {sid: 1000.0 for sid in ids})

    assert set(out) == set(ids), f"跨场清算不得丢句，实际 {set(out)}"
    assert all(not out[sid].get('isDegraded') for sid in ids), \
        "候选充足时不应出现熔断降级"
    print("✓ test_solve_cross_scene_settlement_keeps_all_shots: 跨场收敛后全场次正常排产")


# ===========================================================================
# 5. 置信度全链路（落码点2：新引擎契约补 confidence）
# ===========================================================================
def test_result_carries_confidence_from_supply_cost():
    """结果项置信度 = 1 − 供给层综合代价（与 legacy confidence 同量纲），score 同值且落在 [0,1]。"""
    q1 = assemble_query({'shotId': 's1', 'text': '句1'})
    c1 = assemble_chunk({'id': 'c1', 'startMs': 1000, 'endMs': 3000})
    ctx = _mk_ctx([q1], [c1], {'s1': ['c1']})

    out = solve(ctx, {'s1': {'c1': 0.2}}, [], {'s1': 1000.0})

    r = out['s1']
    assert r['confidence'] == 0.8, f"置信度应为 1−0.2=0.8，实际 {r['confidence']}"
    assert r['score'] == r['confidence'], \
        "score 应与 confidence 同值（旧实现 = −pen，含跨句软阻尼、量纲不可比）"
    assert 0.0 <= r['confidence'] <= 1.0, "置信度必须落在 [0,1]"
    print("✓ test_result_carries_confidence_from_supply_cost: 置信度由供给层综合代价换算")


def test_degraded_confidence_capped_below_confirm_threshold():
    """一级熔断强挂候选置信度封顶 0.85（<0.88 已确认阈值）⇒ 降级段不得伪装成已确认。"""
    q1 = assemble_query({'shotId': 's1', 'text': '句1'})
    q2 = assemble_query({'shotId': 's2', 'text': '句2'})
    c1 = assemble_chunk({'id': 'c1', 'startMs': 1000, 'endMs': 3000})
    c2 = assemble_chunk({'id': 'c2', 'startMs': 5000, 'endMs': 8000})
    ctx = _mk_ctx([q1, q2], [c1, c2], {'s1': ['c1'], 's2': ['c2']})
    deny_s2 = RuleCard(
        'fake_deny_s2', 'hard',
        lambda p, c, x: HARD_DENY_COST if (x.get('query') or {}).get('shotId') == 's2' else 0.0)

    out = solve(ctx, {'s1': {'c1': 0.05}, 's2': {'c2': 0.05}}, [deny_s2],
                {'s1': 1000.0, 's2': 1000.0})

    assert out['s1']['confidence'] == 0.95, "未熔断句应报真实综合分 0.95（不被封顶）"
    assert out['s2'].get('isDegraded') is True
    assert out['s2']['confidence'] == DEGRADED_CONF_CAP == 0.85, \
        f"熔断段应封顶 {DEGRADED_CONF_CAP}，实际 {out['s2']['confidence']}"
    assert out['s2']['confidence'] < 0.88, "封顶后必须低于消费端已确认阈值（承接不虚高）"
    print("✓ test_degraded_confidence_capped_below_confirm_threshold: 降级段置信度封顶生效")


def test_monotonic_lock_reads_window_entry():
    """补丁11 单向锁（P4）：判据基准是**本窗入点**（ctx['entryMs']）而非镜头起点。

    同镜换窗续用（入点随游标前移，镜头起点恒定）不得被误判为时间倒流；
    入点确实回退到已消费最远入点之前才 ∞。
    """
    cand = assemble_chunk({'id': 'P', 'startMs': 0, 'endMs': 20000})
    # 入点前移 0 → 12000：通过（若按 startMs 判，恒 0 < farthest 会误杀同镜续用）。
    assert monotonic_lock.SCORE(None, cand, {
        'state': {'max_consumed_ms': {'P': 11000.0}}, 'entryMs': 12000.0}) == 0.0, \
        "同镜换窗（入点前移）不得被判时间倒流"
    # 容差内（11000 − 200 = 10800 ≤ 入点）：通过。
    assert monotonic_lock.SCORE(None, cand, {
        'state': {'max_consumed_ms': {'P': 11000.0}}, 'entryMs': 10900.0}) == 0.0
    # 入点回退到已消费最远入点之前（超出 200ms 容差）：一票否决。
    assert monotonic_lock.SCORE(None, cand, {
        'state': {'max_consumed_ms': {'P': 11000.0}}, 'entryMs': 1000.0}) >= HARD_DENY_COST
    # 未给 entryMs 时退回切片起点（兼容旧调用形态）。
    assert monotonic_lock.SCORE(None, cand, {'state': {'max_consumed_ms': {'P': -1.0}}}) == 0.0
    print("✓ test_monotonic_lock_reads_window_entry: 单向锁按本窗入点判据正确")


def test_continuation_confidence_inherits_prev_shot():
    """顺延对账（P4 镜头粒度）：异镜的 CONTINUE_PREV 句回写**上一镜本体**并继承其置信度。"""
    q1 = assemble_query({'shotId': 's1', 'text': '句1'})
    q2 = assemble_query({'shotId': 's2', 'text': '句2', 'shotMode': 'CONTINUE_PREV'})
    c_p = assemble_chunk({'id': 'P', 'startMs': 0, 'endMs': 8000})
    c_x = assemble_chunk({'id': 'X', 'startMs': 20000, 'endMs': 26000})
    # s2 候选池只给异镜 X（上一镜 P 不在池内）⇒ 由 reconcile_continuation 回写上一镜本体 P。
    ctx = _mk_ctx([q1, q2], [c_p, c_x], {'s1': ['P'], 's2': ['X']})

    out = solve(ctx, {'s1': {'P': 0.2}, 's2': {'X': 0.1}}, [], {'s1': 1000.0, 's2': 1000.0})

    assert out['s1']['confidence'] == 0.8
    assert out['s2']['chosenChunkId'] == 'P', "顺延句应回写上一镜本体（同一切片 id）"
    assert out['s2']['confidence'] == 0.8, \
        f"续镜置信度应继承上一镜 0.8（而非异镜候选 X 的 0.9），实际 {out['s2']['confidence']}"
    assert out['s2'].get('_cont_ok') == 'continued', "权威顺延分类应记为 continued"
    print("✓ test_continuation_confidence_inherits_prev_shot: 续镜回写上一镜本体并继承置信度")


if __name__ == "__main__":
    print("=" * 60)
    print("🔎 步骤5 新引擎 · 束搜索求解核验证（⓪ 单测骨架）")
    print("=" * 60)
    test_solve_allows_same_shot_next_window()
    test_solve_blocks_exhausted_shot_window()
    test_unique_curr_chunks_diversity_pruning()
    test_two_tier_pipeline_hard_first_then_soft()
    test_k1_breaker_level1_hard_relax()
    test_k1_breaker_level3_all_beam_death()
    test_scene_collapse_picks_min_pen_and_rejects_empty()
    test_solve_cross_scene_settlement_keeps_all_shots()
    test_result_carries_confidence_from_supply_cost()
    test_degraded_confidence_capped_below_confirm_threshold()
    test_monotonic_lock_reads_window_entry()
    test_continuation_confidence_inherits_prev_shot()
    print("=" * 60)
    print("全部通过 ✅")