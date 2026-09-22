# -*- coding: utf-8 -*-
"""
rules/beat_snap.py —— 补丁2 视听节拍器对齐（Tier2 软阻尼）

强切点对齐 TTS 气口 / 句尾静音（Silence Gap≥200ms）并磁吸 BGM 强拍。本卡对「候选
镜头入点与句尾气口错位」施加轻微罚，逼迫顺延强切点踩在呼吸节奏上。

字段依赖：`query.silenceGapMs`（步骤1 ③ 气口时长）与 `bgmBeats`（已有 BPM 网格）。
**两字段当前未回填（契约未含），本卡休眠（返回 0.0），A/B 回填后经 availability 点亮**。
"""
from __future__ import annotations


def SCORE(prev_shot, cand, ctx) -> float:
    """视听节拍器对齐：依赖气口/强拍字段，当前未落地 → 中性放行（不可造假）。

    Args:
        prev_shot: 前一镜切片（本卡不依赖，保留接口签名）。
        cand: 候选切片。
        ctx: 上下文 {state, query, is_scene_first}。

    Returns:
        float: 恒 0.0（字段未回填前休眠）。
    """
    query = ctx.get('query') or {}
    # 步骤1 ③ 的 silenceGapMs / bgmBeats 未落地，本卡无判据可依，不伪造对齐伤害。
    if query.get('silenceGapMs') is None and not query.get('bgmBeats'):
        return 0.0
    # 回填后：入点与句尾气口错位的候选施加微小对齐阻尼（守恒等量伸缩）。
    return 0.0