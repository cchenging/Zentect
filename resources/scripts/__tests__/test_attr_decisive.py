"""
test_attr_decisive.py —— 🎯 属性维「决胜带」（方案1；2026-10-20）

锁定 bug「工单声明的画面属性对选片零贡献」：属性六维此前只以 ±0.04/维、整趟封顶 ±0.20 的软阻尼
并入候选代价，在**语义难分伯仲的近分簇**里与该句其他候选同向平移 ⇒ 相对序不变、被语义主分
（权重 0.64）淹没。实测取证：2026-10-20 两次真实步骤5 运行，主体维命中 651→710（59 处 miss↔match
翻转），选片序列 81 段**逐段完全相同**、综合 Top1 语义名次 r1 恒为 69/80。

修法：`_calc_row` 内把「本句 base（不含属性）最优」当基准，与基准差 ≤ `ATTR_DECISIVE_BAND`
的近分候选，属性权重按线性衰减放大（带中心最大 ×1.6，带沿归零）；带外候选恒 +0.00 ⇒ 逐字节
保持原软阻尼口径。开关 `ZENTECT_KM_ATTR_DECISIVE`（缺省 on，'0' 回退原口径）。

覆盖点：
  1. 近分带内：off 档保持语义序（语义最优胜），on 档属性翻盘（属性贴合的候选胜）——
     且增量严格等于 0.12·(attr/0.20)·(1−gap/0.10)。
  2. 近分带外（gap > 带）：属性**不得越带翻盘**（语义最优仍胜），带外候选增量恒 0。
  3. 属性无判别力（行内属性全体同值）：on 档与 off 档**逐字节一致**，排序不被扰动。
  4. off 档（env '0'）＝ 原口径「base + attr」逐字节成立（零行为变化，可一键回退）。

造数口径：quad 场景用 fake BGE 编码器给可控余弦；时长/情绪/角色三维在候选间**完全同值**
（同 startMs/endMs、空 emotion、空 charIds）⇒ base 差只来自语义分，断言可精确闭式核对。

运行方式：
  cd resources/scripts
  ..\\ai-env\\python.exe __tests__\\test_attr_decisive.py   # 单文件直跑
  ..\\ai-env\\python.exe __tests__\\run_all.py               # L1 总入口（自动收集本文件）
"""
import math
import os
import sys
import numpy as np

# 将 scripts 目录加入 path，以便 import match_cost / timeline_solver
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import match_cost
from match_cost import ATTR_DECISIVE_BAND, ATTR_DECISIVE_GAIN, build_match_cost

# 显式权重集：情绪/角色权重显式置 0（二者在测试里恒为中性 0.5，若留权重会被
# `_compute_combined_score` 的动态让渡并入语义 ⇒ 有效语义权重变成 0.78、断言闭式失准）。
# 置 0 后让渡搬运量恒为 0，有效语义权重锁定 0.78 ⇒ base 差 = 0.78×语义归一化差，可精确核对。
W = dict(sem=0.78, emotion=0.0, duration=0.22, role=0.0)
_SEM_W = 0.78         # 有效语义权重（= W['sem']，让渡后不变）
_ATTR_CAP = 0.20      # = montage_contract.ATTR_TOTAL_CAP（单维 ±0.04、六维封顶）


# ---- fake BGE 编码器：按文本内容映射固定向量（L2 归一化），余弦可控 ----
_QUERY_TEXT = 'Q文案'
_VEC_RAW = {}


def _vec(cos: float) -> np.ndarray:
    """构造与 [1,0] 夹角余弦为 cos 的单位向量（2 维，便于闭式核对余弦）。"""
    return np.array([cos, math.sqrt(max(0.0, 1.0 - cos * cos))], dtype=np.float32)


def _setup_vecs(cos_c2: float) -> None:
    """装配本用例的三向量：q=[1,0]、c1 余弦 0.90、c2 余弦 cos_c2、c3 余弦 0（锚定 min-max 下界）。

    语义归一化差 = 余弦差 / 0.90（min=0、max=0.90）；base 差 = `_SEM_W` × 该差。
    故 cos_c2 由「目标 base 差」反解：cos_c2 = 0.90 × (1 − 目标差 / _SEM_W)。
    """
    _VEC_RAW.clear()
    _VEC_RAW[_QUERY_TEXT] = np.array([1.0, 0.0], dtype=np.float32)
    _VEC_RAW['c1desc'] = _vec(0.90)
    _VEC_RAW['c2desc'] = _vec(cos_c2)
    _VEC_RAW['c3desc'] = _vec(0.0)


def _fake_encode_texts(texts, batch_size=32, max_length=512):
    """测试替身：返回固定向量矩阵（行=文本，已 L2 归一化，模拟 BGE 编码结果）。"""
    memo = {}
    for t, v in _VEC_RAW.items():
        n = np.linalg.norm(v) + 1e-12
        memo[t] = v / n
    return np.stack([memo.get(t, np.zeros(2, np.float32)) for t in texts]).astype(np.float32)


def _patch_encode():
    """monkeypatch match_cost.AIModels.encode_texts 为 fake；返回恢复函数。"""
    orig = match_cost.AIModels.encode_texts
    match_cost.AIModels.encode_texts = staticmethod(_fake_encode_texts)
    return lambda: setattr(match_cost.AIModels, 'encode_texts', orig)


def _with_envs(mapping, fn):
    """在指定一组 env 取值下执行 fn（执行后逐个还原，避免测试间互相污染）。"""
    saved = {k: os.environ.get(k) for k in mapping}
    for k, v in mapping.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    try:
        return fn()
    finally:
        for k, old in saved.items():
            if old is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = old


# 基础 env：β=0 走纯拼接语义（单路编码，便于闭式核对）；supply/desc_aug 关闭；量纲对齐 minmax
_BASE = {'ZENTECT_KM_SEM_NORM': 'minmax', 'ZENTECT_KM_SUPPLY_DUR': None,
         'ZENTECT_KM_DESC_AUG': None, 'ZENTECT_KM_DUR_WEIGHT': None}


def _run(envs, chunk_by_id, cands):
    """在给定 env 下跑 build_match_cost（text_beta=0.0 纯拼接、固定权重，隔离干扰）。"""
    queries = [{'shotId': 's1', 'text': _QUERY_TEXT, 'visualIntent': '',
                'audioDurationMs': 3000.0, 'emotion': '', 'moodIntent': '', 'charIds': [],
                'preferredShot': 'CLOSE_SHOT'}]
    return _with_envs(envs, lambda: build_match_cost(
        queries, chunk_by_id, cands, weights=W, text_beta=0.0))


def _chunk(cid, desc, shot_scale):
    """造候选切片：时长/情绪/角色三维同值（同 0~3000ms、空 emotion、无 charIds）。"""
    return {'id': cid, 'description': desc, 'parentChunkId': cid, 'filePath': 'v.mp4',
            'startMs': 0.0, 'endMs': 3000.0, 'emotion': '', 'charIds': [],
            'charGrain': 'ok', 'shotScale': shot_scale}


def _row3(shot_scale_c1, shot_scale_c2, shot_scale_c3):
    """三候选资产：c1 语义最优（desc 余弦 0.90）、c2 次之、c3 垫底（锚定 min-max 下界）。"""
    return {'c1': _chunk('c1', 'c1desc', shot_scale_c1),
            'c2': _chunk('c2', 'c2desc', shot_scale_c2),
            'c3': _chunk('c3', 'c3desc', shot_scale_c3)}, {'s1': ['c1', 'c2', 'c3']}


def test_attr_decisive_flips_within_band():
    """近分带内：off 档语义优先（c1 胜），on 档属性翻盘（c2 胜），增量 = 0.12·(attr/0.20)·(1−gap/0.10)。"""
    # 目标 base 差(gap) = 0.09（带内，≤ 0.10）；且 0.09 > 单维属性差 0.08 ⇒ off 档属性不足以翻盘
    #   cos2 = 0.90 × (1 − 0.09/0.78) ≈ 0.7962
    _setup_vecs(0.90 * (1.0 - 0.09 / _SEM_W))
    restore = _patch_encode()
    try:
        # c1 景别「全景」= 与声明 CLOSE_SHOT 相隔 2 带 ⇒ 落空(+0.04)；c2「近景」= 命中(−0.04)；c3 无景别 ⇒ 中性
        chunk_by_id, cands = _row3('全景', '近景', '')

        m_off = _run({**_BASE, 'ZENTECT_KM_ATTR_DECISIVE': '0'}, chunk_by_id, cands)
        m_on = _run({**_BASE, 'ZENTECT_KM_ATTR_DECISIVE': '1'}, chunk_by_id, cands)

        # ① off 档：语义最优（c1）胜 —— 语义差 0.09 > 单维属性差 0.08，属性不足以翻盘
        assert m_off['s1']['c1'] < m_off['s1']['c2'], f"off 档应保持语义序，实际 {m_off['s1']}"
        # ② on 档：属性贴合者（c2）翻盘
        assert m_on['s1']['c2'] < m_on['s1']['c1'], f"on 档近分带内属性应翻盘，实际 {m_on['s1']}"
        # ③ 增量式核对（闭式）：带中心(gap=0) c1 ⇒ +0.12×(0.04/0.20)×1.0；带沿前(gap=0.09) c2 ⇒ 0.12×(−0.2)×0.1
        _d1 = m_on['s1']['c1'] - m_off['s1']['c1']
        _d2 = m_on['s1']['c2'] - m_off['s1']['c2']
        assert abs(_d1 - ATTR_DECISIVE_GAIN * (0.04 / _ATTR_CAP)) < 1e-9, f"c1 增量应为 +0.024，实际 {_d1}"
        _expect_d2 = ATTR_DECISIVE_GAIN * (-0.04 / _ATTR_CAP) * (1.0 - 0.09 / ATTR_DECISIVE_BAND)
        # 容差 1e-6：gap 由 float32 向量余弦推得（~1e-7 级误差），不追求逐位相等
        assert abs(_d2 - _expect_d2) < 1e-6, f"c2 增量应为 {_expect_d2}，实际 {_d2}"
        # ④ 带外候选（c3，gap=0.64）增量恒 0（零行为变化）
        assert m_on['s1']['c3'] == m_off['s1']['c3'], "带外候选不得被放大"
    finally:
        restore()
    print("✓ test_attr_decisive_flips_within_band: 近分带内属性翻盘生效")


def test_attr_decisive_never_crosses_band():
    """近分带外（gap > 带）：属性不得越带翻盘（语义最优仍胜），带外候选增量恒 0。"""
    # 目标 base 差(gap) = 0.30（带外，> 0.10）；cos2 = 0.90 × (1 − 0.30/0.78) ≈ 0.5538
    _setup_vecs(0.90 * (1.0 - 0.30 / _SEM_W))
    restore = _patch_encode()
    try:
        chunk_by_id, cands = _row3('全景', '近景', '')
        m_off = _run({**_BASE, 'ZENTECT_KM_ATTR_DECISIVE': '0'}, chunk_by_id, cands)
        m_on = _run({**_BASE, 'ZENTECT_KM_ATTR_DECISIVE': '1'}, chunk_by_id, cands)

        assert m_off['s1']['c1'] < m_off['s1']['c2'], f"off 档语义序，实际 {m_off['s1']}"
        assert m_on['s1']['c1'] < m_on['s1']['c2'], \
            f"带外属性不得翻盘（语义差 0.30 明显），实际 {m_on['s1']}"
        # 带外候选（c2）逐字节不变 ⇒ 语义差距明显的句完全保持原口径
        assert m_on['s1']['c2'] == m_off['s1']['c2'], "带外候选不得被放大"
        assert m_on['s1']['c3'] == m_off['s1']['c3'], "带外候选不得被放大"
    finally:
        restore()
    print("✓ test_attr_decisive_never_crosses_band: 带外不越带翻盘")


def test_attr_decisive_no_signal_keeps_bytewise():
    """属性无判别力（行内属性全体同值）：on 档与 off 档逐字节一致，排序不被扰动。"""
    _setup_vecs(0.90 * (1.0 - 0.09 / _SEM_W))   # 同用例1的带内 gap，但两侧属性都无信号
    restore = _patch_encode()
    try:
        # 三个候选都无景别标签 ⇒ 景别维全中性；query 亦无运镜/空间/主体/道具/动作声明 ⇒ 属性恒 0
        chunk_by_id, cands = _row3('', '', '')
        m_off = _run({**_BASE, 'ZENTECT_KM_ATTR_DECISIVE': '0'}, chunk_by_id, cands)
        m_on = _run({**_BASE, 'ZENTECT_KM_ATTR_DECISIVE': '1'}, chunk_by_id, cands)
        assert m_on == m_off, f"无属性信号时 on 档须与 off 逐字节一致，on={m_on['s1']} off={m_off['s1']}"
        assert m_on['s1']['c1'] < m_on['s1']['c2'], f"应由语义序决定，实际 {m_on['s1']}"
    finally:
        restore()
    print("✓ test_attr_decisive_no_signal_keeps_bytewise: 无信号零扰动")


def test_attr_decisive_off_matches_legacy_costs():
    """off 档（env '0'）＝ 原口径「base + attr」逐字节成立（可一键回退，零行为变化）。"""
    _setup_vecs(0.90 * (1.0 - 0.09 / _SEM_W))
    restore = _patch_encode()
    try:
        chunk_by_id, cands = _row3('全景', '近景', '')
        m_off = _run({**_BASE, 'ZENTECT_KM_ATTR_DECISIVE': '0'}, chunk_by_id, cands)
        # base 差只来自语义：base2 − base1 = 0.78×(1−归一化差) = 0.09；属性差 attr1 − attr2 = 0.08
        # ⇒ 原口径 (base1+attr1) − (base2+attr2) = 0.08 − 0.09 = −0.01（无任何放大项）
        _diff = m_off['s1']['c1'] - m_off['s1']['c2']
        assert abs(_diff - (-0.01)) < 1e-6, f"off 档应为原口径 base+attr（差 −0.01），实际 {_diff}"
    finally:
        restore()
    print("✓ test_attr_decisive_off_matches_legacy_costs: off 档逐字节回退原口径")


if __name__ == "__main__":
    print("=" * 60)
    print("🎯 属性维「决胜带」（方案1）验证")
    print("=" * 60)
    test_attr_decisive_flips_within_band()
    test_attr_decisive_never_crosses_band()
    test_attr_decisive_no_signal_keeps_bytewise()
    test_attr_decisive_off_matches_legacy_costs()
    print("=" * 60)
    print("全部通过 ✅")
