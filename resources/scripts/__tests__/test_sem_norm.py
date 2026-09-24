"""
test_sem_norm.py — 🎯 方向2 语义量纲对齐验证
验证 match_cost 的候选内 min-max 归一化：
  1. _read_sem_norm_mode 开关解析（缺省 minmax / off / 非法回退 / override 优先）
  2. _norm_cand_sem 归一化正确性（单调变换、[0,1] 区间、防除零）
  3. 端到端机制：未归一化时「语义精确但时长差」的切片被高分时长项翻盘，
     归一化后语义权重真正主导、正确切片回到综合 Top-1（量纲对齐救回 case）

运行方式：
  cd resources/scripts
  ..\\ai-env\\python.exe -m __tests__.test_sem_norm
"""
import os
import sys
import numpy as np

# 将 scripts 目录加入 path，以便 import match_cost / timeline_solver
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import match_cost
from match_cost import (
    _read_sem_norm_mode, _norm_cand_sem, build_match_cost,
    _read_desc_aug, _build_chunk_semantic_text,
)

# 显式权重集（避免运行环境 ZENTECT_KM_DUR_WEIGHT 等 env 覆盖干扰断言）
W = dict(sem=0.64, emotion=0.05, duration=0.22, role=0.09)


# ---- fake BGE 编码器：按文本内容映射固定向量，sim 值可控 ----
_VEC_RAW = {
    'c1desc': np.array([1.0, 0.0, 0.0], dtype=np.float32),        # 正确切片描述
    'c2desc': np.array([0.0, 1.0, 0.0], dtype=np.float32),        # 错误切片描述
    '文案A': np.array([0.6, 0.5, 0.0], dtype=np.float32),         # 纯 text query → sim(c1)=0.768 / sim(c2)=0.640
    '文案A 画面意图B': np.array([0.8, 0.2, 0.0], dtype=np.float32),  # concat query（β=1.0 时只影响 DIAG 基线）
}


def _fake_encode_texts(texts, batch_size=32, max_length=512):
    """测试替身：返回固定向量矩阵（行=文本，L2 归一化，模拟 BGE 编码结果）。"""
    memo = {}
    for t, v in _VEC_RAW.items():
        n = np.linalg.norm(v) + 1e-12
        memo[t] = v / n
    return np.stack([memo.get(t, np.zeros(3, np.float32)) for t in texts]).astype(np.float32)


def _patch_encode():
    """monkeypatch match_cost.AIModels.encode_texts 为 fake；返回恢复函数。"""
    orig = match_cost.AIModels.encode_texts
    match_cost.AIModels.encode_texts = staticmethod(_fake_encode_texts)
    return lambda: setattr(match_cost.AIModels, 'encode_texts', orig)


def test_read_sem_norm_mode_default_minmax():
    """缺省为 minmax（方向2 主行为）；off 可回退；非法值错就错按 minmax 落；override 优先。"""
    saved = os.environ.pop('ZENTECT_KM_SEM_NORM', None)
    try:
        assert _read_sem_norm_mode() == 'minmax'
        os.environ['ZENTECT_KM_SEM_NORM'] = 'off'
        assert _read_sem_norm_mode() == 'off'
        os.environ['ZENTECT_KM_SEM_NORM'] = 'bogus'
        assert _read_sem_norm_mode() == 'minmax'
        os.environ['ZENTECT_KM_SEM_NORM'] = 'minmax'
        assert _read_sem_norm_mode(override='off') == 'off'
    finally:
        if saved is None:
            os.environ.pop('ZENTECT_KM_SEM_NORM', None)
        else:
            os.environ['ZENTECT_KM_SEM_NORM'] = saved
    print("✓ test_read_sem_norm_mode_default_minmax: 开关解析正确（缺省 minmax / off / 非法回退）")


def test_norm_cand_sem():
    """min-max 归一化：单调变换不改语义排序、结果落 [0,1]、单候选与全等保持原值。"""
    vals = [0.4, 0.5, 0.7, 0.2]
    out = _norm_cand_sem(vals)
    assert min(out) == 0.0 and max(out) == 1.0, f"区间应 [0,1]，实际 {out}"
    # 单调：排序关系不变
    order_a = np.argsort(np.argsort(vals))
    order_b = np.argsort(np.argsort(out))
    assert (order_a == order_b).all(), "归一化必须保持候选内语义排序"
    assert abs(out[2] - 1.0) < 1e-12, f"最大值应映射到 1.0"
    assert abs(out[3] - 0.0) < 1e-12, f"最小值应映射到 0.0"
    # 单候选 / 全相等：保持原值（无判别梯度，防除零）
    assert _norm_cand_sem([0.45]) == [0.45]
    assert _norm_cand_sem([0.5, 0.5]) == [0.5, 0.5]
    print("✓ test_norm_cand_sem: 单调/区间/防除零正确")


def test_sem_norm_rescues_semantic_top1():
    """端到端机制：语义精确(0.768 vs 0.640)但时长差(0.6倍)的正确切片，
    未归一化被高分时长项翻盘 → 归一化后语义主导回到综合 Top-1。"""
    restore = _patch_encode()
    try:
        queries = [{
            'shotId': 's1',
            'text': '文案A',
            'visualIntent': '画面意图B',
            'audioDurationMs': 3000.0,
            'emotion': '',
            'moodIntent': '',
            'charIds': [],
        }]
        chunk_by_id = {
            'c1': {'description': 'c1desc', 'startMs': 0, 'endMs': 1800,  # ratio 0.6 → 时长分 0.40
                   'emotion': '', 'charIds': [], 'charGrain': 'ok'},
            'c2': {'description': 'c2desc', 'startMs': 0, 'endMs': 3000,  # ratio 1.0 → 时长分 0.95
                   'emotion': '', 'charIds': [], 'charGrain': 'ok'},
        }
        cands_by_shotid = {'s1': ['c1', 'c2']}

        # off：未归一化 → 综合 Top-1 = c2（时长反超语义）
        os.environ['ZENTECT_KM_SEM_NORM'] = 'off'
        m_off = build_match_cost(queries, chunk_by_id, cands_by_shotid, weights=W, text_beta=1.0)
        assert m_off['s1']['c2'] < m_off['s1']['c1'], \
            f"off 时应被时长翻盘(c2 胜)，实际 c1={m_off['s1']['c1']:.4f} c2={m_off['s1']['c2']:.4f}"

        # minmax：量纲对齐 → 综合 Top-1 = c1（语义精确匹配回位）
        os.environ['ZENTECT_KM_SEM_NORM'] = 'minmax'
        m_norm = build_match_cost(queries, chunk_by_id, cands_by_shotid, weights=W, text_beta=1.0)
        assert m_norm['s1']['c1'] < m_norm['s1']['c2'], \
            f"minmax 时应救回语义 Top-1(c1 胜)，实际 c1={m_norm['s1']['c1']:.4f} c2={m_norm['s1']['c2']:.4f}"
    finally:
        os.environ.pop('ZENTECT_KM_SEM_NORM', None)
        restore()
    print("✓ test_sem_norm_rescues_semantic_top1: 量纲对齐救回被时长翻盘的语义精确切片")


def test_read_desc_aug():
    """desc_aug 开关：缺省 False（守「未测量即上线」）；1/on/true/yes 开启；非法 False。"""
    saved = os.environ.pop('ZENTECT_KM_DESC_AUG', None)
    try:
        assert _read_desc_aug() is False
        for val in ('1', 'on', 'true', 'yes', 'ON'):
            os.environ['ZENTECT_KM_DESC_AUG'] = val
            assert _read_desc_aug() is True, f'{val} 应开启'
        os.environ['ZENTECT_KM_DESC_AUG'] = 'bogus'
        assert _read_desc_aug() is False
        assert _read_desc_aug(override=True) is True
    finally:
        if saved is None:
            os.environ.pop('ZENTECT_KM_DESC_AUG', None)
        else:
            os.environ['ZENTECT_KM_DESC_AUG'] = saved
    print("✓ test_read_desc_aug: 开关解析正确（缺省 off / 显式开启 / 非法回退）")


def test_build_chunk_semantic_text():
    """描述增强：off 时纯 description（零行为变化）；on 时并入非空实体摘要（中文标签）；
    无实体字段时退化纯描述。"""
    chunk = {
        'description': '机场大厅，韩智恩拖着行李箱。',
        'primarySubject': '韩智恩',
        'shotScale': '全景',
        'location': '机场',
        'camera': '',
        'keyProps': '',
        'costume': '',
        'weatherEnv': '',
    }
    plain = _build_chunk_semantic_text(chunk, False)
    assert plain == '机场大厅，韩智恩拖着行李箱。', f"off 应纯描述，实际 {plain}"
    aug = _build_chunk_semantic_text(chunk, True)
    assert '主体:韩智恩' in aug and '景别:全景' in aug and '地点:机场' in aug, f"应含实体摘要，实际 {aug}"
    assert '机场大厅，韩智恩拖着行李箱。' in aug, f"描述应保留，实际 {aug}"
    assert '运镜:' not in aug and '道具:' not in aug, f"空实体不入，实际 {aug}"
    # 无实体字段：退化纯描述
    bare = {'description': '只有描述。'}
    assert _build_chunk_semantic_text(bare, True) == '只有描述。'
    print("✓ test_build_chunk_semantic_text: 描述增强构造正确（并入非空实体 / 空实体退化）")


if __name__ == "__main__":
    print("=" * 60)
    print("🎯 方向2 语义量纲对齐验证")
    print("=" * 60)
    test_read_sem_norm_mode_default_minmax()
    test_norm_cand_sem()
    test_sem_norm_rescues_semantic_top1()
    test_read_desc_aug()
    test_build_chunk_semantic_text()
    print("=" * 60)
    print("✅ 全部测试通过")
    print("=" * 60)
