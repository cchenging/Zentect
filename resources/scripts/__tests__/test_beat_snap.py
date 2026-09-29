"""
test_beat_snap.py — 🎵 步骤5 输出装配 · 补丁2 视听节拍器对齐（ISSUE-10 层位纠正）

为什么测在输出层（而不是规则卡）：BGM 强拍网格的 0 点 = 成片 BGM 起点（输出时间轴），
切片 startMs 是源视频 PTS，两者**不同轴**；且新引擎每段画面时长由刚性音频时长决定
（净画收窄后窗长恒 = audioDurationMs）⇒ 同一句所有候选的输出切点**恒同**，写进候选打分卡
对排序零影响（可证明 no-op）。故本律落 `timeline_solver._apply_beat_snap`（结果装配处）。

锁定判据：
  1. `_read_beat_snap` 开关语义：缺省 0（关闭 = 零行为变化）/ 正数生效 / 非法值错就错落 0 / 负值夹回 0
  2. `_beat_snap_plan` 退化输入：无强拍网格 / 音频时长 ≤ 0 / 原声段 ⇒ 不可磁吸（None）
  3. 容差：最近强拍距离 |δ| > 250ms ⇒ 不可磁吸
  4. 死区：|δ| ≤ 40ms ⇒ 视为已对齐，返回 (aud, 1.0) 不改变速（避免 0.1% 级无意义拉伸）
  5. 变速带：所需速率 σ=aud/(aud+δ) 越出 `[1/1.03, 1.03]`（±3%，2026-09-27 由 ±8% 收紧）
     ⇒ 宁可不吸附也不把整段拉出可感知快/慢放（None）
  6. `_apply_beat_snap` off 档：原对象直通、不改写、零计数（零行为变化）
  7. `_apply_beat_snap` on 档：可磁吸且需变速 ⇒ 写 appliedSpeedFactor + isExactSpeed=False +
     返回 D 推进游标 + 计数；死区 ⇒ 仅计数不改写；不可磁吸 ⇒ 返回刚性时长

运行方式：cd resources/scripts ; ..\\ai-env\\python.exe __tests__\\test_beat_snap.py
（或 ..\\ai-env\\python.exe __tests__\\run_all.py 全量跑）
"""
import os
import sys

# 将 scripts 目录加入 path，以便 import timeline_solver
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from timeline_solver import (
    _read_beat_snap,
    _beat_snap_plan,
    _apply_beat_snap,
    BEAT_SNAP_TOLERANCE_MS,
    BEAT_SNAP_DEAD_ZONE_MS,
    BEAT_SNAP_MAX_RATE,
    BEAT_SNAP_MIN_RATE,
)

ENV_KEY = 'ZENTECT_BEAT_SNAP'


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


def _item(aud=4000.0, **kw):
    """造一个最小结果项（default_result 关键字段）。"""
    it = {'shotId': 's1', 'audioDurationMs': aud, 'appliedSpeedFactor': 1.0,
          'isExactSpeed': True, 'keepOriginalAudio': False}
    it.update(kw)
    return it


def test_read_beat_snap_switch_semantics():
    """开关：缺省/非法/负值一律 0（零行为变化），正数原样返回。"""
    assert _with_env(None, _read_beat_snap) == 0.0, "缺省必须关闭"
    assert _with_env('1', _read_beat_snap) == 1.0
    assert _with_env('0', _read_beat_snap) == 0.0
    assert _with_env('abc', _read_beat_snap) == 0.0, "非法值错就错落 0（不磁吸也不造假）"
    assert _with_env('-2', _read_beat_snap) == 0.0, "负值夹回 0"
    print("✓ test_read_beat_snap_switch_semantics: 开关语义正确（缺省 off）")


def test_beat_snap_plan_degenerate_is_none():
    """退化输入：无网格 / 音频时长≤0 / 原声段 ⇒ 不可磁吸。"""
    assert _beat_snap_plan(0.0, 4000.0, []) is None, "无强拍网格不可磁吸"
    assert _beat_snap_plan(0.0, 4000.0, None) is None
    assert _beat_snap_plan(0.0, 0.0, [4000.0]) is None, "音频时长≤0 不可磁吸"
    assert _beat_snap_plan(0.0, 4000.0, [4000.0], keep_original=True) is None, \
        "原声段导出端强制 1.0x ⇒ 属死开关，必须中性放行"
    print("✓ test_beat_snap_plan_degenerate_is_none: 缺料/原声段一律 no-op（不造假）")


def test_beat_snap_plan_tolerance_and_dead_zone():
    """容差 250ms 之外不吸附；40ms 死区之内返回 (aud, 1.0)（已对齐免变速）。"""
    # 切点 = 0 + 4000；强拍 4600 ⇒ |δ|=600 > 250 ⇒ 不吸附
    assert _beat_snap_plan(0.0, 4000.0, [4600.0]) is None

    # 强拍 4050 ⇒ |δ|=50：在死区外、±3% 内（rate=4000/4050=0.988）⇒ 可磁吸
    d, rate = _beat_snap_plan(0.0, 4000.0, [4050.0])
    assert abs(d - 4050.0) < 1e-9 and abs(rate - 4000.0 / 4050.0) < 1e-9

    # 强拍 4020 ⇒ |δ|=20 ≤ 死区 ⇒ 视为已对齐，不改变速
    assert _beat_snap_plan(0.0, 4000.0, [4020.0]) == (4000.0, 1.0)
    assert BEAT_SNAP_DEAD_ZONE_MS < 50.0 < BEAT_SNAP_TOLERANCE_MS

    # 游标不为 0：切点 = cursor + aud（输出时间轴）
    assert _beat_snap_plan(1000.0, 4000.0, [5020.0]) == (4000.0, 1.0)
    print("✓ test_beat_snap_plan_tolerance_and_dead_zone: 容差/死区判据正确")


def test_beat_snap_plan_speed_law_clamp():
    """±3% 变速带（2026-09-27 由 ±8% 收紧）：越界 ⇒ 宁可不吸附，也不把整段拉出可感知快/慢放。"""
    # aud=4000, δ=-1000 ⇒ d=3000 ⇒ rate=1.333 超上限 ⇒ None
    assert _beat_snap_plan(0.0, 4000.0, [3000.0]) is None
    # aud=4000, δ=+1000 ⇒ d=5000 ⇒ rate=0.800 超下限 ⇒ None
    assert _beat_snap_plan(0.0, 4000.0, [5000.0]) is None
    # 本次收紧要拦的实测档：aud=2634、δ=-151（约 -5.7%）⇒ rate=1.061 > 1.03 ⇒ None
    assert _beat_snap_plan(0.0, 2634.0, [2634.0 - 151.0]) is None, \
        "1.061 级快放（>1.03）必须弃吸附（该档原先被 ±8% 放行）"
    #   对称档：δ=+151 ⇒ rate≈0.9458 < 1/1.03 ⇒ None
    assert _beat_snap_plan(0.0, 2634.0, [2634.0 + 151.0]) is None

    # 上沿闭区间：d=aud/1.03 ⇒ rate 恰 1.03，|δ|=aud*(1-1/1.03)≈58.25ms > 死区 ⇒ 可磁吸
    aud = 2000.0
    d, rate = _beat_snap_plan(0.0, aud, [aud / 1.03])
    assert abs(rate - 1.03) < 1e-9, f"上沿应恰为 1.03，实际 {rate}"
    #   再深 1ms ⇒ rate>1.03 ⇒ None
    assert _beat_snap_plan(0.0, aud, [aud / 1.03 - 1.0]) is None

    # 下沿闭区间：d=aud*1.03 ⇒ rate 恰 1/1.03，|δ|=0.03*aud=60ms > 死区 ⇒ 可磁吸
    d, rate = _beat_snap_plan(0.0, aud, [aud * 1.03])
    assert abs(rate - 1.0 / 1.03) < 1e-9, f"下沿应恰为 1/1.03，实际 {rate}"
    assert _beat_snap_plan(0.0, aud, [aud * 1.03 + 1.0]) is None

    # 常量自证：±3%；下沿仍远在导出端 SPEED_MIN（1/1.08≈0.9259）之内，不会与导出端实算打架
    assert BEAT_SNAP_MAX_RATE == 0.03
    assert abs(BEAT_SNAP_MIN_RATE - 1.0 / 1.03) < 1e-12
    assert BEAT_SNAP_MIN_RATE > 1.0 / 1.08
    print("✓ test_beat_snap_plan_speed_law_clamp: 变速带 [1/1.03, 1.03] 生效（超限不吸附）")


def test_apply_beat_snap_off_is_noop():
    """off 档：原对象直通、不改写、零计数（零行为变化）。"""
    def _run():
        it = _item()
        stats = {'hit': 0, 'speed': 0, 'max_delta_ms': 0.0}
        out = _apply_beat_snap(it, {'shotId': 's1'}, [4050.0], 0.0, stats)
        assert out == 4000.0, "off 档必须返回刚性时长（游标口径不变）"
        assert it['appliedSpeedFactor'] == 1.0 and it['isExactSpeed'] is True, "off 档不得改写结果项"
        assert stats == {'hit': 0, 'speed': 0, 'max_delta_ms': 0.0}, "off 档不得计数"

    _with_env(None, _run)
    _with_env('0', _run)
    _with_env('abc', _run)
    print("✓ test_apply_beat_snap_off_is_noop: off 档零行为变化")


def test_apply_beat_snap_on_writes_and_counts():
    """on 档：可磁吸 ⇒ 写变速 + isExactSpeed=False + 返回 D；死区/不可磁吸 ⇒ 仅计数或原值。"""
    def _run():
        # 需变速：aud=4000、强拍 4050（|δ|=50）⇒ σ=0.988、D=4050
        it = _item()
        stats = {'hit': 0, 'speed': 0, 'max_delta_ms': 0.0}
        d = _apply_beat_snap(it, {'shotId': 's1'}, [4050.0], 0.0, stats)
        assert abs(d - 4050.0) < 1e-9, f"应返回磁吸后时长，实际 {d}"
        assert it['appliedSpeedFactor'] == round(4000.0 / 4050.0, 3), f"变速系数有误：{it}"
        assert it['isExactSpeed'] is False, "变速段必须显式置 False（否则导出端强制 1.0x）"
        assert stats == {'hit': 1, 'speed': 1, 'max_delta_ms': 50.0}, f"计数有误：{stats}"

        # 死区（已对齐）：仅计 hit、不改写变速
        it2 = _item()
        stats2 = {'hit': 0, 'speed': 0, 'max_delta_ms': 0.0}
        d2 = _apply_beat_snap(it2, {'shotId': 's2'}, [4020.0], 0.0, stats2)
        assert d2 == 4000.0 and it2['appliedSpeedFactor'] == 1.0 and it2['isExactSpeed'] is True
        assert stats2 == {'hit': 1, 'speed': 0, 'max_delta_ms': 0.0}

        # 超容差：不可磁吸 ⇒ 刚性时长、零计数
        it3 = _item()
        stats3 = {'hit': 0, 'speed': 0, 'max_delta_ms': 0.0}
        assert _apply_beat_snap(it3, {'shotId': 's3'}, [5000.0], 0.0, stats3) == 4000.0
        assert stats3['hit'] == 0

        # 原声段：死开关，中性放行
        it4 = _item(keepOriginalAudio=True)
        stats4 = {'hit': 0, 'speed': 0, 'max_delta_ms': 0.0}
        assert _apply_beat_snap(it4, {'shotId': 's4', 'keepOriginalAudio': True}, [4050.0], 0.0, stats4) == 4000.0
        assert stats4['hit'] == 0 and it4['appliedSpeedFactor'] == 1.0

        # stats 缺省（None）：不得抛错
        assert _apply_beat_snap(_item(), {'shotId': 's5'}, [4050.0], 0.0) == 4050.0

    _with_env('1', _run)
    print("✓ test_apply_beat_snap_on_writes_and_counts: on 档磁吸/计数正确")


if __name__ == "__main__":
    print("=" * 60)
    print("🎵 步骤5 输出装配 · 补丁2 视听节拍器对齐（ISSUE-10 层位纠正）")
    print("=" * 60)
    test_read_beat_snap_switch_semantics()
    test_beat_snap_plan_degenerate_is_none()
    test_beat_snap_plan_tolerance_and_dead_zone()
    test_beat_snap_plan_speed_law_clamp()
    test_apply_beat_snap_off_is_noop()
    test_apply_beat_snap_on_writes_and_counts()
    print("=" * 60)
    print("全部通过 ✅")