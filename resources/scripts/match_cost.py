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

from montage_contract import ATTR_TOTAL_CAP, ContractError, attribute_adherence_cost

# 复用旧 KM 求解器的纯标量打分助手（唯一打分口径来源，避免重复实现造成口径漂移）。
from timeline_solver import (
    ACTION_CLASSES,
    AIModels,
    ENTITY_CLASSES,
    _abstract_semantic_score,
    _action_of_chunk,
    _char_ids_of_chunk,
    _char_ids_of_query,
    _class_of_query,
    _compute_combined_score,
    _compute_duration_score,
    _compute_role_score,
    _emotion_compatibility,
    _prop_of_chunk,
    _shot_type_level,
    _smart_truncate_desc,
)


# ---------------------------------------------------------------------------
# 可供给时长口径（落码点3 乙案，开关 `ZENTECT_KM_SUPPLY_DUR`，缺省 off = 零行为变化）
#   问题：候选粒度 = 3.0s 切片（605 镜头切出 1613 候选段，单段上限 ≈3s）；时长契合分若只吃
#   「本段自身时长」，配音惯常 4~8s 的句子在候选池里人人「供不起」⇒ 只能在同样不合格的候选里挑
#   最不差的，导出侧再靠变速硬凑（实测 scene_001 1067ms vs 配音 4744ms ⇒ 4.45× 慢放）。
#   事实：605 镜头在源片上连续铺满 0 间断 ⇒ 同母块内**源时间连续**的子切片链可 1.0× 连播取满，
#   「素材不足」是伪命题，真问题在「用哪段时长当候选容量」的口径。
#   口径：可供给时长 = 本段时长 + 同母块内源时间连续（同 filePath、相邻间隔 ≤ SUPPLY_CHAIN_GAP_MS）
#   的后继段链合计。供得起 ⇒ 取子窗即够（无需变速）；供不起 ⇒ 如实按缺口计罚。
# ---------------------------------------------------------------------------
SUPPLY_CHAIN_GAP_MS = 100.0   # 源时间连续判据（与 SemanticAnalyzeStrategy 单位内切窗同口径）

# 乙案「可供给 ≥ 配音」约束（落码点3 近硬约束 → 2026-10-15 第1步 升级为结构性硬过滤）：
#   现状软惩罚权重（时长权重 0.22 × 曲线分差）太小 ⇒ 语义分一翻盘就选中「供不起」的片，
#   交付端再靠 ±3% clamp 硬凑 ⇒ 配音被截断（实测 6 句窗长远短于配音）。
#   旧口径：对「供不起」候选加 cost +100 的数值罚（成本 100 ≫ 其它分项之和），靠「数值差」取胜。
#   新口径（第1步，2026-10-15）：同一判据改为**结构性硬过滤**——本句存在可覆盖候选时，把供不起
#   候选从候选集里**直接剔除**（`build_match_cost` 内 `_kept = [c for c in cands if c[5]]`）。
#   升级动机：数值罚可以被后续任何归一化/权重调整稀释（罚成立性依赖 100 这个数），硬过滤是
#   结构性事实（候选集里根本没有它）⇒ 不变量「交付窗长 ≥ 配音时长」不再依赖打分标度。
#   取证：`候选供不起=68 ｜ 近硬约束生效句=40 ｜ 无候选可覆盖=0`（本项目 40 句全有可覆盖候选）
#   ⇒ 过滤后候选集必非空，不引入「空中池」（束搜索跳过该句 = 空段）的新失效态。
#   ⚠️ 仅当该句**存在**可覆盖候选时才过滤（全候选供不起 ⇒ 不过滤、不罚，逐字节退回现状、
#   保置信度量纲）；原声段（keepOriginalAudio）不适用（窗长由 ASR 段决定）⇒ 不判不过滤。


def _read_supply_dur() -> bool:
    """读取「可供给时长」口径开关（env `ZENTECT_KM_SUPPLY_DUR`，缺省 off）。

    off（缺省）= 零行为变化：时长契合仍按候选段自身时长计（现状、可一键回退）。
    on = 第二入参改用可供给时长（乙案主线），需经 L2 保真哨兵 + L3 25 段标注裁判后才可转缺省。

    Returns:
        bool: True 表示按可供给时长口径计分。
    """
    import os
    return str(os.environ.get('ZENTECT_KM_SUPPLY_DUR', '0')).strip().lower() in ('1', 'on', 'true')


def build_supply_ms(chunks: Dict[str, dict]) -> Dict[str, float]:
    """构建「切片 id → 可供给时长 ms」（乙案，落码点3；仅开关 on 档消费）。

    自后向前累加同母块内**源时间连续**的后继段链（同 filePath、相邻间隔 ≤ SUPPLY_CHAIN_GAP_MS），
    得到「本段起可 1.0× 连播的素材总长度」。缺 parentChunkId 的切片不进索引（调用方回退自身时长，
    不造假相邻关系）。

    Args:
        chunks: 切片资产索引 {chunkId: chunk}。

    Returns:
        Dict[str, float]: {chunkId: 可供给时长 ms}（仅含带 parentChunkId 的切片）。
    """
    by_parent: Dict[str, List[dict]] = {}
    for c in chunks.values():
        pid = str(c.get('parentChunkId') or '')
        if pid:
            by_parent.setdefault(pid, []).append(c)
    out: Dict[str, float] = {}
    for arr in by_parent.values():
        arr.sort(key=lambda c: float(c.get('startMs') or 0.0))
        tail = 0.0
        for i in range(len(arr) - 1, -1, -1):
            cur = arr[i]
            dur = max(0.0, float(cur.get('endMs') or 0.0) - float(cur.get('startMs') or 0.0))
            if i + 1 < len(arr):
                nxt = arr[i + 1]
                gap = float(nxt.get('startMs') or 0.0) - float(cur.get('endMs') or 0.0)
                if str(nxt.get('filePath') or '') == str(cur.get('filePath') or '') \
                        and abs(gap) <= SUPPLY_CHAIN_GAP_MS:
                    dur += tail     # 与后继链连续 ⇒ 合并（tail 已含后继链全部时长）
            tail = dur
            out[str(cur.get('id'))] = dur
    return out


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
#   ⚠️ 读键口径：`shotScale/location/camera` 在 KM 路径上由 `build_chunk_index` 的别名补空
#     （`shotType→shotScale`、`scene→location`、`cameraMovement→camera`，见 montage_contract
#     `CHUNK_KEY_ALIASES`）后**是有值的**；直接读 `projects.metadata.videoChunks` 原始键会误判为全空。
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


# ---------------------------------------------------------------------------
# 属性维「决胜带」（2026-10-20 方案1，开关 `ZENTECT_KM_ATTR_DECISIVE`，缺省 on）
#   问题（实测取证）：工单声明的画面属性（景别/运镜/空间/主体/道具/动作）此前只以 ±0.04/维、
#   整趟封顶 ±0.20 的软阻尼并入候选代价 —— 量纲不小，却对**最终选片零贡献**：以 2026-10-20
#   两次真实步骤5 运行为证（主体维命中 651→710，59 处 miss↔match 翻转），选片序列 81 段仍
#   **逐段完全相同**、综合 Top1 语义名次 r1 恒为 69/80。根因：软阻尼在**语义难分伯仲的近分簇**
#   里与其他候选同向平移（相对序不变），即便局部有差也被语义主分（权重 0.64）淹没。
#   做法：把属性贴合度按**本句 base 代价刻度**做带内放大 —— 仅当候选与「本句 base 最优」的差
#   ≤ `ATTR_DECISIVE_BAND`（语义上难分伯仲）时，属性权重按线性衰减放大（带中心 ×(1+1.6)，
#   衰减到带沿归零）。带外候选**逐字节保持原 ±0.20 软阻尼**（零行为变化）⇒ 语义差距明显时不
#   越带翻盘，只在近分簇内由工单声明的画面属性决定选谁。仍受 `ATTR_TOTAL_CAP` 归一（不引入新量纲）。
# ---------------------------------------------------------------------------
ATTR_DECISIVE_BAND = 0.10   # 近分带宽（base 代价差 ≤ 此值 ⇒ 视为「语义难分伯仲」）
ATTR_DECISIVE_GAIN = 0.12   # 带内额外放大上限（叠加在 ±ATTR_TOTAL_CAP 之上，带中心最大 ×1.6）


def _read_attr_decisive() -> bool:
    """读取「属性维决胜带」开关（env `ZENTECT_KM_ATTR_DECISIVE`，缺省 on）。

    缺省 on = 属性维在近分簇内参与决胜（用户 2026-10-20 明确要求，见本文件上方常量块取证件）；
    '0/off' = 零行为变化（逐字节回退「base + ±0.20 软阻尼」原口径），供 A/B 对账。

    Returns:
        bool: True 表示启用近分簇内的属性放大。
    """
    import os
    return str(os.environ.get('ZENTECT_KM_ATTR_DECISIVE', '1')).strip().lower() in ('1', 'on', 'true')


def _read_frame_desc() -> bool:
    """读取「帧描述并入」开关（env `ZENTECT_KM_FRAME_DESC`，缺省 on）。

    缺省 on = 对 Node 下发的帧证据候选取 `max(切片描述相似度, 帧描述相似度)`（方案 B）；
    '0/off' = 零行为变化（逐字节回退旧口径），供 A/B 对账。

    Returns:
        bool: True 表示启用帧描述并入。
    """
    import os
    return str(os.environ.get('ZENTECT_KM_FRAME_DESC', '1')).strip().lower() in ('1', 'on', 'true')


def _read_frame_primary() -> bool:
    """读取「帧描述唯一主力」开关（env `ZENTECT_KM_FRAME_PRIMARY`，缺省 on）。

    缺省 on（方案 D，2026-10-21）= 帧证据候选的语义分**直接取帧描述语义**（取代切片描述语义），
    切片描述仅作「无帧证据候选」的兜底（整片无帧索引 ⇒ frame_hints 空 ⇒ 整段回退切片描述旧口径）；
    '0/off' = 回退方案 B 的 max(切片, 帧) 只升不降口径，供 A/B 对账。

    Returns:
        bool: True 表示帧描述取代切片描述为唯一主力。
    """
    import os
    return str(os.environ.get('ZENTECT_KM_FRAME_PRIMARY', '1')).strip().lower() in ('1', 'on', 'true')


# ---------------------------------------------------------------------------
# 实体命中降代价（方案 C，2026-10-21）
#   目的：显式实体名词（照片/戒指/机票…）被 BGE 长句余弦淹没，切片描述又是「高频 top8」聚合、
#   天生丢低频实体 —— 即便帧描述已并入（方案 B），语义主分对「query 点名实体词 ↔ 候选含该词」
#   仍零奖励。于是 seg_2「越经不起一张照片的考验」即便帧召回捞到「墙面合影照片」镜头，
#   依然输给「女子侧脸说话」（cost 0.154 vs 0.284，gap 0.13 超决胜带）。
#   做法：候选文本（切片描述 **或** 帧描述）包含 query 命中的词表实体词 ⇒ 扣一小笔代价（离散可解释）。
#   词表与 TS 侧 FrameRecallService.FRAME_ENTITY_LEXICON 同源（48 词，只收画面可描述的具体物）。
#   零行为变化前提：query 未命中词表 / 开关 off ⇒ 整段不启用（逐字节回退旧口径）。
# ---------------------------------------------------------------------------
FRAME_ENTITY_LEXICON = (
    # 影像 / 纸本
    '照片', '相片', '拍立得', '合影', '贺卡', '报纸', '杂志', '卡片', '信封', '信纸', '日记',
    # 通信 / 数码
    '手机', '相机', '电话', '耳机',
    # 凭证 / 文书
    '证书', '票据', '机票', '车票', '登机牌', '护照', '合同', '文件', '名单', '病历', '超声',
    # 随身 / 容器
    '钱包', '现金', '钞票', '钥匙', '门卡', '行李箱', '行囊', '背包', '手提包', '礼物',
    # 餐饮 / 饰品 / 其它
    '酒杯', '酒瓶', '餐具', '咖啡', '戒指', '花束', '玫瑰', '口红', '眼镜', '手表', '药瓶', '绷带',
)
ENTITY_BOOST_REWARD = 0.15


def _read_entity_boost() -> bool:
    """读取「实体命中降代价」开关（env `ZENTECT_KM_ENTITY_BOOST`，缺省 on）。

    缺省 on = 候选文本（切片描述 或 帧描述）包含 query 命名实体词 ⇒ 代价扣 `ENTITY_BOOST_REWARD`；
    '0/off' = 零行为变化（逐字节回退旧口径），供 A/B 对账。

    Returns:
        bool: True 表示启用实体命中降代价。
    """
    import os
    return str(os.environ.get('ZENTECT_KM_ENTITY_BOOST', '1')).strip().lower() in ('1', 'on', 'true')


def _read_abstract_route() -> bool:
    """读取「抽象旁白分流」开关（env `ZENTECT_KM_ABSTRACT_ROUTE`，缺省 off）。

    on = 抽象句（`query.isAbstractNarration`）的语义主分改取景别分级抽象分
    （复用旧链 `_abstract_semantic_score`，单一真源），并跳过帧描述/实体/属性三类噪声信号。
    off（缺省）= 逐字节回退旧口径，一行回退；此时仍统计抽象句数量供取证，日志仅在 N>0 时输出。

    Returns:
        bool: True 表示启用抽象句景别先验分流。
    """
    import os
    return str(os.environ.get('ZENTECT_KM_ABSTRACT_ROUTE', '0')).strip().lower() in ('1', 'on', 'true')


def build_match_cost(
    queries: List[dict],
    chunk_by_id: Dict[str, dict],
    cands_by_shotid: Dict[str, List[str]],
    weights: Optional[dict] = None,
    text_beta: Optional[float] = None,
    sem_out: Optional[Dict[str, Dict[str, float]]] = None,
    frame_hints: Optional[Dict[str, Dict[str, str]]] = None,
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
        sem_out: 可选**只读导出**容器，就地填入 {shotId: {chunkId: 拼接口径语义分}}。
            供跨模态重排构候选盘排序用（对齐离线实验的 BGE 榜口径），**不参与任何生产代价计算**；
            不传（None）时零额外开销、零行为变化。
        frame_hints: 可选「帧证据」映射 {shotId: {chunkId: 帧级释义}}（方案 B，Node 侧实体补召下发）。
            命中候选的语义分取 `max(切片描述相似度, 帧描述相似度)` —— 只升不降；缺省/空 ⇒ 旧口径。

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
    # 方向3 前置检查（A/B 自诊断）：实体并入到底命中了几条切片。
    #   `_DESC_AUG_FIELDS` 里的 keyProps/weatherEnv **不在 default_chunk 契约**，只有上游真回填才有料；
    #   aug_hit=0 ⇒ desc_aug=on 与 off 逐字节等价，A/B 无判别力（先补上游字段，再谈收益）。
    _aug_hit = (sum(1 for cid, t in zip(chunk_ids, chunk_desc_texts)
                    if t != _build_chunk_semantic_text(chunk_by_id[cid], False))
                if desc_aug else 0)
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

    # ---- 1.5 帧描述并入（方案 B 只升不降 / 方案 D 唯一主力，2026-10-21）----
    #   根因（实测）：切片级描述会漏掉镜头内的关键瞬间 —— chunk_084 切片描述是「女子手持黑色卡片夹」，
    #   而它被帧召回命中的那一帧是「墙面展示合影照片」。只吃切片描述 ⇒ 靠帧证据进池的镜头在语义项
    #   上零支撑，seg_2「越经不起一张照片的考验」仍会选到说话镜头。
    #   方案 B：`sem = max(切片相似度, 帧描述相似度)`（只升不降，帧证据作为补充）。
    #   方案 D（缺省）：帧描述升**唯一主力**，直接取代切片描述语义；切片描述仅作无帧证据候选的兜底。
    #   零行为变化前提：无 frame_hints / 开关 off ⇒ 整段不启用（逐字节回退旧口径）。
    frame_on = _read_frame_desc() and bool(frame_hints)
    frame_primary = _read_frame_primary()   # 方案 D：帧描述取代切片（off 回退方案 B max）
    _fstat = {'cands': 0, 'lifted': 0, 'max_lift': 0.0, 'climbed': 0, 'replaced': 0}
    _frame_sem: Dict[tuple, float] = {}
    if frame_on:
        _qi_by_sid = {str(q.get('shotId')): i for i, q in enumerate(queries)}
        _items = []
        for _sid, _m in (frame_hints or {}).items():
            for _cid, _txt in (_m or {}).items():
                _t = str(_txt or '').strip()
                if _t and str(_cid) in chunk_order and str(_sid) in _qi_by_sid:
                    _items.append((str(_sid), str(_cid), _t))
        if _items:
            _fe = AIModels.encode_texts([t for _, _, t in _items])
            for _i, (_sid, _cid, _t) in enumerate(_items):
                _qi = _qi_by_sid[_sid]
                _sim = float(np.dot(_qc_emb[_qi], _fe[_i]))
                if beta > 0.0 and text_sim is not None:
                    _sim = float((1.0 - beta) * _sim + beta * float(np.dot(_qt_emb[_qi], _fe[_i])))
                _frame_sem[(_sid, _cid)] = _sim

    # ---- 2. 逐句逐候选算贴合分并转负向代价 ----
    sem_norm = _read_sem_norm_mode()
    result: Dict[str, Dict[str, float]] = {}
    _beta_changed_n = 0        # DIAG 统计：β>0 时相较纯拼接 Top-1 发生变更的句数
    _norm_changed_n = 0        # DIAG 统计：量纲对齐前后综合 Top-1 发生变更的句数
    _comb_top1_sem_ranks = []  # DIAG 统计：综合 Top-1 切片的候选内语义名次（1=语义第一即综合第一）
    _cand_pool_sizes = []      # DIAG 统计：候选池大小分布
    # 可供给时长口径（乙案，落码点3）：仅开关 on 档构建索引（off 档零开销、零行为变化）。
    supply_on = _read_supply_dur()
    _supply_ms = build_supply_ms(chunk_by_id) if supply_on else {}
    _supply_stat = {'short': 0, 'extended': 0, 'enforced': 0, 'none_cover': 0, 'filtered': 0}
    # 供不起候选数 / 可供给链长于自身的候选数 / 近硬约束实际生效句数 / 全候选供不起句数
    # / 被硬过滤剔除的供不起候选数（第1步 选片硬过滤，见下）
    # P5 结构化属性贴合（议题 D 的桥）：命中/落空/中性计数，供「属性命中率」诊断（只读统计容器）。
    _attr_stat = {'match': 0, 'miss': 0, 'neutral': 0}
    # 属性维决胜带（方案1，2026-10-20）：开关 + 只读诊断容器（flip=属性翻盘句数 / band_*=近分簇规模
    # / spans=行内属性跨度分布 / span0=属性全同值句数，即「放大也无判别力」的句数）。
    attr_decisive = _read_attr_decisive()
    _ad_stat = {'flip': 0, 'band_rows': 0, 'band_cands': 0, 'span0': 0, 'spans': []}
    # 实体命中降代价（方案 C）：开关 + 只读诊断容器（query_hits=命中实体句数 / cand_hits=被降代价候选数
    # / flip=降代价后综合 Top-1 被翻盘的句数）。
    entity_on = _read_entity_boost()
    _eb_stat = {'query_hits': 0, 'cand_hits': 0, 'flip': 0}
    # 抽象旁白分流（P1 方案 A，2026-10-21）：开关 + 只读诊断容器。
    #   queries=抽象句数（开关 off 也计，供取证）｜ routed=景别分实际生效句｜ pool_wide=候选含≥全景句
    #   ｜ pool_no_wide=候选全为近景句｜ hit_wide/hit_close=综合 Top-1 落在宽景/近景带句数
    #   ｜ no_level=存在无景别标记候选的句数。
    abstract_on = _read_abstract_route()
    _ar_stat = {'queries': 0, 'routed': 0, 'pool_wide': 0, 'pool_no_wide': 0,
                'hit_wide': 0, 'hit_close': 0, 'no_level': 0}

    def _calc_row(cands: list, sem_values: List[float], decisive: bool = False,
                  stat: Optional[dict] = None) -> tuple:
        """按给定语义分序列算综合代价行（供原始/归一化两版复用）。

        Args:
            cands: 本句候选元组列表 (cid, sem, duration, emotion, role, coverable, attr)。
            sem_values: 与 cands 等长的语义分序列（原始或归一化）。
            decisive: 是否启用属性维「决胜带」（近分簇内放大属性权重，见 `ATTR_DECISIVE_BAND`）。
            stat: 可选只读容器，就地写入本行的 `band`（近分带内候选数），供决胜诊断。

        Returns:
            tuple: (row {cid: cost}, 综合最优 cid)。
        """
        # base = 1 − 综合贴合分（语义/时长/情绪/角色），**不含属性**：决胜带以 base 差定「近分」。
        _bases = [1.0 - float(_compute_combined_score(sem_values[i], c[2], c[3], c[4], weights))
                  for i, c in enumerate(cands)]
        _base_best = min(_bases) if _bases else 0.0
        if stat is not None:
            stat['band'] = sum(1 for _b in _bases if _b - _base_best <= ATTR_DECISIVE_BAND)
        row: Dict[str, float] = {}
        _best_cid = None
        _best_cost = 1e9
        for i, (cid, _s, _d, _e, _r, _cov, _attr) in enumerate(cands):
            _a = float(_attr)
            cost = _bases[i] + _a  # P5 结构化属性贴合（软阻尼、封顶 ±0.20，绝不压过语义主分）
            # 属性维决胜带（方案1）：与「本句 base 最优」的差落在带内 ⇒ 属性权重线性放大到带沿归零。
            #   带外（差 > 带）恒 +0.00 ⇒ 逐字节保持原软阻尼口径（语义差距明显时属性不越带翻盘）。
            if decisive:
                _gap = _bases[i] - _base_best
                if _gap <= ATTR_DECISIVE_BAND:
                    cost += (ATTR_DECISIVE_GAIN * (_a / ATTR_TOTAL_CAP)
                             * (1.0 - _gap / ATTR_DECISIVE_BAND))
            row[cid] = cost
            if cost < _best_cost:
                _best_cost = cost
                _best_cid = cid
        return row, _best_cid

    for qi, query in enumerate(queries):
        sid = str(query['shotId'])
        # 🎬 抽象旁白分流（P1 方案 A）：抽象文本与任何具体画面低相关，BGE 相似度即噪声。
        #   `abstract_flag` 无论开关都统计（供「本片抽象句=N」取证）；真正改分仅开关 on。
        _abstract_flag = bool(query.get('isAbstractNarration'))
        _is_abstract = abstract_on and _abstract_flag
        if _abstract_flag:
            _ar_stat['queries'] += 1
        # 🔍 实体命中降代价（方案 C）：提取本句命中的词表实体词（开关 off / 零命中 ⇒ 空集，整句零开销）。
        #   抽象句禁用该通道：抽象文本里的词不指向画面实体，命中即假信号。
        _qi_entities = ([w for w in FRAME_ENTITY_LEXICON if w in query_concat_texts[qi]]
                        if entity_on and not _is_abstract else [])
        _hit_cids: set = set()
        if _qi_entities:
            _eb_stat['query_hits'] += 1
        cand_ids = cands_by_shotid.get(sid) or []
        if not cand_ids:
            continue  # 空候选：不产出代价行（交给束搜索跳过，不造假象）
        query_emotion = _query_emotion(query)
        query_roles = _char_ids_of_query(query)
        # 道具维「同表归一」（2026-10-09）：query.keyProp 自由文本 → ENTITY_CLASSES 类别名
        #   （与动态门禁 `_dynamic_gate` 同表同函数），使两侧落在同一坐标系后再比对。
        query_prop = _class_of_query(str(query.get('keyProp') or ''), ENTITY_CLASSES)
        # 动作维「同表归一」（2026-10-14）：query.actionType 自由文本 → ACTION_CLASSES 类别名
        #   （与动态门禁 `_dynamic_gate` 同表同函数，单一真源），使两侧落在同一坐标系后再比对。
        query_action = _class_of_query(str(query.get('actionType') or ''), ACTION_CLASSES)
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
        _cand_levels: list = []   # 抽象句诊断：本句各候选的景别等级（None=无景别标记）
        for cid in cand_ids:
            chunk = chunk_by_id.get(cid)
            if chunk is None:
                raise ContractError(f'MatchCost: 候选切片 {cid} 不在资产索引中')
            ci = chunk_order[cid]
            if _qi_entities:
                # 候选文本（切片描述 或 帧描述）包含任一本句命中实体词 ⇒ 标记为命中候选。
                _fb_txt = str(((frame_hints or {}).get(sid) or {}).get(cid) or '')
                if any(_w in chunk_desc_texts[ci] or _w in _fb_txt for _w in _qi_entities):
                    _hit_cids.add(cid)
            if _is_abstract:
                # 🎬 抽象旁白分流：语义主分 = 景别分级抽象分（空镜/全景/远景 0.90 ＞ 近景/特写 0.80
                #   ＞ 中景 0.55 ＞ 未识别 0.45），与旧链决策 #6 同表同函数（单一打分真源）。
                #   契约键优先：build_chunk_index 已由 CHUNK_KEY_ALIASES 把 shotType 补到 shotScale。
                _shot_label = str(chunk.get('shotScale') or chunk.get('shotType') or '')
                sem_score = _abstract_semantic_score(_shot_label)
                _cand_levels.append(_shot_type_level(_shot_label))
                # 重排盘导出同样给景别分（否则重排盘排序仍吃文本噪声）。
                if sem_out is not None:
                    sem_out.setdefault(sid, {})[cid] = sem_score
            else:
                sem_score = float(semantic_sim[qi, ci])
                # 🔬 跨模态重排候选盘排序用（可选只读导出，对齐离线 BGE 榜的拼接口径）。
                #   在 β 融合「之前」记录，导出的恒为拼接语义分；sem_out=None 时整段零开销。
                if sem_out is not None:
                    sem_out.setdefault(sid, {})[cid] = sem_score
                # P1′-a 精排融合：β=1.0 → 纯 text；β=0 → 纯拼接；中间 → 线性混合。
                if beta > 0.0 and text_sim is not None:
                    sem_score = float((1.0 - beta) * sem_score + beta * float(text_sim[qi, ci]))

                # 帧描述并入：帧证据候选的语义分来源（方案 D 取代 / 方案 B 只升不降）。
                #   抽象句不走此通道：帧描述是具体画面内容，对抽象文本同属噪声。
                _fs = _frame_sem.get((sid, str(cid)))
                if _fs is not None:
                    _fstat['cands'] += 1
                    if frame_primary:
                        _fstat['replaced'] += 1
                        sem_score = _fs          # 帧描述升唯一主力：直接取代切片描述语义
                    elif _fs > sem_score:
                        _fstat['lifted'] += 1
                        _fstat['max_lift'] = max(_fstat['max_lift'], _fs - sem_score)
                        sem_score = _fs

            # 时长契合（非对称裁剪友好型）
            c_start = float(chunk.get('startMs') or 0.0)
            c_end = float(chunk.get('endMs') or c_start)
            _eff_ms = c_end - c_start
            _coverable = True   # 可覆盖 = 可供给时长 ≥ 配音时长（off 档/原声段恒真，不参与罚）
            if supply_on:
                # 乙案（落码点3）：第二入参改用「可供给时长」（本段 + 同母块源时间连续后继链）。
                #   供得起（供应 ≥ 目标）⇒ 取子窗即够、无需变速 ⇒ 按曲线「正好够」档计（min 即该表达）；
                #   供不起 ⇒ 按真实可供给时长计罚（后果确为变速/截断，如实罚，不豁免不造假）。
                _sup_ms = float(_supply_ms.get(str(cid), _eff_ms) or _eff_ms)
                if _sup_ms < t_audio_ms:
                    _supply_stat['short'] += 1
                if abs(_sup_ms - _eff_ms) > 1e-6:
                    _supply_stat['extended'] += 1
                _coverable = _sup_ms >= t_audio_ms   # 供得起 ⇒ 本候选可覆盖本句配音
                _eff_ms = min(_sup_ms, t_audio_ms)
            duration_penalty = _compute_duration_score(t_audio_ms, _eff_ms)

            # 情绪相容度（切片情绪由步骤2 帧聚合而来）
            emotion_score = _emotion_compatibility(query_emotion, chunk.get('emotion') or '')

            # 角色契合（软排，绝不作硬门禁；union_suspect 粒度降权对齐旧口径）
            chunk_roles = _char_ids_of_chunk(chunk)
            role_score = _compute_role_score(query_roles, chunk_roles)
            if str(chunk.get('charGrain') or 'ok') == 'union_suspect':
                role_score = 0.5 + (role_score - 0.5) * 0.5

            # P5 结构化属性贴合（议题 D 的桥）：工单声明 ↔ 镜头属性逐维软阻尼，并入供给代价。
            #   主体维复用 char-id 桥（chunk_roles 同上）、道具维复用 ENTITY_CLASSES 类别桥
            #   （`_prop_of_chunk` 与动态门禁同表）——两维均不再跨坐标系裸比较（修伪惩罚）。
            #   抽象句跳过该通道：软阻尼与景别先验重复计分，且抽象句工单往往无逐维声明。
            if _is_abstract:
                _attr = 0.0
            else:
                chunk_prop = _prop_of_chunk(chunk)
                chunk_action = _action_of_chunk(chunk)
                _attr = attribute_adherence_cost(
                    query, chunk, _attr_stat,
                    query_roles=query_roles, chunk_roles=chunk_roles,
                    query_prop=query_prop, chunk_prop=chunk_prop,
                    query_action=query_action, chunk_action=chunk_action)
            cands.append((cid, sem_score, duration_penalty, emotion_score, role_score, _coverable, _attr))

        # 「可供给 ≥ 配音」约束判定（仅开关 on 档、非原声段）：
        #   本句存在任一可覆盖候选 ⇒ 供给约束成立（下游「硬过滤」剔除供不起候选）；
        #   全候选都供不起 ⇒ 约束不成立（不过滤、不罚，逐字节退回现状），仅计数 + 打日志暴露缺料。
        _koa = bool(query.get('keepOriginalAudio'))
        _any_cov = any(c[5] for c in cands)
        _apply_supply_penalty = supply_on and not _koa and _any_cov
        if supply_on and not _koa:
            _supply_stat['enforced' if _any_cov else 'none_cover'] += 1

        # 🛑 慢放修复·第1步「选片供给硬过滤」（2026-10-15）：把「可供给时长 ≥ 配音时长」从
        #   「罚 100 分」升级为结构性硬过滤——本句存在可覆盖候选时，供不起的候选**直接退出候选集**
        #   （不进 beam 展开、不进重排盘），不再依赖数值罚在后续任何归一/权重变动中继续成立。
        #   取证依据：`候选供不起=68 ｜ 近硬约束生效句=40 ｜ 无候选可覆盖=0`（本句 40 句全有可覆盖
        #   候选）⇒ 过滤后候选集必非空，不引入「空中池」（束搜索跳过该句 = 空段）的新失效态。
        #   回退口径（逐字节保现状）：全候选都供不起（`_any_cov=False`）⇒ **不过滤也不罚**，
        #   候选集与排序完全等于过滤前 —— 「按 supply 降序取最长、语义分作 tie-break」不在本轮，
        #   当前项目 0 例、无从测量，守「禁止未测量即上线」。原声段同样不判不滤（窗长由 ASR 决定）。
        if _apply_supply_penalty:
            _kept = [c for c in cands if c[5]]
            if len(_kept) < len(cands):
                _supply_stat['filtered'] += len(cands) - len(_kept)
                cands = _kept

        # 方向2 量纲对齐：候选内 min-max 归一化后参与综合分（不改语义排序，只重排相对权重）。
        #   抽象句豁免归一化：景别分是 0.90/0.80/0.55/0.45 的**绝对刻度**（旧链口径），
        #   min-max 会把同档候选拉平、把跨档放大成 1.0 vs 0.0，破坏景别先验的相对权重。
        raw_sems = [c[1] for c in cands]
        norm_sems = (raw_sems if _is_abstract or sem_norm == 'off'
                     else _norm_cand_sem(raw_sems))
        row, _best_cid = _calc_row(cands, norm_sems, attr_decisive)
        # 🔍 实体命中降代价（方案 C）：命中词表实体的候选扣 ENTITY_BOOST_REWARD，再取新的综合 Top-1。
        #   ⚠️ 不覆盖 `_best_cid`——其仍为 _calc_row 原始最优，供下方 β/量纲/属性决胜诊断正确归因。
        if _hit_cids:
            for _hc in _hit_cids:
                if _hc in row:
                    row[_hc] -= ENTITY_BOOST_REWARD
                    _eb_stat['cand_hits'] += 1
            _eb_best = min(row, key=row.get) if row else _best_cid
            if _eb_best != _best_cid:
                _eb_stat['flip'] += 1
        result[sid] = row

        # 🔍 属性维决胜诊断（只读）：回答「属性到底有没有参与决胜」——
        #   ① band = 本句近分带内候选数（≥2 才有决胜余地）；② flip = 属性放大后综合 Top-1 被翻盘的句数；
        #   ③ spans = 行内属性值跨度（全同值 ⇒ 该句属性毫无判别力，放大多少都不动排序）。
        #   抽象句不参与该口径（属性维已被跳过，计入会污染「属性命中率」诊断）。
        if not _is_abstract:
            _ad_row = {}
            _, _best_plain = _calc_row(cands, norm_sems, False, stat=_ad_row)
            if _best_plain != _best_cid:
                _ad_stat['flip'] += 1
            _ad_stat['band_cands'] += _ad_row.get('band', 0)
            if _ad_row.get('band', 0) >= 2:
                _ad_stat['band_rows'] += 1
            _attrs_row = [float(c[6]) for c in cands]
            _span_row = max(_attrs_row) - min(_attrs_row)
            _ad_stat['spans'].append(_span_row)
            if _span_row <= 1e-9:
                _ad_stat['span0'] += 1

        # 🎬 抽象旁白分流诊断（只读）：回答「景别先验到底有没有可用候选」——
        #   pool_no_wide 高 ⇒ 候选池全是近景（扩池问题，见方案档 D3）；no_level 高 ⇒ 先补景别覆盖。
        if _is_abstract:
            _ar_stat['routed'] += 1
            _lv_known = [l for l in _cand_levels if l is not None]
            if len(_lv_known) < len(_cand_levels):
                _ar_stat['no_level'] += 1
            if any(l >= 4 for l in _lv_known):
                _ar_stat['pool_wide'] += 1
            else:
                _ar_stat['pool_no_wide'] += 1
            _best_level = next((l for c, l in zip(cands, _cand_levels) if c[0] == _best_cid), None)
            if _best_level is not None and _best_level >= 4:
                _ar_stat['hit_wide'] += 1
            elif _best_level is not None and _best_level <= 2:
                _ar_stat['hit_close'] += 1

        # DIAG：β 融合后语义主分 Top-1 相对纯拼接发生变更的句数（可测量精排是否翻盘）。
        if beta > 0.0 and not _is_abstract and _concat_best_cid is not None and _best_cid is not None \
                and _best_cid != _concat_best_cid:
            _beta_changed_n += 1
        # DIAG：量纲对齐前后综合 Top-1 变更 + 综合 Top-1 的候选内语义名次分布（回答「墙在哪」：
        #   r1 占比高 ⇒ 语义第一即综合第一，墙在语义判别本身；占比低 ⇒ 被其他因子翻盘，量纲/权重可调）。
        #   抽象句豁免归一化 ⇒ 不参与「归一化前后变更」统计（否则是恒 0 的假样本）。
        if sem_norm != 'off' and not _is_abstract:
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
                   f"实体并入命中={_aug_hit}/{len(chunk_ids)} "
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
    # 可供给时长口径（乙案，落码点3）诊断：仅开关 on 时输出（off 档日志零变化，符合缺省零行为变化）。
    if supply_on:
        _diag_parts.append(
            f"[supply-dur] 乙案 on：时长契合改吃可供给时长 ｜ 候选供不起={_supply_stat['short']} "
            f"链长于自身={_supply_stat['extended']} ｜ 供给索引={len(_supply_ms)}/{len(chunk_ids)} 切片"
            f" ｜ 近硬约束生效句={_supply_stat['enforced']} ｜ 无候选可覆盖={_supply_stat['none_cover']}"
            f"｜ 硬过滤剔除候选={_supply_stat['filtered']}")
    # 帧描述并入诊断（方案 B）：回答「帧证据在打分侧到底兑现了多少」——
    #   候选数 / 实际被抬升数 / 最大抬升幅度（语义分绝对刻度）。
    if frame_on:
        _diag_parts.append(
            f"[frame-desc] 帧描述并入={'on' if _frame_sem else 'off(无帧证据候选)'} primary={'on' if frame_primary else 'off'} ｜ "
            f"帧证据候选={_fstat['cands']} 帧取代切片={_fstat['replaced']} 只升={_fstat['lifted']} "
            f"最大抬升={_fstat['max_lift']:.4f}")
    # 实体命中降代价诊断（方案 C）：仅开关 on 时输出（off 逐字节回退旧口径，日志零变化）。
    if entity_on:
        _diag_parts.append(
            f"[entity-boost] 实体命中降代价 on ｜ 命中实体句={_eb_stat['query_hits']}/{len(result)} "
            f"降代价候选={_eb_stat['cand_hits']} 翻盘句={_eb_stat['flip']}/{len(result)}")
    # 🎬 抽象旁白分流诊断（P1 方案 A）：开关 off 且无抽象句 ⇒ 不输出（日志零变化）；
    #   开关 off 但有抽象句 ⇒ 只打印计数（取证：回答「本片到底几句抽象」）。
    #   pool_no_wide 高 ⇒ 抽象句候选池全是近景（排序救不了，需扩池，见方案档 D3）。
    if abstract_on or _ar_stat['queries']:
        _ar_parts = [f"[abstract-route] {'on' if abstract_on else 'off(仅计数)'} 抽象句={_ar_stat['queries']}/{len(result)}"]
        if abstract_on:
            _ar_parts.append(
                f"景别分生效句={_ar_stat['routed']} ｜ 候选含宽景={_ar_stat['pool_wide']} "
                f"无宽景候选={_ar_stat['pool_no_wide']} 无景别标记={_ar_stat['no_level']} ｜ "
                f"命中宽景={_ar_stat['hit_wide']} 命中近景/特写={_ar_stat['hit_close']}")
        _diag_parts.append(' '.join(_ar_parts))
    # P5 属性贴合诊断（验收口径「属性命中率」）：仅在有信号时输出（零信号 = 两侧无声明，恒中性）。
    #   ⚠️ 容器除三个计数外还挂了 dims/samples 分账子树（2026-10-09），求和须只取整型项。
    _attr_total = sum(_v for _v in _attr_stat.values() if isinstance(_v, int))
    if _attr_total:
        _diag_parts.append(
            f"[attr-match] 属性贴合命中率: match={_attr_stat['match']}/{_attr_total} "
            f"miss={_attr_stat['miss']}/{_attr_total} neutral={_attr_stat['neutral']}/{_attr_total}")
        # 🔍 逐维分布（2026-10-09）：回答"落空的 2367 次到底在哪一维、值差在何处"。
        #   按 miss 降序，附 ≤2 组「声明值→候选值」样例，直接区分 枚举命名对不齐 / 切片侧缺值。
        _attr_dims = _attr_stat.get('dims') or {}
        if _attr_dims:
            _attr_samples = _attr_stat.get('samples') or {}
            _dim_txt = []
            for _dn, _dv in sorted(_attr_dims.items(), key=lambda kv: -kv[1]['miss']):
                _n = _dv['match'] + _dv['miss'] + _dv['neutral']
                _eg = '、'.join(f'{_a}→{_b}' for _a, _b in _attr_samples.get(_dn, [])[:2])
                _dim_txt.append(
                    f"{_dn}: 命中/落空/中性={_dv['match']}/{_dv['miss']}/{_dv['neutral']}"
                    f"(共{_n} 落空{(_dv['miss'] / _n * 100) if _n else 0:.0f}%)"
                    + (f" 例:{_eg}" if _eg else ""))
            _diag_parts.append('[attr-dim] 逐维分布(按 miss 降序): ' + ' ｜ '.join(_dim_txt))
        # 属性维决胜诊断（2026-10-20 方案1）：回答「属性参与决胜了没有」——只看这四项即可判读：
        #   ① 近分簇规模（≥2 候选才有决胜余地）；② 属性翻盘句数（>0 = 属性真的改变了选片）；
        #   ③ 行内属性跨度（全同值句数高 ⇒ 属性在该句无判别力，放大多少都不动排序）。
        _sp = _ad_stat['spans']
        _sp_min = min(_sp) if _sp else 0.0
        _sp_med = _stats.median(_sp) if _sp else 0.0
        _sp_max = max(_sp) if _sp else 0.0
        _diag_parts.append(
            f"[attr-decisive] 决胜带={'on' if attr_decisive else 'off'}(带={ATTR_DECISIVE_BAND:.2f} "
            f"放大上限={ATTR_DECISIVE_GAIN:.2f}) ｜ 近分簇句={_ad_stat['band_rows']}/{len(result)}"
            f"(带内候选{_ad_stat['band_cands']}) ｜ 属性翻盘句数={_ad_stat['flip']}/{len(result)}"
            f" ｜ 行内属性跨度(±{ATTR_TOTAL_CAP:.2f}封顶): min={_sp_min:.2f} med={_sp_med:.2f} "
            f"max={_sp_max:.2f} 同值句={_ad_stat['span0']}/{len(result)}")
        # 🩺 信号链自检（防静默断链）：统计 query 侧各维声明数，暴露「上游应下发却恒空」。
        #   契约层若丢弃 cameraDynamic/targetSubjects（如 DTO 未声明字段致 model_dump() 丢弃），
        #   此处声明数恒 0 ⇒ 配合 match/miss 全 0 明确区分「断链」与「本就无声明」。
        _attr_decl = {'preferredShot': 0, 'cameraDynamic': 0, 'spatialType': 0,
                      'targetSubjects': 0, 'keyProp': 0, 'actionType': 0}
        for _q in queries:
            if str(_q.get('preferredShot') or '').strip():
                _attr_decl['preferredShot'] += 1
            if str(_q.get('cameraDynamic') or '').strip():
                _attr_decl['cameraDynamic'] += 1
            if str(_q.get('spatialType') or '').strip():
                _attr_decl['spatialType'] += 1
            if _q.get('targetSubjects'):
                _attr_decl['targetSubjects'] += 1
            if str(_q.get('keyProp') or '').strip():
                _attr_decl['keyProp'] += 1
            if str(_q.get('actionType') or '').strip():
                _attr_decl['actionType'] += 1
        _decl_total = sum(_attr_decl.values())
        _diag_parts.append(
            f"[attr-decl] query 声明数: preferredShot={_attr_decl['preferredShot']} "
            f"cameraDynamic={_attr_decl['cameraDynamic']} spatialType={_attr_decl['spatialType']} "
            f"targetSubjects={_attr_decl['targetSubjects']} keyProp={_attr_decl['keyProp']} "
            f"actionType={_attr_decl['actionType']} "
            f"（共 {_decl_total} / {len(queries)} 句）")
        if _decl_total > 0 and _attr_stat['match'] == 0 and _attr_stat['miss'] == 0:
            _diag_parts.append(
                '⚠️[attr-warn] query 已声明属性却逐维全中性 → 疑似切片侧对应属性恒空(shotScale/'
                'cameraMovement/scene/primarySubject)或契约层字段丢失，请核对 KMMatchQuery 声明')
        elif _decl_total == 0:
            _diag_parts.append(
                '⚠️[attr-warn] query 侧零属性声明 → 若上游应下发工单字段，疑似 KMMatchQuery 未声明'
                '致 model_dump() 丢弃(cameraDynamic/targetSubjects 尤甚)')
    print(" ".join(_diag_parts), file=sys.stderr)

    # 及时释放大矩阵引用，缓解常驻内存。
    del semantic_sim, _qc_emb, _c_emb
    if text_sim is not None:
        del text_sim
    return result