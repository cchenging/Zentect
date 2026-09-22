# -*- coding: utf-8 -*-
"""
rules/shot_loop_reset.py —— 补丁8 正反打视听环线（Tier2 软偏好）

单场景长对白戏切片枯竭时，允许主角主机位在「间隔 ≥2 句并穿插反打/特写/空镜阻断后」
解除排他锁合法重入（A说→B惊恐→手部特写→再切回A冷笑）。本卡对「候选主控焦点 = 句
期望角色主机位」且与本句目标一致的复用施轻微偏好。

字段依赖：`cand.primarySubject` + `cand.characters`（A域）。**当前未回填，本卡休眠；
完整环线状态（hero_pool/reentry 计数）随 A/B 回填在束搜索 `_advance_state` 推进**。
"""
from __future__ import annotations


def SCORE(prev_shot, cand, ctx) -> float:
    """正反打环线：候选焦点与句期望角色一致 → 轻微偏好。

    Args:
        prev_shot: 前一镜切片（本卡不依赖，保留接口签名）。
        cand: 候选切片。
        ctx: 上下文 {state, query, is_scene_first}。

    Returns:
        float: 0.0（primarySubject 未回填期间休眠）。
    """
    subject = (cand.get('primarySubject') or '').strip()
    if not subject:
        return 0.0
    query = ctx.get('query') or {}
    chars = query.get('characters') or []
    if any(str(c) == subject for c in chars):
        return -0.05  # 焦点与句期望角色一致 → 允许合法重入（软偏好，量级低于硬门禁）
    return 0.0