"""
test_rule_cards.py — 🧩 步骤5 新引擎 · 16 卡装配验证（⓪ 单测骨架）

锁定 `rules.build_rule_cards` 的「点亮 / 休眠」机制（守项目红线「不可造假门」：
依赖字段未回填的卡必须真休眠，绝不以缺字段数据伪造启用硬门禁）：

  1. 全量装配：available_keys=None ⇒ 16 卡全亮（4 hard + 12 soft），卡名唯一
  2. 严格收窄：available_keys=set() ⇒ 全休眠（0 卡）
  3. 子集判据：`availability ⊆ available_keys` 才点亮（差一字段即休眠）
  4. 字段级点亮：silenceGapMs ⇒ 仅 gap_padding 亮；`beat_snap` **已退役**（层位错配：
     BGM 强拍在输出时间轴、与切片源 PTS 不同轴，且同句所有候选的输出切点恒同 ⇒ 该卡对
     排序零影响；已下沉到 timeline_solver 输出装配层实现，见 `_apply_beat_snap`）

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


# 16 卡的完整花名册（增删卡即改本表 —— 本表是「16 卡」这一事实的锁）。
# `beat_snap` 已于 2026-09-25 退役（层位错配 ⇒ 下沉输出装配层，见 timeline_solver 补丁2 段）。
ALL_CARD_NAMES = frozenset({
    # Tier1 硬门禁（4）
    'monotonic_lock', 'env_medium_lock', 'eyeline_guard', 'critical_asset_lock',
    # Tier2 软阻尼（12）
    'jump_cut', 'heartbeat', 'scale_rhythm', 'motion_rhythm', 'cross_scene_recall',
    'costume_rhythm', 'color_continuity', 'camera_continuity', 'shot_pref_adherence',
    'gap_padding', 'shot_loop_reset', 'focus_exemption',
})


def _names(cards):
    """取卡片名集合（RuleCard.name）。"""
    return {c.name for c in cards}


def test_all_cards_activated_when_keys_none():
    """available_keys=None ⇒ 契约全字段就绪，16 卡全亮且 hard/soft 配额正确。"""
    cards = build_rule_cards()
    assert len(cards) == 16, f"应装配 16 卡，实际 {len(cards)}"
    assert _names(cards) == ALL_CARD_NAMES, f"卡名花名册不一致: {_names(cards) ^ ALL_CARD_NAMES}"
    assert len(_names(cards)) == len(cards), "卡名必须唯一（重名会污染 trace 与降级标记）"
    hard = [c for c in cards if c.tier == 'hard']
    soft = [c for c in cards if c.tier == 'soft']
    assert (len(hard), len(soft)) == (4, 12), f"应为 4 hard / 12 soft，实际 {len(hard)}/{len(soft)}"
    print(f"✓ test_all_cards_activated_when_keys_none: 16 卡全亮（4 hard + 12 soft）")


def test_all_dormant_when_keys_empty():
    """available_keys=set() ⇒ 严格模式下无字段就绪，全部休眠（0 卡）。"""
    cards = build_rule_cards(set())
    assert cards == [], f"空字段集应全休眠，实际点亮 {_names(cards)}"
    print("✓ test_all_dormant_when_keys_empty: 空可用集 → 16 卡全休眠")


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
    """字段级点亮：`silenceGapMs` 单字段即可点亮 gap_padding；`beat_snap` 已退役不在册。

    `beat_snap`（补丁2）退役依据：BGM 强拍在输出时间轴、切片 startMs 在源 PTS（不同轴），
    且同句所有候选的输出切点恒同 ⇒ 该卡对候选排序零影响（可证明 no-op）。
    改判为输出装配层实现（`timeline_solver._apply_beat_snap`），故不得再出现在装配表里。
    """
    got = _names(build_rule_cards({'silenceGapMs'}))
    assert 'gap_padding' in got, "silenceGapMs 就绪时 gap_padding 应点亮"
    assert 'beat_snap' not in got, "beat_snap 已退役，不得再被装配"

    # 即便两字段齐备，退役卡也不得复活（防止「顺手加回一行」的回归）。
    got2 = _names(build_rule_cards({'silenceGapMs', 'bgmBeats'}))
    assert 'beat_snap' not in got2 and 'gap_padding' in got2, "退役卡不得因字段齐备而复活"
    print("✓ test_field_level_gating_silence_gap_vs_bgm_beats: 字段级点亮判据正确（beat_snap 已退役）")


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
        assert len(active) + len(dormant) == 16, "点亮 + 休眠必须覆盖全部 16 卡"
        assert not (active_names & set(dormant)), "点亮与休眠不得重叠"
    print("✓ test_partition_rule_cards_single_source_of_truth: 点亮判据单一真源一致")


if __name__ == "__main__":
    print("=" * 60)
    print("🧩 步骤5 新引擎 · 16 卡装配验证（⓪ 单测骨架）")
    print("=" * 60)
    test_all_cards_activated_when_keys_none()
    test_all_dormant_when_keys_empty()
    test_subset_judgement_exact_match_only()
    test_field_level_gating_silence_gap_vs_bgm_beats()
    test_card_defs_availability_is_frozenset()
    test_partition_rule_cards_single_source_of_truth()
    print("=" * 60)
    print("全部通过 ✅")