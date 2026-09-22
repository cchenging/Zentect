# -*- coding: utf-8 -*-
"""
rules/gap_padding.py —— 补丁7 气口弹性腔（Tier2 软阻尼）

唯一允许的时间弹性来源 = 句尾 ASR 静音气口（Silence Gap）。本卡以「物理不足即罚」为判据：
候选镜切片在速度上限（±8% 铁律）下即使拉到最大倍速，仍无法覆盖「整句配音时长 + 句尾安全静音
红线（80ms，可由真实气口 silenceGapMs 抵扣）」时，其出点必然切入人声发音区 → 施加软阻尼；
气口充足/物理足长时不罚（绝不无中生有判罚，守「错就错」）。

字段依赖：`query.silenceGapMs`（步骤1 ③ 气口时长）+ `query.audioDurationMs`（配音时长）。
缺任一判据字段 → 中性放行 0.0（不可造假）。
"""
from __future__ import annotations

from montage_contract import (
    GAP_MAX_PENALTY,
    GAP_OVERRUN_RATE,
    GAP_SAFE_SILENCE_MS,
    GAP_SPEED_MAX,
)


def SCORE(prev_shot, cand, ctx) -> float:
    """气口弹性腔：候选切片物理不足、出点必然切入发音区时施加软阻尼。

    Args:
        prev_shot: 前一镜切片（本卡不依赖，保留接口签名）。
        cand: 候选切片。
        ctx: 上下文 {state, query, is_scene_first}。

    Returns:
        float: 0.0 中性放行；否则按缺额线性阻尼（上限 GAP_MAX_PENALTY）。
    """
    query = ctx.get('query') or {}
    # 无 ASR 气口数据：无判据可依，中性放行（非错误掩盖，领域条件）。
    gap = query.get('silenceGapMs')
    if gap is None:
        return 0.0
    # 无配音时长：句尾时刻不可定义，中性放行。
    audio_dur = float(query.get('audioDurationMs') or 0.0)
    if audio_dur <= 0:
        return 0.0
    # 候选切片物理窗无效：无从断言，中性放行。
    s = float(cand.get('startMs') or 0.0)
    e = float(cand.get('endMs') or 0.0)
    if not (e > s):
        return 0.0

    # 句尾必须保留安全静音红线；真实气口 silenceGapMs 足够（≥红线）时由素材自然承载，
    # 短缺部分才要求切片补足 → required 仅在气口不足时上浮。
    need_extra = max(0.0, GAP_SAFE_SILENCE_MS - float(gap))
    required = audio_dur + need_extra
    # 候选切片在速度上限下的最大可承载输出时长。
    max_cov = (e - s) * GAP_SPEED_MAX
    deficit = required - max_cov
    if deficit <= 0:
        # 能完整承载配音 + 安全静音 → 出点不侵入发音区，中性放行。
        return 0.0
    # 物理不足：即使拉到速度上限仍无法覆盖句尾安全静音 → 出点必切发音区，软阻尼罚。
    return min(GAP_MAX_PENALTY, GAP_OVERRUN_RATE * deficit)