# -*- coding: utf-8 -*-
"""
rules/monotonic_lock.py —— 补丁11 同源物理单向锁（Tier1 硬门禁）

同一物理长镜头（同 `parentChunkId`）拆出的切片按时间正序消费。若某切片重入时
其入点显著早于「该父镜头已消费的最远起点」，即为时间倒流穿越 → ∞ 一票否决。

状态依赖：`maxConsumedTimeMs[parentChunkId]`（由束搜索 `_advance_state` 推进）。
本卡只读 `ctx['state']['max_consumed_ms']`，不做写入。
"""
from __future__ import annotations

from montage_contract import MONOTONIC_SLACK_MS


def SCORE(prev_shot, cand, ctx) -> float:
    """同源单向锁：重入起点须 ≥ 已消费最远起点 − 200ms；违反即 ∞。

    Args:
        prev_shot: 前一镜切片（本卡不依赖，保留接口签名）。
        cand: 候选切片。
        ctx: 上下文 {state, query, is_scene_first}。

    Returns:
        float: 0.0 通过；float('inf') 一票否决。
    """
    # 独立镜头（无父镜头）不存在「同源重入」，本锁不适用（领域条件，非兜底）。
    pid = cand.get('parentChunkId') or ''
    if not pid:
        return 0.0
    consumed = (ctx.get('state') or {}).get('max_consumed_ms') or {}
    farthest = float(consumed.get(pid, 0.0))
    start = float(cand.get('startMs') or 0.0)
    if start < farthest - MONOTONIC_SLACK_MS:
        return float('inf')
    return 0.0