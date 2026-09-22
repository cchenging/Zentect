# -*- coding: utf-8 -*-
"""
rules/camera_continuity.py —— 运镜连续性（C域五罚之一，Tier2 软阻尼）

相邻两镜运镜标识跳变（急拉急推、运镜方向痉挛）→ 轻微罚款。运镜字段
（`camera`/`cameraMovement`）覆盖不足或首镜时中性放行（未识别不判罚）。
跨宏观场次首步自动豁免（补丁19 #2）。
"""
from __future__ import annotations

from montage_contract import CAMERA_CHANGE_PENALTY


def _camera_of(chunk) -> str:
    """取切片的运镜标识（兼容 camera / cameraMovement 两种字段名）。"""
    return (chunk.get('camera') or chunk.get('cameraMovement') or '').strip()


def SCORE(prev_shot, cand, ctx) -> float:
    """运镜连续性：相邻两镜运镜标识不一致 → 轻微罚。

    Args:
        prev_shot: 前一镜切片。
        cand: 候选切片。
        ctx: 上下文 {state, query, is_scene_first}。

    Returns:
        float: 运镜跳变阻尼；跨场首步 / 运镜未标注 / 首镜 → 0.0。
    """
    # 跨宏观场次首步豁免（补丁19 #2）。
    if ctx.get('is_scene_first') or prev_shot is None:
        return 0.0
    p_cam = _camera_of(prev_shot)
    c_cam = _camera_of(cand)
    # 任一侧无运镜标注：无从断言是否跳变，中性放行（领域条件）。
    if not p_cam or not c_cam:
        return 0.0
    if p_cam != c_cam:
        return CAMERA_CHANGE_PENALTY
    return 0.0