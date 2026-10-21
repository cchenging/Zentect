# -*- coding: utf-8 -*-
"""
test_pool_dump.py —— 候选池快照开关（取证设施；2026-10-21）

目的：回答「选片差是池里没有，还是排序选错」。开关 `ZENTECT_KM_POOL_DUMP`（缺省 off）时，
把每句真实候选池 + 切片属性落盘；与最终 matchResults 按 shotId 关联即可离线量化召回/排名。

覆盖点：
  1. 开关 on：落盘 JSON，含 queries/candidateIds/chunks 属性，poolSource 标注来源。
  2. 开关 off：不产生文件（逐字节零行为变化）。
  3. 无 candidateIds 声明：回退全池，poolSource='all' 且候选=全部切片。

运行方式：
  cd resources/scripts
  ..\\ai-env\\python.exe __tests__\\test_pool_dump.py
  ..\\ai-env\\python.exe __tests__\\run_all.py
"""
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from build_context import build_req_context

_SWITCH = 'ZENTECT_KM_POOL_DUMP'
_DIR = 'ZENTECT_KM_POOL_DUMP_DIR'


def _chunk(cid: str, desc: str, shot: str) -> dict:
    return {'id': cid, 'description': desc, 'shotType': shot, 'scene': '室内客厅',
            'primarySubject': '女子', 'characters': ['女子'], 'emotion': '平静',
            'startMs': 0.0, 'endMs': 3000.0, 'parentChunkId': 'scene_0', 'motionScore': 0.2}


def _req(with_candidate_ids: bool) -> dict:
    req = {
        'projectId': 'proj_test',
        'queries': [{'shotId': 's1', 'text': '文案', 'visualIntent': '画面',
                     'audioDurationMs': 2000.0, 'segmentId': 0}],
        'videoChunks': [_chunk('c1', '女子站立微笑', '近景'), _chunk('c2', '城市夜景车流', '全景')],
        'segments': [],
        'storyboardOrders': [],
    }
    if with_candidate_ids:
        req['candidateIds'] = {'s1': ['c1']}
    return req


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


def _files(d: str):
    return [f for f in os.listdir(d) if f.startswith('pool-')]


def test_pool_dump_on_writes_snapshot():
    """开关 on：落盘快照，字段与来源标记齐全。"""
    d = tempfile.mkdtemp(prefix='zt-pool-')
    _with_envs({_SWITCH: 'on', _DIR: d}, lambda: build_req_context(_req(True)))
    files = _files(d)
    assert len(files) == 1, f'应产出 1 个快照文件，实际 {files}'
    data = json.load(open(os.path.join(d, files[0]), encoding='utf-8'))
    assert data['projectId'] == 'proj_test'
    q = data['queries'][0]
    assert q['candidateIds'] == ['c1'], f"候选池应取 candidateIds 声明：{q}"
    assert q['poolSource'] == 'candidateIds', f"来源标记错误：{q['poolSource']}"
    assert q['preferredShot'] == '' and q['isAbstractNarration'] is False
    assert data['chunks']['c2']['shotType'] == '全景', '切片属性应随快照落盘'
    assert data['chunks']['c1']['description'] == '女子站立微笑'
    print("✓ test_pool_dump_on_writes_snapshot: 快照落盘且字段齐全")


def test_pool_dump_off_no_file():
    """开关 off：不产生任何文件（零行为变化）。"""
    d = tempfile.mkdtemp(prefix='zt-pool-')
    _with_envs({_SWITCH: '0', _DIR: d}, lambda: build_req_context(_req(True)))
    assert not _files(d), f'开关 off 不得落盘，实际 {_files(d)}'
    print("✓ test_pool_dump_off_no_file: 开关 off 零落盘")


def test_pool_dump_fallback_all_pool():
    """无 candidateIds 声明：回退全池，来源标 all。"""
    d = tempfile.mkdtemp(prefix='zt-pool-')
    _with_envs({_SWITCH: 'on', _DIR: d}, lambda: build_req_context(_req(False)))
    data = json.load(open(os.path.join(d, _files(d)[0]), encoding='utf-8'))
    q = data['queries'][0]
    assert sorted(q['candidateIds']) == ['c1', 'c2'], f"无声明时应回退全池：{q['candidateIds']}"
    assert q['poolSource'] == 'all', f"来源应为 all：{q['poolSource']}"
    print("✓ test_pool_dump_fallback_all_pool: 无声明回退全池")


if __name__ == '__main__':
    print("=" * 60)
    print("🗂 候选池快照开关验证")
    print("=" * 60)
    test_pool_dump_on_writes_snapshot()
    test_pool_dump_off_no_file()
    test_pool_dump_fallback_all_pool()
    print("=" * 60)
    print("全部通过 ✅")
