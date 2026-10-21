# -*- coding: utf-8 -*-
"""
rules/monotonic_lock.py —— 补丁11 同源物理单向锁（Tier1 硬门禁）

同一物理镜头（P4 键域 = 镜头，`parentChunkId` 与自身 id 同指，无父字段者以自身 id 为键）
的多个**时间窗**按时间正序开窗消费。若某次开窗的**入点**显著早于「该镜头已消费的最远
入点」，即为时间倒流穿越 → ∞ 一票否决。

状态依赖：`max_consumed_ms[镜头键]`（由束搜索 `_advance_state` 推进，写入本窗入点）。
本卡只读 `ctx['state']['max_consumed_ms']` 与 `ctx['entryMs']`（本窗入点），不做写入。
"""
from __future__ import annotations

from montage_contract import MONOTONIC_SLACK_MS


def SCORE(prev_shot, cand, ctx) -> float:
    """同源单向锁：本窗入点须 ≥ 该镜已消费最远入点 − 200ms；违反即 ∞。

    P4（镜头 + 时间窗）：判据基准由「切片 startMs」改为「**本窗入点** `ctx['entryMs']`」
    （由束搜索按 `游标 ?? 命中帧强锚 ?? 镜头起点` 算出，与取料层开窗口径同源）。
    若沿用 `cand.startMs`（镜头起点恒定）会把同镜换窗续用误判成时间倒流。

    **闪回豁免（2026-10-14 接通）**：`query.isFlashback`（步骤3 LLM 显式标注的闪回/回忆/倒叙段）
    为真时本卡直接放行——闪回段叙事时间与画面时间不同步，其取料窗口允许在源时间回退，
    本卡是唯一会以 ∞ 误杀合法闪回素材的 Tier1 硬门禁，故须对其豁免。
    缺省 / False ⇒ 不豁免、仍按严格口径判（不因字段缺失放宽，守「不可造假门」）。

    Args:
        prev_shot: 前一镜切片（本卡不依赖，保留接口签名）。
        cand: 候选镜头。
        ctx: 上下文 {state, query, is_scene_first, entryMs}。

    Returns:
        float: 0.0 通过（含闪回豁免）；float('inf') 一票否决。
    """
    query = ctx.get('query') or {}
    if query.get('isFlashback'):
        # 闪回/回忆段：允许源时间回退，豁免单向锁（步骤3 已显式标注，非猜测）。
        return 0.0
    pid = str(cand.get('parentChunkId') or cand.get('id') or '')
    if not pid:
        return 0.0
    consumed = (ctx.get('state') or {}).get('max_consumed_ms') or {}
    farthest = float(consumed.get(pid, 0.0))
    _entry = ctx.get('entryMs')
    entry = float(_entry) if _entry is not None else float(cand.get('startMs') or 0.0)
    if entry < farthest - MONOTONIC_SLACK_MS:
        return float('inf')
    return 0.0