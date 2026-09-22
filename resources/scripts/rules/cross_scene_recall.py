# -*- coding: utf-8 -*-
"""
rules/cross_scene_recall.py —— 补丁10 时空互文定向越狱（Tier2 软偏袒）

回忆/闪回等时空互文句（工单 `isCrossSceneRecall=true`）需定向拉入目标场次切片
作合法候选。本卡对「声明越狱且候选命中 `recallTargetSceneId`」的跨段候选施轻微
负奖励（软偏袒，非硬门槛）；未声明越狱的句，跨段候选仍受段域门禁约束，本卡不干预。

字段依赖：`query.isCrossSceneRecall / recallTargetSceneId`（分镜工单），
`cand.segmentId / scene`（切片归属场次）。字段缺失即中性放行（不可造假）。
"""
from __future__ import annotations

from montage_contract import CROSS_SCENE_RECALL_REWARD


def _seg_id(shot: dict) -> str:
    """取切片/句归属场次 id（兼容 segmentId / scene 两种字段名）。"""
    return str(shot.get('segmentId') if shot.get('segmentId') is not None
               else (shot.get('scene') or ''))


def SCORE(prev_shot, cand, ctx) -> float:
    """时空互文定向越狱：声明的越狱句命中目标场次候选 → 轻微奖励。

    Args:
        prev_shot: 前一镜切片（本卡不依赖，保留接口签名）。
        cand: 候选切片。
        ctx: 上下文 {state, query, is_scene_first}。

    Returns:
        float: CROSS_SCENE_RECALL_REWARD（鼓励），无越狱声明 / 字段缺失 → 0.0。
    """
    query = ctx.get('query') or {}
    # 未声明时空互文：本卡不越权（段域门禁自担）。字段缺失即中性。
    if not query.get('isCrossSceneRecall'):
        return 0.0
    target = str(query.get('recallTargetSceneId') or '')
    if not target:
        return 0.0
    # 候选归属场次与越狱目标一致 → 定向拉入合法，软偏袒。
    if _seg_id(cand) == target:
        return CROSS_SCENE_RECALL_REWARD
    return 0.0