# -*- coding: utf-8 -*-
"""
build_context.py —— 标准候选池构建（§8.5.3 三段式中「纯数据、零规则」）

职责：
  1. 读取工单（storyboard_orders.json）+ 场次（segments.json）+ 脚本句 + 切片资产。
  2. 将 ShotSpec 工单字段合入对应脚本句（按 matchUnitId 对齐）。
  3. 解析剧情锚点 sourceRefTimeMs（补丁9：segments[sourceSceneId].startMs 查表，绝对物理坐标）。
  4. 为每个脚本句构建「标准候选池」：段内切片 ∪ 时空门禁（补丁全区段段落口径）。

不变量（守 Q1「错就错」）：
  - 候选池 = 真实可用切片集合的**忠实投影**，缺则空、空则空，绝不兜底编造。
  - 空候选是合法结果：束搜索对该句不产出分配（对应「旧7空段在新引擎必0」验收）。
  - 唯一的数据加工只有「查表映射」与「按 id 索引」，不掺任何打分/规则。

本模块不 import 其它新引擎模块，只吃 montage_contract（契约唯一权威）。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional

from montage_contract import (
    ContractError,
    default_chunk,
    default_query,
    require_field,
)


# ===========================================================================
# 标准候选池上下文（build_context 的唯一产出）
# ===========================================================================
@dataclass
class CandidateContext:
    """一次求解的标准输入上下文（纯数据容器，被 beam_search 消费）。

    Attributes:
        queries: 归一化脚本句列表（已合入工单字段 + 已解析 sourceRefTimeMs）。
        chunk_by_id: 切片资产索引 {chunkId: chunk}。
        seg_by_id: 场次索引 {segmentId: segment}。
        cands_by_shotid: 每句的候选切片 id 列表 {shotId: [chunkId]}。
        shotid_to_segment: 每句所属场次 {shotId: segmentId}。
        batch_orders: 本次装载的工单列表（shot 明细），供 trace。
    """
    queries: List[dict] = field(default_factory=list)
    chunk_by_id: Dict[str, dict] = field(default_factory=dict)
    seg_by_id: Dict[int, dict] = field(default_factory=dict)
    cands_by_shotid: Dict[str, List[str]] = field(default_factory=dict)
    shotid_to_segment: Dict[str, int] = field(default_factory=dict)
    batch_orders: List[dict] = field(default_factory=list)


# ===========================================================================
# 装载基础资产
# ===========================================================================
def build_chunk_index(chunks: List[dict]) -> Dict[str, dict]:
    """建立切片资产 id → 切片 的唯一索引。

    Args:
        chunks: 切片资产列表（raw，来自输入契约 videoChunks）。

    Returns:
        Dict[str, dict]: {chunkId: chunk}，用 default_chunk 补齐缺省字段。

    Raises:
        ContractError: 存在重复 id 或切片缺 id（数据唯一性被破坏时必须暴露）。
    """
    index: Dict[str, dict] = {}
    for raw in chunks or []:
        cid = str(require_field(raw, 'id'))
        if cid in index:
            raise ContractError(f'切片 id 重复: {cid}')
        chunk = default_chunk()
        chunk.update(raw)
        index[cid] = chunk
    _flag_critical_hero_assets(list(index.values()))
    return index


def _flag_critical_hero_assets(chunks: List[dict]) -> None:
    """求解前置 O(N) 纯统计：标记全局唯一的稀有料切片 isCriticalHeroAsset（补丁17，零模型）。

    判定口径：内容签名（primarySubject + keyProps + shotType 拼接）在整个切片库中**频次==1**
    即视为全局唯一稀有料，仅可由 priority:HIGH / PASS_OBJECT / FIRE_WEAPON 强取普通句禁用。

    不可造假门：签名任一维为空（该维未回填）则不参与判定 → isCriticalHeroAsset 保持 False，
    不会因缺失字段伪造门禁。频次统计为多源归约，无模型、无启发权重，可复现。

    Args:
        chunks: 已补齐缺省字段的切片列表（就地改写 isCriticalHeroAsset）。
    """
    from collections import Counter
    sigs: List[str] = []
    for c in chunks:
        parts = [str(c.get(k) or '').strip() for k in ('primarySubject', 'keyProps', 'shotType')]
        sigs.append('|'.join(p for p in parts if p))
    counter = Counter(s for s in sigs if s)
    for c, s in zip(chunks, sigs):
        c['isCriticalHeroAsset'] = bool(s and counter[s] == 1)


def build_segment_index(segments: List[dict]) -> Dict[int, dict]:
    """建立场次 segmentId → 场次 的唯一索引。

    Args:
        segments: 场次列表（raw，来自 segments.json / 输入契约 segments）。

    Returns:
        Dict[int, dict]: {segmentId: segment}。

    Raises:
        ContractError: 场次缺 segmentId 或重复。
    """
    index: Dict[int, dict] = {}
    for seg in segments or []:
        sid = int(require_field(seg, 'segmentId'))
        if sid in index:
            raise ContractError(f'场次 segmentId 重复: {sid}')
        index[sid] = seg
    return index


# ===========================================================================
# 工单合入与锚点解析
# ===========================================================================
def merge_orders_into_queries(
    queries: List[dict],
    orders: List[dict],
) -> List[dict]:
    """把 ShotSpec 工单字段合入对应脚本句（按 matchUnitId 精确对齐）。

    工单字段（mode/segmentId/spatialType/targetSubjects/preferredShot/
    cameraDynamic/emotion/audioMode/fallbackLevel/actionType/keyProp）与脚本句
    同源（同一母句），故以 matchUnitId 为 join key。

    Args:
        queries: 脚本句列表（含 matchUnitId）。
        orders: 工单列表（storyboard_orders.json）。

    Returns:
        List[dict]: 归一变完整的查询列表（缺工单的句保持原状，交由 spell 门禁/降级链处理）。

    Raises:
        ContractError: 工单缺 matchUnitId。
    """
    order_by_unit: Dict[str, dict] = {}
    for order in orders or []:
        uid = str(require_field(order, 'matchUnitId'))
        order_by_unit[uid] = order

    normalized: List[dict] = []
    for q in queries or []:
        query = default_query()
        query.update(q)
        uid = str(query.get('matchUnitId') or '')
        order = order_by_unit.get(uid)
        if order is not None:
            # 工单字段显式覆盖查询默认（工单为 S2/S3 的权威派工结果）。
            for key, value in order.items():
                if key in query:
                    query[key] = value
        normalized.append(query)
    return normalized


def resolve_source_ref_time(query: dict, seg_by_id: Dict[int, dict]) -> dict:
    """解析剧情锚点 sourceRefTimeMs（补丁9）并执行锁1 幻觉守卫（B域 §10.2.3 动作2）。

    两步：
      ① 锚点解析：query 显式有效 sourceRefTimeMs 直用；否则若 sourceSceneId 非空，
         取 segments[sourceSceneId].startMs 查表转译；两者皆无保留 0。
      ② 锁1 校验（忠实消费步骤3 真实参考帧，去幻觉，守「错就错」非兜底混淆）：
         - 越界守卫：0 ≤ refFrameTimeMs ≤ sourceDurationMs，越界判幻觉置 0（交由下方置信分级）。
         - 片头幻觉守卫（补丁4）：refFrameTimeMs 落入已裁片头 [0, trimStartMs) 判幻觉 += trimStartMs
           （步骤3 在 source 坐标里选帧，trimStart 前的帧属刚被裁掉的序场残影）。
      锁1 不改 sourceRefTimeMs（那仍是段锚），只对 refFrameTimeMs 做物理合法性校准；
      二者在束搜索消费时分层：refFrameSource=='matched' → 强锚 ±60s，否则退段锚。

    Args:
        query: 脚本句（合并工单后）。
        seg_by_id: 场次索引。

    Returns:
        dict: 已解析 sourceRefTimeMs + 已锁1 校验 refFrameTimeMs 的同一查询副本。
    """
    _q = dict(query)

    # --- ① 锚点解析（补丁9，原有逻辑）---
    if not (float(_q.get('sourceRefTimeMs') or 0) > 0):
        scene_id_str = str(_q.get('sourceSceneId') or '')
        if scene_id_str:
            digits = ''.join(ch for ch in scene_id_str if ch.isdigit())
            seg = seg_by_id.get(int(digits)) if digits else None
            if seg is not None:
                _q['sourceRefTimeMs'] = float(seg.get('startMs') or 0)

    # --- ② 锁1 校验（G 域 §10.2.8 动作3：权威已沉入契约 clamp_ref_frame，此处只委托，不重复实现）---
    from montage_contract import clamp_ref_frame
    _q = clamp_ref_frame(_q)
    return _q


# ===========================================================================
# 方向2：自动场次划分（软偏袒源，纯地理聚类注入）
# ===========================================================================
def _maybe_auto_segments(req: dict) -> List[dict]:
    """无有效手动场次时，从素材池透出的 sceneCuts 自动聚类宏观场次（软偏袒源）。

    触发条件：req['segments'] 为空或全部 segmentId==0（无 Sxx 手动场次）才参与，
    避免与 S3 手动工单（build_segment_index 现有口径）打架。
    数据源：缓存 PROJECT_MATERIAL_POOL[pool_key]['sceneCuts']（pool_key 沿用检测侧同构公式，
    与步骤1写入的素材池缓存 key 对齐，无需 Node 补传）。

    守「错就错」：读不到空池 / 切点不足（<2）⇒ 返回 []（合法退化，上游退 segmentId=0 全池），
    绝不 try/except 吞错、绝不编造切点。这只是「找不到数据就走全池」的设计多路径，非防御性兜底。

    Args:
        req: SegmentRequest 输入契约。

    Returns:
        List[dict]: 自动场次列表（含 auto=True），任一前置不满足返回 []。
    """
    segs_in = req.get('segments') or []
    if segs_in and any(int((s or {}).get('segmentId') or 0) != 0 for s in segs_in):
        return []  # 存在有效手动场次 ⇒ 自动划分不介入

    # 懒 import：避免模块顶层引入 ai_config 的副作用（保持本模块仅依赖契约）
    from ai_config import PROJECT_MATERIAL_POOL
    project_id = str(req.get('projectId') or '')
    media_id = str(req.get('mediaId') or '')
    pool_key = f"{project_id}:{media_id}" if project_id else (media_id or 'default')
    pool = PROJECT_MATERIAL_POOL.get(pool_key) or {}
    scene_cuts = pool.get('sceneCuts') or []
    if not isinstance(scene_cuts, list) or len(scene_cuts) < 2:
        return []  # 切点不足 ⇒ 合法退化回全池

    from auto_segment import auto_segment_scene_cuts
    from montage_contract import (
        AUTO_SEG_ID_OFFSET,
        AUTO_SEG_MAX_MS,
        AUTO_SEG_MIN_MS,
        AUTO_SEG_SWITCH_GAP_MS,
    )
    return auto_segment_scene_cuts(
        scene_cuts,
        min_scene_ms=AUTO_SEG_MIN_MS,
        max_scene_ms=AUTO_SEG_MAX_MS,
        switch_gap_ms=AUTO_SEG_SWITCH_GAP_MS,
        id_offset=AUTO_SEG_ID_OFFSET,
    )


def _soft_rank_auto_scene(
    cands: List[str],
    query: dict,
    auto_segs: List[dict],
    chunk_by_id: Dict[str, dict],
) -> List[str]:
    """对全池候选施自动场次软偏袒：仅按时间把命中 sourceRefTimeMs 所在场的切片排前。

    只调整排序（优先排序），**绝不排除场外候选**（非硬门禁、切错不锁候选池），顺序语义：
    「句剧情锚点落在哪个自动场 → 该场时间窗内的切片排在最前」，场外候选仅后置仍保留。
    源发原地不改，返回新列表；无锚点 / 无自动场 / 锚点落在场间缝隙 ⇒ 原序返回。

    Args:
        cands: 当前句候选切片 id 列表。
        query: 归一化脚本句（含已解 sourceRefTimeMs）。
        auto_segs: 自动场次列表（segmentId 递增，auto=True）。
        chunk_by_id: 切片资产索引。

    Returns:
        List[str]: 重排后的候选 id 列表（集合不变，仅顺序变化）。
    """
    ref = float(query.get('sourceRefTimeMs') or 0)
    if ref <= 0 or not auto_segs:
        return cands
    seg_in = next(
        (s for s in auto_segs if float(s['startMs']) <= ref < float(s['endMs'])),
        None,
    )
    if seg_in is None:
        return cands
    in_scene: List[str] = []
    out_scene: List[str] = []
    for cid in cands:
        cstart = float((chunk_by_id.get(cid) or {}).get('startMs') or 0)
        if float(seg_in['startMs']) <= cstart < float(seg_in['endMs']):
            in_scene.append(cid)
        else:
            out_scene.append(cid)
    return in_scene + out_scene


# ===========================================================================
# 候选池构建（时空物理漏斗，纯映射）
# ===========================================================================
def _scene_of_query(query: dict) -> int:
    """取一句所属场次号：query.segmentId 优先，缺省 0（未场次化）。

    Args:
        query: 归一化脚本句。

    Returns:
        int: 场次号；0 表示无场次约束（退全池）。
    """
    raw = query.get('segmentId')
    return int(raw) if raw else 0


def _chunk_scene(chunk: dict) -> int:
    """取切片所属场次号（切片资产在 assetization 阶段回填 segmentId）。

    Args:
        chunk: 切片资产。

    Returns:
        int: 切片所属场次；缺省 0（未归属）。
    """
    raw = chunk.get('segmentId')
    return int(raw) if raw else 0


def build_candidates_for_query(
    query: dict,
    chunk_by_id: Dict[str, dict],
    seg_by_id: Dict[int, dict],
) -> List[str]:
    """构建单句的标准候选池（时空物理漏斗 + 补丁10 定向越狱）。

    候选池口径（段域优先，§24.12）：
      1. 普通句：取 query 所属场次段内的全部切片（segmentId 精确匹配）。
      2. 补丁10 定向越狱句（isCrossSceneRecall）：额外并入 recallTargetSceneId
         场次的切片作临时合法候选。
      3. 未场次化句（segmentId=0）：候选=全池（无段域硬卡，退旧口径）。

    Args:
        query: 归一化脚本句。
        chunk_by_id: 切片索引。
        seg_by_id: 场次索引（未用，保留签名对称性，便于未来段内过滤扩展）。

    Returns:
        List[str]: 候选切片 id 列表（空列表=无可用候选，合法）。
    """
    scene = _scene_of_query(query)
    recall_scene = 0
    if query.get('isCrossSceneRecall'):
        rs = ''.join(ch for ch in str(query.get('recallTargetSceneId') or '') if ch.isdigit())
        recall_scene = int(rs) if rs else 0

    cands: List[str] = []
    for cid, chunk in chunk_by_id.items():
        cscene = _chunk_scene(chunk)
        if scene > 0 and cscene == scene:
            cands.append(cid)
        elif recall_scene > 0 and cscene == recall_scene:
            cands.append(cid)
        elif scene == 0:
            cands.append(cid)
    return cands


# ===========================================================================
# 对外主入口
# ===========================================================================
def build_req_context(req: dict) -> CandidateContext:
    """从输入契约 SegmentRequest 构建标准候选池上下文。

    流程：索引切片/场次 → 合入工单 → 解析锚点 → 逐句构建候选池。

    Args:
        req: SegmentRequest 输入契约（montage_contract.validate_request 已验证结构）。

    Returns:
        CandidateContext: 纯数据标准输入，供束搜索消费。

    Raises:
        ContractError: 关键资产缺失（缺口即抛，不兜底）。
    """
    queries = req.get('queries') or []
    if not queries:
        raise ContractError('build_context: 无脚本句可装配')

    chunk_by_id = build_chunk_index(req.get('videoChunks') or [])
    seg_by_id = build_segment_index(req.get('segments') or [])
    # 方向2：无有效手动场次时用物理切点自动聚类宏观场次（软偏袒源，退化不抛）。
    #   自动场次并入 seg_by_id，供"按 sourceSceneId 查表"（resolve_source_ref_time）与软排序消费。
    auto_segs = _maybe_auto_segments(req)
    for seg in auto_segs:
        seg_by_id[int(seg['segmentId'])] = seg
    orders = req.get('storyboardOrders') or req.get('orders') or []
    # CandidateIds（P2 #11 方案B，shotId → [chunkId]）：daemon 透传的真实候选行域。
    #   优先以此为每句候选池（与 legacy 同源，shadow A/B 才对账真实候选；该数据形态下既有
    #   段域漏斗恒空），仅当某句无候选声明时才落回段域漏斗/全池。严格取交集防脏候选混入。
    cand_override = req.get('candidateIds') or {}

    merged = merge_orders_into_queries(queries, orders)
    ctx = CandidateContext(
        queries=[],
        chunk_by_id=chunk_by_id,
        seg_by_id=seg_by_id,
        batch_orders=list(orders),
    )

    for query in merged:
        resolved = resolve_source_ref_time(query, seg_by_id)
        sid = str(resolved['shotId'])
        cands = build_candidates_for_query(resolved, chunk_by_id, seg_by_id)
        cid_list = cand_override.get(sid)
        if cid_list:
            cands = [str(c) for c in cid_list if str(c) in chunk_by_id]
        else:
            # 方向2 软偏袒仅作用于未显式声明候选行域的句：按剧情锚点所在自动场重排（优先排序，非排除）。
            cands = _soft_rank_auto_scene(cands, resolved, auto_segs, chunk_by_id)
        ctx.queries.append(resolved)
        ctx.cands_by_shotid[sid] = cands
        ctx.shotid_to_segment[sid] = _scene_of_query(resolved)
    return ctx