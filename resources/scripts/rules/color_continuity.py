# -*- coding: utf-8 -*-
"""
rules/color_continuity.py —— 色调连续性（C域五罚之一，Tier2 软阻尼）

相邻两镜 `colorHist` 直方图 L1 距离超阈值 → 色调撕裂（闪跳观感）轻微罚款。
任一侧无语色标签（空直方图）或首镜时中性放行（无法比对不判罚，符合「不可造假」）。
跨宏观场次首步自动豁免（补丁19 #2）。
"""
from __future__ import annotations

from typing import List

from montage_contract import COLOR_CONTINUITY_PENALTY, COLOR_GAP


def _hist(chunk) -> List[float]:
    """取切片色温直方图序列（兼容 colorHist，缺失/非列表返回空）。"""
    h = chunk.get('colorHist')
    return h if isinstance(h, list) and all(isinstance(v, (int, float)) for v in h) else []


def _l1(a: List[float], b: List[float]) -> float:
    """两等长直方图 L1 距离（长度不同视为不可比，返回 0 由调用方判中性）。"""
    if len(a) != len(b) or not a:
        return 0.0
    return sum(abs(x - y) for x, y in zip(a, b))


def SCORE(prev_shot, cand, ctx) -> float:
    """色调连续性：相邻两镜语色直方图 L1 距离超阈值 → 轻微罚。

    Args:
        prev_shot: 前一镜切片。
        cand: 候选切片。
        ctx: 上下文 {state, query, is_scene_first}。

    Returns:
        float: 色调撕裂阻尼；跨场首步 / 语色缺失 / 直方图不可比 → 0.0。
    """
    # 跨宏观场次首步豁免（补丁19 #2）。
    if ctx.get('is_scene_first') or prev_shot is None:
        return 0.0
    p_hist = _hist(prev_shot)
    c_hist = _hist(cand)
    # 任一侧无语色直方图：无从比对，中性放行。
    if not p_hist or not c_hist or len(p_hist) != len(c_hist):
        return 0.0
    if _l1(p_hist, c_hist) > COLOR_GAP:
        return COLOR_CONTINUITY_PENALTY
    return 0.0