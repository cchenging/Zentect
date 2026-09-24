# -*- coding: utf-8 -*-
"""
match_cost.py —— 供给层 MatchCost（R1 两层次串行第一步：第一句候选集合 + 代价矩阵）

定位（§8.2 / Q1/Q2 准绳）：
  - 本模块是**供给层（supply）**：为调度层（beam_search）预计算「每句 × 每候选切片」的
    基础贴合代价矩阵 {shotId: {chunkId: base_cost}}，**cost 越小越贴合**（束搜索按它升序展开）。
  - 调度层消费本矩阵 + 规则卡片，不重算贴合；本模块不掺任何转移/排产逻辑。

复用口径（不重复实现，保持唯一打分来源）：
  - 语义主分：与旧 KM 同源的 **BGE 文本↔文本**（`AIModels.encode_texts` + 点积=余弦）。
  - 综合分：复用旧 KM 的 `_compute_combined_score`（语义 0.64 / 时长 0.22 / 情绪 0.05 / 角色 0.09，
    含动态权重让渡；时长权重可由 `ZENTECT_KM_DUR_WEIGHT` 覆盖）+ 各标量助手（时长/情绪/角色，
    均从 timeline_solver import）。
  - 量纲对齐（方向2，2026-09-23）：纯 text 精排语义分绝对值低（0.2~0.5），综合分里易被
    高分时长/情绪项反超稀释；候选内 min-max 归一化把语义分拉到 [0,1] 重排相对权重，
    让语义真正履行第一主依据（开关 `ZENTECT_KM_SEM_NORM`，缺省 minmax，off 回退）。
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


def build_text_query_text(query: dict) -> str:
    """构造「纯文案精排」的语义编码文本：仅取解说词正文，不拼画面意图。

    P1′-a（docs/agents/context.md §P1′-a）离线实测：召回用现状拼接（r@10 61%），
    在局部候选内改用纯 text 精排（β(text)=1.0）使 **p@1 5.6%→16.7%（3 倍）**、
    r@3 11.1%→44.4%。关键洞察「弱信号 + 局部候选」：文案全局检索极差（r@10 11.1%），
    但**在已召回候选内具备判别力**。本函数即精排阶段的 query 文本构造。

    Args:
        query: 归一化脚本句。

    Returns:
        str: 纯文案语义编码文本（正文缺失时退回画面意图，保持语义可编码）。
    """
    text = (query.get('text') or '').strip()
    if text:
        return text
    return (query.get('visualIntent') or '').strip()


def _query_emotion(query: dict) -> str:
    """取一句的情绪期望态：moodIntent 优先于 emotion（对齐旧 KM query_emotions 口径）。

    Args:
        query: 归一化脚本句。

    Returns:
        str: 情绪标签（可为空串）。
    """
    mood = (query.get('moodIntent') or '').strip()
    return mood if mood else (query.get('emotion') or '')


def _read_text_beta(override: Optional[float] = None) -> float:
    """解析文案精排力度 β（语义主分在「拼接」与「纯 text」之间的融合系数）。

    P1′-a 落地开关（守「禁止未测量即上线」：必须可开关、可对账）：
      - 缺省/未显式传值：读 `ZENTECT_KM_TEXT_BETA`，缺省 `1.0`（纯 text 精排，方向 B 主行为）；
      - `0` → 纯拼接（回退旧 KM 语义口径，A/B 复测用）；
      - 中间数值 → 线性融合 `sem = (1-β)·sem_concat + β·sem_text`。

    Args:
        override: 显式传入的 β（优先于环境变量）；None 时读环境。

    Returns:
        float: [0,1] 区间内的 β。
    """
    import os
    raw = override if override is not None else os.environ.get('ZENTECT_KM_TEXT_BETA', '1.0')
    try:
        beta = float(raw)
    except (TypeError, ValueError):
        beta = 1.0  # 非法值错就错：不回退旧口径也不造假，直接按主口径落
    return max(0.0, min(1.0, beta))


def _read_sem_norm_mode(override: Optional[str] = None) -> str:
    """解析候选内语义量纲对齐模式（off | minmax）。

    量纲对齐（2026-09-23 方向2 语义加强，依据 docs/agents/context.md §23.6「量纲副作用」）：
      - 问题：纯 text 精排（β=1.0）的语义分绝对值低（0.2~0.5），而时长/情绪分普遍高（0.8~1.0）；
        综合分里语义权重虽为第一主依据（0.64），但其量纲差距被高分他项稀释，
        「时长恰好但画面泛泛」的切片容易反超「语义精确匹配」。
      - 机制：候选内 min-max 归一化把语义分拉到 [0,1]，不改变语义排序（单调变换），
        只重排语义与其他因子的相对权重，让 sem 真正履行第一主依据。
      - 开关：`ZENTECT_KM_SEM_NORM`，缺省 `minmax`（方向2 主行为）；`off` 回退原量纲（A/B）。

    Args:
        override: 显式传入的模式（优先于环境变量）；None 时读环境。

    Returns:
        str: 'minmax' 或 'off'（非法值错就错：按主口径 minmax 落）。
    """
    import os
    raw = override if override is not None else os.environ.get('ZENTECT_KM_SEM_NORM', 'minmax')
    return str(raw).strip().lower() if str(raw).strip().lower() in ('minmax', 'off') else 'minmax'


def _norm_cand_sem(scores: List[float]) -> List[float]:
    """候选内语义分 min-max 量纲对齐（单调变换，不改候选内语义排序）。

    Args:
        scores: 本句候选的 β 融合后语义分列表。

    Returns:
        List[float]: 归一化后的语义分；候选数<2 或 max==min（无判别梯度）时保持原值。
    """
    if len(scores) < 2:
        return list(scores)
    lo, hi = min(scores), max(scores)
    span = hi - lo
    if span < 1e-9:
        return list(scores)
    return [(float(s) - lo) / span for s in scores]


# 切片侧结构化实体字段 → 中文语义标签（方向3 描述增强并入用）。
#   选型口径：仅取「文案↔画面」匹配中最具判别力的实体维（主体/景别/地点/运镜/道具/服装/天气），
#   情绪/角色维度不走文本并入（已有独立打分因子，避免重复信号）。
_DESC_AUG_FIELDS = (
    ('primarySubject', '主体'),
    ('shotScale', '景别'),
    ('location', '地点'),
    ('camera', '运镜'),
    ('keyProps', '道具'),
    ('costume', '服装'),
    ('weatherEnv', '天气'),
)


def _read_desc_aug(override: Optional[bool] = None) -> bool:
    """解析切片描述侧实体并入开关（方向3）：`ZENTECT_KM_DESC_AUG` ∈ 1/on/true/yes。

    守「禁止未测量即上线」：默认关闭（零行为变化），A/B 显式开启。

    Args:
        override: 显式传入（优先于环境变量）；None 时读环境。

    Returns:
        bool: 是否并入结构化实体摘要到切片语义编码文本。
    """
    import os
    if override is not None:
        return bool(override)
    raw = str(os.environ.get('ZENTECT_KM_DESC_AUG', '') or '').strip().lower()
    return raw in ('1', 'on', 'true', 'yes')


def _build_chunk_semantic_text(chunk: dict, desc_aug: bool) -> str:
    """构造切片语义编码文本：默认仅 VLM 自然语言描述；desc_aug 时并入结构化实体摘要。

    机制（方向3，2026-09-23）：切片侧 A 域结构化字段（主控主体/景别/地点/运镜/道具/服装/天气）
    当前完全不参与语义编码，只吃 description 一个源；并入后给 BGE「文案↔画面」匹配
    更多判别信号。与「实体通道加性权重」（2026-09-16 已证端到端负收益）机制不同——
    这里是合成编码输入文本，不改任何打分权重。
    实体摘要置前（BGE 对头部 token 更敏感），description 收尾，整体仍走截断防超 512。

    Args:
        chunk: 切片资产（含 description / primarySubject / shotScale 等）。
        desc_aug: 是否并入结构化实体摘要。

    Returns:
        str: 语义编码文本（无实体字段时退化为纯 description，零行为变化）。
    """
    desc = _smart_truncate_desc(chunk.get('description') or '')
    if not desc_aug:
        return desc
    parts = []
    for field, label in _DESC_AUG_FIELDS:
        v = str(chunk.get(field) or '').strip()
        if v and v not in ('无', '未知'):
            parts.append(f'{label}:{v}')
    if not parts:
        return desc
    aug = ' | '.join(parts)
    return _smart_truncate_desc(aug + (' | ' + desc if desc else ''))


def build_match_cost(
    queries: List[dict],
    chunk_by_id: Dict[str, dict],
    cands_by_shotid: Dict[str, List[str]],
    weights: Optional[dict] = None,
    text_beta: Optional[float] = None,
) -> Dict[str, Dict[str, float]]:
    """计算每句候选切片的综合贴合代价矩阵 {shotId: {chunkId: base_cost}}。

    流程：
      1. 全部句编码一次、全部切片描述编码一次 → 语义矩阵（BGE 点积余弦）。
         - 若 β>0，额外对纯 text 文案再编码一次，得到拼接 & 纯 text 双矩阵，
           并在候选集内线性融合 `sem = (1-β)·sem_concat + β·sem_text`（P1′-a 精排阶段）。
      2. 对每句的候选切片逐片算时长/情绪/角色分，并入 `_compute_combined_score` 得贴合分。
      3. cost = 1 - 贴合分（正向转负向，越小越贴合，供束搜索升序展开）。

    Arg text_beta:
        文案精排融合系数（None 时经 `_read_text_beta` 读环境变量，缺省 1.0 纯 text）。

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

    beta = _read_text_beta(text_beta)

    # ---- 1. 语义矩阵：全部句 × 全部切片，一次性 BGE 编码 ----
    desc_aug = _read_desc_aug()
    query_concat_texts = [build_query_text(q) for q in queries]
    chunk_ids: List[str] = list(chunk_by_id.keys())
    chunk_desc_texts = [_build_chunk_semantic_text(chunk_by_id[cid], desc_aug)
                        for cid in chunk_ids]
    _c_emb = AIModels.encode_texts(chunk_desc_texts)  # 切片描述编码（行=切片，两路共享）
    _qc_emb = AIModels.encode_texts(query_concat_texts)  # 拼接句编码（行=句，α=1-β）
    semantic_sim = np.matmul(_qc_emb, _c_emb.T).astype(np.float32)

    # 纯 text 精排路径：仅当 β>0 才额外编码文案 matrix（0 时退化纯拼接，零额外成本）。
    text_sim = None
    if beta > 0.0:
        query_text_texts = [build_text_query_text(q) for q in queries]
        _qt_emb = AIModels.encode_texts(query_text_texts)  # 纯文案句编码（行=句，α=β）
        text_sim = np.matmul(_qt_emb, _c_emb.T).astype(np.float32)

    # 供后续按列定位切片：chunkId → 语义矩阵列下标
    chunk_order = {cid: idx for idx, cid in enumerate(chunk_ids)}

    # ---- 2. 逐句逐候选算贴合分并转负向代价 ----
    sem_norm = _read_sem_norm_mode()
    result: Dict[str, Dict[str, float]] = {}
    _beta_changed_n = 0        # DIAG 统计：β>0 时相较纯拼接 Top-1 发生变更的句数
    _norm_changed_n = 0        # DIAG 统计：量纲对齐前后综合 Top-1 发生变更的句数
    _comb_top1_sem_ranks = []  # DIAG 统计：综合 Top-1 切片的候选内语义名次（1=语义第一即综合第一）
    _cand_pool_sizes = []      # DIAG 统计：候选池大小分布

    def _calc_row(cands: list, sem_values: List[float]) -> tuple:
        """按给定语义分序列算综合代价行（供原始/归一化两版复用）。

        Args:
            cands: 本句候选元组列表 (cid, sem, duration, emotion, role)。
            sem_values: 与 cands 等长的语义分序列（原始或归一化）。

        Returns:
            tuple: (row {cid: cost}, 综合最优 cid)。
        """
        row: Dict[str, float] = {}
        _best_cid = None
        _best_cost = 1e9
        for i, (cid, _s, _d, _e, _r) in enumerate(cands):
            combined = _compute_combined_score(sem_values[i], _d, _e, _r, weights)
            row[cid] = 1.0 - float(combined)  # 正向分 → 负向代价
            if row[cid] < _best_cost:
                _best_cost = row[cid]
                _best_cid = cid
        return row, _best_cid

    for qi, query in enumerate(queries):
        sid = str(query['shotId'])
        cand_ids = cands_by_shotid.get(sid) or []
        if not cand_ids:
            continue  # 空候选：不产出代价行（交给束搜索跳过，不造假象）
        query_emotion = _query_emotion(query)
        query_roles = _char_ids_of_query(query)
        t_audio_ms = float(query.get('audioDurationMs') or 0.0)

        # DIAG 基线：本句纯拼接语义分的 Top-1 候选（供「变化」对账，不改主流程）。
        _concat_best_cid = None
        if beta > 0.0:
            _concat_best_val = -1.0
            for cid in cand_ids:
                if cid not in chunk_order:
                    continue
                _v = float(semantic_sim[qi, chunk_order[cid]])
                if _v > _concat_best_val:
                    _concat_best_val = _v
                    _concat_best_cid = cid

        # 逐候选收集：β 融合语义分 + 时长/情绪/角色分（一次计算，供两版语义序列复用）。
        cands: list = []
        for cid in cand_ids:
            chunk = chunk_by_id.get(cid)
            if chunk is None:
                raise ContractError(f'MatchCost: 候选切片 {cid} 不在资产索引中')
            ci = chunk_order[cid]
            sem_score = float(semantic_sim[qi, ci])
            # P1′-a 精排融合：β=1.0 → 纯 text；β=0 → 纯拼接；中间 → 线性混合。
            if beta > 0.0 and text_sim is not None:
                sem_score = float((1.0 - beta) * sem_score + beta * float(text_sim[qi, ci]))

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

            cands.append((cid, sem_score, duration_penalty, emotion_score, role_score))

        # 方向2 量纲对齐：候选内 min-max 归一化后参与综合分（不改语义排序，只重排相对权重）。
        raw_sems = [c[1] for c in cands]
        norm_sems = _norm_cand_sem(raw_sems) if sem_norm != 'off' else raw_sems
        row, _best_cid = _calc_row(cands, norm_sems)
        result[sid] = row

        # DIAG：β 融合后语义主分 Top-1 相对纯拼接发生变更的句数（可测量精排是否翻盘）。
        if beta > 0.0 and _concat_best_cid is not None and _best_cid is not None \
                and _best_cid != _concat_best_cid:
            _beta_changed_n += 1
        # DIAG：量纲对齐前后综合 Top-1 变更 + 综合 Top-1 的候选内语义名次分布（回答「墙在哪」：
        #   r1 占比高 ⇒ 语义第一即综合第一，墙在语义判别本身；占比低 ⇒ 被其他因子翻盘，量纲/权重可调）。
        if sem_norm != 'off':
            _row_raw, _best_raw = _calc_row(cands, raw_sems)
            if _best_raw != _best_cid:
                _norm_changed_n += 1
        _cand_pool_sizes.append(len(cand_ids))
        _best_sem = next(c[1] for c in cands if c[0] == _best_cid)
        _comb_top1_sem_ranks.append(1 + sum(1 for s in raw_sems if s > _best_sem))

    # DIAG 对账（P1′-a 精排 + 方向2 量纲对齐可测量性）：落盘开关生效统计，供离线核对。
    import sys
    import statistics as _stats
    _diag_parts = [f"[text-rerank] β={beta:.3f} desc_aug={'on' if desc_aug else 'off'} "
                   f"候选内语义主分融合生效",
                   f"_beta_changed_top1={_beta_changed_n}/{len(result)}"]
    if _cand_pool_sizes:
        _pool_med = _stats.median(_cand_pool_sizes)
        _rank1 = sum(1 for r in _comb_top1_sem_ranks if r == 1)
        _rank3 = sum(1 for r in _comb_top1_sem_ranks if r <= 3)
        _diag_parts.append(
            f"[sem-norm] mode={sem_norm} 候选池len: min={min(_cand_pool_sizes)} "
            f"med={_pool_med:.0f} max={max(_cand_pool_sizes)} | 综合Top1语义名次: "
            f"r1={_rank1}/{len(_comb_top1_sem_ranks)} r<=3={_rank3}/{len(_comb_top1_sem_ranks)}"
            + (f" | 归一化前后综合Top1变更={_norm_changed_n}/{len(result)}"
               if sem_norm != 'off' else ""))
    print(" ".join(_diag_parts), file=sys.stderr)

    # 及时释放大矩阵引用，缓解常驻内存。
    del semantic_sim, _qc_emb, _c_emb
    if text_sim is not None:
        del text_sim
    return result