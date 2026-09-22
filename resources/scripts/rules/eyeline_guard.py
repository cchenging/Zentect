# -*- coding: utf-8 -*-
"""
rules/eyeline_guard.py —— 补丁14 视线轴线反打守卫（Tier1 硬门禁）

对峙反打双方视线必须互斥（一方 LEFT 一方 RIGHT）；顺延遇机位视轴翻转（LEFT→RIGHT
穿越中轴）→ 强制断顺延（一票否决，改切中立空镜/全景过渡），防跳轴穿帮空间错乱。

字段依赖：`eyelineDirection`（A域 v7 结构化标注）。**当前未回填，本卡休眠；
回填后经 available_keys 点亮为硬卡**。
"""
from __future__ import annotations


def SCORE(prev_shot, cand, ctx) -> float:
    """视线轴线守卫：前一镜视向与候选视向穿越中轴 → 一票否决。

    Args:
        prev_shot: 前一镜切片。
        cand: 候选切片。
        ctx: 上下文 {state, query, is_scene_first}。

    Returns:
        float: float('inf') 否决跳轴；字段缺失 / 首镜 → 0.0。
    """
    if prev_shot is None:
        return 0.0
    p_eye = (prev_shot.get('eyelineDirection') or '').strip()
    c_eye = (cand.get('eyelineDirection') or '').strip()
    # 任一侧无视线标注：无从判跳轴，中性放行（不可造假）。
    if not p_eye or not c_eye:
        return 0.0
    # 视线穿越中轴（LEFT↔RIGHT）视为空间错乱跳轴；FRONT/同侧放行。
    if {p_eye, c_eye} == {'LEFT', 'RIGHT'}:
        return float('inf')
    return 0.0