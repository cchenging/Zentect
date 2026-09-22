# -*- coding: utf-8 -*-
"""
montage_contract.py —— 剪辑装配引擎唯一契约权威（§8.5.5 双层解耦）

职责：
  1. 定义「喂什么 / 吐什么」的 JSON 契约（输入 SegmentRequest / 输出 MatchResult）。
  2. Node 策略层按本契约拼输入、读输出；Python daemon 按本契约消费、产出。
  3. 任何一方内部改动，只要不动本契约字段，对方完全无感；未来换算法/换模型也只吃同一份契约。

工程红线（守项目 Q1「错就错」准则）：
  - 缺字段即抛错，**绝不**用默认值/空数组兜底掩盖真实缺失。
  - 校验失败直接 raise，由调用方决定降级与否；本模块不吞错、不造假象。

路径说明：新引擎各模块（build_context / rules / beam_search / montage_router）均 import 本契约，
其它模块之间**不互相 import 类**，只经 JSON 字段通信。
"""

from __future__ import annotations

from typing import Any, List, Optional

# ---------------------------------------------------------------------------
# 路由档位常量（复用既有 ZENTECT_KM_STORYBOARD_MODE，§8.5.2）
#   on      = 新引擎生效（束搜索前向排产）
#   shadow  = 新旧并行、只留日志（A/B 对账，不生效）
#   off     = 旧引擎（KM 静态全局指派）
# ---------------------------------------------------------------------------
ROUTER_MODE_ON = 'on'
ROUTER_MODE_SHADOW = 'shadow'
ROUTER_MODE_OFF = 'off'
ROUTER_MODES = (ROUTER_MODE_OFF, ROUTER_MODE_SHADOW, ROUTER_MODE_ON)

# 束搜索几何参数（§8.2-项4）：束宽上限；首版固定 3。
BEAM_WIDTH = 3

# ---------------------------------------------------------------------------
# 剪辑规则常量（§13.4 补丁21 两级阻断 / §8.2 补丁5·13 阻尼权重）
#   hard 卡违反 → 返回 float('inf')（一票否决）；soft 卡仅累加，权重固定写法。
# ---------------------------------------------------------------------------
# 同机位跳斩（补丁5）：同一 camera 且入点间隔 ≤1500ms → +0.60 阻尼。
JUMP_CUT_GAP_MS = 1500.0
JUMP_CUT_PENALTY = 0.60
# 同源物理单向锁（补丁11）：重入须 startMs ≥ maxConsumedTimeMs − 200ms。
MONOTONIC_SLACK_MS = 200.0
# 心跳阻尼（补丁13）：连续 ≥8000ms 无机位/动静反差 → +0.50 疲劳；破局 → −0.20 奖励。
FATIGUE_FLAT_MS = 8000.0
FATIGUE_PENALTY = 0.50
BREAKOUT_REWARD = -0.20
# 动静/机位反差判据（补丁13 前驱用）：motionScore 差≥0.4 或机位变。
MOTION_CONTRAST_GAP = 0.40
# 景别律动（W_scale）：同景别连切罚 / 规范蒙太奇推拉（±1 档）奖励。
SAME_SCALE_PENALTY = 0.40
PUSH_PULL_REWARD = -0.20
# 时空互文定向越狱（补丁10）：声明 isCrossSceneRecall 且候选命中 recallTargetSceneId 时，
# 对跨段候选施轻微负奖励（定向拉入视为合法，软偏袒非硬门禁）。
CROSS_SCENE_RECALL_REWARD = -0.15
# 服装律动（W_costume）：相邻两镜服装标识跳变 → 轻微罚（观感突兀，C域五罚之一）。
COSTUME_JUMP_PENALTY = 0.12
# 色调连续性（C域五罚之一）：colorHist 直方图 L1 距离超阈值 → 轻微罚（色调撕裂）。
COLOR_GAP = 0.35
COLOR_CONTINUITY_PENALTY = 0.10
# 运镜连续性（C域五罚之一）：相邻运镜标识跳变 → 轻微罚（运镜痉挛）。
CAMERA_CHANGE_PENALTY = 0.10
# 首选景别贴合（ShotSpec.preferredShot 动态门禁软偏袒）：候选景别与工单首选一致 → 奖励，
# 不一致 → 微罚（仅加分项，绝不作硬门禁，守「软排」）。
PREFERRED_SHOT_REWARD = -0.10
PREFERRED_SHOT_MISS_PENALTY = 0.10
# 补丁7 气口弹性腔（gap_padding）：句尾必须保留的安全静音红线与判定常量（物理不足即罚）。
#   唯一允许的时间弹性 = 句尾 ASR 静音气口（silenceGapMs）：两者俱备则出点不侵入发音区。
GAP_SAFE_SILENCE_MS = 80.0      # 安全静音红线条（ms）：出点落点须 ≥ 说话结尾 + 本线
GAP_SPEED_MAX = 1.08            # 复用「±8%」铁律上限：切片在此倍速下可承载的最大输出时长
GAP_OVERRUN_RATE = 0.0010       # 每缺 1ms 计 0.001 阻尼（软阻尼量级，与补丁5/13 同级）
GAP_MAX_PENALTY = 0.60          # 超限阻尼上限（与 JUMP_CUT_PENALTY 同级）

# ---------------------------------------------------------------------------
# 自动场次划分常量（方向2「自动场次划分」）
#   sceneCuts（物理镜头切点 ms 列表）在无手动场次时自动聚类为宏观场次，作候选池软偏袒。
#   以下为纯几何聚类参数（仅对候选排序加权，绝不锁场、绝不作硬门禁）。
# ---------------------------------------------------------------------------
AUTO_SEG_MIN_MS = 20000.0       # 宏观场次最短时长：过短并入邻场（防碎场）
AUTO_SEG_MAX_MS = 120000.0      # 宏观场次最长时长：过长按密度等分再分（防单场过长）
AUTO_SEG_SWITCH_GAP_MS = 2000.0 # 相邻物理切点间隙超过本值 ⇒ 判为新场次起始（场间停顿信号）
AUTO_SEG_ID_OFFSET = 0          # 自动场次 segmentId 起始偏移（从 1 递增，见 auto_segment）


def has_motion_contrast(prev: Optional[dict], cand: dict) -> bool:
    """纯确定性谓词：判定相邻两镜是否构成「动静/机位反差」。

    供心跳阻尼（补丁13）与束搜索 `_advance_state` 共用，保证同一判据单源落地
    （守准则「不重复造轮子」）。反差 = motionScore 差≥MOTION_CONTRAST_GAP
    或机位标识发生变化。缺 motionScore / 机位时不做反差判定（领域中性）。

    Args:
        prev: 前一镜切片（首镜为 None）。
        cand: 当前候选切片。

    Returns:
        bool: True 表示两镜存在动静/机位反差。
    """
    if prev is None:
        return False
    pm = prev.get('motionScore')
    cm = cand.get('motionScore')
    if isinstance(pm, (int, float)) and isinstance(cm, (int, float)):
        if abs(float(pm) - float(cm)) >= MOTION_CONTRAST_GAP:
            return True
    p_cam = (prev.get('camera') or prev.get('cameraMovement') or '').strip()
    c_cam = (cand.get('camera') or cand.get('cameraMovement') or '').strip()
    if p_cam and c_cam and p_cam != c_cam:
        return True
    return False


# ===========================================================================
# 输入契约 —— SegmentRequest
# ===========================================================================
def default_query() -> dict:
    """构造一个脚本句 + 分镜工单的标准字段骨架（全部显式带默认值）。

    调用方据此填充真实值；**未填即抛错的字段不在此设默认**（见校验函数）。
    统一坐标约定：一切时间均为源视频绝对物理 PTS（ms），`source_timeline_ms`，补丁4。
    """
    return {
        # -- 身份与文案 --
        'shotId': '',                 # 段落唯一主键
        'text': '',                   # 解说词原文
        'audioDurationMs': 0.0,       # TTS 配音时长（刚性音频，锁定目标时长）
        'keepOriginalAudio': False,   # 原声段：锁定 ASR 原声时间窗，不配 TTS
        # -- 匹配语义量 --
        'emotion': '',                # 段落情绪标签
        'moodIntent': '',             # VI 情绪终点态（优先于 emotion，见 KMMatchQuery）
        'characters': [],             # 期望角色名集合（软排，Never 硬门禁）
        'charIds': [],                # 期望角色注册表主键集合（优先消费）
        'visualIntent': '',           # 画面语言描述（主体/动作/场景/景别/氛围）
        'isAbstractNarration': False, # 抽象旁白路由标记（空镜分流）
        'isFlashback': False,         # 显式闪回/回忆标记（豁免时序软罚）
        'sceneGroup': '',             # 地点约束组名
        # -- 时间轴 --
        'startMs': 0.0,               # 等分插值假锚（补丁9 提醒：勿作绝对锚）
        'durationMs': 0.0,
        'windowStartMs': 0.0,         # 段落级时间窗（Layer1）
        'windowEndMs': 0.0,
        'sourceRefTimeMs': 0.0,       # 补丁9：剧情锚点（segments[sourceSceneId].startMs 查表，绝对坐标）
        'sourceSceneId': '',          # 补丁9：语义对标场景引用（严禁手写绝对毫秒）
        # -- B域（§10.2.3）：步骤3 本地确定性选帧的真实参考帧（源坐标）--
        'refFrameTimeMs': 0.0,        # 真实参考帧时间（源视频绝对坐标，锁1 强锚消费）
        'refFrameSource': '',         # matched=命中真实帧 / block_first=退化为母块首帧 / 空=无锚
        'trimStartMs': 0.0,           # 已裁片头偏移（补丁4 幻觉守卫：refFrame 落入[0,trimStartMs)判幻觉 +=trimStartMs）
        'sourceDurationMs': 0.0,      # 源视频总时长（锁1 越界守卫：refFrame>源时长判幻觉置 0）
        'asrAnchorStartMs': None,     # 原声段 ASR 台词起始（补丁20 hasHardSub 对齐用）
        'asrAnchorEndMs': None,
        # -- 步骤1 ③ ASR 句尾气口（补丁2/7 磁吸消费；TTS 旁白/无 ASR 数据恒 None ➜ 规则卡中性放行不造假）--
        'silenceGapMs': None,         # 句尾静音气口毫秒（本句结尾→下句开头；末句为 0；None=无 ASR 气口数据）
        # -- 分镜工单 ShotSpec（§24.15 / S3）--
        'matchUnitId': '',
        'segmentId': 0,               # 剧情场次号（>0 时候选=该段内全部切片）
        'spatialType': '',            # 空间类型门禁
        'shotMode': 'NEW_SHOT',       # NEW_SHOT | CONTINUE_PREV
        'fallbackLevel': 0,           # 允许降级到第几级（降级链）
        'actionType': '',             # 动态门禁：动作类别
        'keyProp': '',                # 动态门禁：关键道具
        'preferredShot': '',          # 动态门禁：首选景别
        'isCrossSceneRecall': False,  # 补丁10：时空互文定向越狱声明
        'recallTargetSceneId': '',    # 补丁10：定向拉入的目标场次
    }


def default_chunk() -> dict:
    """构造一个视频切片资产品牌标准字段骨架（切片资产口径，§10.2.1 A 域）。

    切片 = 素材侧物理资产，须携带时空物理坐标、视听实体、空间环境等字段，
    供 build_context 产出标准候选池（本契约不定任何打分逻辑）。
    """
    return {
        'id': '',
        'parentChunkId': '',          # 所属物理镜头 ID（假转场识别）
        'parentStartMs': 0.0,         # 物理镜头起始
        'startMs': 0.0,               # 切片物理入点（source 绝对坐标）
        'endMs': 0.0,                 # 切片物理出点
        'filePath': '',               # 素材文件路径
        'coverPath': '',
        # -- 语义描述 --
        'description': '',            # VLM 画面描述
        'semantics': '',
        'emotion': '',
        # -- 角色 --
        'characters': [],             # 出现角色
        'charIds': [],
        'primarySubject': '',         # 补丁18：主控焦点角色（众数归约，frameRoles≥50%）
        'primarySubjectConf': 0.0,    # 补丁18：主控焦点置信度（出现帧率）
        # -- A域 v7（§10.2.1）：视线/稀有料，点亮补丁14/补丁17 休眠硬卡 --
        'eyelineDirection': '',       # 补丁14 跳轴守卫：主体视线朝向枚举 LEFT|RIGHT|FRONT|NONE（VLM 结构化标注）
        'isCriticalHeroAsset': False, # 补丁17 稀有料预锁：全局唯一稀有料（求解前置 O(N) 纯统计，零模型）
        # -- 功能分类 --
        'materialType': 'real',       # real 实拍 / empty 空镜 / effect 特效（功能路由分流）
        'isAbstractCapable': False,   # 可否作空镜/B-Roll（抽象句池）
        # -- 光学/字幕 --
        'hasHardSub': False,          # 是否含硬字幕（补丁20 出入点对齐 ASR 边界）
        # -- 锁3 视听实体（景别/运镜/服装/地点，覆盖率决定哪些转移矩阵开启）--
        'shotScale': '',              # 景别（特写/近景/中景/全景/远景/空镜）
        'camera': '',                 # 机位/运镜
        'costume': '',                # 服装
        'location': '',               # 地点
        # -- 物理量 --
        'motionScore': 0.0,           # 动静分
        'colorHist': [],              # 色温直方图（补丁5 用）
    }


def default_segment() -> dict:
    """构造一个宏观场次（scene）字段骨架（S1 场记单资产）。

    供 build_context 做场次锚定与跨场清算（补丁19）。
    """
    return {
        'segmentId': 0,               # 剧情场次号（Sxx）
        'startMs': 0.0,               # 场次物理起
        'endMs': 0.0,                 # 场次物理止
        'parentIds': [],              # 归属物理镜头集合
        'locPurity': 0.0,             # 地点纯度 0~1（低纯度段放开空间硬卡预留）
        'emotion': '',                # 场次情绪基调
        'storyBeat': '',              # 剧情节拍描述
        'auto': False,                # 方向2：场次是否由 sceneCuts 自动划分（True=软偏袒源，非 Sxx 手动工单）
    }


def default_request() -> dict:
    """构造标准 SegmentRequest（输入契约根）字段骨架。"""
    return {
        'projectId': '',
        'mediaId': '',
        'queries': [],                # List[SegmentQuery]
        'videoChunks': [],            # List[VideoChunkAsset]
        'segments': [],               # List[Segment]
        'bgm': None,                  # {bpm, filePath, name} 或 None
        'taskId': '',
        # -- 引擎开关（router 注入）--
        'routerMode': ROUTER_MODE_OFF,  # on | shadow | off
    }


# ===========================================================================
# 输出契约 —— MatchResult
# ===========================================================================
def default_result() -> dict:
    """构造一个标准 MatchResult 输出字段骨架（与 TS MatchResult 同构 + 新字段）。

    消费端（Node/前端）读下列字段渲染镜头卡片与合成时间线。
    裁点字段供导出层高光子窗裁剪消费（补丁20：inPointMs/outPointMs 已掐头去尾）。
    """
    return {
        # -- 身份 --
        'id': '',                     # 段落唯一主键（React key，出生处全局唯一）
        'shotId': '',                 # 段落 id（与 id 同值兼容）
        'mediaId': '',
        'thumbnail': '',
        'score': 0.0,                 # 综合匹配得分（越大越好 / 排序键）
        'confirmed': False,
        'isUserLocked': False,        # K2：用户手动微调/确认后置 True（确定性锚点，重新匹配冻结）
        # -- 选中切片与裁点 --
        'chosenChunkId': '',          # 命中的切片 id（chunkData 主 payload）
        'inPointMs': 0.0,             # 补丁20：裁剪后的入场点（含 200ms 光学掐头）
        'outPointMs': 0.0,            # 补丁20：裁剪后的出场点（含 200ms 光学掐尾）
        'appliedSpeedFactor': 0.0,    # 变速因子（[1/1.08, 1.08]，守 ±8% 铁律）
        'isExactSpeed': False,        # 哨兵：纯裁剪段（1.00x），禁止 linear stretch
        'audioDurationMs': 0.0,       # 配音时长
        'chunkData': {},              # 原始切片引用（透传）
        # -- 文案 --
        'text': '',
        'keepOriginalAudio': False,
        # -- 合成时间线 --
        'videoTimelineStartMs': 0.0,
        'videoTimelineEndMs': 0.0,
        # -- 新引擎标记 --
        'isDegraded': False,          # 降级夹杂标记（§8.2-项5 输出）
        'sourceRefTimeMs': 0.0,       # trace：本段剧情锚点（补丁9）
        'assignedSegmentId': 0,       # trace：实际落到的场次（shadow 对账用）
        'prevChunkId': '',            # trace：束搜索前驱（跨场清算/诊断用）
    }


# ===========================================================================
# 契约校验（守「错就错」：缺即抛，不兜底）
# ===========================================================================
class ContractError(ValueError):
    """契约校验失败异常：调用方据此进行显式处理，绝不静默降级。"""


def require_field(payload: dict, field: str) -> Any:
    """强制读取一个字段，缺失/为空即抛 ContractError（不造兜底假象）。

    Args:
        payload: 待校验的契约字典。
        field: 必填字段名。

    Returns:
        Any: 字段值。

    Raises:
        ContractError: 字段缺失或为空（None/空字符串）。
    """
    if field not in payload:
        raise ContractError(f'契约缺字段: {field}')
    value = payload[field]
    # 空串/None 视为缺失——缺了它下游必出错，早抛优于晚错。
    if value is None or value == '':
        raise ContractError(f'契约字段为空: {field}')
    return value


def validate_request(req: dict) -> dict:
    """校验输入契约根：结构合法则原样返回，否则抛 ContractError。

    Args:
        req: SegmentRequest 字典。

    Returns:
        dict: 原请求体（校验通过后直接透传）。

    Raises:
        ContractError: 关键结构缺失。
    """
    require_field(req, 'projectId')
    if not isinstance(req.get('queries'), list) or not req['queries']:
        raise ContractError('契约 queries 必须为非空数组')
    if not isinstance(req.get('videoChunks'), list):
        raise ContractError('契约 videoChunks 必须为数组')
    mode = req.get('routerMode', ROUTER_MODE_OFF)
    if mode not in ROUTER_MODES:
        raise ContractError(f'非法 routerMode: {mode!r}')
    return req


def validate_queries(normalized_queries: List[dict]) -> None:
    """校验归一化后的脚本句列表（build_context 调用前）。

    Args:
        normalized_queries: SegmentQuery 字典列表。

    Raises:
        ContractError: 任一句缺少 shotId / text。
    """
    for q in normalized_queries:
        require_field(q, 'shotId')
        require_field(q, 'text')


# ---------------------------------------------------------------------------
# 输出侧权威（G 域 §10.2.8 动作2）：MatchResult schema 漂移检测
#   缺字段即 fail-fast，守「错就错」——输出漂移在求解内暴露，不打到消费端才砸脸。
# ---------------------------------------------------------------------------
# 输出项必填字段：缺任一即判 schema 漂移抛错（其余字段 default_result 自带缺省）。
REQUIRED_RESULT_FIELDS = ('id', 'shotId')


def validate_result(result: dict) -> dict:
    """校验一个 MatchResult 输出项：缺必填字段即抛 ContractError（schema 漂移 fail-fast）。

    Args:
        result: 求解器产出的匹配结果字典。

    Returns:
        dict: 校验通过的同一结果（透传）。

    Raises:
        ContractError: 缺任一 REQUIRED_RESULT_FIELDS。
    """
    for field in REQUIRED_RESULT_FIELDS:
        require_field(result, field)
    return result


def assemble_result(patch: dict, strict: bool = True) -> dict:
    """以 default_result 为骨架组装标准 MatchResult 输出项（含必填校验）。

    Args:
        patch: 求解器填写的字段（按 default_result 键名）。
        strict: 为 True 时对缺失必填字段（id/shotId）抛错。

    Returns:
        dict: 完整 MatchResult。

    Raises:
        ContractError: strict 且缺 id/shotId。
    """
    result = default_result()
    result.update(patch or {})
    if strict:
        validate_result(result)
    return result


# ---------------------------------------------------------------------------
# 锁1 守卫（G 域 §10.2.8 动作3：从 build_context 沉入契约，单一权威）
# ---------------------------------------------------------------------------
def clamp_ref_frame(query: dict) -> dict:
    """锁1 幻觉守卫（B 域 §10.2.3 动作2）：仅对 refFrameTimeMs 做物理合法性校准。

    - 越界守卫：0 ≤ refFrameTimeMs ≤ sourceDurationMs，越界判幻觉置 0（走无锚章节降级）。
    - 片头幻觉守卫（补丁4）：refFrameTimeMs 落入已裁片头 [0, trimStartMs) 判幻觉 += trimStartMs
      （步骤3 在 source 坐标里选帧，trimStart 前的帧属刚被裁掉的序场残影）。

    返回修正后的 query 副本；越界置 0 时同时清空 refFrameSource（无锚）。
    不改 sourceRefTimeMs（那仍是段锚）；锁1 只校准真实参考帧坐标。
    """
    _q = dict(query)
    _ref = float(_q.get('refFrameTimeMs') or 0)
    if _ref > 0:
        _src_dur = float(_q.get('sourceDurationMs') or 0)
        if _src_dur > 0 and _ref > _src_dur:
            # 越界判幻觉：明确置 0，走无锚章节降级，绝不静默封顶拉回。
            _q['refFrameTimeMs'] = 0.0
            _q['refFrameSource'] = ''
        else:
            _trim = float(_q.get('trimStartMs') or 0)
            if _trim > 0 and _ref < _trim:
                # 片头幻觉（补丁4）：落入已裁序场残影区，前移 trimStart 回真实物理起点。
                _q['refFrameTimeMs'] = float(_trim)
    return _q


# ===========================================================================
# 工具：字段缺省装配（显式声明，非兜底掩盖）
# ===========================================================================
def assemble_query(patch: dict, strict: bool = True) -> dict:
    """以 default_query 为骨架，用 patch 覆盖成一条完整 SegmentQuery。

    Args:
        patch: 调用方填写的字段。
        strict: 为 True 时对缺失的必填字段抛错（shotId/text）。

    Returns:
        dict: 完整 SegmentQuery。

    Raises:
        ContractError: strict 且缺 shotId/text。
    """
    query = default_query()
    query.update(patch or {})
    if strict:
        require_field(query, 'shotId')
        require_field(query, 'text')
    return query


def assemble_chunk(patch: dict) -> dict:
    """以 default_chunk 为骨架，用 patch 覆盖成一条标准切片资产。"""
    chunk = default_chunk()
    chunk.update(patch or {})
    require_field(chunk, 'id')
    return chunk


def assemble_segment(patch: dict) -> dict:
    """以 default_segment 为骨架，用 patch 覆盖成一个标准场次资产。"""
    segment = default_segment()
    segment.update(patch or {})
    require_field(segment, 'segmentId')
    return segment


def assemble_request(patch: dict) -> dict:
    """以 default_request 为骨架组装 SegmentRequest 输入契约。"""
    request = default_request()
    request.update(patch or {})
    return validate_request(request)