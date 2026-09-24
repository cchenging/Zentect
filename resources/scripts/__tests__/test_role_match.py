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

# 当前默认权重（timeline_solver._compute_combined_score 缺省值）。测试用显式权重集，
# 避免运行环境 ZENTECT_KM_DUR_WEIGHT 等 env 覆盖与未来默认值漂移干扰断言。
ROLE_DEFAULT_W = dict(sem=0.64, emotion=0.05, duration=0.22, role=0.09)


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
    """软加成：相同语义/时长/情绪下，角色命中(1.0)比未命中(0.0)综合分高 role 权重 0.09"""
    # 位置参数修复：第 4 位是 role_score，weights 走关键字（原实现把 1.0 误传给 weights 槽，
    # 导致 role_score 恒为默认 0.5、命中与未命中差为 0——这是既有历史 bug，非本次改动引入）。
    # emotion=0.5 中性 → 动态让渡给语义；role 维度命中/未命中保留权重参与。
    hit = _compute_combined_score(0.6, 0.8, 0.5, 1.0, weights=ROLE_DEFAULT_W)
    miss = _compute_combined_score(0.6, 0.8, 0.5, 0.0, weights=ROLE_DEFAULT_W)
    assert abs(hit - miss - 0.09) < 1e-9, f"命中应比未命中多 role 权重 0.09，实际 {hit-miss}"
    print("✓ test_role_score_soft_bonus_no_penalty: 角色命中软加成 +0.09（未命中不破坏既有排序）")


def test_combined_score_weight_sum():
    """综合分权重之和为 1.0，且各维度独立贡献（显式权重集，含中性让渡语义）"""
    score = _compute_combined_score(1.0, 1.0, 1.0, 1.0, weights=ROLE_DEFAULT_W)
    assert abs(score - 1.0) < 1e-9, f"全满分应=1.0，实际 {score}"
    # 语义贡献：emotion/role 均中性(0.5) → 动态让渡给语义 → sem = 0.64+0.05+0.09 = 0.78
    s1 = _compute_combined_score(1.0, 0.0, 0.5, 0.5, weights=ROLE_DEFAULT_W)
    assert abs(s1 - 0.78) < 1e-9, f"语义权重应为 0.78（含中性让渡），实际 {s1}"
    # 角色贡献：仅 role 非中性(1.0) → 保留权重 0.09
    s2 = _compute_combined_score(0.0, 0.0, 0.5, 1.0, weights=ROLE_DEFAULT_W)
    assert abs(s2 - 0.09) < 1e-9, f"角色权重应为 0.09，实际 {s2}"
    print("✓ test_combined_score_weight_sum: 权重系数正确（sem0.78含让渡 / role0.09）")


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