# -*- coding: utf-8 -*-
"""
rules/heartbeat.py —— 补丁13 视听节奏心跳阻尼（Tier2 软阻尼 +0.50/−0.20）

连续 ≥8s 无机位/动静反差 → 观感疲劳（完播率杀手），+0.50 惩罚；候选镜主动提供
动静/机位反差（破局）→ −0.20 奖励，鼓励每 5~7s 一次起伏。

疲劳累积 / 破局重置由束搜索 `_advance_state` 推进到 `ctx['state']['fatigue_accum_ms']`，
本卡只读该累加量，并用 `has_motion_contrast` 判定候选是否构成破局（判据单源复用）。
"""
from __future__ import annotations

from montage_contract import (
    BREAKOUT_REWARD,
    FATIGUE_FLAT_MS,
    FATIGUE_PENALTY,
    has_motion_contrast,
)


def SCORE(prev_shot, cand, ctx) -> float:
    """心跳阻尼：疲劳超限 → +0.50；候选破局反差 → −0.20。

    Args:
        prev_shot: 前一镜切片。
        cand: 候选切片。
        ctx: 上下文 {state, query, is_scene_first}。

    Returns:
        float: 破局奖励 / 疲劳惩罚 / 0.0。
    """
    # 峰值优先：候选镜本身构成动静反差 → 破局奖励。
    if prev_shot is not None and has_motion_contrast(prev_shot, cand):
        return BREAKOUT_REWARD
    fatigue = float((ctx.get('state') or {}).get('fatigue_accum_ms', 0.0))
    if fatigue >= FATIGUE_FLAT_MS:
        return FATIGUE_PENALTY
    return 0.0