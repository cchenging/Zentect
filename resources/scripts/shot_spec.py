# -*- coding: utf-8 -*-
"""
Shot Spec（分镜师工单）共享契约 —— Python 端（C0 契约）。
与 TS 端 `src/shared/contracts/shotSpec.ts` **逐字段一一对应**（字段清单同源，杜绝双端漂移）。

职责：
- 定义 ShotSpec dataclass（S3 剪辑改道输入的解析目标）+ 各枚举常量；
- `validate_shot_spec()`：结构校验（schema + 枚举 + 段号合法 + subjects∈段人物），供 S2 校验与 S3 消费共用；
- 任何新增字段必须在这里与 TS 端同步修改（TODO C0-3：改为生成式单真源）。

对齐方案：§24.2（2026-09-18）。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional

# ---------------- 枚举常量（与 TS 端 SHOT_SPEC_ENUMS 逐项一致） ----------------

MODE_NEW_SHOT = "NEW_SHOT"
MODE_CONTINUE_PREV = "CONTINUE_PREV"
SHOT_SPEC_MODE = [MODE_NEW_SHOT, MODE_CONTINUE_PREV]

SPATIAL_INDOOR_RESIDENCE = "INDOOR_RESIDENCE"
SPATIAL_INDOOR_PUBLIC = "INDOOR_PUBLIC"
SPATIAL_OUTDOOR_STREET = "OUTDOOR_STREET"
SPATIAL_OUTDOOR_NATURE = "OUTDOOR_NATURE"
SPATIAL_VEHICLE = "VEHICLE"
SPATIAL_TRANSIT_HUB = "TRANSIT_HUB"
SPATIAL_UNKNOWN = "UNKNOWN"
SPATIAL_TYPE = [
    SPATIAL_INDOOR_RESIDENCE, SPATIAL_INDOOR_PUBLIC, SPATIAL_OUTDOOR_STREET,
    SPATIAL_OUTDOOR_NATURE, SPATIAL_VEHICLE, SPATIAL_TRANSIT_HUB, SPATIAL_UNKNOWN,
]

PREF_EXTREME_LONG = "EXTREME_LONG"
PREF_LONG_SHOT = "LONG_SHOT"
PREF_FULL_SHOT = "FULL_SHOT"
PREF_MEDIUM_SHOT = "MEDIUM_SHOT"
PREF_MEDIUM_CLOSE = "MEDIUM_CLOSE"
PREF_CLOSE_SHOT = "CLOSE_SHOT"
PREF_EXTREME_CLOSE = "EXTREME_CLOSE"
PREFERRED_SHOT = [
    PREF_EXTREME_LONG, PREF_LONG_SHOT, PREF_FULL_SHOT,
    PREF_MEDIUM_SHOT, PREF_MEDIUM_CLOSE, PREF_CLOSE_SHOT, PREF_EXTREME_CLOSE,
]

CAM_STATIC = "STATIC"
CAM_PAN = "PAN"
CAM_TILT = "TILT"
CAM_PUSH = "PUSH"
CAM_PULL = "PULL"
CAM_FOLLOW = "FOLLOW"
CAMERA_DYNAMIC = [CAM_STATIC, CAM_PAN, CAM_TILT, CAM_PUSH, CAM_PULL, CAM_FOLLOW]

EMO_WARM = "WARM"
EMO_TENSE = "TENSE"
EMO_JOYFUL = "JOYFUL"
EMO_SAD = "SAD"
EMO_NEUTRAL = "NEUTRAL"
SHOT_EMOTION = [EMO_WARM, EMO_TENSE, EMO_JOYFUL, EMO_SAD, EMO_NEUTRAL]

AUDIO_NARRATION = "narration"
AUDIO_ORIGINAL = "original"
AUDIO_MODE = [AUDIO_NARRATION, AUDIO_ORIGINAL]

# 降级链 Level：值越小越严（§24.4）
L0, L1, L2, L3, L4, L5 = 0, 1, 2, 3, 4, 5
FALLBACK_LEVEL = [L0, L1, L2, L3, L4, L5]


@dataclass
class ShotSpec:
    """分镜师工单：一份对应「一个完整句」（sentence 档 matchUnitId）。字段对齐 §24.2。"""
    matchUnitId: str                       # 来源完整句主键（溯源用）
    mode: str                              # NEW_SHOT | CONTINUE_PREV
    segmentId: int                         # 剧情场次段号（圈定候选池）
    spatialType: str                       # 空间类型（门禁）
    targetSubjects: List[str] = field(default_factory=list)  # 主体（取自段 characters 白名单）
    actionType: Optional[str] = None       # 动作类别（可空）
    keyProp: Optional[str] = None          # 关键道具类别（可空）
    preferredShot: str = PREF_MEDIUM_SHOT  # 首选景别（软排）
    cameraDynamic: str = CAM_STATIC        # 运镜（软排）
    emotion: str = EMO_NEUTRAL             # 情绪（软排）
    audioMode: str = AUDIO_NARRATION       # narration | original
    fallbackLevel: int = L3                # 允许降到第几级
    atmosphereNote: Optional[str] = None   # 散文备注（仅软排/兜底）


def validate_shot_spec(spec) -> Dict[str, str]:
    """
    结构校验：枚举 + 段号合法 + 必要字段齐全。
    返回错误字典 {字段: 错误信息}；空字典表示通过。
    注意：subjects∈段人物 属「配场存疑校验」，需带段上下文件另行判定，不在此处（§24.11-F）。

    参数:
        spec: ShotSpec 实例或 dict
    返回:
        结构错误映射；为空即通过
    """
    errors: Dict[str, str] = {}
    scope = spec.__dict__ if isinstance(spec, ShotSpec) else (spec or {})

    def _get(k: str):
        return scope.get(k) if isinstance(scope, dict) else getattr(spec, str(k), None)

    if not _get("matchUnitId"):
        errors["matchUnitId"] = "missing"
    mode = _get("mode")
    if mode not in SHOT_SPEC_MODE:
        errors["mode"] = f"invalid:{mode}"
    seg = _get("segmentId")
    if not isinstance(seg, int) or seg < 1:
        errors["segmentId"] = f"invalid:{seg}"
    if _get("spatialType") not in SPATIAL_TYPE:
        errors["spatialType"] = f"invalid:{_get('spatialType')}"
    if _get("preferredShot") not in PREFERRED_SHOT:
        errors["preferredShot"] = f"invalid:{_get('preferredShot')}"
    if _get("cameraDynamic") not in CAMERA_DYNAMIC:
        errors["cameraDynamic"] = f"invalid:{_get('cameraDynamic')}"
    if _get("emotion") not in SHOT_EMOTION:
        errors["emotion"] = f"invalid:{_get('emotion')}"
    if _get("audioMode") not in AUDIO_MODE:
        errors["audioMode"] = f"invalid:{_get('audioMode')}"
    if _get("fallbackLevel") not in FALLBACK_LEVEL:
        errors["fallbackLevel"] = f"invalid:{_get('fallbackLevel')}"
    return errors