# -*- coding: utf-8 -*-
"""
rules/jump_cut.py —— 补丁5 同机位跳斩阻尼（Tier2 软阻尼 +0.60）

相邻两镜相同机位（camera）且入点间隔 ≤1500ms → 观感为廉价跳剪（Jump Cut），
施加 +0.60 阻尼，逼迫换景别/换角/走顺延。跨宏观场次首步自动豁免（补丁19 #2）。
"""
from __future__ import annotations

from montage_contract import JUMP_CUT_GAP_MS, JUMP_CUT_PENALTY


def _camera_of(chunk) -> str:
    """取切片的机位标识（兼容 camera / cameraMovement 两种字段名）。"""
    return (chunk.get('camera') or chunk.get('cameraMovement') or '').strip()


def SCORE(prev_shot, cand, ctx) -> float:
    """同机位跳斩阻尼：同机位 + 短间隔 → +0.60。

    Args:
        prev_shot: 前一镜切片。
        cand: 候选切片。
        ctx: 上下文 {state, query, is_scene_first}。

    Returns:
        float: +0.60 阻尼，否则 0.0。
    """
    # 跨宏观场次首步豁免（补丁19 #2）：换场=时空大跳跃，不受同场景机位连续限制。
    if ctx.get('is_scene_first'):
        return 0.0
    if prev_shot is None:
        return 0.0
    p_cam = _camera_of(prev_shot)
    c_cam = _camera_of(cand)
    if not p_cam or not c_cam or p_cam != c_cam:
        return 0.0
    p_start = float(prev_shot.get('startMs') or 0.0)
    c_start = float(cand.get('startMs') or 0.0)
    if abs(c_start - p_start) <= JUMP_CUT_GAP_MS:
        return JUMP_CUT_PENALTY
    return 0.0