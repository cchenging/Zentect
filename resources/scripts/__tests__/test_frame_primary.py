# -*- coding: utf-8 -*-
"""
test_frame_primary.py —— 🧩 帧描述唯一主力（方案 D；2026-10-21）

方案 D 把「帧描述」升为打分侧唯一主力，取代「切片描述」；切片描述仅作「无帧证据候选」的兜底。
与方案 B 的差异点（关键行为契约）：
  - 方案 B（ZENTECT_KM_FRAME_PRIMARY=off）：`sem = max(切片, 帧)` —— 只升不降，帧描述弱时不动作。
  - 方案 D（缺省 on）：`sem = 帧描述` —— **直接取代**，即使帧描述比切片描述更弱也以帧为准。
    理由：切片描述是「高频 top8 聚合」，其高相似度可能来自聚合放大、并非某帧真实贴合；
    帧描述才是逐帧真实瞬间。方案 D 阻断「切片描述虚高」对择片的干扰。

开关 `ZENTECT_KM_FRAME_PRIMARY`（缺省 on）；`ZENTECT_KM_FRAME_DESC` 仍为帧证据总开关。

覆盖点：
  1. 帧描述比切片描述更弱 ⇒ 方案 D 仍以帧取代（切片虚高被压掉），排名翻转；off 回退 max（不降）。
  2. 无 frame_hints ⇒ 切片描述兜底，on/off 逐字节一致（零行为变化）。
  3. 帧描述强于切片描述 ⇒ 取代生效（帧语义兑现），off 时退化为 max（同向，一致性 sanity）。

运行方式：
  cd resources/scripts
  ..\\ai-env\\python.exe __tests__\\test_frame_primary.py   # 单文件直跑
  ..\\ai-env\\python.exe __tests__\\run_all.py               # L1 总入口（自动收集本文件）
"""
import math
import os
import sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import match_cost
from match_cost import build_match_cost

# 情绪/角色权重显式置 0（测试里二者恒中性 0.5，留着会被动态让渡并入语义，断言闭式失准）
W = dict(sem=0.78, emotion=0.0, duration=0.22, role=0.0)

_QUERY_TEXT = 'Q文案'
_VEC_RAW = {}


def _vec(cos: float) -> np.ndarray:
    """构造与 [1,0] 夹角余弦为 cos 的单位向量（2 维，便于闭式核对余弦）。"""
    return np.array([cos, math.sqrt(max(0.0, 1.0 - cos * cos))], dtype=np.float32)


def _setup(query_cos_map: dict) -> None:
    """装配向量表：{文本: 目标余弦}；query 文本恒取 [1,0]。"""
    _VEC_RAW.clear()
    _VEC_RAW[_QUERY_TEXT] = np.array([1.0, 0.0], dtype=np.float32)
    for t, c in query_cos_map.items():
        _VEC_RAW[t] = _vec(c)


def _fake_encode_texts(texts, batch_size=32, max_length=512):
    """测试替身：返回固定向量矩阵（行=文本，L2 归一化，模拟 BGE 编码结果）。"""
    memo = {}
    for t, v in _VEC_RAW.items():
        n = np.linalg.norm(v) + 1e-12
        memo[t] = v / n
    return np.stack([memo.get(t, np.zeros(2, np.float32)) for t in texts]).astype(np.float32)


def _patch_encode():
    """monkeypatch match_cost.AIModels.encode_texts 为 fake；返回恢复函数。"""
    orig = match_cost.AIModels.encode_texts
    match_cost.AIModels.encode_texts = staticmethod(_fake_encode_texts)
    return lambda: setattr(match_cost.AIModels, 'encode_texts', orig)


def _with_envs(mapping, fn):
    """在指定一组 env 取值下执行 fn（执行后逐个还原，避免测试间互相污染）。"""
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


def _chunk(cid: str, desc: str) -> dict:
    """造候选切片：时长/情绪/角色三维同值（同 0~3000ms、空 emotion、无 charIds）。"""
    return {'id': cid, 'description': desc, 'parentChunkId': cid, 'filePath': 'v.mp4',
            'startMs': 0.0, 'endMs': 3000.0, 'emotion': '', 'charIds': [],
            'charGrain': 'ok', 'shotScale': ''}


# 语义量纲对齐 off（闭式可控）；属性决胜带 off；FRAME_PRIMARY 缺省 on（方案 D）。
# 开关 off/缺省值不显式写 = 走 _read_frame_primary 缺省 on。
_BASE = {'ZENTECT_KM_SEM_NORM': 'off', 'ZENTECT_KM_SUPPLY_DUR': None,
         'ZENTECT_KM_DESC_AUG': None, 'ZENTECT_KM_DUR_WEIGHT': None,
         'ZENTECT_KM_ATTR_DECISIVE': '0'}


def _run(envs, chunk_by_id, cands, hints=None):
    """text_beta=0.0 走纯拼接（单路编码，闭式可控）；hints 透传给 frame_hints。"""
    queries = [{'shotId': 's1', 'text': _QUERY_TEXT, 'visualIntent': '',
                'audioDurationMs': 3000.0, 'emotion': '', 'moodIntent': '', 'charIds': []}]
    return _with_envs(envs, lambda: build_match_cost(
        queries, chunk_by_id, cands, weights=W, text_beta=0.0, frame_hints=hints))


def test_frame_primary_replaces_weak_frame_flips():
    """帧描述比切片描述更弱 ⇒ 方案 D 仍以帧为准（压掉切片虚高），排名翻转；off（max）则不动。"""
    # c1 切片 0.50（无帧证据）；c2 切片 0.70（切片更强），但帧描述仅 0.30（帧更弱）。
    _setup({'c1desc': 0.50, 'c2desc': 0.70, 'f2desc': 0.30})
    restore = _patch_encode()
    try:
        chunks = {'c1': _chunk('c1', 'c1desc'), 'c2': _chunk('c2', 'c2desc')}
        cands = {'s1': ['c1', 'c2']}
        m_d = _run(_BASE, chunks, cands, {'s1': {'c2': 'f2desc'}})                          # 方案 D（缺省 on）
        m_b = _run({**_BASE, 'ZENTECT_KM_FRAME_PRIMARY': '0'}, chunks, cands, {'s1': {'c2': 'f2desc'}})  # 方案 B max
        # 方案 D：c2 用帧 0.30 → 输给 c1；方案 B：c2 取 max(0.70,0.30)=0.70 → 赢 c1。
        assert m_d['s1']['c1'] < m_d['s1']['c2'], f"方案 D 应以帧为准（c2 压到 0.30）⇒ c1 胜：{m_d['s1']}"
        assert m_b['s1']['c2'] < m_b['s1']['c1'], f"方案 B 只升不降（c2 保持 0.70）⇒ c2 胜：{m_b['s1']}"
        assert abs(m_d['s1']['c2'] - m_b['s1']['c2']) > 1e-3, "取代 vs max 对 c2 代价应产生实质差"
    finally:
        restore()
    print("✓ test_frame_primary_replaces_weak_frame_flips: 帧取代切片（即便帧更弱）")


def test_frame_primary_absent_falls_back_to_chunk():
    """无 frame_hints ⇒ 切片描述兜底，on/off 逐字节一致（零行为变化）。"""
    _setup({'c1desc': 0.70, 'c2desc': 0.50})
    restore = _patch_encode()
    try:
        chunks = {'c1': _chunk('c1', 'c1desc'), 'c2': _chunk('c2', 'c2desc')}
        cands = {'s1': ['c1', 'c2']}
        m_d = _run(_BASE, chunks, cands)
        m_b = _run({**_BASE, 'ZENTECT_KM_FRAME_PRIMARY': '0'}, chunks, cands)
        assert m_d == m_b, f"无帧证据时 primary on/off 必须逐字节一致，on={m_d['s1']} off={m_b['s1']}"
    finally:
        restore()
    print("✓ test_frame_primary_absent_falls_back_to_chunk: 无帧证据用切片兜底")


def test_frame_primary_strong_frame_replaces():
    """帧描述强于切片描述 ⇒ 取代生效（帧语义升唯一主力），结果与 max 同向（一致性 sanity）。"""
    _setup({'c1desc': 0.70, 'c2desc': 0.50, 'f2desc': 0.95})
    restore = _patch_encode()
    try:
        chunks = {'c1': _chunk('c1', 'c1desc'), 'c2': _chunk('c2', 'c2desc')}
        cands = {'s1': ['c1', 'c2']}
        m_d = _run(_BASE, chunks, cands, {'s1': {'c2': 'f2desc'}})
        m_b = _run({**_BASE, 'ZENTECT_KM_FRAME_PRIMARY': '0'}, chunks, cands, {'s1': {'c2': 'f2desc'}})
        assert m_d['s1']['c2'] < m_d['s1']['c1'], f"帧证据强 ⇒ c2 胜（方案 D）：{m_d['s1']}"
        assert abs(m_d['s1']['c2'] - m_b['s1']['c2']) < 1e-6, "强帧下 取代 与 max 对 c2 应等价"
    finally:
        restore()
    print("✓ test_frame_primary_strong_frame_replaces: 强帧取代且与 max 同值")


if __name__ == "__main__":
    print("=" * 60)
    print("🧩 帧描述唯一主力（方案 D）验证")
    print("=" * 60)
    test_frame_primary_replaces_weak_frame_flips()
    test_frame_primary_absent_falls_back_to_chunk()
    test_frame_primary_strong_frame_replaces()
    print("=" * 60)
    print("全部通过 ✅")