# -*- coding: utf-8 -*-
"""
rules/focus_exemption.py —— 补丁3 反打/过肩焦点豁免（Tier2 软偏好）

冲突/对白句允许焦点落对抗者（非主控角色的特写/近景）；过肩句无条件豁免焦点门禁。
本卡对「句含多主体冲突意图且候选焦点落在句中任一期望角色」施轻微奖励（豁免偏袒，
非硬门禁），缓解对话戏焦点单边化导致的戏感瘫痪。

字段依赖：`query.characters`（期望角色）+ `cand.primarySubject`（A域 v7 单焦点）。
**已点亮**（VLM 帧级 primarySubject 由步骤2 聚合落库）；补丁18
（`ZENTECT_STEP2_ROLE_POOLING=on`）起改由帧级时序众数归约，可能写入 `MULTIPLE`/`EMPTY` 哨兵——
哨兵非角色名，下面 `subject == 期望角色` 自然不命中 ⇒ 即"空/全景豁免焦点门禁"，无需特判。
**仍缺**：docstring 要求的"句含多主体冲突意图"判据尚未落地（当前只要 `any(chars)` 命中即给软分）。
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