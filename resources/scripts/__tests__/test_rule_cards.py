"""
test_rule_cards.py — 🧩 步骤5 新引擎 · 17 卡装配验证（⓪ 单测骨架）

锁定 `rules.build_rule_cards` 的「点亮 / 休眠」机制（守项目红线「不可造假门」：
依赖字段未回填的卡必须真休眠，绝不以缺字段数据伪造启用硬门禁）：

  1. 全量装配：available_keys=None ⇒ 17 卡全亮（4 hard + 13 soft），卡名唯一
  2. 严格收窄：available_keys=set() ⇒ 全休眠（0 卡）
  3. 子集判据：`availability ⊆ available_keys` 才点亮（差一字段即休眠）
  4. 字段级点亮：silenceGapMs ⇒ gap_padding 亮 / beat_snap 眠（还缺 bgmBeats）

本文件只锁机制、不改算法，也不引入新引擎以外的依赖。

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
from rules import build_rule_cards


# 17 卡的完整花名册（增删卡即改本表 —— 本表是「17 卡」这一事实的锁）。
ALL_CARD_NAMES = frozenset({
    # Tier1 硬门禁（4）
    'monotonic_lock', 'env_medium_lock', 'eyeline_guard', 'critical_asset_lock',
    # Tier2 软阻尼（13）
    'jump_cut', 'heartbeat', 'scale_rhythm', 'motion_rhythm', 'cross_scene_recall',
    'costume_rhythm', 'color_continuity', 'camera_continuity', 'shot_pref_adherence',
    'beat_snap', 'gap_padding', 'shot_loop_reset', 'focus_exemption',
})


def _names(cards):
    """取卡片名集合（RuleCard.name）。"""
    return {c.name for c in cards}


def test_all_cards_activated_when_keys_none():
    """available_keys=None ⇒ 契约全字段就绪，17 卡全亮且 hard/soft 配额正确。"""
    cards = build_rule_cards()
    assert len(cards) == 17, f"应装配 17 卡，实际 {len(cards)}"
    assert _names(cards) == ALL_CARD_NAMES, f"卡名花名册不一致: {_names(cards) ^ ALL_CARD_NAMES}"
    assert len(_names(cards)) == len(cards), "卡名必须唯一（重名会污染 trace 与降级标记）"
    hard = [c for c in cards if c.tier == 'hard']
    soft = [c for c in cards if c.tier == 'soft']
    assert (len(hard), len(soft)) == (4, 13), f"应为 4 hard / 13 soft，实际 {len(hard)}/{len(soft)}"
    print(f"✓ test_all_cards_activated_when_keys_none: 17 卡全亮（4 hard + 13 soft）")


def test_all_dormant_when_keys_empty():
    """available_keys=set() ⇒ 严格模式下无字段就绪，全部休眠（0 卡）。"""
    cards = build_rule_cards(set())
    assert cards == [], f"空字段集应全休眠，实际点亮 {_names(cards)}"
    print("✓ test_all_dormant_when_keys_empty: 空可用集 → 17 卡全休眠")


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


def test_field_level_gating_silence_gap_vs_bgm_beats():
    """字段级点亮：silenceGapMs 单字段可点亮 gap_padding，但 beat_snap 仍眠（缺 bgmBeats）。"""
    got = _names(build_rule_cards({'silenceGapMs'}))
    assert 'gap_padding' in got, "silenceGapMs 就绪时 gap_padding 应点亮"
    assert 'beat_snap' not in got, "beat_snap 还缺 bgmBeats，必须休眠（双缺口的字段侧）"

    got2 = _names(build_rule_cards({'silenceGapMs', 'bgmBeats'}))
    assert {'gap_padding', 'beat_snap'} <= got2, "两字段齐备时两卡应同时点亮"
    print("✓ test_field_level_gating_silence_gap_vs_bgm_beats: 字段级点亮判据正确")


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
        assert len(active) + len(dormant) == 17, "点亮 + 休眠必须覆盖全部 17 卡"
        assert not (active_names & set(dormant)), "点亮与休眠不得重叠"
    print("✓ test_partition_rule_cards_single_source_of_truth: 点亮判据单一真源一致")


if __name__ == "__main__":
    print("=" * 60)
    print("🧩 步骤5 新引擎 · 17 卡装配验证（⓪ 单测骨架）")
    print("=" * 60)
    test_all_cards_activated_when_keys_none()
    test_all_dormant_when_keys_empty()
    test_subset_judgement_exact_match_only()
    test_field_level_gating_silence_gap_vs_bgm_beats()
    test_card_defs_availability_is_frozenset()
    test_partition_rule_cards_single_source_of_truth()
    print("=" * 60)
    print("全部通过 ✅")