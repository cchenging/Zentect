"""
test_role_match.py — 🎭 P1 角色组合匹配逻辑验证
验证 _compute_role_score（角色契合度软加成）与 _compute_combined_score（角色权重）的正确性

运行方式：
  cd resources/scripts
  ..\\ai-env\\python.exe -m __tests__.test_role_match
"""
import sys
import os

# 将 scripts 目录加入 path，以便 import timeline_solver
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from timeline_solver import _compute_role_score, _compute_combined_score


def test_role_score_neutral_when_missing():
    """Query 或 Chunk 任一方无角色名单 → 中性 0.5（不参与加分也不惩罚）"""
    assert _compute_role_score([], ['张三']) == 0.5
    assert _compute_role_score(['张三'], []) == 0.5
    assert _compute_role_score(None, ['张三']) == 0.5
    assert _compute_role_score(['张三'], None) == 0.5
    assert _compute_role_score([], []) == 0.5
    print("✓ test_role_score_neutral_when_missing: 任一方缺失给中性 0.5")


def test_role_score_full_hit():
    """Query 角色全部命中 → 1.0"""
    assert _compute_role_score(['张三', '李四'], ['张三', '李四', '路人甲']) == 1.0
    assert _compute_role_score(['张三'], ['张三']) == 1.0
    print("✓ test_role_score_full_hit: 全部命中 → 1.0")


def test_role_score_partial_hit():
    """部分命中 → 命中率 = 交集/Query 角色数；切片多出的路人角色不扣 Query 分"""
    assert _compute_role_score(['张三', '李四'], ['张三']) == 0.5
    assert _compute_role_score(['张三', '李四'], ['路人甲']) == 0.0
    print("✓ test_role_score_partial_hit: 部分命中按 Query 为基准计算")


def test_role_score_soft_bonus_no_penalty():
    """软加成：未命中不破坏既有排序（中性 0.5 与命中 1.0 只差 0.05 权重贡献）"""
    # 相同语义/情绪/运动/时长下，命中角色只比未命中多 0.05 * 0.5 = 0.025
    base = dict(sem=0.6, dur=0.8, motion=0.5, emo=0.5)
    hit = _compute_combined_score(base['sem'], base['dur'], base['motion'], base['emo'], 1.0)
    miss = _compute_combined_score(base['sem'], base['dur'], base['motion'], base['emo'], 0.0)
    neutral = _compute_combined_score(base['sem'], base['dur'], base['motion'], base['emo'], 0.5)
    assert abs(hit - miss - 0.05) < 1e-9, f"命中与未命中差应为 0.05，实际 {hit-miss}"
    expected_neutral = base['sem'] * 0.35 + base['dur'] * 0.25 + base['motion'] * 0.15 + base['emo'] * 0.2 + 0.5 * 0.05
    assert abs(neutral - expected_neutral) < 1e-9, f"中性应以权重公式计得 {expected_neutral}，实际 {neutral}"
    print(f"✓ test_role_score_soft_bonus_no_penalty: 软加成仅 ±0.025（命中 1.0 vs 中性 0.5）")


def test_combined_score_weight_sum():
    """综合分权重之和为 1.0，且各维度独立贡献"""
    score = _compute_combined_score(1.0, 1.0, 1.0, 1.0, 1.0)
    assert abs(score - 1.0) < 1e-9, f"全满分应=1.0，实际 {score}"
    # 语义权重 0.35
    s1 = _compute_combined_score(1.0, 0.0, 0.0, 0.0, 0.0)
    assert abs(s1 - 0.35) < 1e-9
    # 角色权重 0.05
    s2 = _compute_combined_score(0.0, 0.0, 0.0, 0.0, 1.0)
    assert abs(s2 - 0.05) < 1e-9
    print("✓ test_combined_score_weight_sum: 权重系数正确（语义0.35/角色0.05）")


if __name__ == "__main__":
    print("=" * 60)
    print("🎭 P1 角色组合匹配逻辑验证")
    print("=" * 60)
    test_role_score_neutral_when_missing()
    test_role_score_full_hit()
    test_role_score_partial_hit()
    test_role_score_soft_bonus_no_penalty()
    test_combined_score_weight_sum()
    print("=" * 60)
    print("✅ 全部测试通过")
    print("=" * 60)