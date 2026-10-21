"""
test_rule_cards.py — 🧩 步骤5 新引擎 · 13 卡装配验证（⓪ 单测骨架）

锁定 `rules.build_rule_cards` 的「点亮 / 休眠」机制（守项目红线「不可造假门」：
依赖字段未回填的卡必须真休眠，绝不以缺字段数据伪造启用硬门禁）：

  1. 全量装配：available_keys=None ⇒ 13 卡全亮（4 hard + 9 soft），卡名唯一
  2. 严格收窄：available_keys=set() ⇒ 全休眠（0 卡）
  3. 子集判据：`availability ⊆ available_keys` 才点亮（差一字段即休眠）
  4. 退役卡不得复活（字段齐备也不行）：
     - `beat_snap`（补丁2，2026-09-25 退役）：层位错配，已下沉输出装配层 `_apply_beat_snap`
     - `cross_scene_recall`（补丁10，2026-10-14 退役）：上游工单两字段从未产出 ⇒ 长期休眠
     - `gap_padding`（补丁7，2026-10-14 退役）：`silenceGapMs` 只注入原声段、而 KM query 是
       解说句（实测 0%(0/40)）⇒ SCORE 恒中性放行，属架构不适用
     - `shot_loop_reset`（补丁8，2026-10-14 退役）：新引擎无「排他锁」可解除（`_win_exhausted`
       是镜头+时间窗配额而非「每镜只用一次」），且判据与 `focus_exemption` 逐字同构（重复计分）

本文件锁装配机制 + 两张关键卡的判据行为，不引入新引擎以外的依赖。

运行方式：
  cd resources/scripts
  ..\\ai-env\\python.exe -m __tests__.test_rule_cards
  （函数式 test_* + 纯 assert，pytest 亦可收集）
"""
import sys
import os

# 将 scripts 目录加入 path，以便 import rules
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import rules
from rules import build_rule_cards, focus_exemption, monotonic_lock


# 13 卡的完整花名册（增删卡即改本表 —— 本表是「13 卡」这一事实的锁）。
# 退役记录：`beat_snap` 2026-09-25（下沉输出装配层）；`cross_scene_recall` 2026-10-14
# （工单字段从未产出）；`gap_padding` 2026-10-14（气口只服务原声段）；`shot_loop_reset`
# 2026-10-14（无排他锁可解除、且与 focus_exemption 判据同构）。四者实现均保留封存。
ALL_CARD_NAMES = frozenset({
    # Tier1 硬门禁（4）
    'monotonic_lock', 'env_medium_lock', 'eyeline_guard', 'critical_asset_lock',
    # Tier2 软阻尼（9）
    'jump_cut', 'heartbeat', 'scale_rhythm', 'motion_rhythm',
    'costume_rhythm', 'color_continuity', 'camera_continuity', 'shot_pref_adherence',
    'focus_exemption',
})


def _names(cards):
    """取卡片名集合（RuleCard.name）。"""
    return {c.name for c in cards}


def test_all_cards_activated_when_keys_none():
    """available_keys=None ⇒ 契约全字段就绪，13 卡全亮且 hard/soft 配额正确。"""
    cards = build_rule_cards()
    assert len(cards) == 13, f"应装配 13 卡，实际 {len(cards)}"
    assert _names(cards) == ALL_CARD_NAMES, f"卡名花名册不一致: {_names(cards) ^ ALL_CARD_NAMES}"
    assert len(_names(cards)) == len(cards), "卡名必须唯一（重名会污染 trace 与降级标记）"
    hard = [c for c in cards if c.tier == 'hard']
    soft = [c for c in cards if c.tier == 'soft']
    assert (len(hard), len(soft)) == (4, 9), f"应为 4 hard / 9 soft，实际 {len(hard)}/{len(soft)}"
    print(f"✓ test_all_cards_activated_when_keys_none: 13 卡全亮（4 hard + 9 soft）")


def test_all_dormant_when_keys_empty():
    """available_keys=set() ⇒ 严格模式下无字段就绪，全部休眠（0 卡）。"""
    cards = build_rule_cards(set())
    assert cards == [], f"空字段集应全休眠，实际点亮 {_names(cards)}"
    print("✓ test_all_dormant_when_keys_empty: 空可用集 → 13 卡全休眠")


def test_subset_judgement_exact_match_only():
    """子集判据：仅当卡的 availability 被完全覆盖时才点亮（差一字段即休眠）。

    monotonic_lock 依赖 {parentChunkId, startMs}：两个都给才亮，只给一个必眠。
    """
    both = _names(build_rule_cards({'parentChunkId', 'startMs'}))
    assert both == {'monotonic_lock'}, f"两字段齐备应仅点亮 monotonic_lock，实际 {both}"

    only_one = _names(build_rule_cards({'parentChunkId'}))
    assert 'monotonic_lock' not in only_one, "缺 startMs 时单向锁必须休眠（不可造假门）"

    # 硬卡同理：eyeline_guard 仅依赖 eyelineDirection，单字段即点亮。
    assert _names(build_rule_cards({'eyelineDirection'})) == {'eyeline_guard'}
    print("✓ test_subset_judgement_exact_match_only: availability ⊆ available_keys 才点亮")


def test_retired_cards_never_revive():
    """退役卡（beat_snap / cross_scene_recall / gap_padding / shot_loop_reset）不得复活，字段齐备也不行。

    退役依据见文件头；此处是「防止顺手加回一行」的机器化护栏。
    """
    retired = {'beat_snap', 'cross_scene_recall', 'gap_padding', 'shot_loop_reset'}
    # 四张卡的依赖字段全给齐（含 bgmBeats / silenceGapMs / isCrossSceneRecall /
    # recallTargetSceneId / audioDurationMs / primarySubject / characters）
    got = _names(build_rule_cards({'bgmBeats', 'silenceGapMs', 'isCrossSceneRecall',
                                   'recallTargetSceneId', 'audioDurationMs',
                                   'primarySubject', 'characters'}))
    assert not (got & retired), f"退役卡不得被装配，实际复活: {got & retired}"
    # shot_loop_reset 退役后，{primarySubject, characters} 只点亮 focus_exemption（无重复卡）
    assert _names(build_rule_cards({'primarySubject', 'characters'})) == {'focus_exemption'}, \
        "shot_loop_reset 退役后 {primarySubject, characters} 应仅点亮 focus_exemption"
    # silenceGapMs 单字段：gap_padding 退役后不再点亮任何卡
    assert _names(build_rule_cards({'silenceGapMs'})) == set(), "gap_padding 退役后 silenceGapMs 不点亮任何卡"
    print("✓ test_retired_cards_never_revive: 四张退役卡（beat_snap / cross_scene_recall / gap_padding / shot_loop_reset）均未复活")


def test_card_defs_availability_is_frozenset():
    """装配表结构不变量：每卡 availability 必须是 frozenset（可哈希、可做子集判据）。"""
    for c in rules._CARD_DEFS:
        av = c['availability']
        assert isinstance(av, frozenset), f"{c['name']} 的 availability 必须是 frozenset"
        assert c['tier'] in ('hard', 'soft'), f"{c['name']} tier 非法: {c['tier']!r}"
        assert callable(c['score']), f"{c['name']} 的 score 必须可调用"
    print("✓ test_card_defs_availability_is_frozenset: 装配表结构不变量成立")


def test_partition_rule_cards_single_source_of_truth():
    """① 单一真源：`partition_rule_cards` 的点亮集合必须与 `build_rule_cards` 装配结果逐名一致。

    这是「点亮」定义只有一个版本的机器化保证 —— 若谁在别处重写子集判断，本测试会先红。
    """
    for av in (None, set(), {'parentChunkId', 'startMs'},
               {'silenceGapMs', 'bgmBeats', 'eyelineDirection', 'primarySubject'}):
        active, dormant = rules.partition_rule_cards(av)
        active_names = {c['name'] for c in active}
        assert _names(build_rule_cards(av)) == active_names, \
            f"available_keys={av} 时两份判据不一致（单一真源被绕过）"
        assert len(active) + len(dormant) == 13, "点亮 + 休眠必须覆盖全部 13 卡"
        assert not (active_names & set(dormant)), "点亮与休眠不得重叠"
    print("✓ test_partition_rule_cards_single_source_of_truth: 点亮判据单一真源一致")


def test_monotonic_lock_flashback_exemption():
    """① 闪回豁免：query.isFlashback=True ⇒ 单向锁放行；缺省/False ⇒ 仍按严格口径 ∞ 否决。

    守「不可造假门」：豁免只在显式 True 时生效，字段缺失不放宽。
    """
    cand = {'id': 'c1', 'parentChunkId': 'p1', 'startMs': 10000.0}
    state = {'max_consumed_ms': {'p1': 20000.0}}   # 已消费最远 20s
    assert monotonic_lock.SCORE(None, cand, {'query': {'isFlashback': True},
                                             'state': state, 'entryMs': 0.0}) == 0.0, \
        "闪回段应豁免单向锁（防合法闪回被 ∞ 误杀）"
    assert monotonic_lock.SCORE(None, cand, {'query': {'isFlashback': False},
                                             'state': state, 'entryMs': 0.0}) == float('inf'), \
        "非闪回段入点回退必须 ∞ 一票否决"
    assert monotonic_lock.SCORE(None, cand, {'query': {},
                                             'state': state, 'entryMs': 0.0}) == float('inf'), \
        "isFlashback 缺失不得放宽（守不可造假门）"
    print("✓ test_monotonic_lock_flashback_exemption: 闪回豁免生效、缺省仍严格")


def test_focus_exemption_conf_gate():
    """③ 置信门：多主体句且焦点命中，但 primarySubjectConf < 0.5 ⇒ 不豁免；≥0.5 或缺失 ⇒ 豁免。

    字段缺失按「未知」放行（向后兼容），只有明确低置信才拦。
    """
    q = {'characters': ['A', 'B']}
    base = {'primarySubject': 'A'}
    assert focus_exemption.SCORE(None, dict(base, primarySubjectConf=0.6), {'query': q}) == -0.10, \
        "高置信多主体命中应豁免"
    assert focus_exemption.SCORE(None, dict(base, primarySubjectConf=0.3), {'query': q}) == 0.0, \
        "低置信焦点不得被误豁免"
    assert focus_exemption.SCORE(None, base, {'query': q}) == -0.10, \
        "conf 缺失按未知放行（向后兼容）"
    assert focus_exemption.SCORE(None, dict(base, primarySubjectConf=0.5), {'query': q}) == -0.10, \
        "恰为阈值 0.5 ⇒ 放行（判据为 < 阈值才拦）"
    print("✓ test_focus_exemption_conf_gate: 置信门生效（低置信拦截、缺失放行）")


if __name__ == "__main__":
    print("=" * 60)
    print("🧩 步骤5 新引擎 · 13 卡装配验证（⓪ 单测骨架）")
    print("=" * 60)
    test_all_cards_activated_when_keys_none()
    test_all_dormant_when_keys_empty()
    test_subset_judgement_exact_match_only()
    test_retired_cards_never_revive()
    test_monotonic_lock_flashback_exemption()
    test_focus_exemption_conf_gate()
    test_card_defs_availability_is_frozenset()
    test_partition_rule_cards_single_source_of_truth()
    print("=" * 60)
    print("全部通过 ✅")
