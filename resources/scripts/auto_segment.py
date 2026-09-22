# -*- coding: utf-8 -*-
"""
auto_segment.py —— 方向2「自动场次划分」纯几何聚类算子

职责：
  用步骤1透出的 sceneCuts（物理镜头切点 ms 列表）在「无手动场次」时自动聚类为宏观场次，
  产物作为候选池**软偏袒**（优先排序非排除场外），不替代 S3 手动开单、不入 Tier1 硬门禁。

工程红线（守项目 Q1「错就错」）：
  - 本模块零模型、零启发性折扣，纯确定性几何聚类，可复现。
  - 切点不足 / 无法形成宏观场次 ⇒ 返回 []（合法退化，调用方退全池），**不抛错、不编造**。
  - 只做「按 id 索引 + 几何聚类」，不掺任何打分/规则（与 build_context「纯数据」一层解耦）。

字段对齐：产物 dict 对齐 montage_contract.default_segment 骨架，仅填 segmentId/startMs/endMs/auto，
其余字段（parentIds/locPurity/emotion/storyBeat）保持默认，由默认值语义兜底完整结构。
"""

from __future__ import annotations

import math
from typing import List


# ===========================================================================
# 纯函数：物理切点 → 宏观场次（几何聚类 + 时长钳制）
# ===========================================================================
def auto_segment_scene_cuts(
    scene_cuts_ms: List[float],
    *,
    min_scene_ms: float = 20000.0,
    max_scene_ms: float = 120000.0,
    switch_gap_ms: float = 2000.0,
    id_offset: int = 0,
) -> List[dict]:
    """把物理镜头切点聚类为宏观场次（纯几何，软偏袒源）。

    算法（确定性，逐步可复现）：
      ① 相邻切点间隙 > switch_gap_ms ⇒ 该切点判为新场次起始（场间停顿信号，快速连切视为同场）。
      ② 每场次 = [scene_start, 下场_start)，末场止于最后一个物理切点。
      ③ 时长钳制（先并后分，互不遮蔽）：
         - 过短（< min_scene_ms）：并入邻场（非首场并入前场，首场并入下邻；整片仅一场且过短则保守保留）。
         - 过长（> max_scene_ms）：按密度等分 floor/ceil 段，保证每段 ≤ max_scene_ms。
      ④ 产物按 segmentId = id_offset 起递增，全部标记 auto=True。

    Args:
        scene_cuts_ms: 物理镜头切点毫秒列表（步骤1 sceneCuts 透出，无序亦可，内部排序）。
        min_scene_ms: 宏观场次最短时长（过短并入邻场，防碎场）。
        max_scene_ms: 宏观场次最长时长（过长按密度等分，防单场过长）。
        switch_gap_ms: 相邻切点间隙超过本值 ⇒ 判为场间停顿（新场起始信号）。
        id_offset: 自动场次 segmentId 起始偏移（0 ⇒ 从 1 递增）。

    Returns:
        List[dict]: [{segmentId, startMs, endMs, auto:True}, ...]；切点不足时返回 []（合法退化）。

    Raises:
        ValueError: 输入参数 e=非法（min/max/gap 非正 或 min>max，几何不成立即显式报错）。
    """
    # --- 参数合法性（错就错：几何不成立的配置显式抛错，不静默降级）---
    if min_scene_ms <= 0 or max_scene_ms <= 0 or switch_gap_ms <= 0:
        raise ValueError(f'auto_segment: 时长/间隙必须为正, got min={min_scene_ms} max={max_scene_ms} gap={switch_gap_ms}')
    if min_scene_ms > max_scene_ms:
        raise ValueError(f'auto_segment: min_scene_ms({min_scene_ms}) 不得大于 max_scene_ms({max_scene_ms})')

    # --- ① 排序切点;不足 2 个 ⇒ 无法形成宏观场次,合法退化 ---
    cuts = sorted(float(x) for x in scene_cuts_ms or [])
    if len(cuts) < 2:
        return []

    # --- ② 聚类：间隙 > switch_gap_ms ⇒ 新场起始 ---
    scene_starts: List[float] = [cuts[0]]
    for i in range(1, len(cuts)):
        if (cuts[i] - cuts[i - 1]) > switch_gap_ms:
            scene_starts.append(cuts[i])

    # 首尾场界：每场 [start, next_start)，末场止于最后一个物理切点。
    bounds: List[List[float]] = []
    for k in range(len(scene_starts)):
        s = scene_starts[k]
        e = scene_starts[k + 1] if k + 1 < len(scene_starts) else cuts[-1]
        bounds.append([s, e])

    # --- ③a 过短并入邻场（非首场并入前场;首场并入下邻）---
    i = 0
    while i < len(bounds):
        if (bounds[i][1] - bounds[i][0]) >= min_scene_ms:
            i += 1
            continue
        if i == 0:
            # 首场过短：并入下一场（下邻 start 提前），删除本场
            if len(bounds) > 1:
                bounds[i + 1][0] = bounds[i][0]
                del bounds[i]
                continue  # 停在 i=0，重评并入后的新首场（可能仍过短，链式吸收）
            # 整片仅一场且过短：几何上无邻场可并，保守保留该场（不允许凭空分场）
            i += 1
        else:
            # 非首场过短：并入前场（延伸前场 end），删除本场，重评前场
            bounds[i - 1][1] = bounds[i][1]
            del bounds[i]
            i -= 1

    # --- ③b 过长按密度等分（保证每段 ≤ max_scene_ms）---
    scenes: List[List[float]] = []
    for s, e in bounds:
        dur = e - s
        if dur <= max_scene_ms:
            scenes.append([s, e])
            continue
        n = int(math.ceil(dur / max_scene_ms))
        step = dur / n
        for j in range(n):
            seg_s = s + j * step
            seg_e = seg_s + step if j < n - 1 else e
            scenes.append([seg_s, seg_e])

    # --- ④ 产契约 dict（对齐 default_segment 骨架）---
    segs: List[dict] = []
    for idx, (s, e) in enumerate(scenes):
        segs.append({
            'segmentId': id_offset + idx + 1,
            'startMs': round(s, 3),
            'endMs': round(e, 3),
            'auto': True,
        })
    return segs


# ===========================================================================
# 内联自检（已知真值断言）
# ===========================================================================
def _selftest() -> None:
    """合成切点跑一遍，断言与手推真值完全一致，任一不符即抛 AssertionError。"""
    # 手推场景：切点全部短间隙消化后聚类为 2 场（见设计笔记）
    cuts = [3000.0, 7000.0, 11000.0, 26000.0, 32000.0, 90000.0]
    segs = auto_segment_scene_cuts(
        cuts,
        min_scene_ms=20000.0,
        max_scene_ms=60000.0,
        switch_gap_ms=2000.0,
        id_offset=1000,
    )
    expected = [
        {'segmentId': 1001, 'startMs': 3000.0, 'endMs': 32000.0, 'auto': True},
        {'segmentId': 1002, 'startMs': 32000.0, 'endMs': 90000.0, 'auto': True},
    ]
    assert segs == expected, f'自检失败:\ngot      {segs}\nexpected {expected}'

    # 退化：切点不足 ⇒ []（调用方退全池）
    assert auto_segment_scene_cuts([5000.0]) == []

    # 过长场按密度等分：单场 130s > max 120s ⇒ 等分为 2 段
    segs2 = auto_segment_scene_cuts(
        [0.0, 5000.0, 130000.0],
        min_scene_ms=20000.0,
        max_scene_ms=120000.0,
        switch_gap_ms=2000.0,
        id_offset=0,
    )
    assert len(segs2) == 2 and segs2[0]['startMs'] == 0.0 \
        and abs(segs2[1]['endMs'] - 130000.0) < 0.01, f'过长等分自检失败: {segs2}'

    # 参数非法必须抛错（错就错不静默）
    for bad in (dict(min_scene_ms=-1), dict(min_scene_ms=50000.0, max_scene_ms=40000.0)):
        try:
            auto_segment_scene_cuts(cuts, **bad)
            raise AssertionError(f'非法参数未抛错: {bad}')
        except ValueError:
            pass


if __name__ == '__main__':
    _selftest()
    print('auto_segment selftest OK')