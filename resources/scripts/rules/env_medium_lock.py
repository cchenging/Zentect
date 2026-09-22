# -*- coding: utf-8 -*-
"""
rules/env_medium_lock.py —— 补丁16 空镜环境介质强硬锁（Tier1 硬门禁）

抽象抒情句分流到空镜/B-Roll 时，其环境介质（室内/室外/街头/白天/黑夜…）必须与上一镜
保持一致，否则色温/昼夜撕裂跳戏 → ∞ 一票否决（降级走背影或顺延）。

介质推导复用旧 KM 的 `env_medium_of`（场景文本长词优先 → 枚举，未识别返回 UNKNOWN）。
介质为 UNKNOWN（无任何介质线索）时无从断言不匹配，属领域中性，本卡放行。
"""
from __future__ import annotations

from timeline_solver import _is_reusable_broll, env_medium_of

# 中性地——无从断言不匹配的返回值（非兜底掩盖，见模块 docstring）。
_MEDIUM_UNKNOWN = 'UNKNOWN'


def _medium_of(chunk) -> str:
    """从切片的 location（场景文本）+ 氛围抽取环境介质枚举。

    Args:
        chunk: 切片资产。

    Returns:
        str: 环境介质枚举；无可识别线索时返回 'UNKNOWN'。
    """
    return env_medium_of(
        chunk.get('location') or '',
        chunk.get('visualAtmosphere') or chunk.get('atmosphere') or '',
    )


def SCORE(prev_shot, cand, ctx) -> float:
    """空镜昼夜/环境介质锁：候选为空镜且与上镜介质不同相 → ∞。

    Args:
        prev_shot: 前一镜切片。
        cand: 候选切片。
        ctx: 上下文（本卡不消费，保留接口签名）。

    Returns:
        float: 0.0 通过；float('inf') 一票否决。
    """
    # 首镜或候选非空镜/B-Roll：本锁不起效。
    if prev_shot is None or not _is_reusable_broll(cand):
        return 0.0
    prev_medium = _medium_of(prev_shot)
    cand_medium = _medium_of(cand)
    # 任一侧介质线索缺失（UNKNOWN）→ 无从比对，中性放行（领域条件）。
    if prev_medium == _MEDIUM_UNKNOWN or cand_medium == _MEDIUM_UNKNOWN:
        return 0.0
    if prev_medium != cand_medium:
        return float('inf')
    return 0.0