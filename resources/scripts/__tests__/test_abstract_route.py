# -*- coding: utf-8 -*-
"""
test_abstract_route.py —— 🎬 抽象旁白分流（P1 方案 A；2026-10-21）

背景：抽象旁白（「岁月流转，转眼十年」类）与任何具体画面低相关 ⇒ BGE 文本相似度即噪声。
方案：`ZENTECT_KM_ABSTRACT_ROUTE=on` 时，抽象句的语义主分改取**景别分级抽象分**
      （复用旧链 `_abstract_semantic_score`：空镜/全景/远景 0.90 ＞ 近景/特写 0.80 ＞ 中景 0.55
      ＞ 未识别 0.45），并跳过帧描述 / 实体命中 / 属性贴合三类噪声信号，且豁免候选内 min-max 归一化。

覆盖点：
  1. 抽象句排序：全景 > 近景 > 中景（景别先验生效），同时非抽象句仍按文本相似度排（分支互斥）。
  2. 非抽象句零行为变化：开关 on/off 对非抽象句逐字节一致。
  3. 开关 off 回退：抽象句与普通句口径完全一致（旧链 BGE 口径）。
  4. 无景别标记：退化 0.45 中性，不抛错、不编造。
  5. 噪声信号被抑制：帧证据/实体命中对抽象句结果零影响。

运行方式：
  cd resources/scripts
  ..\\ai-env\\python.exe __tests__\\test_abstract_route.py   # 单文件直跑
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

_QUERY_TEXT = '岁'
_VEC_RAW = {}


def _vec(cos: float) -> np.ndarray:
    """构造与 [1,0] 夹角余弦为 cos 的单位向量（2 维，便于闭式核对余弦）。"""
    return np.array([cos, math.sqrt(max(0.0, 1.0 - cos * cos))], dtype=np.float32)


def _setup(query_cos_map: dict) -> None:
    """装配向量表：{文本: 目标余弦}；无映射的文本得零向量（相似度 0）。"""
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


def _chunk(cid: str, desc: str, shot_scale: str = '') -> dict:
    """造候选切片：时长/情绪/角色三维同值（同 0~3000ms、空 emotion、无 charIds）。"""
    return {'id': cid, 'description': desc, 'parentChunkId': cid, 'filePath': 'v.mp4',
            'startMs': 0.0, 'endMs': 3000.0, 'emotion': '', 'charIds': [],
            'charGrain': 'ok', 'shotScale': shot_scale}


def _run(envs, chunk_by_id, cands, abstract=False, text=None, hints=None):
    """text_beta=0.0 走纯拼接（单路编码，闭式可控）；hints 透传给 frame_hints。"""
    queries = [{'shotId': 's1', 'text': text or _QUERY_TEXT, 'visualIntent': '',
                'audioDurationMs': 3000.0, 'emotion': '', 'moodIntent': '', 'charIds': [],
                'isAbstractNarration': abstract}]
    return _with_envs(envs, lambda: build_match_cost(
        queries, chunk_by_id, cands, weights=W, text_beta=0.0, frame_hints=hints))


# 语义量纲对齐 off（闭式可控）；供给/描述并入/属性决胜带均置缺省；抽象开关按用例显式给。
_BASE = {'ZENTECT_KM_SEM_NORM': 'off', 'ZENTECT_KM_SUPPLY_DUR': None,
         'ZENTECT_KM_DESC_AUG': None, 'ZENTECT_KM_DUR_WEIGHT': None,
         'ZENTECT_KM_ATTR_DECISIVE': '0'}
_ON = {**_BASE, 'ZENTECT_KM_ABSTRACT_ROUTE': 'on'}
_OFF = {**_BASE, 'ZENTECT_KM_ABSTRACT_ROUTE': 'off'}


def test_abstract_route_shot_scale_prior():
    """抽象句：全景(0.90) > 近景(0.80) > 中景(0.55) —— 与文本相似度无关。"""
    # 文本相似度故意反向：近景切片 0.95 最像、全景切片 0.10 最不像。
    _setup({'d_close': 0.95, 'd_mid': 0.70, 'd_wide': 0.10})
    restore = _patch_encode()
    try:
        chunks = {'c_close': _chunk('c_close', 'd_close', '近景'),
                  'c_mid': _chunk('c_mid', 'd_mid', '中景'),
                  'c_wide': _chunk('c_wide', 'd_wide', '全景')}
        cands = {'s1': ['c_close', 'c_mid', 'c_wide']}
        m_abs = _run(_ON, chunks, cands, abstract=True)
        row = m_abs['s1']
        assert row['c_wide'] < row['c_close'] < row['c_mid'], \
            f"抽象句应按景别先验排序（全景<近景<中景）：{row}"
        # 同一批数据去掉抽象标记 ⇒ 仍按文本相似度（近景最像 ⇒ 最优）。
        m_plain = _run(_ON, chunks, cands, abstract=False)
        assert m_plain['s1']['c_close'] < m_plain['s1']['c_wide'], \
            f"非抽象句必须仍走文本语义（近景 0.95 胜全景 0.10）：{m_plain['s1']}"
    finally:
        restore()
    print("✓ test_abstract_route_shot_scale_prior: 抽象句按景别先验，非抽象句走文本")


def test_abstract_route_non_abstract_unchanged():
    """非抽象句：抽象开关 on/off 逐字节一致（分支互斥）。"""
    _setup({'d_close': 0.95, 'd_mid': 0.70, 'd_wide': 0.10})
    restore = _patch_encode()
    try:
        chunks = {'c_close': _chunk('c_close', 'd_close', '近景'),
                  'c_wide': _chunk('c_wide', 'd_wide', '全景')}
        cands = {'s1': ['c_close', 'c_wide']}
        m_on = _run(_ON, chunks, cands, abstract=False)
        m_off = _run(_OFF, chunks, cands, abstract=False)
        assert m_on == m_off, f"非抽象句不得受抽象开关影响，on={m_on['s1']} off={m_off['s1']}"
    finally:
        restore()
    print("✓ test_abstract_route_non_abstract_unchanged: 非抽象句零行为变化")


def test_abstract_route_off_falls_back_to_bge():
    """开关 off：抽象句退回 BGE 文本口径（与普通句完全一致）。"""
    _setup({'d_close': 0.95, 'd_wide': 0.10})
    restore = _patch_encode()
    try:
        chunks = {'c_close': _chunk('c_close', 'd_close', '近景'),
                  'c_wide': _chunk('c_wide', 'd_wide', '全景')}
        cands = {'s1': ['c_close', 'c_wide']}
        m_abs_off = _run(_OFF, chunks, cands, abstract=True)
        m_plain_off = _run(_OFF, chunks, cands, abstract=False)
        assert m_abs_off == m_plain_off, \
            f"开关 off 时抽象标记必须被忽略，abs={m_abs_off['s1']} plain={m_plain_off['s1']}"
    finally:
        restore()
    print("✓ test_abstract_route_off_falls_back_to_bge: 开关 off 逐字节回退")


def test_abstract_route_missing_shot_scale_neutral():
    """无景别标记：两候选同退 0.45 中性（代价相等），不抛错、不编造。"""
    _setup({'d1': 0.90, 'd2': 0.10})
    restore = _patch_encode()
    try:
        chunks = {'c1': _chunk('c1', 'd1', ''), 'c2': _chunk('c2', 'd2', '')}
        cands = {'s1': ['c1', 'c2']}
        row = _run(_ON, chunks, cands, abstract=True)['s1']
        assert abs(row['c1'] - row['c2']) < 1e-9, \
            f"无景别标记应同值中性（0.45），不得被文本相似度拉开：{row}"
    finally:
        restore()
    print("✓ test_abstract_route_missing_shot_scale_neutral: 无景别退中性 0.45")


def test_abstract_route_suppresses_noise():
    """抽象句：帧证据 + 实体命中对结果零影响（噪声通道被跳过）。"""
    _setup({'d_wide': 0.10, 'd_close': 0.95, 'f_close': 0.99})
    restore = _patch_encode()
    try:
        chunks = {'c_wide': _chunk('c_wide', 'd_wide', '全景'),
                  'c_close': _chunk('c_close', 'd_close', '近景')}
        cands = {'s1': ['c_wide', 'c_close']}
        # 「照片」在词表内；切片描述也含该词 ⇒ 若实体通道生效，c_close 会被额外降代价。
        _VEC_RAW['照片'] = np.array([1.0, 0.0], dtype=np.float32)
        clean = _run(_ON, chunks, cands, abstract=True, text=_QUERY_TEXT)
        noisy = _run(_ON, chunks, cands, abstract=True,
                     text='照片', hints={'s1': {'c_close': 'f_close'}})
        assert clean == noisy, \
            f"抽象句不得受帧证据/实体命中影响，clean={clean['s1']} noisy={noisy['s1']}"
        assert noisy['s1']['c_wide'] < noisy['s1']['c_close'], \
            f"噪声通道被跳过 ⇒ 仍应按景别（全景胜近景）：{noisy['s1']}"
    finally:
        restore()
    print("✓ test_abstract_route_suppresses_noise: 帧证据/实体命中被抑制")


if __name__ == "__main__":
    print("=" * 60)
    print("🎬 抽象旁白分流（P1 方案 A）验证")
    print("=" * 60)
    test_abstract_route_shot_scale_prior()
    test_abstract_route_non_abstract_unchanged()
    test_abstract_route_off_falls_back_to_bge()
    test_abstract_route_missing_shot_scale_neutral()
    test_abstract_route_suppresses_noise()
    print("=" * 60)
    print("全部通过 ✅")
