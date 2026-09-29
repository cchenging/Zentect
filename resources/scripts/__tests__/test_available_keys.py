"""
test_available_keys.py — 📊 步骤5 新引擎 · 点亮判据与覆盖率采集（① 单测骨架）

锁定 ① 字段侧的两件事（守「点亮 ≠ 可信」在日志里可见的前提）：

  1. `_key_value_usable` 单值判据：str.strip 非空 / 数值 > 0 / 列表元组非空 / is True；None 不算
  2. `_collect_available_keys` 宽粒度：任一**样本**满足即该字段可用（不因个别切片缺字段休眠整卡）
  3. `_collect_key_coverage` 分母分离：切片字段分母 = chunk 条数、句级字段分母 = queries 条数，
     两者**不可混算成一个百分比**
  4. 两份判据一致性：覆盖率命中数 > 0 ⟺ 该键进 available_keys（杜绝双份口径漂移）
  5. `build_chunk_index` 别名补空：生产者键名（shotType/scene/cameraMovement/colorHistogram）
     归一为契约键名后，此前被闸门关死的 4 张卡点亮；契约键非空时禁止被覆盖
  6. 补丁18 哨兵（MULTIPLE/EMPTY）与空同口径：不参与稀有料签名（不与"真·稀有"互相撞签）

运行方式：cd resources/scripts ; ..\\ai-env\\python.exe __tests__\\test_available_keys.py
（或 python -m __tests__.test_available_keys；pytest 亦可收集）
"""
import sys
import os

# 将 scripts 目录加入 path，以便 import timeline_solver
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from timeline_solver import _key_value_usable, _collect_available_keys, _collect_key_coverage


def test_key_value_usable_matrix():
    """单值判据矩阵：0 视为未回填、字符串 strip、布尔 is True、结构化字段有值即算可用。"""
    assert _key_value_usable('女主') is True
    assert _key_value_usable('   ') is False, "空白串必须视为未回填"
    assert _key_value_usable(3.5) is True
    assert _key_value_usable(0) is False, "0 视为未回填（契约缺省值不算点亮依据）"
    assert _key_value_usable(0.0) is False
    assert _key_value_usable(['女主']) is True
    assert _key_value_usable([]) is False
    assert _key_value_usable(True) is True
    assert _key_value_usable(False) is False, "哨兵必须 is True 才算回填"
    assert _key_value_usable(None) is False
    assert _key_value_usable({'k': 1}) is True, "非数值型（dict）有值即算可用"
    print("✓ test_key_value_usable_matrix: 单值判据矩阵正确")


def test_collect_available_keys_wide_granularity():
    """宽粒度：只要**一片**切片带 primarySubject，该字段就整轮可用（个别缺失靠卡内中性放行守护）。"""
    chunks = [
        {'id': 'c1', 'primarySubject': '女主', 'shotScale': ''},
        {'id': 'c2', 'primarySubject': '', 'shotScale': ''},
        {'id': 'c3'},
    ]
    queries = [{'shotId': 's1', 'silenceGapMs': 0, 'characters': []}]
    got = _collect_available_keys(chunks, queries)

    assert 'primarySubject' in got, "任一非空即视为可用（宽粒度）"
    assert 'shotScale' not in got, "全空字段不得进入可用集"
    assert 'silenceGapMs' not in got and 'characters' not in got, "0/空列表视为未回填"
    print("✓ test_collect_available_keys_wide_granularity: 宽粒度判据正确")


def test_collect_key_coverage_denominators_separate():
    """分母分离：切片字段分母 = chunk 条数，句级字段分母 = queries 条数，且计数正确。"""
    chunks = [
        {'id': 'c1', 'primarySubject': '女主', 'shotScale': ''},
        {'id': 'c2', 'primarySubject': '', 'shotScale': '近景'},
    ]
    queries = [
        {'shotId': 's1', 'silenceGapMs': 300, 'characters': ['女主']},
        {'shotId': 's2', 'silenceGapMs': 0, 'characters': []},
        {'shotId': 's3', 'silenceGapMs': 120, 'characters': ['男配']},
    ]
    cov = _collect_key_coverage(chunks, queries,
                                ('primarySubject', 'shotScale', 'silenceGapMs', 'characters'))

    assert cov['primarySubject'] == (1, 2), f"切片字段分母应为 chunk 数 2，实际 {cov['primarySubject']}"
    assert cov['shotScale'] == (1, 2)
    assert cov['silenceGapMs'] == (2, 3), f"句级字段分母应为 queries 数 3，实际 {cov['silenceGapMs']}"
    assert cov['characters'] == (2, 3)
    # 分母不得被跨池混算：切片 2 + 句 3 = 5 是错的。
    assert cov['primarySubject'][1] != 5 and cov['silenceGapMs'][1] != 5, "切片/句分母不得混算"
    print("✓ test_collect_key_coverage_denominators_separate: 分母分离与计数正确")


def test_coverage_consistent_with_available_keys():
    """判据一致性：某键覆盖率命中 > 0 ⟺ 该键进 available_keys（单一口径的机器化保证）。"""
    chunks = [{'id': 'c1', 'primarySubject': '女主'}, {'id': 'c2', 'primarySubject': None}]
    queries = [{'shotId': 's1', 'characters': []}, {'shotId': 's2', 'characters': ['男配']}]
    keys = ('primarySubject', 'characters', 'shotScale')

    avail = _collect_available_keys(chunks, queries)
    cov = _collect_key_coverage(chunks, queries, keys)

    for k in keys:
        hit = cov[k][0]
        assert (hit > 0) == (k in avail), f"{k} 的覆盖率判据与可用键判据不一致"
    assert cov['shotScale'] == (0, 0), "未出现的键应补 (0, 0) 占位，不得虚增分母"
    print("✓ test_coverage_consistent_with_available_keys: 两份判据口径一致")


def test_coverage_keys_none_covers_all_seen_keys():
    """keys=None：统计两个池里出现过的全部键（用于全量诊断，不遗漏任何字段）。"""
    chunks = [{'id': 'c1', 'camera': '手持'}]
    queries = [{'shotId': 's1', 'sceneGroup': 'g1'}]
    cov = _collect_key_coverage(chunks, queries)
    assert set(cov) == {'id', 'camera', 'shotId', 'sceneGroup'}
    assert cov['camera'] == (1, 1) and cov['sceneGroup'] == (1, 1)
    print("✓ test_coverage_keys_none_covers_all_seen_keys: 全量键统计正确")


def test_chunk_alias_normalization_lights_gate():
    """别名补空（A 类键名修复）：生产者键名归一为契约键名后，4 张被闸门关死的卡点亮。

    实测背景：真实 payload 里 shotScale/location/camera/colorHist 命中率全 0%，而
    shotType/scene/cameraMovement/colorHistogram 全有 —— 卡内 SCORE 早已写了别名容错，
    唯独 availability 闸门读裸契约键名把卡关死。本测钉住「补空后闸门开」与「不覆盖真实值」。
    """
    from build_context import build_chunk_index
    from rules import partition_rule_cards

    raw = [{
        'id': 'c1', 'shotType': '全景', 'scene': '室内采访现场',
        'cameraMovement': '固定', 'colorHistogram': [0.5, 0.5],
        'startMs': 1000.0, 'parentChunkId': 'p1', 'motionScore': 0.3,
    }]
    c = build_chunk_index(raw)['c1']

    assert c['shotScale'] == '全景' and c['camera'] == '固定', "契约键应由生产者键补空"
    assert c['location'] == '室内采访现场' and c['colorHist'] == [0.5, 0.5]
    assert c['shotType'] == '全景' and c['cameraMovement'] == '固定', \
        "生产者键必须原样保留（_is_reusable_broll / 稀有料签名仍读 shotType）"

    active, _dormant = partition_rule_cards(_collect_available_keys([c], []))
    names = {d['name'] for d in active}
    for n in ('jump_cut', 'camera_continuity', 'scale_rhythm', 'color_continuity', 'env_medium_lock'):
        assert n in names, f"{n} 应因别名补空点亮，实际休眠"

    # 契约键已有真实值时，生产者键不得覆盖它（补空 ≠ 改写）。
    c2 = build_chunk_index([{'id': 'c2', 'shotScale': '近景', 'shotType': '全景'}])['c2']
    assert c2['shotScale'] == '近景', "契约键非空时禁止被生产者键覆盖"
    print("✓ test_chunk_alias_normalization_lights_gate: 别名补空点亮闸门且不覆盖真实值")


def test_primary_subject_sentinel_excluded_from_hero_signature():
    """补丁18 哨兵不参与稀有料签名（评审稿 §13.1「空/全景豁免焦点门禁」的落点）。

    两条不同哨兵的空镜/多人戏若把哨兵写进签名，会因签名不同而各自被判"全局唯一"
    （假阳性：空镜被当成稀有料锁死）；剔除哨兵后两者同签名、互相抵消，回归正确。
    真·稀有切片（唯一道具/景别）仍须点亮。
    """
    from build_context import _flag_critical_hero_assets

    chunks = [
        {'id': 'c1', 'primarySubject': 'MULTIPLE', 'keyProps': '怀表', 'shotType': '特写'},
        {'id': 'c2', 'primarySubject': 'EMPTY', 'keyProps': '怀表', 'shotType': '特写'},
    ]
    _flag_critical_hero_assets(chunks)
    assert chunks[0]['isCriticalHeroAsset'] is False and chunks[1]['isCriticalHeroAsset'] is False, \
        "哨兵须按空处理：两条同签名应互相抵消，不得因哨兵字面不同各自判唯一"

    solo = [{'id': 'c3', 'primarySubject': 'EMPTY', 'keyProps': '孤品怀表', 'shotType': '特写'}]
    _flag_critical_hero_assets(solo)
    assert solo[0]['isCriticalHeroAsset'] is True, "剔除哨兵后签名仍全局唯一 → 必须点亮"

    named = [{'id': 'c4', 'primarySubject': '女主', 'keyProps': '怀表', 'shotType': '特写'}]
    _flag_critical_hero_assets(named)
    assert named[0]['isCriticalHeroAsset'] is True, "角色名非哨兵，正常参与签名"
    print("✓ test_primary_subject_sentinel_excluded_from_hero_signature: 哨兵不入稀有料签名")


def test_coverage_double_pool_key_not_summed():
    """回归（2026-09-25 分母口径缺陷）：两池皆有的键**只归切片池**计分母，绝不跨池相加。

    修前实测 `characters=79%(555/706)`，706 = 605(chunks) + 101(queries) ⇒ 分子分母都跨池混算，
    与「切片/句分母不可混算」自相矛盾且量纲不同（切片=实体观测，句级=需求期望）。
    """
    chunks = [{'id': 'c1', 'characters': ['女主']}, {'id': 'c2', 'characters': []}]
    queries = [
        {'shotId': 's1', 'characters': ['女主']},
        {'shotId': 's2', 'characters': ['男配']},
        {'shotId': 's3', 'characters': []},
    ]
    cov = _collect_key_coverage(chunks, queries, ('characters',))
    # 切片池 2 条（1 条非空）+ 句池 3 条 ⇒ 修前会是 (4, 5)（跨池相加）；修后只认切片池
    assert cov['characters'] == (1, 2), f"双池键只归切片池，实际 {cov['characters']}"
    print("✓ test_coverage_double_pool_key_not_summed: 双池键不跨池相加")


def test_coverage_noncontract_key_denominator_is_pool_size():
    """回归（2026-09-25 分母口径缺陷）：非契约键分母 = **池大小**，非「含键样本数」。

    修前 `weatherEnv=100%(477/477)` 读起来像全池覆盖，实为 477/605=79%（分母只数含键样本）。
    """
    chunks = [
        {'id': 'c1', 'weatherEnv': '晴'},
        {'id': 'c2', 'weatherEnv': '雨'},
        {'id': 'c3'},  # 生产者未回填该键
        {'id': 'c4'},
    ]
    cov = _collect_key_coverage(chunks, [], ('weatherEnv', 'keyProps'))
    assert cov['weatherEnv'] == (2, 4), f"非契约键分母应为池大小 4，实际 {cov['weatherEnv']}"
    assert cov['keyProps'] == (0, 0), "全池无该键 ⇒ n/a(0/0) 占位，不虚增分母"
    print("✓ test_coverage_noncontract_key_denominator_is_pool_size: 分母=池大小（不虚高）")


if __name__ == "__main__":
    print("=" * 60)
    print("📊 步骤5 新引擎 · 点亮判据与覆盖率采集（① 单测骨架）")
    print("=" * 60)
    test_key_value_usable_matrix()
    test_collect_available_keys_wide_granularity()
    test_collect_key_coverage_denominators_separate()
    test_coverage_consistent_with_available_keys()
    test_coverage_keys_none_covers_all_seen_keys()
    test_coverage_double_pool_key_not_summed()
    test_coverage_noncontract_key_denominator_is_pool_size()
    test_chunk_alias_normalization_lights_gate()
    test_primary_subject_sentinel_excluded_from_hero_signature()
    print("=" * 60)
    print("全部通过 ✅")