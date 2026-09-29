# -*- coding: utf-8 -*-
"""
rules/shot_pref_adherence.py —— 首选景别贴合（ShotSpec.preferredShot 动态门禁软偏袒，Tier2）

分镜工单声明 `preferredShot`（首选景别）时，候选景别与之一致 → 轻奖励；不一致 → 微罚
（仅排序加分，绝不作硬门禁，守「软排」原则）。工单未声明首选或候选无景别时中性放行。
实际景别读取复用 `_shot_type_level`（与 scale_rhythm 单源口径）。
⚠️ 两侧词表必须先归一：工单侧 `preferredShot` 是契约英文枚举（CLOSE_SHOT…），切片侧
`shotScale / shotType` 是中文标签（近景/中景/全景/特写）⇒ 裸字符串相等比较恒不相等，
一旦 Node 回填英文枚举就会**恒定**施 `PREFERRED_SHOT_MISS_PENALTY`（比不回填更糟）。
归一唯一真源在契约 `montage_contract.normalize_preferred_shot`。
"""
from __future__ import annotations

from montage_contract import (
    PREFERRED_SHOT_MISS_PENALTY,
    PREFERRED_SHOT_REWARD,
    normalize_preferred_shot,
)


def _scale_of(chunk):
    """取切片的景别标识（兼容 shotScale / shotType 两种字段名，返回原样标签）。"""
    return (chunk.get('shotScale') or chunk.get('shotType') or '').strip()


def SCORE(prev_shot, cand, ctx) -> float:
    """首选景别贴合：候选景别与工单首选一致 → 奖励，不一致 → 微罚。

    Args:
        prev_shot: 前一镜切片（本卡不依赖，保留接口签名）。
        cand: 候选切片。
        ctx: 上下文 {state, query, is_scene_first}。

    Returns:
        float: 贴合奖励 / 不贴合微罚；工单未声明或字段缺失 → 0.0。
    """
    query = ctx.get('query') or {}
    pref = normalize_preferred_shot(query.get('preferredShot'))
    if not pref:
        return 0.0
    cand_scale = normalize_preferred_shot(_scale_of(cand))
    if not cand_scale:
        return 0.0  # 候选无景别标识：无从判贴合，中性放行
    if cand_scale == pref:
        return PREFERRED_SHOT_REWARD
    return PREFERRED_SHOT_MISS_PENALTY