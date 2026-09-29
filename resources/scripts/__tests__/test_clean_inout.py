"""
test_clean_inout.py — 🎬 步骤5 裁剪定窗 · 补丁20 光学净画出入点（ISSUE-7）

锁定补丁20 的确定性判据（守「掐头去尾光学转场残影；原声段命中 ASR 台词边界时优先对齐，
绝不在台词中途腰斩」的落码口径）：

  1. `_read_clean_inout` 开关语义：缺省 0（关闭 = 零行为变化）/ 显式正权重 / 非法值错就错落 0 / 负值夹回 0
  2. `_clean_inout_window` 边界策略：target≤0 或窗无效不动 / slack≤0 不动（交变速链）/
     slack≥2×EDGE 两端各内缩 EDGE / 0<slack<2×EDGE 两端均分 slack/2（仍放得下 target、绝不越界）
  3. `_clean_inout_window` ASR 对齐：出点=台词结尾优先（双端对齐）/ 入点=台词开头次选 /
     越界退化纯内缩 / 未命中（has_hard_sub=False）即便有 anchor 也不对齐
  4. `_apply_clean_inout` 接线层：off 档**原对象直通**（零拷贝/零诊断/零计数）；
     on 档位移正确（时长恒=target）+ stats/诊断累加；无 slack 时保持原对象（不留假诊断）
  5. `_q_field` 容错取值：dict / 对象 / None 三态

运行方式：cd resources/scripts ; ..\\ai-env\\python.exe __tests__\\test_clean_inout.py
（或 ..\\ai-env\\python.exe __tests__\\run_all.py 全量跑）
"""
import os
import sys

# 将 scripts 目录加入 path，以便 import timeline_solver
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from timeline_solver import (
    _read_clean_inout,
    _clean_inout_window,
    _apply_clean_inout,
    _q_field,
    CLEAN_INOUT_EDGE_MS,
)

ENV_KEY = 'ZENTECT_KM_CLEAN_INOUT'


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


def test_read_clean_inout_switch_semantics():
    """开关语义：缺省关闭、正数生效、非法值错就错落 0、负值夹回 0（不启用也不造假）。"""
    assert _with_env(None, _read_clean_inout) == 0.0, "缺省必须为 0（关闭 = 零行为变化档）"
    assert _with_env('1', _read_clean_inout) == 1.0
    assert _with_env('200', _read_clean_inout) == 200.0
    assert _with_env('abc', _read_clean_inout) == 0.0, "非法值按关闭处理"
    assert _with_env('', _read_clean_inout) == 0.0, "空串按关闭处理"
    assert _with_env('-5', _read_clean_inout) == 0.0, "负值夹回 0（不得反向放大）"
    assert CLEAN_INOUT_EDGE_MS == 200.0, "光学边距常量须与评审稿 §13.3 一致"
    print("✓ test_read_clean_inout_switch_semantics: 开关语义正确")


def test_clean_inout_window_degenerate_inputs():
    """退化输入：target≤0 或窗无效 ⇒ 原样返回入点（绝不越界、绝不造假收窄）。"""
    # target ≤ 0：不动。
    assert _clean_inout_window(1000.0, 9000.0, 0.0) == (1000.0, 0.0)
    assert _clean_inout_window(1000.0, 9000.0, -5.0) == (1000.0, -5.0)
    # 窗无效（end ≤ start）：不动。
    assert _clean_inout_window(5000.0, 5000.0, 2000.0) == (5000.0, 2000.0)
    assert _clean_inout_window(6000.0, 5000.0, 2000.0) == (6000.0, 2000.0)
    # 缺参（None）：按 0 处理，不抛错。
    assert _clean_inout_window(None, None, None) == (0.0, 0.0)
    print("✓ test_clean_inout_window_degenerate_inputs: 退化输入原样返回")


def test_clean_inout_window_slack_policy():
    """边界策略三档：slack≤0 不动 / slack≥2×EDGE 两端各内缩 EDGE / 0<slack<2×EDGE 两端均分。"""
    # slack == 0（素材正好等于目标）⇒ 不动（交现存变速链）。
    assert _clean_inout_window(0.0, 3000.0, 3000.0) == (0.0, 3000.0)
    # slack < 0（素材比目标短）⇒ 不动。
    assert _clean_inout_window(0.0, 2500.0, 3000.0) == (0.0, 3000.0)

    # slack ≥ 2×EDGE（400ms）：两端各内缩 200ms。
    t_in, dur = _clean_inout_window(0.0, 6000.0, 3000.0)   # slack=3000
    assert t_in == 200.0 and dur == 3000.0, f"标准档内缩 200ms，实际 {t_in}/{dur}"
    # 出点不得侵入源窗尾部 200ms。
    assert t_in + dur == 3200.0 <= 6000.0 - 200.0

    # 0 < slack < 2×EDGE：两端均分 slack/2（仍放得下 target）。
    t_in, dur = _clean_inout_window(1000.0, 4100.0, 3000.0)  # slack=100
    assert abs(t_in - 1050.0) < 1e-9 and dur == 3000.0, f"均分档应为 1050，实际 {t_in}"
    assert t_in + dur == 4050.0 <= 4100.0, "出点不得越界"

    # 临界：slack 恰为 2×EDGE ⇒ 走标准档（各 200ms）。
    t_in, _ = _clean_inout_window(0.0, 3400.0, 3000.0)      # slack=400
    assert t_in == 200.0, f"slack==2×EDGE 应走标准档，实际 {t_in}"
    # 临界：slack 恰为 1ms ⇒ 均分 0.5ms（可行域非空）。
    t_in, dur = _clean_inout_window(0.0, 3001.0, 3000.0)
    assert abs(t_in - 0.5) < 1e-9 and t_in + dur <= 3001.0
    print("✓ test_clean_inout_window_slack_policy: slack 三档边界策略正确")


def test_clean_inout_window_asr_alignment():
    """ASR 对齐：出点=台词结尾优先（双端对齐）→ 入点=台词开头次选 → 越界退化纯内缩。"""
    # 源窗 0~6000、目标 3000、台词 3500~5000。
    # 出点=台词结尾：t_in = 5000 − 3000 = 2000，可行域 [200, 2800] ⇒ 命中（双端对齐）。
    t_in, dur = _clean_inout_window(0.0, 6000.0, 3000.0, True, 3500.0, 5000.0)
    assert t_in == 2000.0 and t_in + dur == 5000.0, f"应双端对齐台词结尾，实际 {t_in}"

    # 台词 1000~2000：出点对齐 t_in = 2000−3000 = −1000 越界 ⇒ 次选入点=台词开头 1000（在 [200,2800] 内）。
    t_in, dur = _clean_inout_window(0.0, 6000.0, 3000.0, True, 1000.0, 2000.0)
    assert t_in == 1000.0, f"应次选对齐台词开头，实际 {t_in}"

    # 台词 100~500：两候选皆越界（−2900 与 100 均 < 200）⇒ 退化纯内缩 200ms。
    t_in, dur = _clean_inout_window(0.0, 6000.0, 3000.0, True, 100.0, 500.0)
    assert t_in == 200.0, f"两候选越界应退化纯内缩，实际 {t_in}"

    # 未命中（has_hard_sub=False）：即便带 anchor 也不对齐（守「不可造假门」）。
    t_in, _ = _clean_inout_window(0.0, 6000.0, 3000.0, False, 3500.0, 5000.0)
    assert t_in == 200.0, f"未命中不得对齐，实际 {t_in}"

    # anchor 为 None：不入对齐分支。
    t_in, _ = _clean_inout_window(0.0, 6000.0, 3000.0, True, None, None)
    assert t_in == 200.0
    print("✓ test_clean_inout_window_asr_alignment: ASR 台词边界对齐正确")


def test_q_field_tolerant_read():
    """`_q_field` 容错：dict / 对象 / None 三态（legacy 对象与新引擎 dict 共用一套读取）。"""
    assert _q_field({'a': 1}, 'a') == 1
    assert _q_field({'a': None}, 'a', 9) == 9, "None 应回落 default"
    assert _q_field({'a': 1}, 'b', 7) == 7, "缺键应回落 default"
    assert _q_field(_Q(a=2), 'a') == 2
    assert _q_field(_Q(a=None), 'a', 3) == 3
    assert _q_field(None, 'a', 5) == 5
    print("✓ test_q_field_tolerant_read: 容错取值正确")


def test_apply_clean_inout_off_is_noop():
    """off 档（缺省）：**原对象直通** —— 零拷贝、零位移、零诊断、零计数（一键回退）。"""
    def _run():
        chunk = {'id': 'c1', 'startMs': 0.0, 'endMs': 6000.0, 'durationMs': 6000.0}
        stats = {'hit': 0, 'asr': 0}
        out = _apply_clean_inout(chunk, 3000.0, _Q(shotId='s1'), 'legacy_main', stats)
        assert out is chunk, "off 档必须返回原对象（零拷贝）"
        assert out['endMs'] == 6000.0 and out['durationMs'] == 6000.0, "off 档不得位移"
        assert stats == {'hit': 0, 'asr': 0}, "off 档不得计数"

    _with_env(None, _run)
    _with_env('0', _run)
    _with_env('abc', _run)
    print("✓ test_apply_clean_inout_off_is_noop: off 档原对象直通（零行为变化）")


def test_apply_clean_inout_on_shifts_and_counts():
    """on 档：位移正确（时长恒=target）、stats 累加、ASR 命中单独计数；无 slack 保持原对象。"""
    def _run():
        # 标准档：源窗 0~6000、目标 3000 ⇒ 净画 200~3200。
        chunk = {'id': 'c1', 'startMs': 0.0, 'endMs': 6000.0, 'durationMs': 6000.0}
        stats = {'hit': 0, 'asr': 0}
        out = _apply_clean_inout(chunk, 3000.0, _Q(shotId='s1'), 'legacy_main', stats)
        assert out is not chunk, "on 档应返回新对象（不改入参）"
        assert out['startMs'] == 200.0 and out['endMs'] == 3200.0, f"净画窗有误：{out}"
        assert out['durationMs'] == 3000.0, "子窗时长恒=目标（仅平移入点）"
        assert chunk['startMs'] == 0.0 and chunk['endMs'] == 6000.0, "入参对象不得被改写"
        assert stats == {'hit': 1, 'asr': 0}, f"计数有误：{stats}"

        # 原声段命中 ASR：hasHardSub 由 asrAnchor 非空驱动 ⇒ asr 计数 +1，出点对齐台词结尾。
        chunk2 = {'id': 'c2', 'startMs': 0.0, 'endMs': 6000.0, 'durationMs': 6000.0}
        stats2 = {'hit': 0, 'asr': 0}
        out2 = _apply_clean_inout(chunk2, 3000.0,
                                  _Q(shotId='s2', asrAnchorStartMs=3500.0, asrAnchorEndMs=5000.0),
                                  'new_engine', stats2)
        assert out2['startMs'] == 2000.0 and out2['endMs'] == 5000.0, f"ASR 对齐有误：{out2}"
        assert stats2 == {'hit': 1, 'asr': 1}, f"ASR 计数有误：{stats2}"

        # hasHardSub 由切片自身驱动（anchor 为空时也走对齐分支，但无候选 ⇒ 退化纯内缩）。
        chunk3 = {'id': 'c3', 'startMs': 0.0, 'endMs': 6000.0, 'durationMs': 6000.0, 'hasHardSub': True}
        stats3 = {'hit': 0, 'asr': 0}
        out3 = _apply_clean_inout(chunk3, 3000.0, {'shotId': 's3'}, 'continuation', stats3)
        assert out3['startMs'] == 200.0 and stats3 == {'hit': 1, 'asr': 1}, f"hasHardSub 驱动有误：{out3}/{stats3}"

        # 无 slack（素材不比目标长）⇒ 保持原对象、不留假诊断、不计数。
        chunk4 = {'id': 'c4', 'startMs': 0.0, 'endMs': 3000.0, 'durationMs': 3000.0}
        stats4 = {'hit': 0, 'asr': 0}
        out4 = _apply_clean_inout(chunk4, 3000.0, _Q(shotId='s4'), 'legacy_main', stats4)
        assert out4 is chunk4 and stats4 == {'hit': 0, 'asr': 0}, "无 slack 不得位移/计数"

        # stats 缺省（None）：不得抛错。
        out5 = _apply_clean_inout({'id': 'c5', 'startMs': 0.0, 'endMs': 6000.0}, 3000.0, _Q(shotId='s5'))
        assert out5['startMs'] == 200.0

    _with_env('1', _run)
    print("✓ test_apply_clean_inout_on_shifts_and_counts: on 档位移/计数正确")


def test_apply_clean_inout_diag_lands_on_disk():
    """诊断行须真实落盘（`_km_diag` 走 stderr + 临时文件，仅 on 档打印）。"""
    import tempfile
    marker = '0xC0FFEE'
    _with_env('1', lambda: _apply_clean_inout(
        {'id': f'c_{marker}', 'startMs': 0.0, 'endMs': 6000.0, 'durationMs': 6000.0},
        3000.0, _Q(shotId=f's_{marker}'), 'legacy_main'))
    path = os.path.join(tempfile.gettempdir(), 'zentect-km-diag.log')
    assert os.path.exists(path), "诊断文件应已创建"
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()
    assert f'c_{marker}' in content and '[clean-inout]' in content, "诊断行须真实写入 zentect-km-diag.log"
    print("✓ test_apply_clean_inout_diag_lands_on_disk: 诊断行落盘正确")


if __name__ == "__main__":
    print("=" * 60)
    print("🎬 步骤5 裁剪定窗 · 补丁20 光学净画出入点（ISSUE-7）")
    print("=" * 60)
    test_read_clean_inout_switch_semantics()
    test_clean_inout_window_degenerate_inputs()
    test_clean_inout_window_slack_policy()
    test_clean_inout_window_asr_alignment()
    test_q_field_tolerant_read()
    test_apply_clean_inout_off_is_noop()
    test_apply_clean_inout_on_shifts_and_counts()
    test_apply_clean_inout_diag_lands_on_disk()
    print("=" * 60)
    print("全部通过 ✅")
