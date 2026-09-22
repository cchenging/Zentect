# -*- coding: utf-8 -*-
"""
rules/focus_exemption.py —— 补丁3 反打/过肩焦点豁免（Tier2 软偏好）

冲突/对白句允许焦点落对抗者（非主控角色的特写/近景）；过肩句无条件豁免焦点门禁。
本卡对「句含多主体冲突意图且候选焦点落在句中任一期望角色」施轻微奖励（豁免偏袒，
非硬门禁），缓解对话戏焦点单边化导致的戏感瘫痪。

字段依赖：`query.characters`（期望角色）+ `cand.primarySubject`（A域 v7 单焦点）。
**primarySubject 尚未按帧级众数回填，本卡休眠；回填后点亮**。
"""
from __future__ import annotations


def SCORE(prev_shot, cand, ctx) -> float:
    """焦点豁免：句含冲突意图且候选焦点落在期望角色 → 轻奖励。

    Args:
        prev_shot: 前一镜切片（本卡不依赖，保留接口签名）。
        cand: 候选切片。
        ctx: 上下文 {state, query, is_scene_first}。

    Returns:
        float: 0.0（primarySubject 未回填期间休眠）。
    """
    subject = (cand.get('primarySubject') or '').strip()
    if not subject:
        return 0.0  # 主控焦点字段未回填：无从豁免，不造假。
    query = ctx.get('query') or {}
    chars = query.get('characters') or []
    # 焦点落在句中任一期望角色 → 视为合法的反打落点（豁免偏悻，仅软分）。
    if any(str(c) == subject for c in chars):
        return -0.10
    return 0.0