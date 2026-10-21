"""
test_frame_desc.py —— 🧩 帧描述并入打分（方案 B；2026-10-21）

锁定 bug「帧证据召回的镜头在打分侧零支撑」：切片级描述会漏掉镜头内的关键瞬间 ——
实测 chunk_084 的切片描述是「女子手持黑色卡片夹」，而它被帧召回命中的那一帧是
「【特写】墙面展示合影照片」。只吃切片描述 ⇒ 靠帧证据进池的镜头在语义项上拿不到任何支持，
seg_2「可越是甜到发腻的誓言，越经不起一张照片的考验」因此仍然选到「女子侧脸说话」镜头。

修法：`build_match_cost(..., frame_hints=...)` 对带帧证据的候选取
`sem = max(切片描述相似度, 帧描述相似度)`（只升不降；缺省/空 ⇒ 逐字节回退旧口径）。
开关 `ZENTECT_KM_FRAME_DESC`（缺省 on，'0' 回退）。

覆盖点：
  1. 帧证据能把语义更弱的候选抬上来并翻盘（无 hint 时它输，有 hint 时它赢）。
  2. 帧描述比切片描述更弱 ⇒ 不抬升（只升不降），代价逐字节不变。
  3. 无 frame_hints ⇒ 与旧口径逐字节一致（零行为变化）。
  4. 开关 off（env '0'）⇒ 即便给了 hint 也与旧口径逐字节一致（可一键回退）。

运行方式：
  cd resources/scripts
  ..\\ai-env\\python.exe __tests__\\test_frame_desc.py   # 单文件直跑
  ..\\ai-env\\python.exe __tests__\\run_all.py           # L1 总入口（自动收集本文件）
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


_BASE = {'ZENTECT_KM_SEM_NORM': 'minmax', 'ZENTECT_KM_SUPPLY_DUR': None,
         'ZENTECT_KM_DESC_AUG': None, 'ZENTECT_KM_DUR_WEIGHT': None,
         'ZENTECT_KM_ATTR_DECISIVE': '0',
         'ZENTECT_KM_FRAME_PRIMARY': '0'}   # 帧描述取 max（方案 B）；primary=方案 D 另见 test_frame_primary.py


def _run(envs, chunk_by_id, cands, hints=None):
    """text_beta=0.0 走纯拼接（单路编码，闭式可控）；hints 透传给 frame_hints。"""
    queries = [{'shotId': 's1', 'text': _QUERY_TEXT, 'visualIntent': '',
                'audioDurationMs': 3000.0, 'emotion': '', 'moodIntent': '', 'charIds': []}]
    return _with_envs(envs, lambda: build_match_cost(
        queries, chunk_by_id, cands, weights=W, text_beta=0.0, frame_hints=hints))


def test_frame_desc_lifts_and_flips():
    """帧证据把语义更弱的候选抬上来并翻盘（无 hint 输 / 有 hint 赢）。"""
    # c1 切片描述余弦 0.70（语义更强）；c2 切片描述 0.50（更弱），但帧描述 0.95（强证据）
    _setup({'c1desc': 0.70, 'c2desc': 0.50, 'f2desc': 0.95})
    restore = _patch_encode()
    try:
        chunks = {'c1': _chunk('c1', 'c1desc'), 'c2': _chunk('c2', 'c2desc')}
        cands = {'s1': ['c1', 'c2']}
        m_off = _run(_BASE, chunks, cands)                       # 无帧证据
        m_on = _run(_BASE, chunks, cands, {'s1': {'c2': 'f2desc'}})
        assert m_off['s1']['c1'] < m_off['s1']['c2'], f"无帧证据应由切片描述决出，实际 {m_off['s1']}"
        assert m_on['s1']['c2'] < m_on['s1']['c1'], f"帧证据应翻盘（c2 胜），实际 {m_on['s1']}"
        # 注：c1 的代价会因候选内 min-max 归一化的分母变化而上升（c2 成为语义上界）——
        #   这是量纲对齐的既有语义（相对刻度），不是「被改坏」；故此处只断言相对序翻盘。
    finally:
        restore()
    print("✓ test_frame_desc_lifts_and_flips: 帧证据抬升并翻盘生效")


def test_frame_desc_never_downgrades():
    """帧描述比切片描述更弱 ⇒ 不抬升（取 max），整行代价逐字节不变。"""
    _setup({'c1desc': 0.70, 'c2desc': 0.50, 'f2desc': 0.30})   # 帧证据明显更弱
    restore = _patch_encode()
    try:
        chunks = {'c1': _chunk('c1', 'c1desc'), 'c2': _chunk('c2', 'c2desc')}
        cands = {'s1': ['c1', 'c2']}
        m_off = _run(_BASE, chunks, cands)
        m_on = _run(_BASE, chunks, cands, {'s1': {'c2': 'f2desc'}})
        assert m_on == m_off, f"弱帧证据不得降低语义分，on={m_on['s1']} off={m_off['s1']}"
    finally:
        restore()
    print("✓ test_frame_desc_never_downgrades: 只升不降")


def test_frame_desc_absent_keeps_bytewise():
    """无 frame_hints ⇒ 与旧口径逐字节一致（零行为变化）。"""
    _setup({'c1desc': 0.70, 'c2desc': 0.50, 'f2desc': 0.95})
    restore = _patch_encode()
    try:
        chunks = {'c1': _chunk('c1', 'c1desc'), 'c2': _chunk('c2', 'c2desc')}
        cands = {'s1': ['c1', 'c2']}
        assert _run(_BASE, chunks, cands) == _run(_BASE, chunks, cands, None)
        assert _run(_BASE, chunks, cands) == _run(_BASE, chunks, cands, {})
    finally:
        restore()
    print("✓ test_frame_desc_absent_keeps_bytewise: 无帧证据零行为变化")


def test_frame_desc_switch_off_reverts():
    """开关 off（env '0'）⇒ 即便给了 hint 也与旧口径逐字节一致（可一键回退）。"""
    _setup({'c1desc': 0.70, 'c2desc': 0.50, 'f2desc': 0.95})
    restore = _patch_encode()
    try:
        chunks = {'c1': _chunk('c1', 'c1desc'), 'c2': _chunk('c2', 'c2desc')}
        cands = {'s1': ['c1', 'c2']}
        m_off = _run(_BASE, chunks, cands)
        m_sw = _run({**_BASE, 'ZENTECT_KM_FRAME_DESC': '0'}, chunks, cands, {'s1': {'c2': 'f2desc'}})
        assert m_sw == m_off, f"开关 off 必须回退旧口径，off={m_off['s1']} sw={m_sw['s1']}"
    finally:
        restore()
    print("✓ test_frame_desc_switch_off_reverts: 开关可一键回退")


def test_frame_desc_unknown_chunk_ignored():
    """hint 指向不在候选/切片索引里的 id ⇒ 忽略（不崩、不改行为）。"""
    _setup({'c1desc': 0.70, 'c2desc': 0.50})
    restore = _patch_encode()
    try:
        chunks = {'c1': _chunk('c1', 'c1desc'), 'c2': _chunk('c2', 'c2desc')}
        cands = {'s1': ['c1', 'c2']}
        m_off = _run(_BASE, chunks, cands)
        m_bad = _run(_BASE, chunks, cands, {'s1': {'chunk_999': 'f2desc'}, 's9': {'c1': 'f2desc'}})
        assert m_bad == m_off, "脏 hint（不存在的句/切片）必须被忽略"
    finally:
        restore()
    print("✓ test_frame_desc_unknown_chunk_ignored: 脏 hint 被忽略")


if __name__ == "__main__":
    print("=" * 60)
    print("🧩 帧描述并入打分（方案 B）验证")
    print("=" * 60)
    test_frame_desc_lifts_and_flips()
    test_frame_desc_never_downgrades()
    test_frame_desc_absent_keeps_bytewise()
    test_frame_desc_switch_off_reverts()
    test_frame_desc_unknown_chunk_ignored()
    print("=" * 60)
    print("全部通过 ✅")
