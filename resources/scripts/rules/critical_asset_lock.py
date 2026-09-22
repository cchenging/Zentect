# -*- coding: utf-8 -*-
"""
rules/critical_asset_lock.py —— 补丁17 稀有物料静态预锁（Tier1 硬门禁）

求解前静态统计出的唯一动作/关键特写（`isCriticalHeroAsset`）仅可由 `priority:HIGH` /
`PASS_OBJECT` / `FIRE_WEAPON` 工单独占，普通叙事句恒禁用（前瞻 O(N²)→O(1) 查表）。
本卡对「普通句强占稀有料」一票否决。

字段依赖：`cand.isCriticalHeroAsset`（A域纯统计，零模型）+ `query.actionType/keyProp`。
**isCriticalHeroAsset 未回填，本卡休眠**。
"""
from __future__ import annotations


def SCORE(prev_shot, cand, ctx) -> float:
    """稀有预锁：普通句强占稀有料 → 一票否决。

    Args:
        prev_shot: 前一镜切片（本卡不依赖，保留接口签名）。
        cand: 候选切片。
        ctx: 上下文 {state, query, is_scene_first}。

    Returns:
        float: float('inf') 否决强占；字段未回填 / 非稀有料 / 高优先级句 → 0.0。
    """
    # 稀有料标记未回填：无从判稀缺，不造门禁（不可造假）。
    if not cand.get('isCriticalHeroAsset'):
        return 0.0
    query = ctx.get('query') or {}
    # 高优先级 / 关键动作 / 武器交接工单独占，稀有料对其普通可用。
    action = query.get('actionType') or ''
    key = query.get('keyProp') or ''
    priority = str(query.get('priority') or '').upper()
    if priority == 'HIGH' or action in ('PASS_OBJECT', 'FIRE_WEAPON') or key:
        return 0.0
    # 普通叙事句：稀有料硬预锁，不得占用。
    return float('inf')