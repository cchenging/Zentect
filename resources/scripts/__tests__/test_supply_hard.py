"""
test_supply_hard.py — 🧩 乙案「可供给≥配音」近硬约束（落码点3，仅 `ZENTECT_KM_SUPPLY_DUR` on 档）

锁定 bug「配音没念完就跳走」的根治约束：只要某句存在任一**可覆盖**候选（可供给时长 ≥ 配音时长），
其综合代价必须低于任何供不起的候选（罚量 SUPPLY_SHORT_PENALTY 远大于其它分项之和），
使束搜索「有可覆盖候选时必须被选中」；全候选供不起 ⇒ 不罚、逐字节退回现状并计数。

覆盖点：
  1. 存在可覆盖候选 ⇒ 供不起候选被罚到 100+，可覆盖候选胜出（off 档语义仍可翻盘，验证零行为变化）。
  2. 全候选供不起 ⇒ on 档代价与 off 档逐字节一致（退回现状，不破坏置信度量纲）。
  3. 原声段（keepOriginalAudio）⇒ 不适用该约束（窗长由 ASR 段决定）⇒ on 档与 off 档一致。

运行方式：
  cd resources/scripts
  ..\\ai-env\\python.exe -m __tests__.test_supply_hard
  （函数式 test_* + 纯 assert；run_all.py 自动收集）
"""
import os
import sys
import numpy as np

# 将 scripts 目录加入 path，以便 import match_cost / timeline_solver
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import match_cost
from match_cost import SUPPLY_SHORT_PENALTY, build_match_cost

# 显式权重集（避免运行环境 ZENTECT_KM_DUR_WEIGHT 等 env 覆盖干扰断言）
W = dict(sem=0.64, emotion=0.05, duration=0.22, role=0.09)


# ---- fake BGE 编码器：按文本内容映射固定向量，sim 值可控 ----
_VEC_RAW = {
    'c1desc': np.array([1.0, 0.0, 0.0], dtype=np.float32),       # 语义精确切片（供不起）
    'c2desc': np.array([0.0, 1.0, 0.0], dtype=np.float32),       # 语义泛泛切片（可覆盖）
    '文案A': np.array([1.0, 0.15, 0.0], dtype=np.float32),        # 纯 text query（sim(c1) 高 / sim(c2) 低）
    '文案A 画面意图B': np.array([1.0, 0.15, 0.0], dtype=np.float32),
}


def _fake_encode_texts(texts, batch_size=32, max_length=512):
    """测试替身：返回固定向量矩阵（行=文本，L2 归一化，模拟 BGE 编码结果）。"""
    memo = {}
    for t, v in _VEC_RAW.items():
        n = np.linalg.norm(v) + 1e-12
        memo[t] = v / n
    return np.stack([memo.get(t, np.zeros(3, np.float32)) for t in texts]).astype(np.float32)


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


def _short_chunk(cid, desc, end_ms, parent):
    """造一个「供不起」候选切片（自身时长 = end_ms，无连续后继链）。"""
    return {'id': cid, 'description': desc, 'parentChunkId': parent, 'filePath': 'v.mp4',
            'startMs': 0.0, 'endMs': float(end_ms), 'emotion': '', 'charIds': [],
            'charGrain': 'ok'}


def _run(envs, queries, chunk_by_id, cands_by_shotid):
    """在给定 env 下跑 build_match_cost（固定 text_beta=1.0、sem_norm 由 envs 控制）。"""
    return _with_envs(envs, lambda: build_match_cost(
        queries, chunk_by_id, cands_by_shotid, weights=W, text_beta=1.0))


# 基础 env：关掉量纲对齐以免干扰语义序（本测试只验证供给近硬约束）
_BASE = {'ZENTECT_KM_SEM_NORM': 'off', 'ZENTECT_KM_TEXT_BETA': '1.0',
         'ZENTECT_KM_DESC_AUG': None, 'ZENTECT_KM_DUR_WEIGHT': None}


def test_supply_hard_penalizes_uncoverable_candidate():
    """存在可覆盖候选 ⇒ 供不起候选被罚到远高于其它分项之和，可覆盖候选胜出。"""
    restore = _patch_encode()
    try:
        queries = [{'shotId': 's1', 'text': '文案A', 'visualIntent': '画面意图B',
                    'audioDurationMs': 5000.0, 'emotion': '', 'moodIntent': '', 'charIds': []}]
        # c1：自身 1000ms（供不起 5000ms 配音）；c2：自身 5000ms（恰好可覆盖）。
        chunk_by_id = {'c1': _short_chunk('c1', 'c1desc', 1000, 'P'),
                       'c2': _short_chunk('c2', 'c2desc', 5000, 'Q')}
        cands = {'s1': ['c1', 'c2']}

        # off 档：零行为变化，语义精确的 c1 胜（无供给罚）。
        m_off = _run({**_BASE, 'ZENTECT_KM_SUPPLY_DUR': None}, queries, chunk_by_id, cands)
        assert m_off['s1']['c1'] < m_off['s1']['c2'], \
            f"off 档应保持语义序（c1 胜），实际 {m_off['s1']}"
        assert m_off['s1']['c1'] < 1.0, "off 档不得引入供给罚（cost 仍 ∈[0,1]）"

        # on 档：c1 供不起被罚 ⇒ c2 胜；罚量远大于其它分项之和。
        m_on = _run({**_BASE, 'ZENTECT_KM_SUPPLY_DUR': '1'}, queries, chunk_by_id, cands)
        assert m_on['s1']['c2'] < m_on['s1']['c1'], \
            f"on 档存在可覆盖候选时必须选 c2，实际 {m_on['s1']}"
        assert m_on['s1']['c1'] >= SUPPLY_SHORT_PENALTY, \
            f"供不起候选须被罚到 ≥{SUPPLY_SHORT_PENALTY}，实际 {m_on['s1']['c1']}"
    finally:
        restore()
    print("✓ test_supply_hard_penalizes_uncoverable_candidate: 可覆盖候选被强制选中")


def test_supply_hard_all_uncoverable_falls_back_to_status_quo():
    """全候选供不起 ⇒ on 档不罚，代价与 off 档逐字节一致（退回现状）。"""
    restore = _patch_encode()
    try:
        queries = [{'shotId': 's1', 'text': '文案A', 'visualIntent': '画面意图B',
                    'audioDurationMs': 5000.0, 'emotion': '', 'moodIntent': '', 'charIds': []}]
        # 两个候选都供不起（1000ms / 800ms 均 < 5000ms 配音，且无连续后继链）。
        chunk_by_id = {'c1': _short_chunk('c1', 'c1desc', 1000, 'P'),
                       'c2': _short_chunk('c2', 'c2desc', 800, 'Q')}
        cands = {'s1': ['c1', 'c2']}

        m_off = _run({**_BASE, 'ZENTECT_KM_SUPPLY_DUR': None}, queries, chunk_by_id, cands)
        m_on = _run({**_BASE, 'ZENTECT_KM_SUPPLY_DUR': '1'}, queries, chunk_by_id, cands)
        assert m_on == m_off, f"全供不起时必须退回现状（逐字节一致），on={m_on['s1']} off={m_off['s1']}"
        assert m_on['s1']['c1'] < 1.0, "全供不起不得被罚（否则置信度量纲被破坏）"
    finally:
        restore()
    print("✓ test_supply_hard_all_uncoverable_falls_back_to_status_quo: 全供不起退回现状")


def test_supply_hard_exempts_keep_original_audio():
    """原声段不适用该约束（窗长由 ASR 段决定）⇒ on 档不罚，与 off 档一致。"""
    restore = _patch_encode()
    try:
        queries = [{'shotId': 's1', 'text': '文案A', 'visualIntent': '画面意图B',
                    'audioDurationMs': 5000.0, 'emotion': '', 'moodIntent': '', 'charIds': [],
                    'keepOriginalAudio': True}]
        chunk_by_id = {'c1': _short_chunk('c1', 'c1desc', 1000, 'P'),
                       'c2': _short_chunk('c2', 'c2desc', 5000, 'Q')}
        cands = {'s1': ['c1', 'c2']}

        m_off = _run({**_BASE, 'ZENTECT_KM_SUPPLY_DUR': None}, queries, chunk_by_id, cands)
        m_on = _run({**_BASE, 'ZENTECT_KM_SUPPLY_DUR': '1'}, queries, chunk_by_id, cands)
        assert m_on == m_off, f"原声段不得施加供给近硬约束，on={m_on['s1']} off={m_off['s1']}"
        assert m_on['s1']['c1'] < 1.0, "原声段不得被罚（天然排除供给约束）"
    finally:
        restore()
    print("✓ test_supply_hard_exempts_keep_original_audio: 原声段天然排除约束")


if __name__ == "__main__":
    print("=" * 60)
    print("🧩 乙案「可供给≥配音」近硬约束验证（落码点3）")
    print("=" * 60)
    test_supply_hard_penalizes_uncoverable_candidate()
    test_supply_hard_all_uncoverable_falls_back_to_status_quo()
    test_supply_hard_exempts_keep_original_audio()
    print("=" * 60)
    print("全部通过 ✅")