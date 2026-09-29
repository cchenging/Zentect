"""
test_forward_lookout.py — 🧊 步骤5 新引擎 · 补丁1 前向审望资源耗尽惩罚（ISSUE-5）

锁定补丁1 的纯统计判据（守「本句抢占后句唯一/濒危主粮 ⇒ 加软阻尼」的落码口径）：

  1. `_read_forward_lookout` 开关语义：缺省 0（关闭）/ 显式正权重 / 非法值错就错落 0 / 负值夹回 0
  2. `_forward_lookout_pools` 前瞻窗口：句窗边界正确、空池剔除（不产生假命中）、窗口 ≤0 等价关闭
  3. `_forward_lookout_remaining` 不可造假门：切片 id 不在全局索引时**不计入可用**（保守判更易耗尽）
  4. `_forward_lookout` 三态：rem==1 唯一主粮罚 SOLE_MAX / rem==2 濒危罚 SCARCE_MAX / rem≥3 不罚
  5. `_forward_lookout` 边界：候选不在未来句池中不罚、整趟按 TOTAL_MAX 封顶、weight=0 恒 0（零行为变化）

运行方式：cd resources/scripts ; ..\\ai-env\\python.exe __tests__\\test_forward_lookout.py
（或 ..\\ai-env\\python.exe __tests__\\run_all.py 全量跑）
"""
import os
import sys

# 将 scripts 目录加入 path，以便 import beam_search
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from beam_search import (
    _read_forward_lookout,
    _forward_lookout_pools,
    _forward_lookout_remaining,
    _forward_lookout,
    _fl_diag,
    _mark_used,
    _is_used,
    FORWARD_LOOKOUT_SENTENCES,
    FORWARD_LOOKOUT_SOLE_MAX,
    FORWARD_LOOKOUT_SCARCE_MAX,
    FORWARD_LOOKOUT_TOTAL_MAX,
)

ENV_KEY = 'ZENTECT_KM_FORWARD_LOOKOUT'


def _with_env(raw, fn):
    """在 env 临时置为 raw 的前提下执行 fn（跑完原样还原，绝不污染后续用例）。"""
    old = os.environ.get(ENV_KEY)
    if raw is None:
        os.environ.pop(ENV_KEY, None)
    else:
        os.environ[ENV_KEY] = raw
    try:
        return fn()
    finally:
        if old is None:
            os.environ.pop(ENV_KEY, None)
        else:
            os.environ[ENV_KEY] = old


def test_read_forward_lookout_switch_semantics():
    """开关语义：缺省关闭、正数生效、非法值错就错落 0、负值夹回 0（不豁免也不造假）。"""
    assert _with_env(None, _read_forward_lookout) == 0.0, "缺省必须为 0（关闭 = 零行为变化档）"
    assert _with_env('2.5', _read_forward_lookout) == 2.5
    assert _with_env('1', _read_forward_lookout) == 1.0
    assert _with_env('abc', _read_forward_lookout) == 0.0, "非法值按关闭处理"
    assert _with_env('', _read_forward_lookout) == 0.0, "空串按关闭处理"
    assert _with_env('-1', _read_forward_lookout) == 0.0, "负值夹回 0（不得反向放大）"
    print("✓ test_read_forward_lookout_switch_semantics: 开关语义正确")


def test_forward_lookout_pools_window_and_empty():
    """前瞻池：本句不入池、空池剔除、句窗边界正确、窗口 ≤0 等价关闭。"""
    queries = [{'shotId': f's{i}'} for i in range(6)]
    cands = {
        's0': ['z'],          # 本句：不得入池
        's1': ['a'],
        's2': [],             # 空池：须剔除（不产生假命中）
        's3': ['b', 'c'],
        's4': ['d'],
        's5': ['e'],
    }
    pools = _forward_lookout_pools(queries, cands, 0)  # 缺省窗口 5 句 → s1..s5
    assert pools == [['a'], ['b', 'c'], ['d'], ['e']], f"窗口/空池剔除有误：{pools}"

    # 句窗边界：qi=1、窗口 2 → 只看 s2..s3，s2 空池剔除后剩 s3。
    assert _forward_lookout_pools(queries, cands, 1, window=2) == [['b', 'c']]

    # 窗口 ≤0 ⇒ 等价关闭（返回空表，不构造前瞻）。
    assert _forward_lookout_pools(queries, cands, 0, window=0) == []
    assert _forward_lookout_pools(queries, cands, 0, window=-3) == []

    # 末句：身后无未来句 ⇒ 空表。
    assert _forward_lookout_pools(queries, cands, len(queries) - 1) == []
    assert FORWARD_LOOKOUT_SENTENCES == 5, "缺省前瞻窗口常量须与文档一致"
    print("✓ test_forward_lookout_pools_window_and_empty: 句窗与空池剔除正确")


def test_forward_lookout_remaining_no_fake_availability():
    """不可造假门：切片 id 不在全局索引 ⇒ 不计入可用（保守判更易耗尽，禁虚增放行抢占）。"""
    chunk_index = {'a': 0, 'b': 1, 'c': 2}

    # 全未用 → 3 个可用。
    assert _forward_lookout_remaining(['a', 'b', 'c'], 0, chunk_index) == 3

    # 位掩码置 0、1 号 → 仅剩 c。
    used = _mark_used(_mark_used(0, 0), 1)
    assert _is_used(used, 0) and _is_used(used, 1)
    assert not _is_used(used, 2)
    assert _forward_lookout_remaining(['a', 'b', 'c'], used, chunk_index) == 1

    # 数据缺陷：id 不在索引 → 不计入（宁可判「更易耗尽」，也不虚增可用数）。
    assert _forward_lookout_remaining(['ghost', 'a'], 0, chunk_index) == 1
    assert _forward_lookout_remaining(['ghost'], 0, chunk_index) == 0
    print("✓ test_forward_lookout_remaining_no_fake_availability: 索引缺失不计入可用")


def test_forward_lookout_three_states():
    """三态判罚：rem==1 → SOLE_MAX；rem==2 → SCARCE_MAX；rem≥3 → 不罚。"""
    chunk_index = {'a': 0, 'b': 1, 'c': 2, 'd': 3}

    # rem==3（全未用）：抢占不造成断供 ⇒ 不罚。
    assert _forward_lookout('c', [['a', 'b', 'c']], 0, chunk_index, 1.0) == 0.0

    # rem==2：濒危 → SCARCE_MAX。
    used2 = _mark_used(0, 0)  # a 已用 → b,c 可用 = 2
    got = _forward_lookout('b', [['a', 'b', 'c']], used2, chunk_index, 1.0)
    assert abs(got - FORWARD_LOOKOUT_SCARCE_MAX) < 1e-9, f"rem==2 应为 {FORWARD_LOOKOUT_SCARCE_MAX}，实际 {got}"

    # rem==1：唯一主粮 → SOLE_MAX。
    used1 = _mark_used(_mark_used(0, 0), 1)  # a,b 已用 → 仅 c 可用
    got = _forward_lookout('c', [['a', 'b', 'c']], used1, chunk_index, 1.0)
    assert abs(got - FORWARD_LOOKOUT_SOLE_MAX) < 1e-9, f"rem==1 应为 {FORWARD_LOOKOUT_SOLE_MAX}，实际 {got}"
    print("✓ test_forward_lookout_three_states: rem==1/2/≥3 三态判罚正确")


def test_forward_lookout_boundaries():
    """边界：候选不在未来句池不罚 / 整趟封顶 TOTAL_MAX / weight=0 与空池恒 0（零行为变化）。"""
    chunk_index = {'c': 0}

    # 候选不在池中：后句用不上它，本句抢占不造成断供 ⇒ 不罚。
    assert _forward_lookout('y', [['x']], 0, chunk_index, 1.0) == 0.0

    # 两段未来句均把 c 视为唯一可用 ⇒ 1.2+1.2=2.4，须封顶到 TOTAL_MAX。
    got = _forward_lookout('c', [['c'], ['c']], 0, chunk_index, 1.0)
    assert abs(got - FORWARD_LOOKOUT_TOTAL_MAX) < 1e-9, f"须封顶 {FORWARD_LOOKOUT_TOTAL_MAX}，实际 {got}"

    # 关闭档（weight=0）/ 空池 / 无索引 ⇒ 恒 0（缺省零行为变化、一键回退）。
    assert _forward_lookout('c', [['c']], 0, chunk_index, 0.0) == 0.0
    assert _forward_lookout('c', [], 0, chunk_index, 1.0) == 0.0
    assert _forward_lookout('c', [['c']], 0, {}, 1.0) == 0.0
    assert _forward_lookout('c', [['c']], 0, None, 1.0) == 0.0

    # 权重线性缩放：SOLE_MAX × 2 = 2.4，仍未越 TOTAL_MAX 封顶前的单句原始值语义。
    got = _forward_lookout('c', [['c']], 0, chunk_index, 2.0)
    assert abs(got - FORWARD_LOOKOUT_SOLE_MAX * 2.0) < 1e-9, f"权重缩放有误：{got}"
    print("✓ test_forward_lookout_boundaries: 池外/封顶/关闭档边界正确")


def test_forward_lookout_stats_attribution():
    """诊断计数桶：零命中须能归因为「未相交 / 池宽裕 / 守卫短路」，而非只报 0 无法定位。"""
    chunk_index = {'a': 0, 'b': 1, 'c': 2}

    # 未相交：候选根本不在未来池中 ⇒ miss_pool。
    st = {}
    assert _forward_lookout('ghost', [['a', 'b', 'c']], 0, chunk_index, 1.0, stats=st) == 0.0
    assert st['probe'] == 1 and st['miss_pool'] == 1, f"应归因未相交：{st}"

    # 池宽裕：相交但 rem≥3 ⇒ wide（设计上不罚，须与「未相交」分开计数）。
    st = {}
    assert _forward_lookout('c', [['a', 'b', 'c']], 0, chunk_index, 1.0, stats=st) == 0.0
    assert st['wide'] == 1 and st.get('miss_pool', 0) == 0, f"应归因宽裕：{st}"

    # 濒危（rem==2）与唯一（rem==1）：须计入命中侧归因桶。
    st = {}
    _forward_lookout('b', [['a', 'b', 'c']], _mark_used(0, 0), chunk_index, 1.0, stats=st)
    assert st['scarce'] == 1, f"应归因濒危：{st}"
    st = {}
    _forward_lookout('c', [['a', 'b', 'c']], _mark_used(_mark_used(0, 0), 1),
                     chunk_index, 1.0, stats=st)
    assert st['sole'] == 1, f"应归因唯一：{st}"

    # 守卫短路：空池 ⇒ guard，不得混进「未相交」。
    st = {}
    assert _forward_lookout('c', [], 0, chunk_index, 1.0, stats=st) == 0.0
    assert st['guard'] == 1 and st['probe'] == 1, f"应归因守卫：{st}"

    # 不传 stats ⇒ 零开销且行为不变（缺省档无计数副作用）。
    assert _forward_lookout('c', [['c']], 0, {'c': 0}, 1.0) == FORWARD_LOOKOUT_SOLE_MAX
    print("✓ test_forward_lookout_stats_attribution: 零命中归因计数正确")


def test_fl_diag_lands_on_disk():
    """诊断行须真实落盘（print 走 stdout 被 AppLogger 丢弃 ⇒ 必须镜像写临时文件）。"""
    import tempfile
    marker = '[forward-lookout] 单测标记 0xC0FFEE'
    _fl_diag(marker)
    path = os.path.join(tempfile.gettempdir(), 'zentect-km-diag.log')
    assert os.path.exists(path), "诊断文件应已创建"
    with open(path, 'r', encoding='utf-8') as f:
        assert marker in f.read(), "诊断行须真实写入 zentect-km-diag.log"
    print("✓ test_fl_diag_lands_on_disk: 诊断行落盘正确")


if __name__ == "__main__":
    print("=" * 60)
    print("🧊 步骤5 新引擎 · 补丁1 前向审望资源耗尽惩罚（ISSUE-5）")
    print("=" * 60)
    test_read_forward_lookout_switch_semantics()
    test_forward_lookout_pools_window_and_empty()
    test_forward_lookout_remaining_no_fake_availability()
    test_forward_lookout_three_states()
    test_forward_lookout_boundaries()
    test_forward_lookout_stats_attribution()
    test_fl_diag_lands_on_disk()
    print("=" * 60)
    print("全部通过 ✅")