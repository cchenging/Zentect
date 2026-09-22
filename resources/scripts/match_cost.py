# -*- coding: utf-8 -*-
"""
match_cost.py —— 供给层 MatchCost（R1 两层次串行第一步：第一句候选集合 + 代价矩阵）

定位（§8.2 / Q1/Q2 准绳）：
  - 本模块是**供给层（supply）**：为调度层（beam_search）预计算「每句 × 每候选切片」的
    基础贴合代价矩阵 {shotId: {chunkId: base_cost}}，**cost 越小越贴合**（束搜索按它升序展开）。
  - 调度层消费本矩阵 + 规则卡片，不重算贴合；本模块不掺任何转移/排产逻辑。

复用口径（不重复实现，保持唯一打分来源）：
  - 语义主分：与旧 KM 同源的 **BGE 文本↔文本**（`AIModels.encode_texts` + 点积=余弦）。
  - 综合分：复用旧 KM 的 `_compute_combined_score`（语义 0.71 / 时长 0.15 / 情绪 0.05 / 角色 0.09，
    含动态权重让渡）+ 各标量助手（时长/情绪/角色，均从 timeline_solver import）。
  - MVP 范围说明：先锁定「语义+时长+情绪+角色」四因子核心分；P3 时间锚、实体通道、C 两阶段
    语义等加性精修暂不并入本版（shadow 对账仪会如实标出 DIFF，不造假象）。

工程红线（守 Q1「错就错」）：
  - 编码失败 / 缺字段直接抛错，绝不兜底返回空矩阵或默认代价。
  - 缺候选的句**不产出该句代价行**；束搜索对该句跳过（对应「旧7空段→新引擎必0」验收）。

路径说明：本模块只 import 旧 KM 的纯标量助手与 BGE 编码器，不 import 其它新引擎模块，
自身也仅被 new_pipeline（montage_router 的 new_run）消费。
"""
from __future__ import annotations

from typing import Dict, List, Optional

from montage_contract import ContractError

# 复用旧 KM 求解器的纯标量打分助手（唯一打分口径来源，避免重复实现造成口径漂移）。
from timeline_solver import (
    AIModels,
    _char_ids_of_chunk,
    _char_ids_of_query,
    _compute_combined_score,
    _compute_duration_score,
    _compute_role_score,
    _emotion_compatibility,
    _smart_truncate_desc,
)


def build_query_text(query: dict) -> str:
    """构造一句的语义编码文本：解说词正文 + 画面意图（对齐旧 KM query_texts 口径）。

    Args:
        query: 归一化脚本句。

    Returns:
        str: 语义编码文本（正文缺失时退回画面意图，两者皆空则空串——交给契约层暴露）。
    """
    text = (query.get('text') or '').strip()
    visual = (query.get('visualIntent') or '').strip()
    if not text:
        return visual
    return f"{text} {visual}" if visual else text


def _query_emotion(query: dict) -> str:
    """取一句的情绪期望态：moodIntent 优先于 emotion（对齐旧 KM query_emotions 口径）。

    Args:
        query: 归一化脚本句。

    Returns:
        str: 情绪标签（可为空串）。
    """
    mood = (query.get('moodIntent') or '').strip()
    return mood if mood else (query.get('emotion') or '')


def build_match_cost(
    queries: List[dict],
    chunk_by_id: Dict[str, dict],
    cands_by_shotid: Dict[str, List[str]],
    weights: Optional[dict] = None,
) -> Dict[str, Dict[str, float]]:
    """计算每句候选切片的综合贴合代价矩阵 {shotId: {chunkId: base_cost}}。

    流程：
      1. 全部句编码一次、全部切片描述编码一次 → 语义矩阵（BGE 点积余弦）。
      2. 对每句的候选切片逐片算时长/情绪/角色分，并入 `_compute_combined_score` 得贴合分。
      3. cost = 1 - 贴合分（正向转负向，越小越贴合，供束搜索升序展开）。

    Args:
        queries: 归一化脚本句（build_context 产出，含 shotId/text/visualIntent/
            audioDurationMs/emotion/moodIntent/charIds 等）。
        chunk_by_id: 切片资产索引 {chunkId: chunk}。
        cands_by_shotid: 每句候选切片 id 列表 {shotId: [chunkId]}。
        weights: 可选综合分权重覆盖（透传 `_compute_combined_score`）。

    Returns:
        Dict[str, Dict[str, float]]: {shotId: {chunkId: base_cost}}；
        缺失候选的句不产出代价行（错就错，交束搜索跳过处理）。

    Raises:
        ContractError: BGE 编码失败 / 候选切片在资产索引中缺失（缺口即抛）。
    """
    if not queries:
        return {}

    import numpy as np  # 本文件按需局部导入 numpy（与既有模块风格一致）

    # ---- 1. 语义矩阵：全部句 × 全部切片，一次性 BGE 编码 ----
    query_texts = [build_query_text(q) for q in queries]
    chunk_ids: List[str] = list(chunk_by_id.keys())
    chunk_desc_texts = [_smart_truncate_desc(chunk_by_id[cid].get('description') or '')
                        for cid in chunk_ids]
    _q_emb = AIModels.encode_texts(query_texts)   # 句编码（L2 归一化，行=句）
    _c_emb = AIModels.encode_texts(chunk_desc_texts)  # 切片描述编码（行=切片）
    semantic_sim = np.matmul(_q_emb, _c_emb.T).astype(np.float32)
    # 供后续按列定位切片：chunkId → 语义矩阵列下标
    chunk_order = {cid: idx for idx, cid in enumerate(chunk_ids)}

    # ---- 2. 逐句逐候选算贴合分并转负向代价 ----
    result: Dict[str, Dict[str, float]] = {}
    for qi, query in enumerate(queries):
        sid = str(query['shotId'])
        cand_ids = cands_by_shotid.get(sid) or []
        if not cand_ids:
            continue  # 空候选：不产出代价行（交给束搜索跳过，不造假象）
        query_emotion = _query_emotion(query)
        query_roles = _char_ids_of_query(query)
        t_audio_ms = float(query.get('audioDurationMs') or 0.0)

        row: Dict[str, float] = {}
        for cid in cand_ids:
            chunk = chunk_by_id.get(cid)
            if chunk is None:
                raise ContractError(f'MatchCost: 候选切片 {cid} 不在资产索引中')
            ci = chunk_order[cid]
            sem_score = float(semantic_sim[qi, ci])

            # 时长契合（非对称裁剪友好型）
            c_start = float(chunk.get('startMs') or 0.0)
            c_end = float(chunk.get('endMs') or c_start)
            duration_penalty = _compute_duration_score(t_audio_ms, c_end - c_start)

            # 情绪相容度（切片情绪由步骤2 帧聚合而来）
            emotion_score = _emotion_compatibility(query_emotion, chunk.get('emotion') or '')

            # 角色契合（软排，绝不作硬门禁；union_suspect 粒度降权对齐旧口径）
            chunk_roles = _char_ids_of_chunk(chunk)
            role_score = _compute_role_score(query_roles, chunk_roles)
            if str(chunk.get('charGrain') or 'ok') == 'union_suspect':
                role_score = 0.5 + (role_score - 0.5) * 0.5

            combined = _compute_combined_score(
                sem_score, duration_penalty, emotion_score, role_score, weights,
            )
            row[cid] = 1.0 - float(combined)  # 正向分 → 负向代价
        result[sid] = row

    # 及时释放大矩阵引用，缓解常驻内存。
    del semantic_sim, _q_emb, _c_emb
    return result