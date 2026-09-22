# -*- coding: utf-8 -*-
"""
rules/ —— 剪辑规则注册表（F 域 §8.5.6 速查表 / D 域 §10.2.5 / §13.4 补丁21 两级阻断）

职责：
  - 每条剪辑规则 = 一个小卡片文件，导出 `SCORE(prev_shot, cand_shot, ctx) -> 罚分数` 纯函数。
  - 本包的 `build_rule_cards(available_keys)` 把「具象卡片」装配为束搜索求解核可遍历的
    `RuleCard` 列表（先 hard 一票否决，后 soft 累加，§13.4 补丁21）。

工程红线（守 Q1「错就错」+「宁可少卡不可造假」）：
  - 每个卡片声明 `AVAILABILITY`（其依赖的下游字段名集合）。装配时仅启用
    `availability ⊆ available_keys` 的卡片；数据未回填（如 A 域 `primarySubject`）的卡片
    默认不激活，绝不因缺字段造假启用硬门禁。
  - 卡片是纯读函数 + 显式 `float('inf')` 否决，不做状态写入；束搜索的
    `_advance_state` 负责状态推进（补丁11 单向锁 / 补丁13 疲劳），卡只读 ctx['state']。

ctx 形状（束搜索展开层注入）：
    {'state': <BeamPath.state dict>, 'query': <脚本句>, 'is_scene_first': bool}
"""
from __future__ import annotations

from typing import List, Optional

from rules import (
    beat_snap,
    camera_continuity,
    color_continuity,
    costume_rhythm,
    critical_asset_lock,
    cross_scene_recall,
    env_medium_lock,
    eyeline_guard,
    focus_exemption,
    gap_padding,
    heartbeat,
    jump_cut,
    monotonic_lock,
    motion_rhythm,
    scale_rhythm,
    shot_loop_reset,
    shot_pref_adherence,
)

# 具象卡片定义表：name / tier(hard|soft) / score / availability(依赖字段集)。
# 加一条规则 = 加一个文件 + 在此登记一行（F 域完成判定「加一卡只动一行」兑现）。
# 休眠语义：依赖字段未回填（如 A 域 primarySubject/eyelineDirection/isCriticalHeroAsset、
# 步骤1 silenceGapMs）的卡在 `available_keys` 收窄时经下放集合自动休眠，不伪造启用硬门禁。
_CARD_DEFS = [
    # ---- Tier1 硬门禁（违反即 ∞，一票否决，§13.4）----
    {'name': 'monotonic_lock', 'tier': 'hard',
     'score': monotonic_lock.SCORE,
     'desc': '补丁11 同源物理单向锁', 'availability': frozenset({'parentChunkId', 'startMs'})},
    {'name': 'env_medium_lock', 'tier': 'hard',
     'score': env_medium_lock.SCORE,
     'desc': '补丁16 空镜环境介质强硬锁', 'availability': frozenset({'location'})},
    {'name': 'eyeline_guard', 'tier': 'hard',
     'score': eyeline_guard.SCORE,
     'desc': '补丁14 视线轴线反打守卫', 'availability': frozenset({'eyelineDirection'})},
    {'name': 'critical_asset_lock', 'tier': 'hard',
     'score': critical_asset_lock.SCORE,
     'desc': '补丁17 稀有物料静态预锁', 'availability': frozenset({'isCriticalHeroAsset'})},
    # ---- Tier2 软阻尼（仅累加，§13.4）----
    {'name': 'jump_cut', 'tier': 'soft',
     'score': jump_cut.SCORE,
     'desc': '补丁5 同机位跳斩阻尼', 'availability': frozenset({'camera', 'startMs'})},
    {'name': 'heartbeat', 'tier': 'soft',
     'score': heartbeat.SCORE,
     'desc': '补丁13 视听心跳阻尼', 'availability': frozenset({'motionScore', 'startMs'})},
    {'name': 'scale_rhythm', 'tier': 'soft',
     'score': scale_rhythm.SCORE,
     'desc': '景别律动 W_scale', 'availability': frozenset({'shotScale', 'shotType'})},
    {'name': 'motion_rhythm', 'tier': 'soft',
     'score': motion_rhythm.SCORE,
     'desc': '动静 W_motion', 'availability': frozenset({'motionScore'})},
    {'name': 'cross_scene_recall', 'tier': 'soft',
     'score': cross_scene_recall.SCORE,
     'desc': '补丁10 时空互文定向越狱', 'availability': frozenset({'isCrossSceneRecall', 'recallTargetSceneId'})},
    {'name': 'costume_rhythm', 'tier': 'soft',
     'score': costume_rhythm.SCORE,
     'desc': '服装律动 W_costume', 'availability': frozenset({'costume'})},
    {'name': 'color_continuity', 'tier': 'soft',
     'score': color_continuity.SCORE,
     'desc': '色调连续性', 'availability': frozenset({'colorHist'})},
    {'name': 'camera_continuity', 'tier': 'soft',
     'score': camera_continuity.SCORE,
     'desc': '运镜连续性', 'availability': frozenset({'camera', 'cameraMovement'})},
    {'name': 'shot_pref_adherence', 'tier': 'soft',
     'score': shot_pref_adherence.SCORE,
     'desc': '首选景别贴合', 'availability': frozenset({'preferredShot', 'shotScale'})},
    {'name': 'beat_snap', 'tier': 'soft',
     'score': beat_snap.SCORE,
     'desc': '补丁2 视听节拍器对齐(休眠待回填)', 'availability': frozenset({'silenceGapMs', 'bgmBeats'})},
    {'name': 'gap_padding', 'tier': 'soft',
     'score': gap_padding.SCORE,
     'desc': '补丁7 气口弹性腔(休眠待回填)', 'availability': frozenset({'silenceGapMs'})},
    {'name': 'shot_loop_reset', 'tier': 'soft',
     'score': shot_loop_reset.SCORE,
     'desc': '补丁8 正反打视听环线(休眠待回填)', 'availability': frozenset({'primarySubject', 'characters'})},
    {'name': 'focus_exemption', 'tier': 'soft',
     'score': focus_exemption.SCORE,
     'desc': '补丁3 反打/过肩焦点豁免(休眠待回填)', 'availability': frozenset({'primarySubject', 'characters'})},
]


def build_rule_cards(available_keys: Optional[set] = None) -> List[object]:
    """装配束搜索可消费的 RuleCard 列表（可用字段不足的卡静默跳过）。

    Args:
        available_keys: 本轮输入里真实存在的切片/句字段名集合。为 None 时视为
            契约 `default_chunk` 全字段就绪（上文 6 卡均只依赖契约保证字段），启用全部；
            传入收窄集合时仅启用 `availability ⊆ available_keys` 的卡（未来 A 域字段如
            `eyelineDirection/isCriticalHeroAsset` 未落地即休眠，兑现「不可造假」）。

    Returns:
        List[object]: RuleCard 实例列表（自 beam_search 运行时导入，规避循环依赖）。
    """
    # 运行时导入 RuleCard：beam_search 不在模块顶层 import rules，杜绝循环。
    from beam_search import RuleCard

    strict = available_keys is not None
    avail = {k for k in (available_keys or []) if k}
    cards: List[object] = []
    for c in _CARD_DEFS:
        if strict and c['availability'] and not c['availability'] <= avail:
            continue  # 依赖字段本轮缺失 → 该卡休眠（A/B 回填后自动点亮）
        cards.append(RuleCard(c['name'], c['tier'], c['score']))
    return cards