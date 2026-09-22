# -*- coding: utf-8 -*-
"""
rules/motion_rhythm.py —— 动静 W_motion（Tier2 软阻尼）

镜头动静层次：相邻两镜全程平缓连续（motionScore 差≤0.15）→ +0.10 轻微阻尼
（画面节奏太平）；大动静反差（差≥0.5）→ −0.10 轻微奖励（节奏起伏）。居中不干预。
"""
from __future__ import annotations


def SCORE(prev_shot, cand, ctx) -> float:
    """动静阻尼：平缓连续 +0.10 / 大反差奖励 −0.10。

    Args:
        prev_shot: 前一镜切片。
        cand: 候选切片。
        ctx: 上下文（本卡不消费，保留接口签名）。

    Returns:
        float: 动态阻尼 / 奖励；缺运动分或首镜时 0.0。
    """
    if prev_shot is None:
        return 0.0
    pm = prev_shot.get('motionScore')
    cm = cand.get('motionScore')
    if not (isinstance(pm, (int, float)) and isinstance(cm, (int, float))):
        return 0.0
    diff = abs(float(pm) - float(cm))
    if diff <= 0.15:
        return 0.10
    if diff >= 0.50:
        return -0.10
    return 0.0