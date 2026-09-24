"""
test_beam_search.py — 🔎 步骤5 新引擎 · 束搜索求解核验证（⓪ 单测骨架）

锁定 ⓪ 里与求解核强相关的四处机制（只锁机制、不改算法）：

  1. 束搜索主核 + 段域掩码（补丁6）：逐句前向排产，任一物理切片本路径落点即永久禁复用
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
# 1. 束搜索主核 + 段域掩码（补丁6）
# ===========================================================================
def test_solve_assigns_and_masks_reuse():
    """两句共享同一候选池：s1 取最优 c1 后，s2 沿同路径被掩码挡住，退次优 c2。"""
    q1 = assemble_query({'shotId': 's1', 'text': '句1'})
    q2 = assemble_query({'shotId': 's2', 'text': '句2'})
    c1 = assemble_chunk({'id': 'c1', 'startMs': 1000, 'endMs': 3000})
    c2 = assemble_chunk({'id': 'c2', 'startMs': 5000, 'endMs': 8000})
    ctx = _mk_ctx([q1, q2], [c1, c2],
                  {'s1': ['c1', 'c2'], 's2': ['c1', 'c2']})
    cost = {'s1': {'c1': 0.1, 'c2': 0.2}, 's2': {'c1': 0.1, 'c2': 0.15}}

    out = solve(ctx, cost, [], {'s1': 1000.0, 's2': 1000.0})

    assert set(out) == {'s1', 's2'}, f"两句都应产出分配，实际 {set(out)}"
    assert out['s1']['chosenChunkId'] == 'c1', "s1 应取原生代价最优 c1"
    # 段域掩码：c1 已在本路径落点 ⇒ 永久禁复用（跨场不清零），s2 只能退 c2。
    assert out['s2']['chosenChunkId'] == 'c2', "s2 不得复用 c1（补丁6 段域掩码）"
    assert not out['s1'].get('isDegraded') and not out['s2'].get('isDegraded'), \
        "正常排产不应带降级标记"
    print("✓ test_solve_assigns_and_masks_reuse: 逐句排产 + 段域掩码禁复用")


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
    """一级熔断：唯一候选被单向锁 ∞ 否决 → 放开 Tier-1 硬门禁后复活，标 hard_relax。"""
    q1 = assemble_query({'shotId': 's1', 'text': '句1'})
    q2 = assemble_query({'shotId': 's2', 'text': '句2'})
    # 同一物理镜头 P 的两片：cA 靠后（10000ms）先被消费，cB 靠前（1000ms）时间倒流。
    c_a = assemble_chunk({'id': 'cA', 'parentChunkId': 'P', 'startMs': 10000, 'endMs': 12000})
    c_b = assemble_chunk({'id': 'cB', 'parentChunkId': 'P', 'startMs': 1000, 'endMs': 3000})
    ctx = _mk_ctx([q1, q2], [c_a, c_b], {'s1': ['cA'], 's2': ['cB']})
    cost = {'s1': {'cA': 0.1}, 's2': {'cB': 0.1}}
    rules = [RuleCard('monotonic_lock', 'hard', monotonic_lock.SCORE)]

    out = solve(ctx, cost, rules, {'s1': 1000.0, 's2': 1000.0})

    assert out['s1']['chosenChunkId'] == 'cA', "s1 应正常过锁"
    assert not out['s1'].get('isDegraded'), "s1 未触发熔断，不应带降级标记"
    assert out['s2']['chosenChunkId'] == 'cB', "s2 唯一候选应在放开硬门禁后复活"
    assert out['s2'].get('isDegraded') is True, "s2 必须标降级（供 UI 待确认徽标）"
    assert out['s2'].get('degradeKind') == 'hard_relax', \
        f"应为一级熔断 hard_relax，实际 {out['s2'].get('degradeKind')!r}"
    print("✓ test_k1_breaker_level1_hard_relax: 一级熔断（放开 Tier-1）标记正确")


def test_k1_breaker_level3_all_beam_death():
    """三级熔断：全候选被段域掩码耗尽 → 强挂最优候（忽略掩码）并标 all_beam_death。"""
    q1 = assemble_query({'shotId': 's1', 'text': '句1'})
    q2 = assemble_query({'shotId': 's2', 'text': '句2'})
    c1 = assemble_chunk({'id': 'c1', 'startMs': 1000, 'endMs': 3000})
    # 两句候选池都只有 c1：s1 落点后 c1 被掩码，s2 在一/二级都无路可走。
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


if __name__ == "__main__":
    print("=" * 60)
    print("🔎 步骤5 新引擎 · 束搜索求解核验证（⓪ 单测骨架）")
    print("=" * 60)
    test_solve_assigns_and_masks_reuse()
    test_unique_curr_chunks_diversity_pruning()
    test_two_tier_pipeline_hard_first_then_soft()
    test_k1_breaker_level1_hard_relax()
    test_k1_breaker_level3_all_beam_death()
    test_scene_collapse_picks_min_pen_and_rejects_empty()
    test_solve_cross_scene_settlement_keeps_all_shots()
    print("=" * 60)
    print("全部通过 ✅")