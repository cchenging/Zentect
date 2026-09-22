# -*- coding: utf-8 -*-
"""
rules/costume_rhythm.py —— 服装律动（C域五罚之一 W_costume，Tier2 软阻尼）

相邻两镜服装标识跳变（同场景内人物换装突兀）→ 轻微罚款阻尼。服装字段（`costume`）
覆盖不足或首镜时中性放行（未识别不判罚，符合「不可造假」）。
跨宏观场次首步自动豁免（补丁19 #2）。
"""
from __future__ import annotations

from montage_contract import COSTUME_JUMP_PENALTY


def _costume_of(chunk) -> str:
    """取切片的服装标识（兼容 costume 字段，未标注返回空串）。"""
    return (chunk.get('costume') or '').strip()


def SCORE(prev_shot, cand, ctx) -> float:
    """服装律动：相邻两镜服装标识不一致 → 轻微罚。

    Args:
        prev_shot: 前一镜切片。
        cand: 候选切片。
        ctx: 上下文 {state, query, is_scene_first}。

    Returns:
        float: 服装跳变阻尼；跨场首步 / 服装未标注 / 首镜 → 0.0。
    """
    # 跨宏观场次首步豁免（补丁19 #2）：换场=时空大跳跃，不受服装连续性限制。
    if ctx.get('is_scene_first') or prev_shot is None:
        return 0.0
    p_costume = _costume_of(prev_shot)
    c_costume = _costume_of(cand)
    # 任一侧无服装标注：无从断言是否换装，中性放行（领域条件）。
    if not p_costume or not c_costume:
        return 0.0
    if p_costume != c_costume:
        return COSTUME_JUMP_PENALTY
    return 0.0