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
    PRIMARY_SUBJECT_SENTINELS,
    default_chunk,
    default_query,
    derive_chunk_material,
    is_wide_scale_label,
    normalize_chunk_aliases,
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
    """🧩 帧描述并入（方案 B）：{ shotId: { chunkId: 帧级释义 } }，仅实体补召镜头（Node 侧下发）。
    供 match_cost 对该候选取 max(切片描述相似度, 帧描述相似度)；空 dict = 旧口径。"""
    frame_hints: Dict[str, Dict[str, str]] = field(default_factory=dict)


# ===========================================================================
# 装载基础资产
# ===========================================================================
def build_chunk_index(chunks: List[dict]) -> Dict[str, dict]:
    """建立切片资产 id → 切片 的唯一索引。

    Args:
        chunks: 切片资产列表（raw，来自输入契约 videoChunks）。

    Returns:
        Dict[str, dict]: {chunkId: chunk}，用 default_chunk 补齐缺省字段，并把
        生产者键名（shotType/scene/cameraMovement/colorHistogram）补空为契约键名。

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
        # 契约键名 ← 生产者键名「补空」（摄入边界单点归一，别名表见 montage_contract）：
        #   生产者链写 shotType/scene/cameraMovement/colorHistogram，契约写 shotScale/
        #   location/camera/colorHist，不补则 4 张卡的 availability 闸门永不开（实测全 0%）。
        normalize_chunk_aliases(chunk)
        # P4 方案 C：把「宽景 + 无主体」派生成空镜能力（materialType / isAbstractCapable），
        #   供抽象句只从空镜/B-Roll 池选。零模型、零新增摄入字段，开关缺省 on。
        if _read_empty_derive():
            derive_chunk_material(chunk)
        index[cid] = chunk
    _flag_critical_hero_assets(list(index.values()))
    return index


def _flag_critical_hero_assets(chunks: List[dict]) -> None:
    """求解前置 O(N) 纯统计：标记全局唯一的稀有料切片 isCriticalHeroAsset（补丁17，零模型）。

    判定口径：内容签名（primarySubject + keyProps + shotType 拼接）在整个切片库中**频次==1**
    即视为全局唯一稀有料，仅可由 priority:HIGH / PASS_OBJECT / FIRE_WEAPON 强取普通句禁用。

    不可造假门：签名任一维为空（该维未回填）则不参与判定 → isCriticalHeroAsset 保持 False，
    不会因缺失字段伪造门禁。频次统计为多源归约，无模型、无启发权重，可复现。

    补丁18 兼容：`primarySubject` 的哨兵值（`MULTIPLE`/`EMPTY`，非角色名）与空同口径处理——
    哨兵是"无人/无单一主控"的宣告，**不是**这条切片的稀有签名，若混入签名会让大量空镜/多人戏
    互相撞签而同批失去唯一性（假阴性）。故哨兵一律剔除该维后参与频次统计。

    Args:
        chunks: 已补齐缺省字段的切片列表（就地改写 isCriticalHeroAsset）。
    """
    from collections import Counter
    sigs: List[str] = []
    for c in chunks:
        parts = [
            '' if str(c.get(k) or '').strip() in PRIMARY_SUBJECT_SENTINELS
            else str(c.get(k) or '').strip()
            for k in ('primarySubject', 'keyProps', 'shotType')
        ]
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
                if key == 'emotion':
                    # 方案1（2026-10-21）：剔除 emotion 覆盖。工单 emotion 是英文枚举
                    #   （WARM/TENSE/JOYFUL/SAD/NEUTRAL），daemon 情绪归一表 EMOTION_CATEGORIES
                    #   全中文关键词，同名覆盖会把 query.emotion 中文原值（如「温馨」）替换成
                    #   「WARM」→ _normalize_emotion 匹配不到 → 恒归「中性」，情绪软排失效。
                    #   情绪维的正确输入是文案侧中文 emotion / moodIntent，工单情绪不落地。
                    continue
                if key in query:
                    query[key] = value
            # 🎬 键名错位对齐：ShotSpec 契约用 `mode`（NEW_SHOT/CONTINUE_PREV），
            #   daemon 契约字段是 `shotMode`（default_query 占位）。二者键名不同，
            #   上面的 `if key in query` 会静默丢弃 `mode` ⇒ B4 段内顺延读不到 shotMode
            #   而把 CONTINUE_PREV 句当 NEW_SHOT 抢 KM 名额（顺延队列恒空，§24.15-B4 失效）。
            if 'mode' in order and 'shotMode' in query:
                query['shotMode'] = order['mode']
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


def _read_drop_empty_desc() -> bool:
    """读取「空描述切片剔除」开关（env `ZENTECT_KM_DROP_EMPTY_DESC`，缺省 on）。

    依据（2026-10-22 实测）：705 切片里有 58 个 `description` 为空（8.2%），多为片头集数字幕/
    黑场/字卡。这些切片没有任何视觉语义可判，BGE 只能编码空串 ⇒ 语义分是噪声，却仍能中标
    （实测 chunk_322 空描述被 seg_8 / seg_21_sub_2 选中，即用户看到的「报第多少集」画面）。
    Node 侧 `stripUninformativeMatchSegments` 只清洗 **1134 段**，段退场后真正参选的 **705 切片**
    没有经过该清洗 ⇒ 缺口在此。

    Returns:
        bool: True 表示从候选池剔除空描述切片。
    """
    import os
    return str(os.environ.get('ZENTECT_KM_DROP_EMPTY_DESC', '1')).strip().lower() not in ('0', 'off', 'false')


def _drop_empty_desc(cands: List[str], chunk_by_id: Dict[str, dict],
                     sid: str, drop_stat: dict) -> List[str]:
    """剔掉描述为空的候选（结构性事实：无视觉语义不可判），并计数。

    Q1 不变量：**仅当剔除后仍有候选才剔除**；整池皆空描述 ⇒ 原样保留（不制造空中池），
    只计入 `all_empty` 暴露缺料。

    Args:
        cands: 本句候选 id 列表。
        chunk_by_id: 切片索引。
        sid: 句 id（诊断用）。
        drop_stat: 只读统计容器 {'dropped': 0, 'sentences': [], 'all_empty': 0}。

    Returns:
        List[str]: 过滤后的候选（可能等于入参）。
    """
    if not cands:
        return cands
    kept = [cid for cid in cands
            if str((chunk_by_id.get(cid) or {}).get('description') or '').strip()]
    if not kept:
        drop_stat['all_empty'] += 1
        return cands
    if len(kept) < len(cands):
        drop_stat['dropped'] += len(cands) - len(kept)
        drop_stat['sentences'].append(sid)
    return kept


# ---------------------------------------------------------------------------
# 抽象句宽景硬过滤（B1，2026-10-22）+ 空镜优先（P4 / 方案 C，2026-10-22）
#   背景：方案 B 已让 S2 对抽象/评论句声明 LONG_SHOT，但 daemon 里景别只是 ±0.04 软阻尼 ⇒
#   实测扩池 60/48 后宽景**已在池中**（seg_2 全景 6、seg_4 全景 8、seg_21 全景 2），
#   5 句仍只有 1 句落宽景（语义分差远大于 0.04）⇒ 软阻尼指望不上。
#   口径（两级，先紧后松）：
#     ① 空镜优先：池内存在 **≥2** 个 `isAbstractCapable` 候选 ⇒ 只留它们（方案 C 的目标态）；
#        仅 1 个空镜候选时**不独占**——实测 3 条相邻抽象句的池里各只有 1 个空镜，
#        收紧后整段三句全押同一片（chunk_533 三个窗口 [2130929,2132098/2132316/2132729] 连续重叠，
#        同一画面重复播放三次）。此时回退宽景，让束搜索在「空镜 + 其他宽景」里分散选片。
#     ② 回退宽景：池内无空镜候选（或仅 1 个）⇒ 按 B1 收紧到宽景带；宽景也没有 ⇒ 原样保留，不制造空池。
#   结构性剔除而非数值罚：罚会被后续任何归一化稀释。
#   开关：`ZENTECT_KM_ABSTRACT_WIDE`（B1，缺省 on）、`ZENTECT_KM_EMPTY_DERIVE`（P4，缺省 on）、
#         `ZENTECT_KM_ABSTRACT_GLOBAL_POOL`（P4 扩充，缺省 on）。
#   P4 扩充（2026-10-23）：抽象句的候选池先被 Node 侧 candidateIds / 段域窗口裁到 3~24 片，
#   池内常只剩 1 个空镜 ⇒ 5/6 句只能回退宽景。抽象句的画面语义本就与前后剧情独立，
#   故在抽象句上并入**全片空镜池**（isAbstractCapable），再由两级过滤收敛，真正用上空镜。
# ---------------------------------------------------------------------------
def _read_abstract_wide() -> bool:
    """读取「抽象句宽景硬过滤」开关（env `ZENTECT_KM_ABSTRACT_WIDE`，缺省 on）。

    Returns:
        bool: True 表示对抽象句收紧到宽景候选。
    """
    import os
    return str(os.environ.get('ZENTECT_KM_ABSTRACT_WIDE', '1')).strip().lower() not in ('0', 'off', 'false')


def _read_empty_derive() -> bool:
    """读取「空镜/B-Roll 派生标注」开关（env `ZENTECT_KM_EMPTY_DERIVE`，缺省 on）。

    Returns:
        bool: True 表示在切片摄入时派生 materialType / isAbstractCapable。
    """
    import os
    return str(os.environ.get('ZENTECT_KM_EMPTY_DERIVE', '1')).strip().lower() not in ('0', 'off', 'false')


def _read_abstract_global_pool() -> bool:
    """读取「抽象句并入全片空镜池」开关（env `ZENTECT_KM_ABSTRACT_GLOBAL_POOL`，缺省 on）。

    Returns:
        bool: True 表示抽象句在自身候选池之外，额外并入全片 `isAbstractCapable` 切片。
    """
    import os
    return str(os.environ.get('ZENTECT_KM_ABSTRACT_GLOBAL_POOL', '1')).strip().lower() not in ('0', 'off', 'false')


def _is_wide_scale(chunk: dict) -> bool:
    """判断切片是否属宽景（远景带或空镜）。

    Args:
        chunk: 切片实体（shotScale / shotType 中文标签）。

    Returns:
        bool: True = 宽景（可承载抽象/评论句）。
    """
    return is_wide_scale_label(chunk.get('shotScale') or chunk.get('shotType') or '')


def _is_abstract_capable(chunk: dict) -> bool:
    """判断切片是否可作空镜/B-Roll（P4 派生标注 `isAbstractCapable`）。

    Args:
        chunk: 切片实体（已过摄入期派生）。

    Returns:
        bool: True = 可承载抽象句的空镜候选。
    """
    return chunk.get('isAbstractCapable') is True


def _abstract_wide_filter(cands: List[str], chunk_by_id: Dict[str, dict],
                          sid: str, stat: dict) -> List[str]:
    """抽象句收紧：优先空镜（isAbstractCapable），无空镜回退宽景，两者皆无则原样保留。

    Args:
        cands: 本句候选 id 列表。
        chunk_by_id: 切片索引。
        sid: 句 id（诊断用）。
        stat: 统计容器 {'capable': 0, 'capable_dropped': 0, 'tightened': 0,
                       'dropped': 0, 'no_wide': 0, 'capable_sentences': [], 'sentences': []}。

    Returns:
        List[str]: 过滤后的候选（可能等于入参）。
    """
    if not cands:
        return cands
    capable = [cid for cid in cands if _is_abstract_capable(chunk_by_id.get(cid) or {})]
    if len(capable) >= 2:
        if len(capable) < len(cands):
            stat['capable_dropped'] += len(cands) - len(capable)
            stat['capable_sentences'].append(sid)
        stat['capable'] += 1
        return capable
    if capable:
        # 仅 1 个空镜：不独占（会整段重复同一画面），回退宽景（空镜本身在宽景超集里）。
        stat['capable_single'] += 1
    wide = [cid for cid in cands if _is_wide_scale(chunk_by_id.get(cid) or {})]
    if not wide:
        stat['no_wide'] += 1
        return cands
    if len(wide) < len(cands):
        stat['dropped'] += len(cands) - len(wide)
        stat['sentences'].append(sid)
    stat['tightened'] += 1
    return wide


# ===========================================================================
# 候选池快照（取证开关，默认关闭：零行为变化）
#   目的：回答「选片差是池里没有，还是排序选错」——把每句的真实候选池 + 切片属性落盘，
#   与最终 matchResults 按 shotId 关联即可离线量化「正确镜头是否进池」「选中片在池内排名」。
#   开关：`ZENTECT_KM_POOL_DUMP` ∈ 1/on/true（缺省 off）；目录 `ZENTECT_KM_POOL_DUMP_DIR`
#   缺省 <repo>/data/_diag_dump。写盘失败只告警不中断（观测设施不参与生产正确性）。
# ===========================================================================
def _read_pool_dump() -> bool:
    """读取候选池快照开关（env `ZENTECT_KM_POOL_DUMP`，缺省 off）。

    Returns:
        bool: True 表示落盘候选池快照。
    """
    import os
    return str(os.environ.get('ZENTECT_KM_POOL_DUMP', '0')).strip().lower() in ('1', 'on', 'true')


def _pool_dump(ctx: CandidateContext, pool_source: Dict[str, str], req: dict) -> None:
    """把候选池与切片属性写入 JSON 快照（仅开关 on 时调用）。

    Args:
        ctx: 已构建完成的候选池上下文。
        pool_source: {shotId: 'candidateIds' | 'segment' | 'all'}，标明该句候选来源。
        req: 原始 SegmentRequest（仅取 projectId 做文件名/归属）。
    """
    import json
    import os
    import time

    out_dir = os.environ.get('ZENTECT_KM_POOL_DUMP_DIR') or os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
        'data', '_diag_dump')
    pid = str(req.get('projectId') or req.get('project_id') or 'req')
    ts = time.strftime('%Y%m%d-%H%M%S')
    path = os.path.join(out_dir, f'pool-{pid}-{ts}.json')

    _chunk_fields = ('shotScale', 'shotType', 'cameraMovement', 'scene', 'primarySubject',
                     'characters', 'emotion', 'startMs', 'endMs', 'parentChunkId',
                     'motionScore', 'description', 'materialType', 'isAbstractCapable')
    chunks = {cid: {k: c.get(k) for k in _chunk_fields} for cid, c in ctx.chunk_by_id.items()}
    queries = []
    for q in ctx.queries:
        sid = str(q.get('shotId'))
        queries.append({
            'shotId': sid,
            'text': q.get('text') or '',
            'visualIntent': q.get('visualIntent') or '',
            'isAbstractNarration': bool(q.get('isAbstractNarration')),
            'segmentId': q.get('segmentId') or 0,
            'preferredShot': q.get('preferredShot') or '',
            'cameraDynamic': q.get('cameraDynamic') or '',
            'spatialType': q.get('spatialType') or '',
            'targetSubjects': q.get('targetSubjects') or [],
            'keyProp': q.get('keyProp') or '',
            'actionType': q.get('actionType') or '',
            'poolSource': pool_source.get(sid, ''),
            'candidateIds': list(ctx.cands_by_shotid.get(sid) or []),
        })
    payload = {'generatedAt': ts, 'projectId': pid, 'queries': queries, 'chunks': chunks}

    try:
        os.makedirs(out_dir, exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(payload, f, ensure_ascii=False)
    except OSError as exc:
        print(f'[pool-dump] ⚠️ 写盘失败（不中断求解）: {exc}')
        return
    _sizes = [len(x['candidateIds']) for x in queries]
    _src = {s: sum(1 for v in pool_source.values() if v == s) for s in ('candidateIds', 'segment', 'all')}
    print(f'[pool-dump] 句={len(queries)} 切片={len(chunks)} ｜ 候选池 med={sorted(_sizes)[len(_sizes) // 2] if _sizes else 0} '
          f'min={min(_sizes) if _sizes else 0} max={max(_sizes) if _sizes else 0} ｜ '
          f'来源 candidateIds={_src["candidateIds"]} 段域={_src["segment"]} 全池={_src["all"]} ｜ 文件={path}')


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
    # 候选来源计数（仅随快照开关消费，off 档只多一次字符串赋值，无行为变化）。
    pool_source: Dict[str, str] = {}
    # 空描述剔除统计（缺省 on；见 `_read_drop_empty_desc`）。
    drop_empty = _read_drop_empty_desc()
    drop_stat = {'dropped': 0, 'sentences': [], 'all_empty': 0}
    # 抽象句宽景硬过滤统计（缺省 on；见 `_read_abstract_wide`）。
    abstract_wide = _read_abstract_wide()
    # 抽象句并入全片空镜池（缺省 on；见 `_read_abstract_global_pool`）。
    abstract_global_pool = abstract_wide and _read_abstract_global_pool()
    wide_stat = {'capable': 0, 'capable_single': 0, 'capable_dropped': 0, 'capable_sentences': [],
                 'tightened': 0, 'dropped': 0, 'no_wide': 0, 'sentences': [],
                 'global_injected': 0, 'global_sentences': []}
    ctx = CandidateContext(
        queries=[],
        chunk_by_id=chunk_by_id,
        seg_by_id=seg_by_id,
        batch_orders=list(orders),
        frame_hints=req.get('frameHints') or {},
    )

    for query in merged:
        resolved = resolve_source_ref_time(query, seg_by_id)
        sid = str(resolved['shotId'])
        cands = build_candidates_for_query(resolved, chunk_by_id, seg_by_id)
        cid_list = cand_override.get(sid)
        if cid_list:
            cands = [str(c) for c in cid_list if str(c) in chunk_by_id]
            pool_source[sid] = 'candidateIds'
        else:
            # 方向2 软偏袒仅作用于未显式声明候选行域的句：按剧情锚点所在自动场重排（优先排序，非排除）。
            cands = _soft_rank_auto_scene(cands, resolved, auto_segs, chunk_by_id)
            pool_source[sid] = 'segment' if _scene_of_query(resolved) > 0 else 'all'
        ctx.queries.append(resolved)
        if abstract_global_pool and bool(resolved.get('isAbstractNarration')):
            # P4 扩充：抽象句并入全片空镜池（仅当全片空镜 ≥2，避免用单片反复押同一画面）。
            global_empty = [cid for cid, c in chunk_by_id.items() if _is_abstract_capable(c)]
            if len(global_empty) >= 2:
                before = len(cands)
                seen = set(cands)
                cands = cands + [cid for cid in global_empty if cid not in seen]
                if len(cands) > before:
                    wide_stat['global_injected'] += 1
                    wide_stat['global_sentences'].append(sid)
        if drop_empty:
            cands = _drop_empty_desc(cands, chunk_by_id, sid, drop_stat)
        if abstract_wide and bool(resolved.get('isAbstractNarration')):
            cands = _abstract_wide_filter(cands, chunk_by_id, sid, wide_stat)
        ctx.cands_by_shotid[sid] = cands
        ctx.shotid_to_segment[sid] = _scene_of_query(resolved)
    if abstract_wide and (wide_stat['capable'] or wide_stat['tightened'] or wide_stat['capable_single'] or wide_stat['global_injected']):
        print(f'[abstract-empty] 空镜优先句={wide_stat["capable"]} ｜ 剔除非空镜候选={wide_stat["capable_dropped"]} '
              f'｜ 仅1个空镜回退宽景={wide_stat["capable_single"]} ｜ 无空镜且无宽景(原样保留)={wide_stat["no_wide"]} '
              f'｜ 全片空镜池注入={wide_stat["global_injected"]} ｜ 示例={wide_stat["capable_sentences"][:5]}')
    if abstract_wide and wide_stat['tightened']:
        print(f'[abstract-wide] 回退宽景收紧句={wide_stat["tightened"]} ｜ 剔除非宽景候选={wide_stat["dropped"]} '
              f'｜ 池内无宽景(原样保留)={wide_stat["no_wide"]} ｜ 示例={wide_stat["sentences"][:5]}')
    if drop_empty and drop_stat['dropped']:
        print(f'[empty-desc] 剔除空描述候选={drop_stat["dropped"]} ｜ 受影响句={len(drop_stat["sentences"])} '
              f'｜ 整池皆空描述(原样保留)={drop_stat["all_empty"]} ｜ 示例={drop_stat["sentences"][:5]}')
    elif drop_empty and drop_stat['all_empty']:
        print(f'[empty-desc] 无剔除 ｜ 整池皆空描述(原样保留)={drop_stat["all_empty"]}')
    if _read_pool_dump():
        _pool_dump(ctx, pool_source, req)
    return ctx