"""
test_motion_cut.py — 🎬 步骤5 裁剪定窗 · 补丁15 动量高光安全裁剪律（ISSUE-6）

锁定补丁15 的确定性判据（守「出点禁落 motionScore>0.7 高动态区间中段；优先丢弃起手平淡准备段；
动作未落点允许出点右移 ≤300ms 并入句尾气口；缺料不猜」的落码口径）：

  1. `_read_motion_cut` 开关语义：缺省 0（关闭 = 零行为变化）/ 正数生效 / 非法值错就错落 0 / 负值夹回 0
  2. `_build_motion_cells`：按 parentChunkId 归并兄弟段并升序；缺 pid / 窗无效的切片跳过；
     motionScore 缺失或非数值 ⇒ motion=None（缺料不进序列，也不补 0）
  3. `_motion_contig_span`：跨格本段求并集跨度；物理连续（≤100ms）逐格外扩；有缝即止（禁跳段瞬移）
  4. `_motion_cut_window` 退化输入：target≤0 / 素材短于目标 / 无兄弟格 ⇒ no-op（默认右对齐窗）
  5. `_motion_cut_window` 规则1（出点避让热段中段）：A 右移 ≤300ms 保动作 > B 前移弃未完结动作；
     两者皆不可行 ⇒ no-op（绝不腰斩也不越界）
  6. `_motion_cut_window` 规则2（Drop Lead-in）：入点落冷段且紧邻热段仅需前移 ≤300ms ⇒ 前移入点；
     位移后出点落入热段内部 ⇒ 回退 no-op
  7. 不可造假门：相关格 motion 缺失 ⇒ 一律 no-op
  8. `_apply_motion_cut` 接线层：off 档**原对象直通**（零拷贝/零诊断/零计数）；on 档位移正确
     （时长恒=target）+ stats/诊断累加；无兄弟 profile / 未位移 ⇒ 保持原对象（不留假诊断）

运行方式：cd resources/scripts ; ..\\ai-env\\python.exe __tests__\\test_motion_cut.py
（或 ..\\ai-env\\python.exe __tests__\\run_all.py 全量跑）
"""
import os
import sys

# 将 scripts 目录加入 path，以便 import timeline_solver
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from timeline_solver import (
    _read_motion_cut,
    _build_motion_cells,
    _motion_contig_span,
    _motion_cut_window,
    _apply_motion_cut,
    MOTION_HOT,
    MOTION_OUT_SHIFT_MAX_MS,
    MOTION_CELL_CONTINUITY_MS,
)

ENV_KEY = 'ZENTECT_KM_MOTION_CUT'


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


class _Q:
    """模拟 legacy 侧 pydantic query 对象（属性取值路径）。"""

    def __init__(self, **kw):
        for k, v in kw.items():
            setattr(self, k, v)


def _cells(*specs):
    """构造段级 motion 序列（tests 专用）：`_cells((0,3000,0.2), (3000,6000,0.9))`。"""
    return [{'start': float(s), 'end': float(e), 'motion': m} for s, e, m in specs]


def test_read_motion_cut_switch_semantics():
    """开关语义：缺省关闭、正数生效、非法值错就错落 0、负值夹回 0；常量与评审稿口径一致。"""
    assert _with_env(None, _read_motion_cut) == 0.0, "缺省必须为 0（关闭 = 零行为变化档）"
    assert _with_env('1', _read_motion_cut) == 1.0
    assert _with_env('0.5', _read_motion_cut) == 0.5
    assert _with_env('abc', _read_motion_cut) == 0.0, "非法值按关闭处理"
    assert _with_env('', _read_motion_cut) == 0.0, "空串按关闭处理"
    assert _with_env('-5', _read_motion_cut) == 0.0, "负值夹回 0（不得反向放大）"
    assert MOTION_HOT == 0.7, "热段阈值须与评审稿 §9.4（motionScore > 0.7）一致"
    assert MOTION_OUT_SHIFT_MAX_MS == 300.0, "出点右移上限须与评审稿 §9.4（≤300ms）一致"
    assert MOTION_CELL_CONTINUITY_MS == 100.0, "物理连续性口径须与导出层 TIME_CONTINUITY_MS 一致"
    print("✓ test_read_motion_cut_switch_semantics: 开关语义正确")


def test_build_motion_cells_grouping():
    """归并：按 parentChunkId 分组升序；缺 pid / 窗无效跳过；motionScore 缺失或非数值 ⇒ None。"""
    pool = [
        {'id': 'b', 'parentChunkId': 'p1', 'startMs': 3000.0, 'endMs': 6000.0, 'motionScore': 0.9},
        {'id': 'a', 'parentChunkId': 'p1', 'startMs': 0.0, 'endMs': 3000.0, 'motionScore': 0.2},
        {'id': 'c', 'parentChunkId': 'p2', 'startMs': 0.0, 'endMs': 2000.0},           # 缺 motionScore
        {'id': 'd', 'parentChunkId': 'p1', 'startMs': 6000.0, 'endMs': 6000.0},       # 窗无效
        {'id': 'e', 'startMs': 0.0, 'endMs': 1000.0},                                 # 缺 parentChunkId
        {'id': 'f', 'parentChunkId': 'p3', 'startMs': 0.0, 'endMs': 1000.0, 'motionScore': 'x'},
    ]
    m = _build_motion_cells(pool)
    assert set(m.keys()) == {'p1', 'p2', 'p3'}, f"分组有误：{sorted(m.keys())}"
    assert [(c['start'], c['motion']) for c in m['p1']] == [(0.0, 0.2), (3000.0, 0.9)], "组内须按 start 升序"
    assert m['p2'][0]['motion'] is None, "缺 motionScore ⇒ None（缺料不补 0）"
    assert m['p3'][0]['motion'] is None, "非数值 motionScore ⇒ None（不猜）"
    assert _build_motion_cells(None) == {} and _build_motion_cells([]) == {}
    print("✓ test_build_motion_cells_grouping: 段级 motion 序列归并正确")


def test_motion_contig_span():
    """物理连续跨度：连续兄弟段逐格外扩；有缝（>100ms）即止（禁跨镜头瞬移）。"""
    c = _cells((0, 3000, 0.2), (3000, 6000, 0.9), (6000, 9000, 0.1))
    assert _motion_contig_span(c, 3000.0, 6000.0) == (0.0, 9000.0), "连续链应左右扩满"
    # 跨格本段（0~5800 同时压住 c0 与 c1）⇒ 并集跨度含 c1 末，再向右扩 c2。
    assert _motion_contig_span(c, 0.0, 5800.0) == (0.0, 9000.0)

    gapped = _cells((0, 2000, 0.2), (2500, 5000, 0.9))     # 缝 500ms
    assert _motion_contig_span(gapped, 2500.0, 5000.0) == (2500.0, 5000.0), "有缝不得外扩（禁跳段）"
    assert _motion_contig_span([], 100.0, 200.0) == (100.0, 200.0), "无格 ⇒ 原样返回本段"
    print("✓ test_motion_contig_span: 物理连续跨度正确")


def test_motion_cut_window_degenerate():
    """退化输入：target≤0 / 素材短于目标 / 无兄弟格 ⇒ no-op（默认右对齐窗，绝不越界）。"""
    c = _cells((0, 6000, 0.9))
    assert _motion_cut_window(0.0, 6000.0, 0.0, c) == (0.0, 6000.0, 'noop')
    assert _motion_cut_window(0.0, 6000.0, -5.0, c) == (0.0, 6000.0, 'noop')
    assert _motion_cut_window(0.0, 2000.0, 3000.0, c) == (0.0, 2000.0, 'noop'), "素材短于目标 ⇒ 不动"
    assert _motion_cut_window(0.0, 6000.0, 3000.0, []) == (0.0, 6000.0, 'noop'), "无格 ⇒ 不动"
    assert _motion_cut_window(None, None, None, c) == (0.0, 0.0, 'noop'), "缺参不抛错"
    print("✓ test_motion_cut_window_degenerate: 退化输入 no-op")


def test_motion_cut_window_out_point_avoidance():
    """规则1：出点落热段中段 ⇒ A 右移 ≤300ms 保动作；A 不可行 ⇒ B 前移弃未完结动作。"""
    # c0 冷 / c1 热 / c2 冷；本段 0~5800（出点 5800 落在 c1 内部，剩 200ms ≤ 300）⇒ A：右移到 c1 末。
    c = _cells((0, 3000, 0.2), (3000, 6000, 0.9), (6000, 9000, 0.1))
    t_in, t_out, reason = _motion_cut_window(0.0, 5800.0, 2000.0, c)
    assert reason == 'out_shift_right', f"应先试右移保动作，实际 {reason}"
    assert (t_in, t_out) == (4000.0, 6000.0), f"右移后窗有误：{t_in}/{t_out}"
    assert abs((t_out - t_in) - 2000.0) < 1e-9, "窗长恒=target"

    # 出点落热段中段但剩余 1000ms > 300 ⇒ A 不可行 ⇒ B：出点前移到热段起点（弃未完结动作）。
    c2 = _cells((0, 3000, 0.1), (3000, 9000, 0.9))
    t_in, t_out, reason = _motion_cut_window(0.0, 8000.0, 2000.0, c2)
    assert reason == 'out_avoid' and (t_in, t_out) == (1000.0, 3000.0), f"应前移弃动作，实际 {reason}/{t_in}/{t_out}"

    # A/B 皆不可行（右移越出连续跨度、前移越左界）⇒ no-op（绝不腰斩、绝不越界）。
    t_in, t_out, reason = _motion_cut_window(3000.0, 8000.0, 5000.0, c2)
    assert reason == 'noop' and (t_in, t_out) == (3000.0, 8000.0), f"皆不可行须 no-op，实际 {reason}/{t_in}/{t_out}"

    # 出点恰落在段边界（非内部）⇒ 不算落入热段中段（不得误触发）。
    t_in, t_out, reason = _motion_cut_window(3000.0, 6000.0, 1000.0, c)
    assert reason == 'noop' and (t_in, t_out) == (5000.0, 6000.0), f"边界不得误判，实际 {reason}"
    print("✓ test_motion_cut_window_out_point_avoidance: 出点避让规则正确")


def test_motion_cut_window_drop_leadin():
    """规则2：入点落冷段、紧邻热段仅需前移 ≤300ms ⇒ 前移入点（弃起手平淡准备段）。"""
    # X 冷 0~2800 / H 热 2800~3000 / Y 冷 3000~6000；本段 0~3000、目标 300 ⇒ 入点 2700 落 X 尾。
    c = _cells((0, 2800, 0.2), (2800, 3000, 0.9), (3000, 6000, 0.1))
    t_in, t_out, reason = _motion_cut_window(0.0, 3000.0, 300.0, c)
    assert reason == 'drop_leadin', f"应弃起手准备段，实际 {reason}"
    assert (t_in, t_out) == (2800.0, 3100.0), f"前移有误：{t_in}/{t_out}"
    assert abs((t_out - t_in) - 300.0) < 1e-9, "窗长恒=target"

    # 前移量 >300ms（入点 2000，热段 2800 起）⇒ 越出右移上限 ⇒ no-op。
    t_in, t_out, reason = _motion_cut_window(0.0, 3000.0, 1000.0, c)
    assert reason == 'noop' and (t_in, t_out) == (2000.0, 3000.0), f"超上限须 no-op，实际 {reason}"

    # 位移后出点落入热段内部 ⇒ 回退 no-op（绝不把出点留在热段中段）。
    c2 = _cells((0, 2800, 0.2), (2800, 9000, 0.9))
    t_in, t_out, reason = _motion_cut_window(0.0, 2800.0, 300.0, c2)
    assert reason == 'noop' and (t_in, t_out) == (2500.0, 2800.0), f"位移后会落热段内须回退，实际 {reason}"

    # 入点落冷段但无紧邻热段（下一格亦冷）⇒ no-op。
    c3 = _cells((0, 3000, 0.2), (3000, 6000, 0.1))
    t_in, t_out, reason = _motion_cut_window(0.0, 3000.0, 300.0, c3)
    assert reason == 'noop', f"无紧邻热段不得位移，实际 {reason}"
    print("✓ test_motion_cut_window_drop_leadin: 弃起手准备段规则正确")


def test_motion_cut_missing_material_is_noop():
    """不可造假门：相关格 motion 缺失（None）⇒ 一律 no-op（不猜、不造热/冷判定）。"""
    c = _cells((0, 3000, None), (3000, 6000, 0.9))
    t_in, t_out, reason = _motion_cut_window(0.0, 3000.0, 300.0, c)
    assert reason == 'noop' and (t_in, t_out) == (2700.0, 3000.0), f"缺料须 no-op，实际 {reason}"

    c2 = _cells((0, 3000, 0.2), (3000, 6000, None))
    t_in, t_out, reason = _motion_cut_window(0.0, 3000.0, 300.0, c2)
    assert reason == 'noop', f"下一格缺 motion 不得判热，实际 {reason}"
    print("✓ test_motion_cut_missing_material_is_noop: 缺料不猜（不可造假门）")


def test_apply_motion_cut_off_is_noop():
    """off 档（缺省）：**原对象直通** —— 零拷贝、零位移、零诊断、零计数（一键回退）。"""
    def _run():
        chunk = {'id': 'c1', 'parentChunkId': 'p1', 'startMs': 0.0, 'endMs': 5800.0, 'durationMs': 5800.0}
        cells_map = {'p1': _cells((0, 3000, 0.2), (3000, 6000, 0.9), (6000, 9000, 0.1))}
        stats = {'hit': 0, 'out_shift_right': 0, 'out_avoid': 0, 'drop_leadin': 0}
        out = _apply_motion_cut(chunk, 2000.0, _Q(shotId='s1'), cells_map, 'legacy_main', stats)
        assert out is chunk, "off 档必须返回原对象（零拷贝）"
        assert out['endMs'] == 5800.0, "off 档不得位移"
        assert stats == {'hit': 0, 'out_shift_right': 0, 'out_avoid': 0, 'drop_leadin': 0}, "off 档不得计数"

    _with_env(None, _run)
    _with_env('0', _run)
    _with_env('abc', _run)
    print("✓ test_apply_motion_cut_off_is_noop: off 档原对象直通（零行为变化）")


def test_apply_motion_cut_on_shifts_and_counts():
    """on 档：位移正确（时长恒=target）、stats 按因分类累加；无兄弟 profile / 未位移 ⇒ 原对象。"""
    def _run():
        cells_map = {'p1': _cells((0, 3000, 0.2), (3000, 6000, 0.9), (6000, 9000, 0.1))}
        chunk = {'id': 'c1', 'parentChunkId': 'p1', 'startMs': 0.0, 'endMs': 5800.0, 'durationMs': 5800.0}
        stats = {'hit': 0, 'out_shift_right': 0, 'out_avoid': 0, 'drop_leadin': 0}
        out = _apply_motion_cut(chunk, 2000.0, _Q(shotId='s1'), cells_map, 'legacy_main', stats)
        assert out is not chunk, "on 档应返回新对象（不改入参）"
        assert (out['startMs'], out['endMs'], out['durationMs']) == (4000.0, 6000.0, 2000.0), f"窗有误：{out}"
        assert (chunk['startMs'], chunk['endMs']) == (0.0, 5800.0), "入参对象不得被改写"
        assert stats['hit'] == 1 and stats['out_shift_right'] == 1, f"计数有误：{stats}"

        # 无 parentChunkId / 无兄弟 profile（缺料）⇒ 原对象直通、不计数、不留假诊断。
        chunk2 = {'id': 'c2', 'startMs': 0.0, 'endMs': 5800.0, 'durationMs': 5800.0}
        stats2 = {'hit': 0, 'out_shift_right': 0, 'out_avoid': 0, 'drop_leadin': 0}
        assert _apply_motion_cut(chunk2, 2000.0, {'shotId': 's2'}, cells_map, 'new_engine', stats2) is chunk2
        assert stats2['hit'] == 0

        chunk3 = {'id': 'c3', 'parentChunkId': 'pX', 'startMs': 0.0, 'endMs': 5800.0}
        assert _apply_motion_cut(chunk3, 2000.0, {'shotId': 's3'}, cells_map, 'continuation') is chunk3, \
            "父镜头无 profile ⇒ 不猜（原对象直通）"

        # 未发生位移（no-op）⇒ 原对象直通。
        chunk4 = {'id': 'c4', 'parentChunkId': 'p1', 'startMs': 3000.0, 'endMs': 6000.0, 'durationMs': 3000.0}
        stats4 = {'hit': 0, 'out_shift_right': 0, 'out_avoid': 0, 'drop_leadin': 0}
        assert _apply_motion_cut(chunk4, 1000.0, _Q(shotId='s4'), cells_map, 'legacy_merge', stats4) is chunk4
        assert stats4['hit'] == 0, "no-op 不得计数"

        # stats 缺省（None）：不得抛错。
        chunk5 = {'id': 'c5', 'parentChunkId': 'p1', 'startMs': 0.0, 'endMs': 5800.0}
        assert _apply_motion_cut(chunk5, 2000.0, _Q(shotId='s5'), cells_map)['startMs'] == 4000.0

    _with_env('1', _run)
    print("✓ test_apply_motion_cut_on_shifts_and_counts: on 档位移/计数正确")


def test_apply_motion_cut_diag_lands_on_disk():
    """诊断行须真实落盘（`_km_diag` 走 stderr + 临时文件，仅 on 档且发生位移时打印）。"""
    import tempfile
    marker = '0xBEEF15'
    cells_map = {'p1': _cells((0, 3000, 0.2), (3000, 6000, 0.9), (6000, 9000, 0.1))}
    _with_env('1', lambda: _apply_motion_cut(
        {'id': f'c_{marker}', 'parentChunkId': 'p1', 'startMs': 0.0, 'endMs': 5800.0, 'durationMs': 5800.0},
        2000.0, _Q(shotId=f's_{marker}'), cells_map, 'legacy_main'))
    path = os.path.join(tempfile.gettempdir(), 'zentect-km-diag.log')
    assert os.path.exists(path), "诊断文件应已创建"
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()
    assert f'c_{marker}' in content and '[motion-cut]' in content, "诊断行须真实写入 zentect-km-diag.log"
    print("✓ test_apply_motion_cut_diag_lands_on_disk: 诊断行落盘正确")


if __name__ == "__main__":
    print("=" * 60)
    print("🎬 步骤5 裁剪定窗 · 补丁15 动量高光安全裁剪律（ISSUE-6）")
    print("=" * 60)
    test_read_motion_cut_switch_semantics()
    test_build_motion_cells_grouping()
    test_motion_contig_span()
    test_motion_cut_window_degenerate()
    test_motion_cut_window_out_point_avoidance()
    test_motion_cut_window_drop_leadin()
    test_motion_cut_missing_material_is_noop()
    test_apply_motion_cut_off_is_noop()
    test_apply_motion_cut_on_shifts_and_counts()
    test_apply_motion_cut_diag_lands_on_disk()
    print("=" * 60)
    print("全部通过 ✅")