# -*- coding: utf-8 -*-
"""
test_abstract_wide.py —— 抽象句宽景硬过滤（B1，2026-10-22）

背景：方案 B 让 S2 对抽象/评论句声明 LONG_SHOT，但 daemon 里景别只是 ±0.04 软阻尼。
实测扩池 60/48 后宽景已在池中（seg_2 全景 6、seg_4 全景 8、seg_21 全景 2），5 句仍只有
1 句落宽景 ⇒ 软阻尼压不过语义分差，改结构性剔除。

不变量（Q1）：**仅当池内存在宽景候选才收紧**；无宽景 ⇒ 原样保留，不制造空池。
仅作用于 `isAbstractNarration=true` 的句，常规叙事句逐字节不变。

覆盖点：
  1. 抽象句 + 混合池：非宽景被剔除，宽景保留。
  2. 抽象句 + 无宽景池：原样保留（不制造空池）。
  3. 非抽象句：不收紧（行为不变）。
  4. 开关 off：逐字节回退。
  5. P4 空镜派生：materialType / isAbstractCapable 由「宽景 + 无主体」派生。
  6. P4 空镜优先：池内有空镜候选 ⇒ 只留空镜（压过 B1 宽景）。
  7. P4 派生开关 off：回退 B1 宽景口径。

运行方式：
  cd resources/scripts
  ..\\ai-env\\python.exe __tests__\\test_abstract_wide.py
  ..\\ai-env\\python.exe __tests__\\run_all.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from build_context import build_chunk_index, build_req_context

_SWITCH = 'ZENTECT_KM_ABSTRACT_WIDE'
_DERIVE = 'ZENTECT_KM_EMPTY_DERIVE'


def _chunk(cid: str, scale: str, **kw) -> dict:
    base = {'id': cid, 'description': f'{scale}画面', 'shotType': scale, 'shotScale': scale,
            'scene': '室内', 'startMs': 0.0, 'endMs': 3000.0, 'parentChunkId': 'scene_0'}
    base.update(kw)
    return base


def _req(cands, chunks, abstract: bool) -> dict:
    return {
        'projectId': 'proj_test',
        'queries': [{'shotId': 's1', 'text': '誓言经不起考验', 'visualIntent': '',
                     'audioDurationMs': 2000.0, 'segmentId': 0,
                     'isAbstractNarration': abstract}],
        'videoChunks': chunks,
        'candidateIds': {'s1': cands},
        'segments': [],
        'storyboardOrders': [],
    }


def _with_envs(mapping, fn):
    saved = {k: os.environ.get(k) for k in mapping}
    for k, v in mapping.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    try:
        return fn()
    finally:
        for k, old in saved.items():
            if old is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = old


def test_abstract_tightens_to_wide():
    """抽象句 + 混合池：只留宽景（全景/远景/空镜）。"""
    chunks = [_chunk('c1', '近景'), _chunk('c2', '特写'),
              _chunk('c3', '全景'), _chunk('c4', '远景'), _chunk('c5', '空镜')]
    ctx = _with_envs({_SWITCH: None},
                     lambda: build_req_context(_req(['c1', 'c2', 'c3', 'c4', 'c5'], chunks, True)))
    assert ctx.cands_by_shotid['s1'] == ['c3', 'c4', 'c5'], \
        f"抽象句应收紧到宽景：{ctx.cands_by_shotid['s1']}"
    print("✓ test_abstract_tightens_to_wide: 抽象句非宽景被剔除")


def test_abstract_no_wide_keeps_pool():
    """抽象句 + 无宽景池：原样保留（不制造空池）。"""
    chunks = [_chunk('c1', '近景'), _chunk('c2', '中景')]
    ctx = _with_envs({_SWITCH: None},
                     lambda: build_req_context(_req(['c1', 'c2'], chunks, True)))
    assert ctx.cands_by_shotid['s1'] == ['c1', 'c2'], \
        f"池内无宽景时必须原样保留：{ctx.cands_by_shotid['s1']}"
    print("✓ test_abstract_no_wide_keeps_pool: 无宽景不造空池")


def test_non_abstract_untouched():
    """非抽象句：不收紧（逐字节不变）。"""
    chunks = [_chunk('c1', '近景'), _chunk('c2', '全景')]
    ctx = _with_envs({_SWITCH: None},
                     lambda: build_req_context(_req(['c1', 'c2'], chunks, False)))
    assert ctx.cands_by_shotid['s1'] == ['c1', 'c2'], \
        f"非抽象句不得收紧：{ctx.cands_by_shotid['s1']}"
    print("✓ test_non_abstract_untouched: 常规句行为不变")


def test_switch_off_keeps_all():
    """开关 off：逐字节回退。"""
    chunks = [_chunk('c1', '近景'), _chunk('c2', '全景')]
    ctx = _with_envs({_SWITCH: '0'},
                     lambda: build_req_context(_req(['c1', 'c2'], chunks, True)))
    assert ctx.cands_by_shotid['s1'] == ['c1', 'c2'], \
        f"开关 off 不得收紧：{ctx.cands_by_shotid['s1']}"
    print("✓ test_switch_off_keeps_all: 开关 off 逐字节回退")


def test_derive_material_fields():
    """P4 派生：宽景且无主体 ⇒ empty/isAbstractCapable；有人物或非宽景 ⇒ real。"""
    index = build_chunk_index([
        _chunk('c1', '全景'),                                        # 无主体宽景 → 空镜
        _chunk('c2', '远景', primarySubject='MULTIPLE'),             # 哨兵视同无主体 → 空镜
        _chunk('c3', '全景', characters=['林夏'], primarySubject='林夏'),  # 有人物 → 实拍
        _chunk('c4', '近景'),                                        # 非宽景 → 实拍
        _chunk('c5', '特写', materialType='empty'),                  # 显式声明只升不降
        _chunk('c6', '全景', materialType='effect'),                 # 特效不重算
    ])
    assert index['c1']['materialType'] == 'empty' and index['c1']['isAbstractCapable'] is True
    assert index['c2']['isAbstractCapable'] is True
    assert index['c3']['materialType'] == 'real' and index['c3']['isAbstractCapable'] is False
    assert index['c4']['materialType'] == 'real' and index['c4']['isAbstractCapable'] is False
    assert index['c5']['materialType'] == 'empty' and index['c5']['isAbstractCapable'] is True
    assert index['c6']['materialType'] == 'effect' and index['c6']['isAbstractCapable'] is False
    print("✓ test_derive_material_fields: 空镜派生口径正确")


def test_empty_preferred_over_wide():
    """P4 空镜优先：池内 ≥2 个空镜时，只留空镜（压过其他宽景）。"""
    chunks = [_chunk('c1', '近景'),
              _chunk('c2', '全景', characters=['林夏'], primarySubject='林夏'),
              _chunk('c3', '全景'),
              _chunk('c4', '远景', characters=['林夏'], primarySubject='林夏'),
              _chunk('c5', '远景')]
    ctx = _with_envs({_SWITCH: None, _DERIVE: None},
                     lambda: build_req_context(_req(['c1', 'c2', 'c3', 'c4', 'c5'], chunks, True)))
    assert ctx.cands_by_shotid['s1'] == ['c3', 'c5'], \
        f"抽象句应只留空镜候选：{ctx.cands_by_shotid['s1']}"
    print("✓ test_empty_preferred_over_wide: 空镜优先压过宽景")


def test_single_empty_falls_back_wide():
    """P4 仅 1 个空镜时不独占：回退宽景，避免整段重复同一片。"""
    chunks = [_chunk('c1', '近景'),
              _chunk('c2', '全景', characters=['林夏'], primarySubject='林夏'),
              _chunk('c3', '全景'),
              _chunk('c4', '远景', characters=['林夏'], primarySubject='林夏')]
    ctx = _with_envs({_SWITCH: None, _DERIVE: None},
                     lambda: build_req_context(_req(['c1', 'c2', 'c3', 'c4'], chunks, True)))
    assert ctx.cands_by_shotid['s1'] == ['c2', 'c3', 'c4'], \
        f"仅 1 个空镜应回退宽景：{ctx.cands_by_shotid['s1']}"
    print("✓ test_single_empty_falls_back_wide: 单空镜不独占")


def test_derive_off_falls_back_wide():
    """P4 派生 off：无 isAbstractCapable 信号 ⇒ 回退 B1 宽景口径。"""
    chunks = [_chunk('c1', '近景'),
              _chunk('c2', '全景', characters=['林夏'], primarySubject='林夏'),
              _chunk('c3', '全景'),
              _chunk('c4', '远景', characters=['林夏'], primarySubject='林夏')]
    ctx = _with_envs({_SWITCH: None, _DERIVE: '0'},
                     lambda: build_req_context(_req(['c1', 'c2', 'c3', 'c4'], chunks, True)))
    assert ctx.cands_by_shotid['s1'] == ['c2', 'c3', 'c4'], \
        f"派生 off 应回退宽景：{ctx.cands_by_shotid['s1']}"
    print("✓ test_derive_off_falls_back_wide: 派生开关 off 回退 B1")


if __name__ == '__main__':
    print("=" * 60)
    print("🎬 抽象句宽景硬过滤 / 空镜优先验证")
    print("=" * 60)
    test_abstract_tightens_to_wide()
    test_abstract_no_wide_keeps_pool()
    test_non_abstract_untouched()
    test_switch_off_keeps_all()
    test_derive_material_fields()
    test_empty_preferred_over_wide()
    test_single_empty_falls_back_wide()
    test_derive_off_falls_back_wide()
    print("=" * 60)
    print("全部通过 ✅")
