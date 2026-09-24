"""
test_group_soft_excl.py — 🧪 ③ 组内软惩罚（软排他）· L1 单测（方案 §3.4）

口径是**实测重定**的（方案 §3.2 v1.3）：原冻结的「景别等值 + 描述相近」两条在 Layer-2 生产
基质上 100% 空转（父内 shotType 368/368 全等、父内 description 3214/3214 逐字相同）⇒ 会退化为
已被弃用的「同父即罚」。故改锚**同父内段序距离**：|ΔsegmentIndexInParent| >= 2 才罚。

锁六项：
  1. 开关口径：缺省 off / 1·on·true·yes 开 / 其余一律 off
  2. 基本机制：同组两句落同父非相邻片 → on 档把被罚句推向异父
  3. 正反打护栏：候选 parentChunkId 互不相同 → on 档与 off 档逐位一致
  4. 相邻豁免：同父 seg0/seg1（|Δ|=1 连续顺延）→ on 档与 off 档逐位一致
  5. 收敛性：对称代价造成震荡 → 3 轮上限 + 「未收敛」诊断（不静默）+ 仍是合法满指派 + 加罚封顶
  6. 开关隔离：off 档与直接 linear_sum_assignment 逐位一致；padding 列不得越界

运行方式：
  cd resources/scripts
  ..\\ai-env\\python.exe __tests__\\run_all.py     （总入口，自动收集本文件）
"""
import contextlib
import io
import os
import re
import sys

import numpy as np
from scipy.optimize import linear_sum_assignment

# 将 scripts 目录加入 path，以便 import timeline_solver
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from timeline_solver import (
    GROUP_SOFT_MAX_ROUNDS,
    GROUP_SOFT_MAX_TOTAL,
    GROUP_SOFT_SEG_GAP,
    _solve_with_group_soft_exclusion,
    read_group_soft_excl,
)


def _mk_block(chunk_specs, scene_groups=('教室', '教室')):
    """构造最小块上下文：chunk_specs = [(parentChunkId, segmentIndexInParent), ...]。"""
    video_chunks = [
        {'id': f'c{i + 1}', 'parentChunkId': pid, 'segmentIndexInParent': seg,
         'startMs': 1000 * i, 'endMs': 1000 * i + 800, 'shotType': '中景'}
        for i, (pid, seg) in enumerate(chunk_specs)
    ]
    return {
        'block_queries': list(range(len(scene_groups))),
        'block_chunk_idx_list': list(range(len(video_chunks))),
        'valid_chunk_indices': list(range(len(video_chunks))),
        'video_chunks': video_chunks,
        'query_scene_groups': list(scene_groups),
        'local_n_chunks': len(video_chunks),
    }


def _solve(cost, ctx, enabled, local_n_chunks=None):
    """按块上下文求解（cost 可含 padding 列，local_n_chunks 显式覆盖真实列数）。"""
    return _solve_with_group_soft_exclusion(
        np.array(cost, dtype=np.float32), ctx['block_queries'], ctx['block_chunk_idx_list'],
        ctx['valid_chunk_indices'], ctx['video_chunks'], ctx['query_scene_groups'],
        ctx['local_n_chunks'] if local_n_chunks is None else local_n_chunks,
        enabled=enabled)


# ===========================================================================
# 1. 开关口径
# ===========================================================================
def test_read_group_soft_excl_default_off():
    """缺省必须 off（零行为变化）；1/on/true/yes 开启；其余（含非法值）一律 off。"""
    saved = os.environ.pop('ZENTECT_KM_GROUP_SOFT_EXCL', None)
    try:
        assert read_group_soft_excl() is False, "缺省必须 off，否则等于未测量即上线"
        for val in ('1', 'on', 'true', 'yes', 'ON'):
            os.environ['ZENTECT_KM_GROUP_SOFT_EXCL'] = val
            assert read_group_soft_excl() is True, f'{val} 应开启'
        for val in ('off', '0', 'bogus', ''):
            os.environ['ZENTECT_KM_GROUP_SOFT_EXCL'] = val
            assert read_group_soft_excl() is False, f'{val} 应关闭'
    finally:
        if saved is None:
            os.environ.pop('ZENTECT_KM_GROUP_SOFT_EXCL', None)
        else:
            os.environ['ZENTECT_KM_GROUP_SOFT_EXCL'] = saved
    print("✓ test_read_group_soft_excl_default_off: 开关口径正确（缺省 off / 显式开启 / 非法回退）")


# ===========================================================================
# 2. 基本机制（同组同父、段序非相邻 → 加罚重解推向异父）
# ===========================================================================
def test_conflict_pushes_to_other_parent():
    """同组两句落同父 seg0/seg2（|Δ|=2）→ off 档同父、on 档被罚一方改落异父。"""
    assert GROUP_SOFT_SEG_GAP == 2, "段序距离阈值须为 2（=1 相邻顺延豁免，>=2 才罚）"
    ctx = _mk_block([('P', 0), ('P', 2), ('Q', 0)])
    # off 最优 = 0.10 + 0.11 = 0.21（唯一），两句同落父 P；异父备选 0.22 仅贵 0.01 < δ=0.05
    cost = [[0.10, 0.30, 0.40],
            [0.30, 0.11, 0.12]]

    _r_off, c_off = _solve(cost, ctx, False)
    assert list(c_off) == [0, 1], f"off 档应落同父两片，实际 {list(c_off)}"
    assert (ctx['video_chunks'][c_off[0]]['parentChunkId']
            == ctx['video_chunks'][c_off[1]]['parentChunkId'] == 'P'), "off 档前提：两句确在同父"

    _r_on, c_on = _solve(cost, ctx, True)
    assert list(c_on) == [0, 2], f"on 档应把被罚句推向异父 Q，实际 {list(c_on)}"
    assert ctx['video_chunks'][c_on[1]]['parentChunkId'] == 'Q', "被罚句须落到异父切片"
    print("✓ test_conflict_pushes_to_other_parent: 同组同父段序远离 → on 档推向异父")


# ===========================================================================
# 3. 护栏：正反打（异 parentChunkId）不在罚则内
# ===========================================================================
def test_different_parent_not_penalized():
    """同 sceneGroup 但候选父镜头互不相同（正反打）→ on 档必须与 off 档逐位一致。"""
    ctx = _mk_block([('A', 0), ('B', 0), ('C', 0)])
    cost = [[0.10, 0.30, 0.40],
            [0.30, 0.11, 0.12]]

    r_off, c_off = _solve(cost, ctx, False)
    r_on, c_on = _solve(cost, ctx, True)
    assert list(c_off) == [0, 1], f"off 档应落 A/B 两镜，实际 {list(c_off)}"
    assert np.array_equal(r_off, r_on) and np.array_equal(c_off, c_on), \
        "异父（正反打）不得被罚：on 档必须与 off 档逐位一致"
    print("✓ test_different_parent_not_penalized: 正反打护栏生效（on 档不改选择）")


# ===========================================================================
# 4. 相邻豁免（|Δ|=1：同一镜头的连续顺延，补丁8 明确合法）
# ===========================================================================
def test_adjacent_segments_exempt():
    """同父 seg0/seg1（|Δ|=1 < GAP）→ 连续顺延不得被罚：on 档与 off 档逐位一致。"""
    ctx = _mk_block([('P', 0), ('P', 1), ('Q', 0)])
    cost = [[0.10, 0.30, 0.40],
            [0.30, 0.11, 0.12]]

    r_off, c_off = _solve(cost, ctx, False)
    assert list(c_off) == [0, 1], f"off 档应落同父相邻两片，实际 {list(c_off)}"
    assert (ctx['video_chunks'][c_off[0]]['parentChunkId']
            == ctx['video_chunks'][c_off[1]]['parentChunkId'] == 'P'), \
        "本测试前提：off 档确为同父（否则豁免断言空洞）"

    r_on, c_on = _solve(cost, ctx, True)
    assert np.array_equal(r_off, r_on) and np.array_equal(c_off, c_on), \
        "相邻段（同镜头连续顺延）必须豁免：实测基线 9/16 对属此类，不得误伤"
    print("✓ test_adjacent_segments_exempt: 同父相邻段豁免（连续顺延不罚）")


# ===========================================================================
# 5. 收敛性（3 轮上限 + 未收敛诊断 + 加罚封顶）
# ===========================================================================
def test_max_rounds_cap_and_no_silent_truncation():
    """对称代价使加罚在两侧来回 → 3 轮仍不收敛：必须有诊断（不静默），且仍是合法满指派。"""
    ctx = _mk_block([('P', 0), ('P', 2)])
    cost = [[0.10, 0.11],
            [0.11, 0.10]]

    buf = io.StringIO()
    with contextlib.redirect_stderr(buf):
        _r_on, c_on = _solve(cost, ctx, True)
    log = buf.getvalue()

    assert 'group-soft-excl' in log, f"诊断行必须走 _km_diag 输出，实际 {log!r}"
    assert '未收敛' in log, f"{GROUP_SOFT_MAX_ROUNDS} 轮不收敛必须打诊断，不得静默截断：{log!r}"
    assert sorted(c_on) == [0, 1], f"取当前解仍须是合法满指派，实际 {sorted(c_on)}"

    deltas = [float(m) for m in re.findall(r'累计δ=([\d.]+)', log)]
    assert deltas, f"每轮必须打印累计δ，实际 {log!r}"
    assert max(deltas) <= GROUP_SOFT_MAX_TOTAL + 1e-6, \
        f"单格累计加罚不得越过封顶 {GROUP_SOFT_MAX_TOTAL}，实际 {max(deltas)}"
    print("✓ test_max_rounds_cap_and_no_silent_truncation: 3 轮上限 + 未收敛诊断 + 封顶正确")


# ===========================================================================
# 6. 开关隔离（off 档逐位一致 + padding 列不越界）
# ===========================================================================
def test_off_bitwise_identical_to_reference():
    """off 档（显式 False / env 缺省）与直接 linear_sum_assignment 逐位一致；padding 列不得越界。"""
    ctx = _mk_block([('P', 0), ('P', 2), ('Q', 0)])
    cost = np.array([[0.10, 0.30, 0.40],
                     [0.30, 0.11, 0.12]], dtype=np.float32)
    ref_r, ref_c = linear_sum_assignment(cost)

    saved = os.environ.pop('ZENTECT_KM_GROUP_SOFT_EXCL', None)
    try:
        for enabled in (False, None):   # None = 读 env（此时缺省 off）
            r, c = _solve(cost, ctx, enabled)
            assert np.array_equal(r, ref_r) and np.array_equal(c, ref_c), \
                f"off 档（enabled={enabled}）必须与直接求解逐位一致"
    finally:
        if saved is None:
            os.environ.pop('ZENTECT_KM_GROUP_SOFT_EXCL', None)
        else:
            os.environ['ZENTECT_KM_GROUP_SOFT_EXCL'] = saved

    # padding 列：真实列数 2 < 矩阵列数 3（第 3 列为补零列）→ 冲突判定必须跳过，不得越界
    ctx_pad = _mk_block([('P', 0), ('P', 2)])
    cost_pad = np.array([[0.10, 0.30, 5.0],
                         [0.30, 0.11, 5.0]], dtype=np.float32)
    rp_ref, cp_ref = linear_sum_assignment(cost_pad)
    rp_off, cp_off = _solve(cost_pad, ctx_pad, False, local_n_chunks=2)
    assert np.array_equal(rp_off, rp_ref) and np.array_equal(cp_off, cp_ref), \
        "off 档在 padding 矩阵上必须与直接求解逐位一致"
    with contextlib.redirect_stderr(io.StringIO()):
        _rp_on, cp_on = _solve(cost_pad, ctx_pad, True, local_n_chunks=2)
    assert sorted(cp_on) == [0, 1], f"padding 列不得被当作实体切片，实际 {sorted(cp_on)}"
    print("✓ test_off_bitwise_identical_to_reference: off 档逐位一致 + padding 列不越界")


if __name__ == "__main__":
    print("=" * 60)
    print("🧪 ③ 组内软惩罚（软排他）· L1 单测（方案 §3.4）")
    print("=" * 60)
    test_read_group_soft_excl_default_off()
    test_conflict_pushes_to_other_parent()
    test_different_parent_not_penalized()
    test_adjacent_segments_exempt()
    test_max_rounds_cap_and_no_silent_truncation()
    test_off_bitwise_identical_to_reference()
    print("=" * 60)
    print("全部通过 ✅")