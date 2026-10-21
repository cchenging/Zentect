# -*- coding: utf-8 -*-
"""
rules/shot_loop_reset.py —— 补丁8 正反打视听环线（Tier2 软偏好）

⚠️ 已退役（2026-10-14）：已从 `rules._CARD_DEFS` 摘除注册——本卡机理（"素材枯竭时解除排他锁
合法重入"）在新引擎**无载体**：`beam_search._win_exhausted` 是"镜头+时间窗配额"，而非"每镜只用
一次"的排他锁（同一镜头本就可按剩余时长多次重入）⇒ "解除排他锁"前提不存在；且实现已塌缩为
「`primarySubject ∈ query.characters` → −0.05」，与 `focus_exemption` 判据逐字同构（多主体句重复
计分 −0.05 −0.10 = −0.15）。**实现保留封存**，待引擎引入「镜头排他 / 素材枯竭」机制（如弃段/
拼接组架构）后再注册（回退=恢复 `rules/__init__.py` 的 import 行与 _CARD_DEFS 条目）。

单场景长对白戏切片枯竭时，允许主角主机位在「间隔 ≥2 句并穿插反打/特写/空镜阻断后」
解除排他锁合法重入（A说→B惊恐→手部特写→再切回A冷笑）。本卡对「候选主控焦点 = 句
期望角色主机位」且与本句目标一致的复用施轻微偏好。

字段依赖：`cand.primarySubject` + `cand.characters`（A域）。**已点亮**（步骤2 已聚合落库，补丁18
`ZENTECT_STEP2_ROLE_POOLING=on` 起改由帧级时序众数归约，`MULTIPLE`/`EMPTY` 哨兵非角色名 → 本卡自然中性放行）。
**仍缺**：完整环线状态（`hero_pool`/`reentry` 计数）随 `_advance_state` 推进，尚未实现。
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
