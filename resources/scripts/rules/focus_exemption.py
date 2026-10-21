# -*- coding: utf-8 -*-
"""
rules/focus_exemption.py —— 补丁3 反打/过肩焦点豁免（Tier2 软偏好）

冲突/对白句允许焦点落对抗者（非主控角色的特写/近景）；过肩句无条件豁免焦点门禁。
本卡对「句含多主体冲突意图且候选焦点落在句中任一期望角色」施轻微奖励（豁免偏袒，
非硬门禁），缓解对话戏焦点单边化导致的戏感瘫痪。

字段依赖：`query.characters`（期望角色）+ `cand.primarySubject`（A域 v7 单焦点）。
**已点亮**（VLM 帧级 primarySubject 由步骤2 聚合落库）；补丁18
（`ZENTECT_STEP2_ROLE_POOLING=on`）起改由帧级时序众数归约，可能写入 `MULTIPLE`/`EMPTY` 哨兵——
哨兵非角色名，下面 `subject == 期望角色` 自然不命中 ⇒ 即"空/全景豁免焦点门禁"，无需特判。

**判据落地（2026-10-14）**：docstring 要求的「句含多主体冲突意图」前置，以
`len(query.characters) ≥ 2` 落地——`characters` 是**本句期望角色集合**，≥2 即多主体句
（对白/反打；单主体叙述句恒 1 个）。**「冲突」语义不可由现有字段判定，故不伪造**：本卡只以
「多主体」这一**可实证**的代理判据收窄服务面，不对单主体句重复奖励（该信号已由 match_cost
②供给分的「主体」属性贴合桥承载，本卡再施豁免即重复计分）。

**置信门（2026-10-14 接通）**：`cand.primarySubjectConf`（补丁18 主控焦点置信度）低于
`FOCUS_CONF_MIN`（0.5）时不予豁免——防低置信噪声焦点被误豁免；字段缺失按「未知」放行。
"""
from __future__ import annotations

# 主控焦点置信门（2026-10-14 接通）：`primarySubject` 由步骤2 帧级众数归约产出
# （补丁18 期望口径「出现帧率 ≥50%」）；低于本阈值仍被写入主语时按「噪声焦点」处理，
# 不授予豁免，避免低置信噪声被误豁免。阈值与补丁18 众数定义同源。
FOCUS_CONF_MIN = 0.5


def SCORE(prev_shot, cand, ctx) -> float:
    """焦点豁免：句含多主体（≥2 期望角色）且候选焦点落在期望角色 → 轻奖励。

    Args:
        prev_shot: 前一镜切片（本卡不依赖，保留接口签名）。
        cand: 候选切片。
        ctx: 上下文 {state, query, is_scene_first}。

    Returns:
        float: 0.0（primarySubject 未回填 / 单主体句 / 焦点低置信：无从豁免，不造假）；
               多主体命中且置信达标 −0.10。
    """
    subject = (cand.get('primarySubject') or '').strip()
    if not subject:
        return 0.0  # 主控焦点字段未回填：无从豁免，不造假。
    conf = cand.get('primarySubjectConf')
    # 置信门：主语存在但众数帧率不足（<FOCUS_CONF_MIN）⇒ 视为噪声焦点，不豁免。
    # 字段缺失（None）不设门（向后兼容，缺失即未知而非低置信）。
    if isinstance(conf, (int, float)) and float(conf) < FOCUS_CONF_MIN:
        return 0.0
    query = ctx.get('query') or {}
    chars = query.get('characters') or []
    # 多主体前置（补丁3 落地判据）：单主体叙述句无「冲突/对白」意图，不适用豁免。
    if len(chars) < 2:
        return 0.0
    # 焦点落在句中任一期望角色 → 视为合法的反打落点（豁免偏袒，仅软分）。
    if any(str(c) == subject for c in chars):
        return -0.10
    return 0.0
