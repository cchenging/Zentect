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

运行方式：
  cd resources/scripts
  ..\\ai-env\\python.exe __tests__\\test_abstract_wide.py
  ..\\ai-env\\python.exe __tests__\\run_all.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from build_context import build_req_context

_SWITCH = 'ZENTECT_KM_ABSTRACT_WIDE'


def _chunk(cid: str, scale: str) -> dict:
    return {'id': cid, 'description': f'{scale}画面', 'shotType': scale, 'shotScale': scale,
            'scene': '室内', 'startMs': 0.0, 'endMs': 3000.0, 'parentChunkId': 'scene_0'}


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


if __name__ == '__main__':
    print("=" * 60)
    print("🎬 抽象句宽景硬过滤验证")
    print("=" * 60)
    test_abstract_tightens_to_wide()
    test_abstract_no_wide_keeps_pool()
    test_non_abstract_untouched()
    test_switch_off_keeps_all()
    print("=" * 60)
    print("全部通过 ✅")
