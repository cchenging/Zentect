"""
test_shot_norm.py — 🎬 步骤3→5 接线 · 两侧词表归一锁（景别 / 动作 / 道具）

背景（本轮定案的缺陷）：分镜单 `ShotSpec` 的字段此前只回填 4 个（segmentId/spatialType/
shotMode/fallbackLevel），决定「画面长什么样」的 `preferredShot / actionType / keyProp`
被整批丢弃；而 daemon 侧即便拿到这些值也**无法比较** —— 两侧词表分裂：

  | 维度 | 工单侧（Node 回填） | 切片侧（A 域实测） |
  |---|---|---|
  | 景别 | 英文枚举 CLOSE_SHOT… | 中文标签 近景/中景/全景/特写 |
  | 动作 | LLM 自由文本（「递给对方」） | ACTION_CLASSES 类别名（「递物」） |
  | 道具 | LLM 自由文本（「行囊」） | ENTITY_CLASSES 类别名（「行李」） |

裸字符串比较恒不等 ⇒ ① `_dynamic_gate` 的 L0 恒空、降级链空转；② `shot_pref_adherence`
一旦回填英文枚举就会**恒定**施 `PREFERRED_SHOT_MISS_PENALTY`（比不回填更糟）。
本文件锁「两侧归一到同一层」这一前置条件：

  1. `preferred_shot_from_label` 精确等值（「中全景」不得被「全景」抢先命中）
  2. `normalize_preferred_shot` 双向（英文枚举原样保留 / 中文标签归一 / 未识别 → ''）
  3. `shot_pref_adherence.SCORE` 归一后可比（回归锁：修复前恒 MISS）
  4. `_shot_of_chunk` 从 `shotScale / shotType` 取景别，`scene`（地点文本）仅兜底
  5. `_class_of_query` 自由文本 → 类别名（与切片侧同表）
  6. `_dynamic_gate` 在「自由文本 query」下 L0 可达（修复前恒不可达）

运行方式：cd resources/scripts ; ..\\ai-env\\python.exe __tests__\\test_shot_norm.py
（或 ..\\ai-env\\python.exe __tests__\\run_all.py 全量跑）
"""
import os
import sys

# 将 scripts 目录加入 path，以便 import timeline_solver / rules / montage_contract
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from montage_contract import (
    PREFERRED_SHOT_MISS_PENALTY,
    PREFERRED_SHOT_REWARD,
    normalize_preferred_shot,
    preferred_shot_from_label,
)
from rules.shot_pref_adherence import SCORE as SHOT_PREF_SCORE
from timeline_solver import (
    ACTION_CLASSES,
    ENTITY_CLASSES,
    _class_of_query,
    _dynamic_gate,
    _shot_of_chunk,
)


def test_preferred_shot_from_label_exact_match():
    """中文标签 → 契约英文枚举：精确等值（不做子串包含，防「中全景」被「全景」抢先）。"""
    assert preferred_shot_from_label('特写') == 'EXTREME_CLOSE'
    assert preferred_shot_from_label('近景') == 'CLOSE_SHOT'
    assert preferred_shot_from_label('中近景') == 'MEDIUM_CLOSE'
    assert preferred_shot_from_label('中景') == 'MEDIUM_SHOT'
    assert preferred_shot_from_label('中全景') == 'FULL_SHOT', "「中全景」必须精确归 FULL_SHOT"
    assert preferred_shot_from_label('全景') == 'LONG_SHOT'
    assert preferred_shot_from_label('远景') == 'EXTREME_LONG'
    assert preferred_shot_from_label('大全景') == 'EXTREME_LONG'
    # 「空镜」非景别档位、自由文本（地点）非景别 ⇒ 一律返回空（不参与门禁）
    assert preferred_shot_from_label('空镜') == ''
    assert preferred_shot_from_label('餐厅餐桌') == ''
    assert preferred_shot_from_label('') == ''
    assert preferred_shot_from_label(None) == ''
    print("✓ test_preferred_shot_from_label_exact_match: 中文标签精确归一（中全景 ≠ 全景）")


def test_normalize_preferred_shot_bi_directional():
    """双向归一：工单侧英文枚举原样保留，切片侧中文标签归一，未识别 → ''。"""
    for code in ('EXTREME_LONG', 'LONG_SHOT', 'FULL_SHOT', 'MEDIUM_SHOT',
                 'MEDIUM_CLOSE', 'CLOSE_SHOT', 'EXTREME_CLOSE'):
        assert normalize_preferred_shot(code) == code, f"英文枚举 {code} 必须原样保留"
    assert normalize_preferred_shot('近景') == 'CLOSE_SHOT'
    assert normalize_preferred_shot(' 中景 ') == 'MEDIUM_SHOT', "两侧空白须先 strip"
    assert normalize_preferred_shot('空镜') == ''
    assert normalize_preferred_shot('餐厅餐桌') == ''
    assert normalize_preferred_shot('') == ''
    print("✓ test_normalize_preferred_shot_bi_directional: 双向归一（英文原样 / 中文归一）")


def test_shot_pref_adherence_comparable_after_wiring():
    """回归锁：工单英文枚举 vs 候选中文标签必须可比（修复前裸比较 ⇒ 恒 MISS）。"""
    ctx_match = {'query': {'preferredShot': 'CLOSE_SHOT'}}
    ctx_miss = {'query': {'preferredShot': 'MEDIUM_SHOT'}}

    assert SHOT_PREF_SCORE(None, {'shotType': '近景'}, ctx_match) == PREFERRED_SHOT_REWARD, \
        "同档（CLOSE_SHOT ↔ 近景）必须给奖励，而非恒 MISS"
    assert SHOT_PREF_SCORE(None, {'shotScale': '近景'}, ctx_match) == PREFERRED_SHOT_REWARD, \
        "shotScale 与 shotType 等价"
    assert SHOT_PREF_SCORE(None, {'shotType': '近景'}, ctx_miss) == PREFERRED_SHOT_MISS_PENALTY
    # 中性放行：工单未声明 / 候选无景别 / 候选景别不可识别（空镜、自由文本）
    assert SHOT_PREF_SCORE(None, {'shotType': '近景'}, {'query': {}}) == 0.0
    assert SHOT_PREF_SCORE(None, {'shotType': ''}, ctx_match) == 0.0
    assert SHOT_PREF_SCORE(None, {'shotType': '空镜'}, ctx_match) == 0.0
    print("✓ test_shot_pref_adherence_comparable_after_wiring: 归一后贴合卡真生效")


def test_shot_of_chunk_reads_scale_fields_not_scene():
    """景别取自 shotScale / shotType；`scene` 是地点文本，仅作关键词兜底。"""
    assert _shot_of_chunk({'shotScale': '近景', 'scene': '餐厅餐桌'}) == 'CLOSE_SHOT'
    assert _shot_of_chunk({'shotType': '全景', 'scene': '机场大厅'}) == 'LONG_SHOT'
    # shotScale 为空时回落到 shotType（实测两字段各有一格为空）
    assert _shot_of_chunk({'shotScale': '', 'shotType': '中景'}) == 'MEDIUM_SHOT'
    # 两字段皆空 → 才退回 scene 关键词兜底（保留旧口径）
    assert _shot_of_chunk({'scene': '特写镜头下的手'}) == 'EXTREME_CLOSE'
    # 地点文本无景别关键词 ⇒ 中性（不误否决）
    assert _shot_of_chunk({'scene': '餐厅餐桌'}) == ''
    assert _shot_of_chunk({'shotScale': '空镜', 'scene': '电梯间门口'}) == ''
    print("✓ test_shot_of_chunk_reads_scale_fields_not_scene: 景别读 shotScale/shotType，scene 仅兜底")


def test_class_of_query_maps_free_text_to_class_name():
    """自由文本 → 类别名（与切片侧同一张表，两侧可比）。"""
    assert _class_of_query('行囊', ENTITY_CLASSES) == '行李'
    assert _class_of_query('递给对方', ACTION_CLASSES) == '递物'
    assert _class_of_query('递物', ACTION_CLASSES) == '递物', "已是类别名时须原样保留"
    assert _class_of_query('', ENTITY_CLASSES) == ''
    assert _class_of_query('  ', ACTION_CLASSES) == ''
    assert _class_of_query('天色渐暗', ACTION_CLASSES) == '', "未命中返回空（不参与门禁）"
    print("✓ test_class_of_query_maps_free_text_to_class_name: 自由文本归一到同表类别名")


def test_dynamic_gate_l0_reachable_with_free_text_query():
    """L0 可达性：query 三探测项为「工单原始形态」（英文枚举 + 自由文本）时仍能全满足。

    修复前：`_shot_of_chunk` 恒 ''（从 scene 找景别）、`_act_of/_prop_of` 与自由文本恒不等
    ⇒ L0 恒空、逐级空降；本用例即该缺陷的机器化回归锁。
    """
    video_chunks = [
        {'description': '他递给对方一个行囊', 'shotScale': '近景', 'scene': '机场大厅'},
        {'description': '空荡的走廊', 'shotScale': '全景', 'scene': '走廊'},
    ]
    candidates = [0, 1]

    pool, level, reason = _dynamic_gate('递给对方', '行囊', 'CLOSE_SHOT', 3, candidates, video_chunks)
    assert (pool, level, reason) == ([0], 0, ''), \
        f"三探测项全可满足应 L0 命中切片0，实际 pool={pool} level={level} reason={reason!r}"

    # 景别不满足 → 逐级放宽到 L3（同段任意），且这是「允许的最低级」内的合法降级
    pool2, level2, reason2 = _dynamic_gate('递给对方', '行囊', 'EXTREME_CLOSE', 3, candidates, video_chunks)
    assert level2 == 3 and reason2 == 'preferredShot', \
        f"景别不可满足应降级到 L3(preferredShot)，实际 level={level2} reason={reason2!r}"
    assert sorted(pool2) == candidates, "L3 应回落到同段任意候选"

    # 探测项全空（β 过渡）→ 无动态硬卡，原样直通
    pool3, level3, reason3 = _dynamic_gate('', '', '', 3, candidates, video_chunks)
    assert (pool3, level3, reason3) == (candidates, 0, ''), "无探测项时不得收窄候选池"
    print("✓ test_dynamic_gate_l0_reachable_with_free_text_query: L0 可达 + 降级链行为正确")


if __name__ == '__main__':
    print("=" * 60)
    print("🎬 步骤3→5 接线 · 两侧词表归一锁")
    print("=" * 60)
    test_preferred_shot_from_label_exact_match()
    test_normalize_preferred_shot_bi_directional()
    test_shot_pref_adherence_comparable_after_wiring()
    test_shot_of_chunk_reads_scale_fields_not_scene()
    test_class_of_query_maps_free_text_to_class_name()
    test_dynamic_gate_l0_reachable_with_free_text_query()
    print("=" * 60)
    print("全部通过 ✅")