# -*- coding: utf-8 -*-
"""
test_drop_empty_desc.py —— 空描述切片剔除（2026-10-22）

背景：705 切片中 58 个 `description` 为空（8.2%），多为片头集数字幕/黑场/字卡。它们没有视觉语义，
BGE 只能编码空串 ⇒ 语义分是噪声却仍能中标（实测 chunk_322 被 seg_8 / seg_21_sub_2 选中，
即「报第多少集」画面）。Node 侧清洗只覆盖 1134 段，段退场后真正参选的 705 切片没有清洗。

不变量（Q1）：**仅当剔除后仍有候选才剔除**；整池皆空描述 ⇒ 原样保留，不制造空中池。

覆盖点：
  1. 池内混合：空描述候选被剔除，有描述候选保留。
  2. 整池皆空描述：原样保留（不产生空段）。
  3. 开关 off：逐字节回退（空描述候选保留）。

运行方式：
  cd resources/scripts
  ..\\ai-env\\python.exe __tests__\\test_drop_empty_desc.py
  ..\\ai-env\\python.exe __tests__\\run_all.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from build_context import build_req_context

_SWITCH = 'ZENTECT_KM_DROP_EMPTY_DESC'


def _chunk(cid: str, desc: str) -> dict:
    return {'id': cid, 'description': desc, 'shotType': '中景', 'scene': '室内',
            'startMs': 0.0, 'endMs': 3000.0, 'parentChunkId': 'scene_0'}


def _req(cands, chunks) -> dict:
    return {
        'projectId': 'proj_test',
        'queries': [{'shotId': 's1', 'text': '文案', 'visualIntent': '画面',
                     'audioDurationMs': 2000.0, 'segmentId': 0}],
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


def test_drop_empty_in_mixed_pool():
    """混合池：空描述被剔除，有描述保留。"""
    chunks = [_chunk('c1', '女子站立微笑'), _chunk('c2', '')]
    ctx = _with_envs({_SWITCH: None}, lambda: build_req_context(_req(['c1', 'c2'], chunks)))
    assert ctx.cands_by_shotid['s1'] == ['c1'], f"空描述 c2 应被剔除：{ctx.cands_by_shotid['s1']}"
    print("✓ test_drop_empty_in_mixed_pool: 空描述候选被剔除")


def test_all_empty_pool_kept():
    """整池皆空描述：原样保留（不制造空中池）。"""
    chunks = [_chunk('c2', ''), _chunk('c3', '  ')]
    ctx = _with_envs({_SWITCH: None}, lambda: build_req_context(_req(['c2', 'c3'], chunks)))
    assert ctx.cands_by_shotid['s1'] == ['c2', 'c3'], \
        f"整池皆空描述时必须原样保留：{ctx.cands_by_shotid['s1']}"
    print("✓ test_all_empty_pool_kept: 整池皆空不造空中池")


def test_switch_off_keeps_all():
    """开关 off：逐字节回退，空描述候选保留。"""
    chunks = [_chunk('c1', '女子站立微笑'), _chunk('c2', '')]
    ctx = _with_envs({_SWITCH: '0'}, lambda: build_req_context(_req(['c1', 'c2'], chunks)))
    assert ctx.cands_by_shotid['s1'] == ['c1', 'c2'], \
        f"开关 off 不得剔除：{ctx.cands_by_shotid['s1']}"
    print("✓ test_switch_off_keeps_all: 开关 off 逐字节回退")


if __name__ == '__main__':
    print("=" * 60)
    print("🧹 空描述切片剔除验证")
    print("=" * 60)
    test_drop_empty_in_mixed_pool()
    test_all_empty_pool_kept()
    test_switch_off_keeps_all()
    print("=" * 60)
    print("全部通过 ✅")
