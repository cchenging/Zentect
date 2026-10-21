# -*- coding: utf-8 -*-
"""
test_entity_boost.py —— 🧩 实体命中降代价（方案 C；2026-10-21）

锁定 bug「显式实体名词被 BGE 长句余弦淹没」：切片描述（高频 top8 聚合）天生丢低频实体，
即便帧描述已并入（方案 B），语义主分对「query 点名实体词 ↔ 候选含该词」仍零奖励 ——
seg_2「可越是甜到发腻的誓言，越经不起一张照片的考验」即便帧召回捞到「墙上挂着照片」镜头，
依然输给「女子侧脸说话」（cost gap 超 0.15）。

修法：`build_match_cost` 里，候选文本（切片描述 **或** 帧描述）包含 query 命中的词表实体词
（`FRAME_ENTITY_LEXICON`）⇒ 该候选代价扣 `ENTITY_BOOST_REWARD = 0.15`（离散可解释，不碰语义分）。
开关 `ZENTECT_KM_ENTITY_BOOST`（缺省 on，'0' 回退，逐字节零行为变化）。

覆盖点：
  1. query 命中实体 + 候选描述命中 ⇒ 该候选降 0.15 且翻盘（语义稍弱者反超）。
  2. 开关 off（env '0'）⇒ 即便双命中也零行为变化（不降、不翻盘）。
  3. query 不含词表实体 ⇒ 整段零行为变化（on/off 逐字节一致）。
  4. 实体由**帧描述**（frame_hints）命中、切片描述未命中 ⇒ 仍降 0.15（验证帧证据路径）。

运行方式：
  cd resources/scripts
  ..\\ai-env\\python.exe __tests__\\test_entity_boost.py   # 单文件直跑
  ..\\ai-env\\python.exe __tests__\\run_all.py             # L1 总入口（自动收集本文件）
"""
import math
import os
import sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import match_cost
from match_cost import build_match_cost

# 情绪/角色权重显式置 0（测试里二者恒中性 0.5，留会被动态让渡并入语义，断言闭式失准）
W = dict(sem=0.78, emotion=0.0, duration=0.22, role=0.0)

_Q_HIT = '越经不起一张照片的考验'   # 命中词表实体「照片」
_Q_NONE = '岁月流转沧桑'             # 不含任何词表实体

_VEC_RAW = {}


def _vec(cos: float) -> np.ndarray:
    """构造与 [1,0] 夹角余弦为 cos 的单位向量（2 维，便于闭式核对余弦）。"""
    return np.array([cos, math.sqrt(max(0.0, 1.0 - cos * cos))], dtype=np.float32)


def _setup(mapping: dict) -> None:
    """装配向量表：{文本: 向量}；query 文本恒取 [1,0]（与自身余弦 1.0）。"""
    _VEC_RAW.clear()
    for t, v in mapping.items():
        _VEC_RAW[t] = v


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


# 语义量纲对齐 off（隔离出实体降代价这单一变量）；帧描述 off（隔离出方案 C，不受方案 B 抬升干扰）；
# 属性决胜带 off / 供给口径 off / desc_aug off / dur_weight 缺省。
_BASE = {'ZENTECT_KM_SEM_NORM': 'off', 'ZENTECT_KM_SUPPLY_DUR': None,
         'ZENTECT_KM_DESC_AUG': None, 'ZENTECT_KM_DUR_WEIGHT': None,
         'ZENTECT_KM_ATTR_DECISIVE': '0', 'ZENTECT_KM_FRAME_DESC': '0'}


def _run(envs, query_text, chunk_by_id, cands, hints=None):
    """text_beta=0.0 走纯拼接（单路编码，闭式可控）；hints 透传给 frame_hints。"""
    queries = [{'shotId': 's1', 'text': query_text, 'visualIntent': '',
                'audioDurationMs': 3000.0, 'emotion': '', 'moodIntent': '', 'charIds': []}]
    return _with_envs(envs, lambda: build_match_cost(
        queries, chunk_by_id, cands, weights=W, text_beta=0.0, frame_hints=hints))


def _fixture():
    """c1 语义更强（0.55）但无实体；c2 语义稍弱（0.50）但描述含「照片」。"""
    _setup({_Q_HIT: np.array([1.0, 0.0], np.float32),
            '女子侧脸说话': _vec(0.55),
            '墙上挂着照片': _vec(0.50)})
    chunks = {'c1': _chunk('c1', '女子侧脸说话'), 'c2': _chunk('c2', '墙上挂着照片')}
    return chunks, {'s1': ['c1', 'c2']}


def test_entity_hit_reduces_and_flips():
    """query 命中实体 + 候选描述命中 ⇒ 该候选降 0.15 且翻盘（c2 反超 c1）。"""
    chunks, cands = _fixture()
    restore = _patch_encode()
    try:
        m_off = _run({**_BASE, 'ZENTECT_KM_ENTITY_BOOST': '0'}, _Q_HIT, chunks, cands)
        m_on = _run(_BASE, _Q_HIT, chunks, cands)
        assert m_off['s1']['c1'] < m_off['s1']['c2'], f"未开实体降代价应由语义强的 c1 胜：{m_off['s1']}"
        assert m_on['s1']['c2'] < m_on['s1']['c1'], f"实体命中应降 c2 代价翻盘：{m_on['s1']}"
        assert abs(m_on['s1']['c2'] - (m_off['s1']['c2'] - 0.15)) < 1e-6, "降价幅度应恰为 0.15"
        assert m_on['s1']['c1'] == m_off['s1']['c1'], "未命中实体候选代价不应改变"
    finally:
        restore()
    print("✓ test_entity_hit_reduces_and_flips: 实体命中降 0.15 且翻盘")


def test_entity_switch_off_reverts():
    """开关 off（env '0'）⇒ 即便双命中也零行为变化（不降、不翻盘）。"""
    chunks, cands = _fixture()
    restore = _patch_encode()
    try:
        m_on = _run(_BASE, _Q_HIT, chunks, cands)
        m_sw = _run({**_BASE, 'ZENTECT_KM_ENTITY_BOOST': '0'}, _Q_HIT, chunks, cands)
        assert m_sw['s1']['c1'] < m_sw['s1']['c2'], f"开关 off 应回到语义序（c1 胜）：{m_sw['s1']}"
        assert abs(m_sw['s1']['c2'] - (m_on['s1']['c2'] + 0.15)) < 1e-6, "off 态 c2 应比 on 态多 0.15"
        assert m_sw['s1']['c1'] == m_on['s1']['c1'], "未命中候选在 on/off 间应一致"
    finally:
        restore()
    print("✓ test_entity_switch_off_reverts: 开关可一键回退")


def test_entity_absent_zero_change():
    """query 不含词表实体 ⇒ 整段零行为变化（on/off 逐字节一致）。"""
    chunks, cands = _fixture()
    restore = _patch_encode()
    try:
        m_off = _run({**_BASE, 'ZENTECT_KM_ENTITY_BOOST': '0'}, _Q_NONE, chunks, cands)
        m_on = _run(_BASE, _Q_NONE, chunks, cands)
        assert m_on == m_off, f"query 无词表实体 ⇒ 必须逐字节一致，on={m_on['s1']} off={m_off['s1']}"
    finally:
        restore()
    print("✓ test_entity_absent_zero_change: 无实体句零行为变化")


def test_entity_hit_via_frame_hint():
    """实体由**帧描述**（frame_hints）命中、切片描述未命中 ⇒ 仍降 0.15 翻盘。"""
    # c1 语义更强（0.55）无实体；c2 语义稍弱（0.50），切片描述「男子看向窗外」无实体，
    # 但帧证据 frame_hints['s1']['c2'] = 「墙上挂着照片」含实体「照片」。
    _setup({_Q_HIT: np.array([1.0, 0.0], np.float32),
            '墙上挂着照片': _vec(0.95),              # 帧描述常量（方案 B off 时不参与编码，仅留档）
            '女子侧脸说话': _vec(0.55),
            '男子看向窗外': _vec(0.50)})
    chunks = {'c1': _chunk('c1', '女子侧脸说话'), 'c2': _chunk('c2', '男子看向窗外')}
    cands = {'s1': ['c1', 'c2']}
    hints = {'s1': {'c2': '墙上挂着照片'}}
    restore = _patch_encode()
    try:
        m_no = _run(_BASE, _Q_HIT, chunks, cands)
        m_hint = _run(_BASE, _Q_HIT, chunks, cands, hints)
        assert m_no['s1']['c1'] < m_no['s1']['c2'], f"无帧证据应由语义强的 c1 胜：{m_no['s1']}"
        assert m_hint['s1']['c2'] < m_hint['s1']['c1'], f"帧描述命中实体应降 c2 代价翻盘：{m_hint['s1']}"
        assert abs(m_hint['s1']['c2'] - (m_no['s1']['c2'] - 0.15)) < 1e-6, "帧证据路径降价幅度应恰为 0.15"
    finally:
        restore()
    print("✓ test_entity_hit_via_frame_hint: 帧描述命中实体同样降 0.15")


if __name__ == "__main__":
    print("=" * 60)
    print("🧩 实体命中降代价（方案 C）验证")
    print("=" * 60)
    test_entity_hit_reduces_and_flips()
    test_entity_switch_off_reverts()
    test_entity_absent_zero_change()
    test_entity_hit_via_frame_hint()
    print("=" * 60)
    print("全部通过 ✅")