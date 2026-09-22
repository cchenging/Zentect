# -*- coding: utf-8 -*-
"""
rules/scale_rhythm.py —— 景别律动（Tier2 软阻尼，W_scale）

蒙太奇节奏：同景别连切 → +0.40 罚（画面无呼吸感）；相邻一档推/拉（+1/−1）→ −0.20
奖励（规范蒙太奇推拉）。景别等级映射复用旧 KM `_shot_type_level`（单源口径）。
跨宏观场次首步自动豁免（补丁19 #2）。
"""
from __future__ import annotations

from montage_contract import PUSH_PULL_REWARD, SAME_SCALE_PENALTY
from timeline_solver import _shot_type_level


def _level_of(chunk):
    """取切片的景别等级（兼容 shotScale / shotType 两种字段名），未识别返回 None。"""
    return _shot_type_level(chunk.get('shotScale') or chunk.get('shotType') or '')


def SCORE(prev_shot, cand, ctx) -> float:
    """景别律动：同档连切 +0.40 / 相邻推拉 −0.20。

    Args:
        prev_shot: 前一镜切片。
        cand: 候选切片。
        ctx: 上下文 {state, query, is_scene_first}。

    Returns:
        float: 景别转移阻尼 / 奖励，缺等级或跨场首步时 0.0。
    """
    # 跨宏观场次首步豁免（补丁19 #2）：换场不受同场景景别连续性限制。
    if ctx.get('is_scene_first'):
        return 0.0
    if prev_shot is None:
        return 0.0
    p_level = _level_of(prev_shot)
    c_level = _level_of(cand)
    if p_level is None or c_level is None:
        return 0.0
    gap = abs(p_level - c_level)
    if gap == 0:
        return SAME_SCALE_PENALTY
    if gap == 1:
        return PUSH_PULL_REWARD
    return 0.0