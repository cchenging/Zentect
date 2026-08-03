"""
test_cluster_postprocess.py — 🎭 P0.5+ 聚类后处理逻辑验证
验证 _merge_clusters_by_cosine 和 _assign_noise_points 的正确性

运行方式：
  cd resources/scripts
  python -m __tests__.test_cluster_postprocess
"""
import sys
import os
import numpy as np

# 将 scripts 目录加入 path，以便 import face_analysis
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from face_analysis import _merge_clusters_by_cosine, _assign_noise_points, _compute_cluster_centers


def _normalize(v):
    """归一化向量"""
    n = np.linalg.norm(v)
    return v / n if n > 1e-6 else v


def _make_embedding(angle_deg):
    """生成 2D 归一化 embedding（用于测试，角度差代表相似度）"""
    rad = np.radians(angle_deg)
    return _normalize(np.array([np.cos(rad), np.sin(rad)], dtype=np.float32))


def test_merge_clusters_basic():
    """基础场景：两个簇心余弦相似度 > 阈值，应合并"""
    # 簇 A：4 个点角度 0~10 度
    # 簇 B：4 个点角度 5~15 度（与 A 高度重叠，应合并）
    embeddings = np.array([
        _make_embedding(0), _make_embedding(5), _make_embedding(10), _make_embedding(8),
        _make_embedding(6), _make_embedding(12), _make_embedding(15), _make_embedding(9),
    ])
    labels = np.array([0, 0, 0, 0, 1, 1, 1, 1])

    # 阈值 0.95（cosine 0.95 ≈ 角度差 18 度），两簇心应相似度 > 0.95
    merged = _merge_clusters_by_cosine(embeddings, labels, threshold=0.95)
    # 合并后应只有 1 个簇
    unique = set(merged.tolist())
    assert -1 not in unique, "不应有噪声点"
    assert len(unique) == 1, f"应合并为 1 个簇，实际 {unique}"
    print(f"✓ test_merge_clusters_basic: 2 簇 → 1 簇 (合并成功)")


def test_merge_clusters_no_merge():
    """不应合并场景：两个簇心相似度 < 阈值，保持独立"""
    # 簇 A：角度 0 度附近
    # 簇 B：角度 90 度附近（cosine ≈ 0，完全不相似）
    embeddings = np.array([
        _make_embedding(0), _make_embedding(5),
        _make_embedding(90), _make_embedding(95),
    ])
    labels = np.array([0, 0, 1, 1])

    merged = _merge_clusters_by_cosine(embeddings, labels, threshold=0.95)
    unique = set(merged.tolist())
    assert len(unique) == 2, f"应保持 2 个独立簇，实际 {unique}"
    print(f"✓ test_merge_clusters_no_merge: 2 簇保持独立 (未误合并)")


def test_assign_noise_points_basic():
    """噪声点分配：噪声点与某簇心相似度 > 阈值时分配"""
    # 簇 0：角度 0 度
    # 簇 1：角度 90 度
    # 噪声点：角度 3 度（应分配到簇 0）
    # 噪声点：角度 92 度（应分配到簇 1）
    # 噪声点：角度 45 度（与两簇都不相似，保持噪声）
    embeddings = np.array([
        _make_embedding(0), _make_embedding(2),       # 簇 0
        _make_embedding(90), _make_embedding(88),     # 簇 1
        _make_embedding(3),                            # 噪声 → 应分配到簇 0
        _make_embedding(92),                           # 噪声 → 应分配到簇 1
        _make_embedding(45),                           # 噪声 → 保持 -1
    ])
    labels = np.array([0, 0, 1, 1, -1, -1, -1])

    result = _assign_noise_points(embeddings, labels, threshold=0.95)
    assert result[4] == 0, f"噪声点 4 应分配到簇 0，实际 {result[4]}"
    assert result[5] == 1, f"噪声点 5 应分配到簇 1，实际 {result[5]}"
    assert result[6] == -1, f"噪声点 6 应保持 -1，实际 {result[6]}"
    print(f"✓ test_assign_noise_points_basic: 2/3 噪声点分配成功，1 个保持噪声")


def test_assign_noise_points_all_noise():
    """全是噪声点时（无有效簇）应保持原样"""
    embeddings = np.array([_make_embedding(0), _make_embedding(90)])
    labels = np.array([-1, -1])

    result = _assign_noise_points(embeddings, labels, threshold=0.95)
    assert (result == -1).all(), "无有效簇时所有点应保持噪声"
    print(f"✓ test_assign_noise_points_all_noise: 全噪声时保持原样")


def test_invalid_threshold():
    """无效阈值（<=0 或 >=1）时应直接返回原 labels"""
    embeddings = np.array([_make_embedding(0), _make_embedding(90)])
    labels = np.array([0, 1])

    # 阈值 = 0
    assert (_merge_clusters_by_cosine(embeddings, labels, 0) == labels).all()
    assert (_assign_noise_points(embeddings, labels, 0) == labels).all()
    # 阈值 = 1
    assert (_merge_clusters_by_cosine(embeddings, labels, 1) == labels).all()
    assert (_assign_noise_points(embeddings, labels, 1) == labels).all()
    # 阈值 = -0.5
    assert (_merge_clusters_by_cosine(embeddings, labels, -0.5) == labels).all()
    print(f"✓ test_invalid_threshold: 无效阈值时跳过处理")


def test_compute_cluster_centers():
    """簇心计算：归一化 embedding 均值后再归一化"""
    embeddings = np.array([
        _make_embedding(0), _make_embedding(10),  # 簇 0
        _make_embedding(90),                       # 簇 1
    ])
    labels = np.array([0, 0, 1])

    centers = _compute_cluster_centers(embeddings, labels)
    assert 0 in centers and 1 in centers, "应包含两个簇心"
    assert -1 not in centers, "不应包含噪声簇"
    # 簇心应是单位向量
    for cid, center in centers.items():
        norm = np.linalg.norm(center)
        assert 0.99 < norm < 1.01, f"簇 {cid} 心非单位向量，norm={norm}"
    print(f"✓ test_compute_cluster_centers: 簇心计算正确（单位向量）")


def test_merge_then_assign_integration():
    """集成场景：先合并过拆簇，再分配噪声点"""
    # 同一人物的 3 个子簇（角度相近，应合并）
    embeddings = np.array([
        _make_embedding(0), _make_embedding(2),    # 子簇 0
        _make_embedding(5), _make_embedding(7),    # 子簇 1（与 0 相似，应合并）
        _make_embedding(10), _make_embedding(12),  # 子簇 2（与 0/1 相似，应合并）
        _make_embedding(90), _make_embedding(92),  # 簇 3（另一人物，独立）
        _make_embedding(4),                         # 噪声点（应分配到合并后的簇 0）
    ])
    labels = np.array([0, 0, 1, 1, 2, 2, 3, 3, -1])

    # Step 1: 合并
    merged = _merge_clusters_by_cosine(embeddings, labels, threshold=0.95)
    unique_merged = set(merged.tolist())
    # 去除噪声点 -1 后，应有 2 个有效簇（人物 A = 子簇 0/1/2 合并 + 人物 B = 簇 3）
    effective_clusters = unique_merged - {-1}
    assert len(effective_clusters) == 2, f"合并后应剩 2 个有效簇（人物 A + 人物 B），实际 {unique_merged}"

    # Step 2: 分配噪声点
    final = _assign_noise_points(embeddings, merged, threshold=0.95)
    # 噪声点（角度 4 度）应分配到人物 A 的簇
    assert final[8] != -1, f"噪声点应被分配，实际保持 -1"
    print(f"✓ test_merge_then_assign_integration: 3 子簇 → 1 簇，噪声点分配成功")


if __name__ == "__main__":
    print("=" * 60)
    print("🎭 P0.5+ 聚类后处理逻辑验证")
    print("=" * 60)
    test_merge_clusters_basic()
    test_merge_clusters_no_merge()
    test_assign_noise_points_basic()
    test_assign_noise_points_all_noise()
    test_invalid_threshold()
    test_compute_cluster_centers()
    test_merge_then_assign_integration()
    print("=" * 60)
    print("✅ 全部测试通过")
    print("=" * 60)
