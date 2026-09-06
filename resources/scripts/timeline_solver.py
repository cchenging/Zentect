"""
timeline_solver.py — KM 全局排他性最优匹配模块
  /api/solver/kuhn_munkres_match — 三维一体弹性时间轴对齐算法
"""
import os
import sys
import traceback
import re
import json
import math
import asyncio
import concurrent.futures

import gc
import datetime
import tempfile
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from typing import List
from ai_config import (AIModels, PROJECT_MATERIAL_POOL, INFERENCE_LOCK,
                       set_task_cancel, is_task_cancelled, clear_task_cancel,
                       _load_and_resize_thumb)

router = APIRouter()


# ==========================================
# 🔬 KM 空匹配诊断落盘：把 [KM-DIAG] 关键定位行镜像写到一个独立文件，
#    避免与海量过程数字在 dev 终端刷屏混叠导致看不清根因（仅空结果/异常时写，不刷主日志）。
#    路径经 tempfile 定位到系统临时目录，跨 daemon 重启累积；写失败仅 stderr 警告、不阻断匹配。
# ==========================================
_KM_DIAG_FILE = None
def _km_diag(msg: str) -> None:
    """把空匹配诊断行同时输出到 stderr 与临时文件，供重跑后直接读文件定位根因（免翻刷屏）"""
    line = f"[{datetime.datetime.now().isoformat(timespec='seconds')}] {msg}"
    print(line, file=sys.stderr)
    try:
        global _KM_DIAG_FILE
        if _KM_DIAG_FILE is None:
            _KM_DIAG_FILE = os.path.join(tempfile.gettempdir(), "zentect-km-diag.log")
        os.makedirs(os.path.dirname(_KM_DIAG_FILE), exist_ok=True)
        with open(_KM_DIAG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception as _e:
        print(f"[KM-DIAG] 诊断落盘失败（不影响匹配）: {_e}", file=sys.stderr)


# ==========================================
# 🔬 KM 阶段耗时观测：唯一计时起点，配合 _km_tick() 打印各子阶段耗时，
#    下次步骤5"卡死"时能一眼定位停在哪个子阶段（纯观测，不改业务逻辑）。
# ==========================================
_KM_T0 = None
def _km_now():
    """函数级中文注释：返回单调时钟秒（time.monotonic 不受系统时间跳变影响，仅观测用）"""
    import time
    return time.monotonic()


def _km_t0():
    """函数级中文注释：记录 KM 求解的总起点（monotonic 时钟，不受系统时间跳变影响）"""
    global _KM_T0
    if _KM_T0 is None:
        _KM_T0 = _km_now()
    return _KM_T0


def _km_tick(tag: str):
    """函数级中文注释：打印自 KM 起点到当前 tag 的累计耗时(秒)，用于精确定位卡死子阶段"""
    _km_t0()
    elapsed = _km_now() - _KM_T0
    print(f"[KM-DUR] {tag} elapsed={elapsed:.1f}s", file=sys.stderr)


# ==========================================
# 🔧 P0 内存观测（PR-步骤5资源治理）：跨平台 RSS 读取
#    Windows Python 标准库无 resource 模块，统一用 ctypes/GetProcessMemoryInfo（零新增依赖）；
#    POSIX 用 resource.ru_maxrss。仅观测，失败返回 -1，不兜底业务。
# ==========================================
def _mem_rss_mb() -> float:
    """跨平台获取当前 Python 进程物理内存 RSS（MB）；失败返回 -1（仅观测，不兜底业务）"""
    try:
        if sys.platform == 'win32':
            import ctypes
            from ctypes import wintypes

            class _PROCESS_MEMORY_COUNTERS(ctypes.Structure):
                _fields_ = [
                    ('cb', wintypes.DWORD),
                    ('PageFaultCount', wintypes.DWORD),
                    ('PeakWorkingSetSize', ctypes.c_size_t),
                    ('WorkingSetSize', ctypes.c_size_t),
                    ('QuotaPeakPagedPoolUsage', ctypes.c_size_t),
                    ('QuotaPagedPoolUsage', ctypes.c_size_t),
                    ('QuotaPeakNonPagedPoolUsage', ctypes.c_size_t),
                    ('QuotaNonPagedPoolUsage', ctypes.c_size_t),
                    ('PagefileUsage', ctypes.c_size_t),
                    ('PeakPagefileUsage', ctypes.c_size_t),
                ]

            counters = _PROCESS_MEMORY_COUNTERS()
            counters.cb = ctypes.sizeof(_PROCESS_MEMORY_COUNTERS)
            psapi = ctypes.windll.psapi
            if not psapi.GetProcessMemoryInfo(
                ctypes.windll.kernel32.GetCurrentProcess(),
                ctypes.byref(counters),
                counters.cb,
            ):
                return -1.0
            return counters.WorkingSetSize / (1024 * 1024)
        else:
            import resource
            # Linux ru_maxrss 单位 KB；macOS 为字节，此处按 KB→MB 换算（Linux 主路径）
            return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0
    except Exception:
        return -1.0


# ==========================================
# 🔧 KM 真实进度（长任务在途期间，Node 轮询此进度，避免进度条卡死在锚点后突跳 100%）
#    daemon 侧按阶段写进度到 _KM_PROGRESS，Node 通过 /api/solver/km_progress?task_id= 轮询，
#    映射到前端 60~80 细分区间的相对刻度。
# ==========================================
_KM_PROGRESS: dict = {}


def _report_km_progress(task_id: str, progress: float, stage: str):
    """写入 KM 进度（GIL 下 dict 赋值原子）；task_id 为空则忽略，进度钳制在 [0,1]"""
    if not task_id:
        return
    _KM_PROGRESS[task_id] = {"progress": max(0.0, min(1.0, progress)), "stage": stage}


# ==========================================
# 🃏 步骤5 卡片流式：逐时序块实时推送已匹配结果
#    长视频 KM 是数分钟长任务，若等全部归一再整批渲染，
#    前端全程只有进度条、空等无卡片。故每个时序块求解完毕立即把
#    该块新增的匹配结果累积进 _KM_STREAM[task_id].pending，
#    Node 通过 /api/solver/km_progress 轮询时把 pending 作为增量 results 弹出，
#    前端据此"每匹配一段就渲染一张卡片"，肉眼看到卡片逐个跳出。
#    与 _KM_PROGRESS 同哲学：GIL 下 dict/list 操作原子；因 None 引用被替换，
#    端点与求解线程的窗口极小竞态后果仅是"某次轮询少一段"，下一轮仍能取到，
#    最终全量返回由 Node 覆写收敛，流式只做即时渲染，不影响最终一致性。
# ==========================================
_KM_STREAM: dict = {}


def _report_km_blocks(task_id: str, partial_results: list) -> None:
    """把某时序块新产出的匹配结果追加进该 task 的流式缓冲（卡片流式用）。
    函数级中文注释：task_id 为空或空增量直接忽略；pending 列表按块累积，直到 Node 轮询弹出。"""
    if not task_id or not partial_results:
        return
    entry = _KM_STREAM.setdefault(task_id, {"pending": []})
    entry["pending"].extend(partial_results)


# ==========================================
# DTOs
# ==========================================
class KMMatchQuery(BaseModel):
    """卡点匹配查询"""
    shotId: str
    text: str
    audioDurationMs: float = 0
    """🎭 P0 意境维度：段落情绪标签（如：紧张/平静/温馨），来自步骤3 文案生成的 emotion 字段，用于与切片情绪做相容度匹配"""
    emotion: str = ''
    """🎭 P1 角色组合匹配：本段解说词期望出现的人物名集合（步骤3 透传的 chunk 锚定角色），
    用于 Query 端与切片角色集合做契合度匹配（软加成：未命中不惩罚）"""
    characters: List[str] = []
    """🎯 P3 画面意图：本段解说词"应配什么画面"的画面语言描述（主体/动作/场景/景别/氛围），
    来自步骤3 LLM 生成，用于与切片描述做文本↔文本语义匹配（替代解说词文本↔画面的跨空间错位）"""
    visualIntent: str = ''
    """🎯 P3 时间轴锚定：本段解说词对应的画面时间起点/时长（ms），覆盖该时间点的切片获得锚定加成"""
    startMs: float = 0
    durationMs: float = 0
    """🔬 Step1 Layer1 段落级时间窗（ms）：解说画面窗口 [windowStartMs, windowEndMs]。
    Node 侧按 startMs−30s / startMs+durationMs+60s 显式透传；为 0 时 daemon 用源锚派生（_query_window）。"""
    windowStartMs: float = 0
    windowEndMs: float = 0
    """🎬 决策 #6：抽象文案路由标记。True 表示本段为"岁月流转/时光荏苒"类无具体画面语义的抽象旁白，
    匹配时语义主分由景别分级抽象分（_abstract_semantic_score）取代——空镜优先、近特写次之；
    同时跳过关键词 boost 与情绪路由（抽象文本无具体实体，情绪分已计入避免双计）。
    这是决策 #3"命中即加权、绝不硬否决语义"的唯一显式例外：抽象文案的文字语义本身就是噪声，
    其"语义"由路由意图取代。缺省 False，老工程数据行为与旧版完全一致。"""
    isAbstractNarration: bool = False
    """🎬 决策 #6：显式闪回/回忆标记（决策 #2 豁免条款的契约化）。
    True 直接豁免时序软罚——跨场景是剪辑意图（画面回溯）而非时序倒流错误；
    优先级高于 _is_temporal_exempt 的关键词猜测（后者保留作为缺省兜底）。"""
    isFlashback: bool = False


# ============================================================
# 🎬 阶段2（2026-09-04）语义混合权重与描述截断
# IMG_WEIGHT / TXT_WEIGHT：有描述切片的语义分 = IMG×图文 + TXT×文本。
#   背景：中文 CLIP 跨模态图文对齐天然低（0.5~0.7 到顶），把强文本对齐(0.9+)拉到 ~0.75，
#   压低 combined 天花板 → 强相关段上不了 0.9。文本主导后（0.65）强文本对齐主导分数。
#   无描述切片 has_desc=0 仍纯图像（保底），不因漏标被过度歧视。
# _smart_truncate_desc：描述超长时"保头300字(动作/景别) + 尾200字(角色/场景补全)"，
#   避免直接截前 512 丢尾丢关键可匹配信息。
# ============================================================
IMG_WEIGHT = 0.35
TXT_WEIGHT = 0.65


def _smart_truncate_desc(text: str, head_chars: int = 300, tail_chars: int = 200) -> str:
    text = (text or '').strip()
    if len(text) <= head_chars + tail_chars:
        return text
    return text[:head_chars] + '……' + text[-tail_chars:]


# ============================================================
# 🎬 方案 2.3（2026-09-04 批准版）强相关带门槛温和归一
#   · 防虚高硬门槛：仅当某 query 候选池原始最大相似度 S_max ≥ MATCH_GATE_MIN_SMAX 才触发
#       S_norm = S_orig + (1 − S_orig) × λ（λ = MATCH_GATE_LAMBDA）
#   · S_max < 0.70（弱相关/抽象过渡段）坚决不拉伸，保持低分真实性；
#   · 环境开关 ZENTECT_KM_NORM_GATE：默认 1（启用），置 0/false 回退纯原始分便于 A/B 复测；
#   · 原始语义矩阵 raw 保留供 [MATCH_DIAG] 审计（RawSem/Gate/Smax），不丢审计基准。
# ============================================================
MATCH_GATE_LAMBDA = 0.35
MATCH_GATE_MIN_SMAX = 0.70
MATCH_NORM_GATE_DISABLED = os.environ.get('ZENTECT_KM_NORM_GATE', '1') in ('0', 'false', 'False')


def _apply_2_3_gentle_normalization(semantic_sim):
    """方案 2.3 强相关带门槛温和归一（评审公式落地）。

    - 仅当某 query 候选池**原始**最大相似度 S_max ≥ MATCH_GATE_MIN_SMAX(0.70) 时触发：
        S_norm = S_orig + (1 − S_orig) × λ（λ = MATCH_GATE_LAMBDA=0.35）
    - S_max < 0.70（弱相关/抽象过渡段）坚决不拉伸，保持低分真实性；
    - 拉伸为行内单调仿射（sim → λ + (1−λ)·sim），不改 query 内部候选排序，只抬分位；
    - env ZENTECT_KM_NORM_GATE=0/false → 整体关闭，原样返回（A/B 复测用）。
    - 返回 (norm, raw)：raw=归一前副本仅供 [MATCH_DIAG] 审计（Gate/Smax），不参与任何打分。

    :param semantic_sim: (n_queries, n_chunks) 余弦相似度矩阵（含 anchor 加成后的定稿值）
    """
    import numpy as _np
    raw = semantic_sim.copy()
    if MATCH_NORM_GATE_DISABLED:
        print("[KM] 方案2.3 温和归一: 环境 ZENTECT_KM_NORM_GATE=0 已关闭（使用原始语义分）", file=sys.stderr)
        return semantic_sim, raw
    row_smax = semantic_sim.max(axis=1)
    gated = row_smax >= MATCH_GATE_MIN_SMAX
    norm = semantic_sim
    if bool(gated.any()):
        norm = semantic_sim.copy()
        norm[gated] = semantic_sim[gated] + (1.0 - semantic_sim[gated]) * MATCH_GATE_LAMBDA
    print(f"[KM] 方案2.3 温和归一: S_max≥{MATCH_GATE_MIN_SMAX} 拉伸 {int(gated.sum())}/{semantic_sim.shape[0]} 行 "
          f"(λ={MATCH_GATE_LAMBDA})", file=sys.stderr)
    return norm, raw


class KMMatchReq(BaseModel):
    """卡点匹配请求"""
    queries: List[KMMatchQuery]
    videoChunks: List[dict]
    bgmBeats: List[float] = []
    mediaId: str = 'default'
    """🔧 缓存隔离：与 detect_scene_chunks 写入一致的项目 id，参与 PROJECT_MATERIAL_POOL 兜底 key，
    保证同项目复用、跨项目绝不串（写入端 key 为 <projectId>:<mediaId>，读取端必须同构）。"""
    projectId: str = ''
    vlmApiKey: str = ''
    vlmApiBase: str = ''
    vlmApiModel: str = ''
    """🔬 决策 #4：VLM 二次裁决为 opt-in 能力，默认关闭。
    False 时不触发云端 VLM 重排（即使配置了 API/KM 低置信度也不校验）；
    True 且配置了 vlmApiKey/vlmApiBase/vlmApiModel 时，才对 confidence<VLM_CONFIDENCE_THRESHOLD 的结果调用 VLM 裁决。"""
    useVlmRerank: bool = False
    """🎵 P2 BPM 对齐卡点：BGM 曲目 BPM（librosa tempo 检测），>0 时启用整拍网格磁吸，<=0 回退单点鼓点吸附"""
    bpm: float = 0
    """🎵 P2 权重可配置：四项打分权重字典，键为 sem/emotion/duration/role，缺省回退并归一化"""
    weights: dict = {}
    """🔧 P2 #11 方案B：KM Top-K 行级稀疏预选。
    格式 { shotId: [chunkId, ...] }：每个 query 只允许匹配其候选集合里的切片，
    非候选格在代价矩阵中置强惩罚，KM 优先在候选内求解；空/缺省 = 不启用（老逻辑全量跑）。
    设计为"强惩罚非无穷大"：若某 query 的候选恰好全部落在本时序块之外，KM 仍能兜底选一个，
    不会因整行被禁而引发 assign 无解崩溃。"""
    candidateIds: dict = {}
    """🔧 R3 取消贯通（PR-1）：Node 侧在 abort 时通过 /cancel/{task_id} 置位的取消标记；
    KM 求解循环定期检查，命中后提前返回，避免 CPU 空烧。由端点从请求头 X-Task-Id 填充。"""
    taskId: str = ''


# ==========================================
# 🔬 Step1 Layer1 段落级时间窗（决策 #1 冻结值）
#   解说单章通常覆盖原片 1~2 分钟剧情：前探 30s 覆盖铺垫，后延 60s 覆盖冲突发酵；
#   单向扩张 120s 兜底候选稀缺而不跨幕次跳变。
# ==========================================
WINDOW_LEAD_MS = 30000       # 前探：覆盖章节铺垫
WINDOW_TAIL_MS = 60000       # 后延：覆盖冲突发酵
WINDOW_EXPAND_MS = 120000    # 候选不足单向扩张步长
WINDOW_MIN_CANDIDATES = 5    # 窗内候选不足阈值
WINDOW_PENALTY = 5.0         # 窗外强惩罚（与 candidateIds 同通道量级，远超 combined 的 [0,1]）


def _query_window(query, universe_indices, video_chunks):
    """段落级时间窗 [w0, w1]。
    - 优先取 Node 显式透传的 windowStartMs/windowEndMs（决策 #1：Node 侧算好直接给）；
    - 未透传时由源锚派生：w0=max(0,startMs−30s)，w1=startMs+durationMs+60s（与 Node 口径一致）；
    - 候选不足（窗内切片数 < WINDOW_MIN_CANDIDATES）时单向扩张：先 +120s 后延，仍不足再 −120s 前探。
    返回 (w0, w1)；源锚也无效（startMs 与 durationMs 均 ≤0）返回 None，调用方走旧 ±3 块兜底。"""
    w0 = float(getattr(query, 'windowStartMs', 0) or 0)
    w1 = float(getattr(query, 'windowEndMs', 0) or 0)
    if not (w1 > w0):
        # 派生窗口：Node 未显式透传时用源锚
        start = float(query.startMs or 0)
        dur = float(query.durationMs or 0)
        if start <= 0 and dur <= 0:
            return None
        w0 = max(0.0, start - WINDOW_LEAD_MS)
        w1 = start + dur + WINDOW_TAIL_MS
    # 候选不足自适应扩张（决策 #1：单向 +120s，先顺时序推进）
    if universe_indices:
        def _in_win(_w0, _w1):
            return sum(1 for i in universe_indices
                       if _w0 <= float(video_chunks[i].get('startMs') or 0) <= _w1)
        if _in_win(w0, w1) < WINDOW_MIN_CANDIDATES:
            w1 += WINDOW_EXPAND_MS
            if _in_win(w0, w1) < WINDOW_MIN_CANDIDATES:
                w0 = max(0.0, w0 - WINDOW_EXPAND_MS)
    return (w0, w1)


# ==========================================
# 🎭 P0 意境维度：情绪归一化与相容度（文案情绪 ↔ 画面情绪）
# ==========================================
# 情绪类别关键词表：把步骤2 VLM 输出的自由文本情绪（emotionalState）与步骤3 LLM 生成的段落情绪
# 归一化到有限类别，避免两个自由文本直接比较（"阴沉的" vs "压抑" 文本不等但语义同向）
EMOTION_CATEGORIES = {
    '紧张悬疑': ['紧张', '悬疑', '压迫', '焦虑', '不安', '忐忑', '急促', '惊悚', '恐惧', '害怕', '惊险', '惶恐', '揪心', '屏息', '诡异', '惊慌', '惊恐', '阴森', '诡秘'],
    '悲伤沉重': ['悲伤', '伤心', '难过', '压抑', '沉重', '哀伤', '凄凉', '落寞', '绝望', '无奈', '心碎', '感伤', '忧郁', '怅然', '沮丧', '阴沉', '阴郁', '悲痛', '哀痛'],
    '愤怒激昂': ['愤怒', '激动', '激烈', '冲突', '激昂', '决绝', '狠戾', '狰狞', '咆哮', '爆发', '愤慨', '暴怒', '怒火', '杀气', '狠辣', '戾气'],
    '欢快轻松': ['欢快', '轻松', '喜悦', '开心', '高兴', '愉快', '温馨', '甜蜜', '活泼', '兴奋', '雀跃', '浪漫', '温情', '美好', '幸福', '俏皮'],
    '平静舒缓': ['平静', '舒缓', '宁静', '淡然', '沉稳', '安详', '悠远', '平缓', '温和', '静谧', '从容', '祥和', '深邃', '安逸', '淡泊'],
    '中性': ['中性', '平淡', '客观', '普通', '日常', '寻常', '冷静'],
}

# 情绪类别相容度矩阵（对称，0~1）：同类别 1.0；同向情绪（同为负向/同为正向）0.6；高强度情绪 0.5；中性与其他 0.5；其余 0.15
EMOTION_COMPAT = {
    ('紧张悬疑', '悲伤沉重'): 0.6,
    ('欢快轻松', '平静舒缓'): 0.6,
    ('紧张悬疑', '愤怒激昂'): 0.5,
    ('悲伤沉重', '愤怒激昂'): 0.5,
    ('欢快轻松', '愤怒激昂'): 0.3,
    ('悲伤沉重', '平静舒缓'): 0.3,
    ('紧张悬疑', '平静舒缓'): 0.15,
    ('悲伤沉重', '欢快轻松'): 0.05,
    ('紧张悬疑', '欢快轻松'): 0.05,
    ('愤怒激昂', '平静舒缓'): 0.15,
}
_EMOTION_COMPAT_SYMMETRIC = {}
for (_a, _b), _v in EMOTION_COMPAT.items():
    _EMOTION_COMPAT_SYMMETRIC[(_a, _b)] = _v
    _EMOTION_COMPAT_SYMMETRIC[(_b, _a)] = _v


def _normalize_emotion(text: str) -> str:
    """情绪自由文本 → 情绪类别：命中关键词即归入该类别；空文本/未命中统一归为中性"""
    text = (text or '').strip()
    if not text:
        return '中性'
    for category, keywords in EMOTION_CATEGORIES.items():
        for kw in keywords:
            if kw in text:
                return category
    return '中性'


def _emotion_compatibility(q_emotion: str, c_emotion: str) -> float:
    """
    文案情绪与切片情绪的相容度（0~1）
    设计（与切片描述 has_desc 掩码同哲学）：任一方情绪缺失时给中性 0.5——
    缺失是"该维度无信息"，不参与加分也不参与惩罚，避免空值干扰匹配排序；
    双方都有情绪时按类别相容度打分，让"画面情绪符合文案意境"参与决策。
    """
    if not (q_emotion or '').strip() or not (c_emotion or '').strip():
        return 0.5
    q_norm = _normalize_emotion(q_emotion)
    c_norm = _normalize_emotion(c_emotion)
    if q_norm == c_norm:
        return 1.0
    return _EMOTION_COMPAT_SYMMETRIC.get((q_norm, c_norm), 0.15)


# 🛑 2026-09-05 并发防护闸：KM 是 CPU/内存重型任务（CLIP 预提取 + 94×694 多维矩阵），
#   且全局模型 release/load 非线程安全——若"失败残留任务"与"用户立刻重试"两个 KM 并发，
#   会在同一 daemon 里叠加抢模型/CPU/内存 → 整机卡死（实测现象）。
#   全部 KM 请求经此闸**串行**：后到请求 await 排队，前一个完成自动接续（Node 侧 900s 超时足够覆盖排队）。
_KM_RUN_GATE = asyncio.Semaphore(1)


@router.post("/api/solver/kuhn_munkres_match")
async def kuhn_munkres_match(req: KMMatchReq, request: Request):
    """
    三维一体弹性时间轴对齐算法（时序块段级联匹配版）
    长电影场景下，将全局 O(N³) 的 KM 求解降级为时序分块的 K × O(n³) 级联匹配
    🚀 关键修复：CPU 密集型计算放入线程池，避免阻塞 uvicorn 事件循环
    🔧 R1 互斥（PR-1）：进入步骤5（KM 匹配）即释放步骤1 的 ASR/TTS 模型，避免跨步骤叠加常驻
    🔧 R3 取消贯通（PR-1）：从 X-Task-Id 请求头取取消标识，求解循环定期检查
    🛑 2026-09-05：经 _KM_RUN_GATE 全局限流串行（见上），杜绝并发 KM 叠加抢资源卡死
    """
    async with _KM_RUN_GATE:
        # R1：进入步骤5 前释放步骤1 的 ASR + 人脸模型（步骤1 与步骤5 模型互斥）。
        #    TTS（Kokoro）由 tts_kokoro 独立管理且无 release 方法，暂不在此释放（见 PR-1 未做项说明）
        print(f"[KM] R1 进入步骤5 前 RSS={_mem_rss_mb():.1f}MB（释放 ASR/人脸前）", file=sys.stderr)
        try:
            AIModels.release_faster_whisper()
            AIModels.release_funasr_sensevoice()
            AIModels.release_paraformer()
            AIModels.release_face_app()   # 新增：人脸模型与 Chinese-CLIP 互斥，进入步骤5 即释放避免共存
        except Exception as e:
            print(f"[KM] R1 释放 ASR/人脸模型警告: {e}", file=sys.stderr)
        print(f"[KM] R1 释放 ASR/人脸 后 RSS={_mem_rss_mb():.1f}MB", file=sys.stderr)

        # R3：请求头 X-Task-Id → 取消标识（缺失则取消功能静默降级，不影响兼容性）
        task_id = request.headers.get("X-Task-Id", "") or ""
        req.taskId = task_id

        loop = asyncio.get_running_loop()
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
            try:
                result = await loop.run_in_executor(executor, _kuhn_munkres_match_sync, req)
                return result
            except ImportError:
                raise HTTPException(status_code=500, detail="scipy not installed. Run: pip install scipy")
            except Exception as e:
                print(f"ERROR: KM 匹配算法崩溃 - {str(e)}", file=sys.stderr)
                traceback.print_exc()
                raise HTTPException(status_code=500, detail=str(e))
            finally:
                # 🔧 R3 兜底（PR-1）：请求结束（成功/异常）清理取消标记，避免标记泄漏影响后续同名任务。
                #   正常完成路径本无标记，此调用幂等无害。
                clear_task_cancel(task_id)


@router.get("/api/solver/km_progress")
async def km_progress(task_id: str = ""):
    """
    🔧 KM 真实进度查询（长任务在途期间供 Node 轮询）：
    返回 `_report_km_progress` 写入的 {progress[0,1], stage}。
    daemon 的长耗时 KM 匀速推进该值，Node 侧把它映射到前端 60~80 细分区间的相对刻度，
    避免进度条卡死在锚点 60% 后突跳 100%（进度造假）。
    🃏 卡片流式：额外的 `results` 字段携带 `_report_km_blocks` 累积的本批待推结果，
    Node 轮询取走即弹出（增量语义），前端据此"每匹配一段渲染一张卡片"。
    无任务或查不到时返回 None，Node 轮询视为"尚未开始"，保持当前进度。
    """
    data = _KM_PROGRESS.get(task_id)
    if data is None:
        return {"task_id": task_id, "found": False, "progress": None, "stage": None}
    # 🃏 卡片流式：弹出本批待推结果作为增量（引用替换 pending，取走即消费，下一批不重复）
    pending: list = []
    stream = _KM_STREAM.get(task_id)
    if stream and stream.get("pending"):
        pending = stream["pending"]
        stream["pending"] = []
    return {"task_id": task_id, "found": True, "progress": data["progress"], "stage": data["stage"], "results": pending}


def _extract_pooler(features):
    """
    兼容 transformers 新旧版：get_text_features / get_image_features 在新版返回
    BaseModelOutputWithPooling（含 pooler_output），旧版直接返回 tensor
    """
    return features.pooler_output if hasattr(features, 'pooler_output') else features


def _compute_role_score(query_roles, chunk_roles) -> float:
    """
    🎭 P1 角色契合度（软加成）：只加分不惩罚。
    - Query（query_roles）或 Chunk（chunk_roles）任一方无角色名单 → 中性 0.5（该维度无信息，不参与加分也不惩罚）
    - 双方都有 → 命中率 = 交集数量 / Query 角色数（以解说段落期望角色为基准，优先主角命中；
      切片缺少某路人角色不扣分——"优先不排除"，避免因角色误识别导致匹配失败）
    """
    query_roles = [r for r in (query_roles or []) if isinstance(r, str) and r.strip()]
    chunk_roles = [r for r in (chunk_roles or []) if isinstance(r, str) and r.strip()]
    if not query_roles or not chunk_roles:
        return 0.5
    query_set = set(query_roles)
    chunk_set = set(chunk_roles)
    hit = sum(1 for r in query_set if r in chunk_set)
    return hit / len(query_set)


def _compute_duration_score(t_audio_ms: float, t_chunk_ms: float) -> float:
    """
    非对称裁剪友好型时长评分（0~1）：
    - 切片时长 >= 语音时长（可裁剪）：宽容，最高 0.95，随超长比例缓慢衰减（log2 衰减）
    - 切片时长略短于语音（0.85~1.0 倍）：线性过渡 0.80 → 0.95
    - 切片时长明显短于语音（0.60~0.85 倍）：线性下降 0.40 → 0.80
    - 切片过短（<0.60 倍）：二次方快速衰减，最低 0.01
    任一参数 <= 0 时返回中性 0.5（该维度无信息，不参与加分也不惩罚）。
    """
    if t_audio_ms <= 0 or t_chunk_ms <= 0:
        return 0.5
    ratio = t_chunk_ms / t_audio_ms
    if ratio >= 1.0:
        return max(0.70, 0.95 - math.log2(ratio) * 0.08)
    if ratio >= 0.85:
        return 0.80 + (ratio - 0.85) * 1.0
    if ratio >= 0.60:
        return 0.40 + (ratio - 0.60) * 1.6
    return max(0.01, 0.40 * (ratio / 0.60) ** 2)


# 🎬 P0.5 封面多点采样：超过该时长的切片，封面用头/中/尾 3 点平均池化，缓解封面帧漂移
MULTI_FRAME_THRESHOLD_MS = 6000
# 🛑 卡死修复 1/4：多点采样全局切片数上限，避免 300+ 长切片全开 OpenCV 打爆磁盘/CPU
#    超过阈值的切片直接回退封面图（平均池化的收益递减，不值得整机卡死）
MULTI_FRAME_MAX_CHUNKS = int(os.environ.get("ZENTECT_MULTI_FRAME_MAX_CHUNKS", "50"))
# 🛑 卡死修复 2/4：一键禁用多点采样（紧急降级开关），全量回退单封面图
_MULTI_FRAME_DISABLED = os.environ.get("ZENTECT_DISABLE_MULTI_FRAME", "") not in ("", "0", "false", "False")
# VideoCapture LRU 缓存：同一视频路径复用句柄，避免 300 次 open/close 把磁盘 I/O 打满
# 最大缓存 2 个句柄：典型场景只有 1 个原片视频，预留 1 个位给 BGM 预览/小视频等情况
_VIDEO_CAP_CACHE: dict = {}
_VIDEO_CAP_MAX_SIZE = 2


def _get_cached_video_capture(video_path: str):
    """
    获取同一路视频的 VideoCapture 句柄（LRU 缓存复用）。
    返回 (cap, is_new)：is_new=True 表示新建成功，is_new=False 表示从缓存命中；
    任一情况下 cap.isOpened() 为 False 均表示不可用，调用方需回退。
    """
    import cv2
    # 命中缓存：移到末尾（标记为最近使用），直接返回
    if video_path in _VIDEO_CAP_CACHE:
        cap = _VIDEO_CAP_CACHE.pop(video_path)
        try:
            if cap is not None and cap.isOpened():
                _VIDEO_CAP_CACHE[video_path] = cap
                return cap, False
        except Exception:
            pass
    # 未命中 / 缓存句柄已失效：新建句柄，淘汰最久未使用的项（dict 在 3.7+ 是插入有序的）
    while len(_VIDEO_CAP_CACHE) >= _VIDEO_CAP_MAX_SIZE:
        try:
            old_key, old_cap = next(iter(_VIDEO_CAP_CACHE.items()))
            _VIDEO_CAP_CACHE.pop(old_key)
            if old_cap is not None:
                old_cap.release()
        except StopIteration:
            break
        except Exception:
            pass
    cap = cv2.VideoCapture(video_path)
    if cap.isOpened():
        _VIDEO_CAP_CACHE[video_path] = cap
        return cap, True
    # 新建失败：兜底释放
    try:
        cap.release()
    except Exception:
        pass
    return None, True


def _release_all_video_captures():
    """
    显式释放所有缓存的 VideoCapture 句柄。
    在批量抽帧完成后、进入推理锁 / KM 求解前调用，避免文件句柄残留。
    """
    global _VIDEO_CAP_CACHE
    for cap in _VIDEO_CAP_CACHE.values():
        try:
            if cap is not None:
                cap.release()
        except Exception:
            pass
    _VIDEO_CAP_CACHE = {}


def _extract_frames_at_times(video_path: str, times_ms: list):
    """
    用 OpenCV 从视频按时间点抽帧，返回 RGB PIL 图列表（失败项为 None）。
    🛑 卡死修复 3/4：
      - 按 CAP_PROP_POS_MSEC（毫秒）seek，避免长 GOP H.264 下按帧号反向推算导致的来回跳解码；
      - 复用 VideoCapture LRU 缓存，同一视频只 open 一次；
      - 对 cap.set / cap.read 加异常捕获，任一帧失败不崩溃，留 None 由调用方回退封面。
    用于 >6s 切片封面头/中/尾 3 点采样；有效帧 <2 时调用方回退封面图。
    """
    from PIL import Image
    import cv2
    frames = [None] * len(times_ms)
    if not video_path or not times_ms:
        return frames
    cap, _ = _get_cached_video_capture(video_path)
    if cap is None or not cap.isOpened():
        return frames
    # 🛑 卡死修复 3/4：显式排序后顺序 seek，减少来回跳帧解码（长 GOP 视频每次跳回 I 帧 = 解几百帧）
    indexed = sorted(enumerate(times_ms), key=lambda x: x[1])
    last_pos_ms = -1.0
    for orig_i, t_ms in indexed:
        try:
            # 允许 80ms 容差：上次 seek 位置已经接近目标时，直接顺序读，不再触发 set
            if last_pos_ms < 0 or abs(t_ms - last_pos_ms) > 80.0:
                cap.set(cv2.CAP_PROP_POS_MSEC, float(t_ms))
            ok, frame = cap.read()
            if ok and frame is not None:
                frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                # 🔧 R13 立即缩放 224px：抽帧后马上缩到目标尺寸，禁止原尺寸 PIL 帧驻留多帧池
                resample = getattr(Image, 'Resampling', Image).LANCZOS
                frames[orig_i] = Image.fromarray(frame_rgb).resize((224, 224), resample)
                # 更新当前解码位置（FPS=25 时 1 帧=40ms，保守 +60ms 估算）
                last_pos_ms = t_ms + 60.0
            else:
                last_pos_ms = -1.0  # 读失败：下帧强制重新 seek
        except Exception:
            # OpenCV native 层抛错（损坏帧 / 文件句柄失效）：单帧跳过，不污染其他帧
            last_pos_ms = -1.0
            continue
    return frames


def _prefetch_multi_frame_pool(video_chunks: list, valid_chunk_indices: list):
    """
    🛑 卡死修复 4/4：在进入 INFERENCE_LOCK 之前，把所有需要 OpenCV 抽帧的切片
    【按视频路径分组 → 组内按 start_ms 升序 → 批量顺序抽帧】，返回 {chunk_idx: [PIL frames]}。
    - 同一视频不再反复 open/close（LRU 缓存），seek 全部升序（单次顺序解码 ≈ 随机 seek 的 1/50 耗时）；
    - 受 MULTI_FRAME_MAX_CHUNKS 限流，超出阈值的长切片直接跳过（结果不写回 = 调用方回退封面）；
    - 抽帧过程不持有推理锁，只做纯磁盘 I/O + OpenCV 解码，GPU/CLIP 推理不受影响；
    - 封面图已存在的切片优先把封面作为首帧，视频只需补 mid/tail 两帧，再次减少 1/3 seek。
    返回的 dict 中 chunk_idx 缺失即表示该切片应回退封面图。
    """
    from PIL import Image
    if _MULTI_FRAME_DISABLED:
        return {}
    # Step1: 从所有有效切片中挑出候选（>6s + video_path 存在），并检查是否有封面可复用
    candidates = []  # (chunk_idx, chunk, need_times_ms, cover_img_or_None)
    for ci in valid_chunk_indices:
        if len(candidates) >= MULTI_FRAME_MAX_CHUNKS:
            break
        chunk = video_chunks[ci]
        dur_ms = float(chunk.get("durationMs") or 0)
        video_path = chunk.get("filePath", "")
        if dur_ms <= MULTI_FRAME_THRESHOLD_MS or not video_path or not os.path.exists(video_path):
            continue
        cover = chunk.get("coverPath", "")
        cover_img = None
        start_need = True
        if cover and os.path.exists(cover):
            try:
                # 🔧 R13 立即缩放 224px：封面复用作首帧前先缩图，避免原尺寸驻留多帧池
                cover_img = _load_and_resize_thumb(cover)
                start_need = False  # 封面可直接作为 start_ms 那一帧，不用从视频抽
            except Exception:
                cover_img = None
        start_ms = float(chunk.get("startMs") or 0)
        end_ms = float(chunk.get("endMs") or (start_ms + dur_ms))
        mid_ms = (start_ms + end_ms) / 2.0
        tail_ms = max(start_ms, end_ms - 200.0)
        need_times = []
        need_meta = []  # 与 need_times 等长："start"/"mid"/"tail" 用于回填位置
        if start_need:
            need_times.append(start_ms)
            need_meta.append("start")
        need_times.append(mid_ms)
        need_meta.append("mid")
        need_times.append(tail_ms)
        need_meta.append("tail")
        candidates.append((ci, video_path, need_times, need_meta, cover_img))
    if not candidates:
        return {}
    # Step2: 按 video_path 分组，组内按 min(need_times) 升序（保证同一路视频顺序 seek 不回跳）
    by_video = {}
    for item in candidates:
        ci, video_path, need_times, need_meta, cover_img = item
        by_video.setdefault(video_path, []).append(item)
    result = {}
    for video_path, items in by_video.items():
        items.sort(key=lambda it: min(it[2]))
        for ci, vp, need_times, need_meta, cover_img in items:
            frames_in_order = _extract_frames_at_times(vp, need_times)
            # 回填为 [start_frame, mid_frame, tail_frame] 三槽位（固定顺序，与调用方平均池化兼容）
            slot = {"start": None, "mid": None, "tail": None}
            for pos_label, pil in zip(need_meta, frames_in_order):
                slot[pos_label] = pil
            # 如果封面可用（cover_img 非 None），start 槽位被封面覆盖（视频抽失败也无妨）
            if cover_img is not None:
                slot["start"] = cover_img
            pooled = [slot["start"], slot["mid"], slot["tail"]]
            valid_count = sum(1 for f in pooled if f is not None)
            if valid_count >= 2:
                result[ci] = [f for f in pooled if f is not None]
    # 抽帧结束：立即释放所有 VideoCapture 句柄，防止文件句柄/解码缓存残留
    _release_all_video_captures()
    return result


def _compute_combined_score(sem_score: float, duration_penalty: float,
                            emotion_score: float = 0.5, role_score: float = 0.5,
                            weights: dict = None) -> float:
    """
    多因子综合打分：0.68 画面意图语义 + 0.15 时长契合 + 0.08 情绪意境 + 0.09 角色契合
    - 语义：画面意图（visualIntent）与切片描述的文本↔文本语义相似度归一化到 0~1
      （无 visualIntent 时回退解说词文本；时间轴锚定加成+关键词实体 boost 已并入语义分）
    - 时长：语音与切片时长契合度（非对称裁剪友好型评分，0~1）
    - 情绪：文案情绪与切片情绪相容度（0~1，任一方缺失给中性 0.5）
    - 角色：解说期望角色与切片出现角色的契合度（0~1，任一方缺失给中性 0.5）
    权重设计防止"只看文字匹配，却选中一个时长严重不匹配、被强拉变速的怪异画面"；
    🎯 2026-08-22 修复"牌匾/裂开"类强视觉信号被抢匹配：
      - 语义权重升到 0.62 并改为第一主依据（包含关键词实体 boost）
      - 情绪权重从 0.15 降到 0.08，避免"同类情绪=1.0 + 时长契合=0.95"这种弱相关性
        组合总分超越"语义精确匹配但情绪异类"的强信号组合
    🎯 2026-08-31 匹配贴切度再平衡（用户反馈"画面不够贴切文案"）：
      - 语义权重再升到 0.68、时长权重降到 0.15、角色微降到 0.09，语义第一主依据更强，
        降低"时长恰好但画面泛泛"的切片反超语义精确匹配的概率（仍受变速安全框钳制，不会强拉怪画面）
    🎵 P2 权重可配置：从 weights 读取四项权重（缺省回退默认值），并对四项权重做归一化，
    让前端调参真正生效，不再依赖硬编码。
    """
    _default_weights = {
        'sem': 0.68, 'emotion': 0.08, 'duration': 0.15, 'role': 0.09,
    }
    w = {key: float(weights.get(key, _default_weights[key]))
         for key in _default_weights} if isinstance(weights, dict) else dict(_default_weights)
    total = sum(w.values())
    if total > 0:
        w = {key: value / total for key, value in w.items()}
    else:
        w = dict(_default_weights)
    return w['sem'] * sem_score + w['emotion'] * emotion_score \
        + w['duration'] * duration_penalty + w['role'] * role_score


def _temporal_penalty(delta_ms: float) -> float:
    """三段式时序软罚（决策 #2 冻结值），作用于最大化目标 combined，越优越正：
    Δ<0          → −0.12  反时/铺垫，软压（硬倒走由既有 reselect 承担，避免叠加冲突）
    0≤Δ≤15000    → +0.04  完美顺承，仅作 tiebreak（量级≈0.5×emotion，不压 0.68 语义主依据）
    Δ>15000      → −0.04×(Δ−15000)/60000，封顶 −0.15（顺时序但大跨距，轻微距离惩罚）
    """
    if delta_ms < 0:
        return -0.12
    if delta_ms <= 15000:
        return 0.04
    return max(-0.04 * (delta_ms - 15000) / 60000, -0.15)


def _shot_routing_boost(chunk_shot_type, chunk_characters, query_characters, query_emotion) -> float:
    """Layer2 情绪路由（决策 #3 冻结值），作用于最大化目标 combined，命中即加权、绝不硬否决语义：
    - 仅当 query 带非空情绪时生效（情绪/内心戏才讲空镜·特写路由）；
    - 空镜优先：shotType 文本含"空镜" → +0.03（景物抒情托底）；
    - 主角特写：_shot_type_level≤2（特写/大特写/近景）且 chunk.characters ∩ query.characters 非空 → +0.02。
    空镜与特写不叠加（取更高 0.03）。未命中返回 0。
    """
    if not (query_emotion or '').strip():
        return 0.0
    stype = (chunk_shot_type or '')
    if '空镜' in stype:
        return 0.03
    level = _shot_type_level(stype)
    if level is not None and level <= 2:
        qc = set(str(x) for x in (query_characters or []) if x and str(x).strip())
        cc = set(str(x) for x in (chunk_characters or []) if x and str(x).strip())
        if qc and cc and (qc & cc):
            return 0.02
    return 0.0


def _abstract_semantic_score(chunk_shot_type) -> float:
    """🎬 决策 #6：抽象文案的景别分级语义分（与 _shot_routing_boost 同域，专供 isAbstractNarration 查询）。
    抽象旁白（"岁月流转"类）文字与任何具体画面均低相关，语义主分即路由意图：
    空镜 0.90（景物抒情托底，抽象旁白的第一画面语言）＞ 近景/特写 0.80（情绪脸谱可承接抽象抒情）
    ＞ 中景 0.55 ＞ 全景/远景/未识别 0.45（远景除非标注空镜，否则信息量不足以承接抽象叙事）。
    未识别景别兜底 0.45，与"其余"同档，不因元数据缺失而惩罚。"""
    stype = (chunk_shot_type or '')
    if '空镜' in stype:
        return 0.90
    level = _shot_type_level(stype)
    if level is None:
        return 0.45
    if level <= 2:
        return 0.80
    if level == 3:
        return 0.55
    return 0.45


def _is_temporal_exempt(query) -> bool:
    """flashback/montage 段语义豁免（决策 #2 豁免条款）：
    query 文本/画面意图/情绪命中"回忆/闪回/倒叙/蒙太奇/回溯"等关键词时返回 True，
    解除时序软罚——此时跨场景是剪辑意图（画面回溯），而非时序倒流错误。
    🎬 决策 #6：显式 isFlashback 字段优先于关键词猜测（契约化豁免入口，免受文案措辞影响）。
    """
    if query is None:
        return False
    if getattr(query, 'isFlashback', False):
        return True
    hay = ' '.join(str(_f) for _f in [
        getattr(query, 'text', None),
        getattr(query, 'visualIntent', None),
        getattr(query, 'emotion', None),
    ] if _f).lower()
    for _k in ('回忆', '闪回', '回想', '当年', '曾经', '过去', '以前',
               '回溯', '倒叙', '蒙太奇', 'flashback', 'montage', '回闪'):
        if _k in hay:
            return True
    return False


# 🎬 决策 #8：单次拼接最多额外桥接的跨镜头数（0 = 关闭桥接，回退纯同父链，独立回滚开关）
# 🎬 2026-09-05 档1+档2（剪辑师原速时长窗）：
#   - MAX_EXTRA_SHOTS：素材偏短时向后桥接物理相邻镜头的最大个数（2→3，让长解说有更多镜头可级联）；
#   - WINDOWIZE_COVER_MIN：拼接/裁剪覆盖目标时长的达标比（0.97≈原速窗口，变速≈1.0）；
#   - WINDOWIZE_TAIL_MAX_RATIO：素材比目标长超过该比例才"截尾定窗"（丢弃尾部多余物理帧，避免字幕尾帧闪入）。
MAX_EXTRA_SHOTS = 3
WINDOWIZE_COVER_MIN = 0.97
WINDOWIZE_TAIL_MAX_RATIO = 1.03


def _try_merge_contiguous_segs(ci, video_chunks, used_chunks, target_dur_ms):
    """
    🔧 P2：变速超限（素材偏短需放慢）时，尝试把切片 ci 与其同 parentChunk 的连续兄弟 seg
    按段序索引递增拼接补时长（语义不变，仅补物理时长），规避单切片变速超限重选。
    - 物理连续性断言：|seg_{k+1}.startMs - seg_k.endMs| <= 100ms（与导出层 TIME_CONTINUITY_MS 口径一致），
      且按 segmentIndexInParent 段序递增拼接（seg0→seg1→seg2），从源头杜绝"挑段拼"的跨段瞬移。
    - 🎬 决策 #8：同父链自然耗尽（父镜头末尾）且从未达标时，向物理相邻的下一镜头桥接扩容：
      仅向后（|next.startMs − merged_end| ≤ 100ms）、未占用、链式连续，最多额外桥接
      MAX_EXTRA_SHOTS 个镜头；物理相邻段若已被占用则立即停桥（不可跳过——跳过会造成时间轴重叠）。
      因"占用/断言失败/拼过头"退出的不桥接（时间轴对不上），仅"父镜头耗尽"才桥接。
    - 拼接验收：合并变速比落入 [0.80, 1.20] 即视为补足时长（轻微越界交由 speed clamp 0.93~1.08 兜底；
      dur score 公式对 ratio>1.0 本就宽松保底 0.70；真实牌匾 seg0+seg1=6000ms vs 语音 5125ms ≈1.17 可验收）。
    - 拼接占用：参与拼接的兄弟 seg 索引由调用方写入 global_used_chunks，防止后续 query 重复抢占造成时间轴重叠。
    返回 None 表示无可用拼接；否则返回 {seg_indices, seg_ids, total_dur, chunk}
    """
    seg = video_chunks[ci]
    parent_id = seg.get("parentChunkId")
    seg_idx = seg.get("segmentIndexInParent")
    if not parent_id or not isinstance(seg_idx, int):
        return None
    start_ms = float(seg.get("startMs") or 0)
    end_ms = float(seg.get("endMs") or 0)
    if end_ms <= start_ms or target_dur_ms <= 0:
        return None
    # 素材偏快（已比语音长）时拼接只会更长，无意义
    if (end_ms - start_ms) >= target_dur_ms:
        return None
    merged_start, merged_end = start_ms, end_ms
    seg_indices = [ci]
    seg_ids = [seg.get("id") or f"chunk_{ci}"]
    next_idx = seg_idx + 1
    best_merge = None  # 最近一次落入验收区间的组合
    chain_exhausted = False  # 🎬 决策 #8：True=同父链自然耗尽（允许桥接），False=因占用/断言/拼过头退出
    while True:
        nxt = None
        for ci2, s in enumerate(video_chunks):
            if s.get("parentChunkId") != parent_id:
                continue
            if s.get("segmentIndexInParent") != next_idx:
                continue
            nxt = (ci2, s)
            break
        if nxt is None:
            chain_exhausted = True
            break
        ci2, s2 = nxt
        if ci2 in used_chunks:
            break  # 兄弟已被其它 query 占用，时间轴可能重叠，停止拼接
        s2_start = float(s2.get("startMs") or 0)
        s2_end = float(s2.get("endMs") or 0)
        if abs(s2_start - merged_end) > 100:  # 物理连续性断言
            break
        merged_end = s2_end
        seg_indices.append(ci2)
        seg_ids.append(s2.get("id") or f"chunk_{ci2}")
        total_ms = merged_end - merged_start
        speed = total_ms / target_dur_ms
        if total_ms >= target_dur_ms * WINDOWIZE_COVER_MIN:
            # 🎬 2026-09-05 覆盖目标时长即收：调用方把窗口截为 target → 变速 1.0 原速
            best_merge = (list(seg_indices), list(seg_ids), merged_end)
            break
        if 0.80 <= speed < WINDOWIZE_COVER_MIN:
            # 轻微放慢仍可（变速 clamp 0.93~1.08 补差），记录为后备但继续拼到覆盖
            best_merge = (list(seg_indices), list(seg_ids), merged_end)
        if speed > 1.35:
            break  # 严重拼过头：采用最近后备或放弃
        next_idx += 1
    # 🎬 决策 #8：物理相邻镜头桥接（仅同父链自然耗尽且从未达标时启用）
    if best_merge is None and chain_exhausted:
        extra_shots = 0
        while extra_shots < MAX_EXTRA_SHOTS:
            bridge = None
            blocked = False
            for ci2, s in enumerate(video_chunks):
                if s.get("parentChunkId") == parent_id:
                    continue  # 同父兄弟已由阶段 1 链尽，桥接只找异父段
                if ci2 in seg_indices:
                    continue  # 已参与拼接
                s2_start = float(s.get("startMs") or 0)
                s2_end = float(s.get("endMs") or 0)
                if s2_end <= s2_start:
                    continue
                if abs(s2_start - merged_end) <= 100:
                    if ci2 in used_chunks:
                        blocked = True  # 物理相邻段已被占用：不可跳过（跳过即时间轴重叠），立即停桥
                        break
                    bridge = (ci2, s)
                    break
            if blocked or bridge is None:
                break
            ci2, s2 = bridge
            merged_end = float(s2.get("endMs") or 0)
            seg_indices.append(ci2)
            seg_ids.append(s2.get("id") or f"chunk_{ci2}")
            total_ms = merged_end - merged_start
            speed = total_ms / target_dur_ms
            if total_ms >= target_dur_ms * WINDOWIZE_COVER_MIN:
                best_merge = (list(seg_indices), list(seg_ids), merged_end)
                break  # 覆盖达标即止，不贪多（桥接越少视觉跳变风险越小）
            if 0.80 <= speed < WINDOWIZE_COVER_MIN:
                best_merge = (list(seg_indices), list(seg_ids), merged_end)
            if speed > 1.35:
                break  # 拼过头：采用最近后备或放弃
            extra_shots += 1
    if best_merge is None:
        return None
    seg_indices, seg_ids, merged_end = best_merge
    total_dur = merged_end - merged_start
    # 合成拼接切片（继承首段元数据，时间窗为拼接区间；同父兄弟元数据一致，覆盖/封面继承安全）
    merged_chunk = dict(seg)
    merged_chunk["startMs"] = round(merged_start, 1)
    merged_chunk["endMs"] = round(merged_end, 1)
    merged_chunk["durationMs"] = round(total_dur, 1)
    return {"seg_indices": seg_indices, "seg_ids": seg_ids, "total_dur": total_dur, "chunk": merged_chunk}


# ==========================================
# 🎯 2026-08-22 修复"牌匾类强视觉 chunk 被抢匹配"：关键词实体匹配 boost
#    + 空描述 chunk 相邻画面继承
# 🎯 2026-08-23 同步 TS 侧 3 项升级：
#    1) 实体/动作单条分从 0.20→0.22；手部从 0.12→0.14；氛围从 0.08→0.10
#    2) 新增「牌匾+裂纹」组合命中规则（单独+0.16），query 与 chunk 同时出现"牌匾+裂/裂纹"
#       时触发 double boost，解决"语义精确但词频低"被弱信号组合碾压的经典场景
#    3) clamp 上限从 0.60→0.70，给组合命中留出叠加空间
# ==========================================

# 每条规则：(query 命中正则, chunk 侧命中正则, 加分)
_KEYWORD_BOOST_RULES = [
    # —— 实体类（高权重：牌匾/招牌是强视觉锚点）
    (r'牌匾|招牌|匾额|老字号|鼎庆楼|门匾',
     r'牌匾|招牌|匾额|老字号|鼎庆楼|门匾|牌匾上|牌匾下|匾额上|匾额下', 0.22),
    # —— 动作类（高权重：裂开/劈开是场景核心动词）
    (r'裂|劈开|裂开|劈成|破碎|摔碎|碎裂|一劈为二|掰成|断开',
     r'裂|裂纹|劈开|破碎|断裂|折裂|掰开|炸|劈|裂痕|开裂',         0.22),
    # —— 实体+动作 组合命中（超高权重：query说"牌匾裂开"且chunk也含"牌匾+裂纹"同时出现，给double boost）
    (r'牌匾.*裂|裂.*牌匾|招牌.*裂|匾额.*裂',
     r'牌匾.*裂|裂.*牌匾|招牌.*裂|匾额.*裂|牌匾.*裂纹|裂纹.*牌匾',  0.16),
    # —— 氛围/意象类
    (r'光荣|荣耀|名声|声誉|鼎盛|辉煌|往昔|岁月',
     r'光荣|荣耀|辉煌|往昔|鼎盛|盛极|声誉|岁月|沧桑|旧事',             0.10),
    # —— 手部动作（抚摸裂纹是牌匾裂开的经典衔接镜头）
    (r'手指|抚摸|抚|触碰|摩挲|指尖|掌',
     r'手指|抚摸|抚|掌|手|触碰|摩挲|指尖|掌心|手背',                  0.14),
    # —— 室内场景（饭桌/吃饭等，便于区分室内外）
    (r'饭桌|餐桌|吃饭|围坐|一桌|菜肴|碗筷|宴席|酒席',
     r'饭桌|餐桌|吃饭|菜肴|碗筷|围坐|一桌|茶桌|宴席|酒席|杯盏',        0.10),
    # —— 人物主体类
    (r'人物|老人|女子|男子|小孩|角色|身影|掌柜|伙计',
     r'人物|老人|女子|男子|小孩|身影|掌柜|伙计|佣人|书生',              0.06),
    # —— 景别类
    (r'特写|近景|中景|全景|远景|航拍',
     r'特写|近景|中景|全景|远景|航拍|大特写|极特写|大远景|推镜|拉镜',   0.06),
]
# 预编译正则，避免循环里反复编译
import re as _re
_COMPILED_KEYWORD_RULES = [
    (_re.compile(qr), _re.compile(cr), b) for (qr, cr, b) in _KEYWORD_BOOST_RULES
]


def _keyword_match_boost(query_text: str, query_emotion: str, query_visual: str,
                         chunk_desc: str, chunk_emotion: str,
                         chunk_shot_type: str, chunk_characters, chunk_keywords) -> float:
    """
    文案（text+emotion+visualIntent）与切片侧（desc+emotion+shotType+角色+关键词）
    的精确实体/动作/景别匹配加分。解决 TF-IDF / 中文 CLIP 文本相似度在"强视觉信号
    低词频场景"（如牌匾/裂开/鼎庆楼仅出现在 2~3 个 chunk）得分被情绪/时长弱信号
    拉平的问题。返回 [0, 0.70]（2026-08-23 从 0.60 抬高以容纳"牌匾+裂"组合命中叠加），
    建议与语义分相加后 clamp 到 1.0 再进综合打分。
    """
    q_all = ' '.join(filter(None, [query_text or '', query_emotion or '', query_visual or '']))
    if not q_all:
        return 0.0
    chars_str = ''
    if isinstance(chunk_characters, list):
        chars_str = ' '.join(str(x) for x in chunk_characters if x)
    kw_str = ''
    if isinstance(chunk_keywords, list):
        kw_str = ' '.join(str(x) for x in chunk_keywords if x)
    c_all = ' '.join(filter(None, [
        chunk_desc or '', chunk_emotion or '', chunk_shot_type or '', chars_str, kw_str
    ]))
    bonus = 0.0
    for qr, cr, b in _COMPILED_KEYWORD_RULES:
        if qr.search(q_all) and cr.search(c_all):
            bonus += b
    return min(bonus, 0.70)


def _inherit_empty_chunk_descriptions(video_chunks):
    """
    对空描述 chunk 做相邻画面描述继承（优先前一个邻居，无前则用后一个）。
    用于在 VLM 漏写/全空的切片上，文本语义分支（TF-IDF/中文CLIP文本特征）不会
    直接给出 sText=0 被预选淘汰。返回新列表（每个 chunk 都是浅拷贝，description
    可能被替换为"【继承自xxx】描述"的字符串），原列表不修改。
    """
    if not video_chunks:
        return video_chunks
    out = []
    for c in video_chunks:
        nc = dict(c) if isinstance(c, dict) else c
        out.append(nc)
    M = len(out)
    for i in range(M):
        desc = ''
        c = out[i]
        if isinstance(c, dict):
            desc = (c.get('description') or '').strip()
        else:
            desc = (getattr(c, 'description', None) or '').strip()
        if desc:
            continue
        donor = None
        for j in range(i - 1, -1, -1):
            pd = ''
            if isinstance(out[j], dict):
                pd = (out[j].get('description') or '').strip()
            else:
                pd = (getattr(out[j], 'description', None) or '').strip()
            if pd:
                donor = out[j]
                break
        if donor is None:
            for j in range(i + 1, M):
                nd = ''
                if isinstance(out[j], dict):
                    nd = (out[j].get('description') or '').strip()
                else:
                    nd = (getattr(out[j], 'description', None) or '').strip()
                if nd:
                    donor = out[j]
                    break
        if donor is not None:
            donor_desc = ''
            donor_id = ''
            if isinstance(donor, dict):
                donor_desc = donor.get('description') or ''
                donor_id = donor.get('id') or '相邻切片'
            else:
                donor_desc = getattr(donor, 'description', '') or ''
                donor_id = getattr(donor, 'id', '相邻切片') or '相邻切片'
            new_desc = f'【继承自{donor_id}画面延续】{donor_desc}'
            if isinstance(c, dict):
                c['description'] = new_desc
            else:
                try:
                    c.description = new_desc
                except Exception:
                    pass
    return out


# VLM 二次裁决阈值（低于此值的匹配结果将触发 GPT-4o 重排）
VLM_CONFIDENCE_THRESHOLD = 0.4
# VLM 失败熔断：连续失败达到阈值后本进程内禁用重排，避免纯文本模型/无效凭据反复打日志
_VLM_FAIL_COUNT = 0
_VLM_FAIL_THRESHOLD = 3


def _call_vlm_rerank(script_text: str, candidate_covers: list,
                     api_key: str, api_base: str, model: str = "gpt-4o") -> int:
    """
    调用云端多模态 VLM（OpenAI 兼容接口，需支持识图）从 top-3 候选切片的封面图中，
    选出与解说词最匹配的一个。返回 0/1/2，失败或模型不支持识图时返回 0（保持原匹配）。
    """
    import requests

    global _VLM_FAIL_COUNT
    if _VLM_FAIL_COUNT >= _VLM_FAIL_THRESHOLD:
        return 0

    if not api_key or not api_base:
        print("[VLM裁决] 凭据不完整，跳过", file=sys.stderr)
        return 0

    prompt = (
        "从以下3张候选视频切片的封面图中，选出与解说词最匹配的一张。只输出数字 0、1 或 2。\n\n"
        f"解说词: {script_text}\n\n"
        "最佳匹配切片序号:"
    )

    try:
        import base64
        content = [{"type": "text", "text": prompt}]
        # 将候选封面图 base64 编码为多模态图片块（按 0/1/2 顺序排列）
        for cp in candidate_covers[:3]:
            if cp and os.path.exists(cp):
                try:
                    with open(cp, "rb") as f:
                        b64 = base64.b64encode(f.read()).decode("utf-8")
                    content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}})
                except Exception:
                    pass
        if len(content) < 2:
            return 0

        url = api_base.rstrip('/') + "/chat/completions"
        payload = {
            "model": model,
            "messages": [{"role": "user", "content": content}],
            "temperature": 0.1,
            "max_tokens": 10,
        }
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

        resp = requests.post(url, json=payload, headers=headers, timeout=30)
        resp.raise_for_status()
        body = resp.json()
        content_str = body["choices"][0]["message"]["content"].strip()

        match = re.search(r'[0-2]', content_str)
        if match:
            return int(match.group())
        print(f"[VLM裁决] 响应无法解析数字: {content_str[:100]}", file=sys.stderr)
        return 0

    except Exception as e:
        _VLM_FAIL_COUNT += 1
        if _VLM_FAIL_COUNT >= _VLM_FAIL_THRESHOLD:
            print(f"[VLM裁决] 连续失败 {_VLM_FAIL_COUNT} 次，本进程内禁用 VLM 重排（模型可能不支持识图）: {e}", file=sys.stderr)
        else:
            print(f"[VLM裁决] 调用失败: {e}", file=sys.stderr)
        return 0


def _apply_vlm_rerank(results: list, queries, video_chunks: list,
                      valid_chunk_indices: list, semantic_sim,
                      emotion_sim, role_sim, n_queries: int, api_key: str, api_base: str,
                      model: str = "gpt-4o", weights: dict = None) -> list:
    """
    对置信度低于 VLM_CONFIDENCE_THRESHOLD 的匹配结果，收集 top-3 候选切片，
    调用 VLM 二次裁决，替换低置信度匹配。
    🎭 P0 意境维度：新增 emotion_sim 参数，候选打分与 KM 主体一致计入情绪相容度。
    🎭 P1 角色契合度：新增 role_sim 参数，候选打分与 KM 主体一致计入角色命中。
    """
    import numpy as np

    if not results or not api_key or not api_base:
        return results

    BLOCK_DURATION_MS = 300000

    # 构建 query→block 映射
    query_block = {}
    accumulated_ms = 0
    for qi in range(n_queries):
        audio_dur = queries[qi].audioDurationMs or 0
        query_block[qi] = int(accumulated_ms / BLOCK_DURATION_MS)
        accumulated_ms += audio_dur

    # 构建 chunk→block 映射
    chunk_block = {}
    for ci_idx, ci in enumerate(valid_chunk_indices):
        chunk = video_chunks[ci]
        start_ms = chunk.get("startMs", 0)
        chunk_block[ci_idx] = int(start_ms / BLOCK_DURATION_MS)

    vlm_reranked = 0

    # 🎥 修复"重复切片"：KM 主匹配已保证每个切片只被一个 shot 占用（global_used_chunks 排他），
    # 但 VLM 二次裁决此前替换 chunkData 时不检查排他，可能把相邻 shot 已占用的切片再分给当前 shot，
    # 导致剪映草稿里出现重复的两段视频。这里维护一张"已占用切片 id"集合，替换前过滤掉他人占用的切片。
    used_chunk_ids = set(r.get("chunkId") for r in results if r.get("chunkId"))

    for result in results:
        if result["confidence"] >= VLM_CONFIDENCE_THRESHOLD:
            continue

        # 找到对应的 query index
        qi = None
        for i, q in enumerate(queries):
            if q.shotId == result["shotId"]:
                qi = i
                break
        if qi is None:
            continue

        # 获取该 query 所在 block 的候选切片池
        block_idx = query_block[qi]
        candidate_ci_indices = set()
        for offset in range(-3, 4):
            for ci_idx, cb in chunk_block.items():
                if cb == block_idx + offset:
                    candidate_ci_indices.add(ci_idx)

        # 排除"已被其他 shot 占用"的切片：当前 result 自己占用的切片允许替换（不产生新增重复）。
        # 这样候选池里只含"当前自身切片 + 未占用切片"，VLM 无论选哪个都不会造成重复。
        current_id = result.get("chunkId")
        used_by_others = used_chunk_ids - ({current_id} if current_id else set())
        candidate_list = sorted(
            ci_idx for ci_idx in candidate_ci_indices
            if video_chunks[valid_chunk_indices[ci_idx]].get("id") not in used_by_others
        )

        if len(candidate_list) == 0:
            continue

        # 计算该 query 对所有候选切片的 combined_score
        scores = []
        for ci_idx in candidate_list:
            ci = valid_chunk_indices[ci_idx]
            chunk = video_chunks[ci]
            audio_dur_ms = queries[qi].audioDurationMs or 0
            video_dur_ms = chunk.get("durationMs", 0)

            sem_score = float(semantic_sim[qi, ci_idx])
            sem_score = max(0.0, min(1.0, (sem_score + 1.0) / 2.0))

            duration_penalty = _compute_duration_score(audio_dur_ms, video_dur_ms)

            # 🎭 P0 意境维度：候选打分与 KM 主体一致计入情绪相容度
            emotion_score = float(emotion_sim[qi, ci_idx])

            # 🎭 P1 角色契合度：候选打分与 KM 主体一致计入角色命中
            role_score = float(role_sim[qi, ci_idx])

            # 🎯 修复：关键词精确匹配 boost（强视觉实体/动作），解决 TF-IDF/CLIP 文本低词频信号不足
            q = queries[qi]
            kw_boost = _keyword_match_boost(
                query_text=getattr(q, 'text', '') or '',
                query_emotion=getattr(q, 'emotion', '') or '',
                query_visual=getattr(q, 'visualIntent', '') or '',
                chunk_desc=chunk.get('description') or '',
                chunk_emotion=chunk.get('emotion') or '',
                chunk_shot_type=chunk.get('shotType') or '',
                chunk_characters=chunk.get('characters'),
                chunk_keywords=chunk.get('keywords'),
            )
            if kw_boost > 0:
                sem_score = min(1.0, sem_score + kw_boost)

            combined_score = _compute_combined_score(sem_score, duration_penalty, emotion_score, role_score, weights=weights)
            scores.append((ci_idx, ci, combined_score))

        scores.sort(key=lambda x: x[2], reverse=True)
        top3 = scores[:3]

        if len(top3) < 2:
            continue

        # 补齐到 3 个
        while len(top3) < 3:
            top3.append(top3[-1])

        # 提取候选切片封面图（多模态 VLM 直接看图裁决）
        covers = []
        for _, ci, _ in top3:
            chunk = video_chunks[ci]
            covers.append(chunk.get("coverPath", ""))

        # 调用 VLM
        script_text = queries[qi].text
        chosen = _call_vlm_rerank(script_text, covers, api_key, api_base, model)

        if chosen == 0:
            continue  # VLM 认可当前最佳候选（即原匹配），无需替换

        # 替换匹配结果
        new_ci_idx, new_ci, new_score = top3[chosen]
        new_chunk = video_chunks[new_ci]
        new_id = new_chunk.get("id", f"chunk_{new_ci:03d}")

        # 同步维护已占用集合：释放当前 result 旧切片占用，登记新切片占用（防止后续 shot 重复选中）
        if current_id:
            used_chunk_ids.discard(current_id)
        if new_id:
            used_chunk_ids.add(new_id)

        result["chunkId"] = new_id
        result["confidence"] = round(new_score, 4)
        result["coverPath"] = new_chunk.get("coverPath", "")
        result["chunkData"] = new_chunk
        vlm_reranked += 1

        print(f"[VLM裁决] {result['shotId']}: 置信度 {result['confidence']:.3f} → VLM 选择切片 {chosen}",
              file=sys.stderr)

    if vlm_reranked > 0:
        print(f"[VLM裁决] 共 {vlm_reranked} 条匹配被 VLM 重排", file=sys.stderr)

    return results


# ==========================================
# 🎬 P1 衔接流畅性：相邻切片连续性（色调 / 景别 / 情绪）
# ==========================================
# 景别 → 等级映射：1 特写 ~ 5 远景。相邻切片景别大跨级（特写↔全景）视觉跳跃突兀，
# 递进式衔接（特写→中景→全景）自然。识别不出景别时返回 None（该项给中性值，不参与惩罚）。
SHOT_TYPE_LEVELS = {
    '大特写': 1, '特写': 1, '极特写': 1, '微距': 1,
    '近景': 2, '中近景': 2,
    '中景': 3, '中全景': 3,
    '全景': 4, '远景': 5, '大远景': 5, '空镜': 5, '航拍': 5,
}


def _shot_type_level(shot_type: str):
    """景别文本 → 等级（1~5）；空/未识别返回 None"""
    shot_type = (shot_type or '').strip()
    if not shot_type:
        return None
    for kw, level in SHOT_TYPE_LEVELS.items():
        if kw in shot_type:
            return level
    return None


def _color_histogram_distance(hist_a, hist_b) -> float:
    """两切片 HSV 色相直方图 L1 距离归一化到 0~1（0 完全一致，1 完全不同）。
    缺色调特征时给中性 0.5（与 P0 情绪掩码同哲学：缺失不参与惩罚也不加分）。"""
    import numpy as np
    if not hist_a or not hist_b or len(hist_a) != len(hist_b):
        return 0.5
    return min(1.0, float(np.sum(np.abs(
        np.array(hist_a, dtype=np.float64) - np.array(hist_b, dtype=np.float64)))) / 2.0)


def _continuity_penalty(prev_chunk: dict, next_chunk: dict) -> float:
    """
    🎬 P1 衔接流畅性惩罚（0~1，越大越突兀）：
    - 色调：相邻切片 HSV 色相直方图差异（权重 0.4）
    - 景别：特写↔全景 大跨级跳跃（权重 0.3）
    - 情绪：相邻切片情绪突变（权重 0.3，复用 P0 情绪相容度）
    缺某项特征时该项给 0.5 中性，不参与惩罚也不加分。
    """
    hist_dist = _color_histogram_distance(
        prev_chunk.get('colorHistogram'), next_chunk.get('colorHistogram'))
    level_prev = _shot_type_level(prev_chunk.get('shotType'))
    level_next = _shot_type_level(next_chunk.get('shotType'))
    if level_prev is not None and level_next is not None:
        shot_dist = min(1.0, abs(level_prev - level_next) / 4.0)
    else:
        shot_dist = 0.5
    emotion_dist = 1.0 - _emotion_compatibility(
        prev_chunk.get('emotion'), next_chunk.get('emotion'))
    return 0.4 * hist_dist + 0.3 * shot_dist + 0.3 * emotion_dist


def _apply_continuity_rerank(results: list, queries, video_chunks: list,
                             valid_chunk_indices: list, semantic_sim, emotion_sim, role_sim,
                             weights: dict = None) -> list:
    """
    🎬 P1 衔接流畅性重排：对成品时间轴相邻匹配对做连续性检查（色调/景别/情绪），
    连续性差（惩罚超阈值）的边界，从该段文案的时间块候选池中替换为
    "内容可接受（综合分不低于原切片 90%）且衔接更自然"的未占用切片。
    局部替换，不动全局 KM 解；保持全局排他（不引入已占用切片）。
    🎭 P1 角色契合度：新增 role_sim 参数，候选打分与 KM 主体一致计入角色命中。
    """
    import numpy as np

    if len(results) < 2:
        return results

    # 1. 构建 query→block / chunk→block 映射（与 VLM 重排同款时间块机制）
    BLOCK_DURATION_MS = 300000
    query_block = {}
    accumulated_ms = 0
    for qi in range(len(queries)):
        audio_dur = queries[qi].audioDurationMs or 0
        query_block[qi] = int(accumulated_ms / BLOCK_DURATION_MS)
        accumulated_ms += audio_dur
    chunk_block = {}
    for ci_idx, ci in enumerate(valid_chunk_indices):
        chunk_block[ci_idx] = int((video_chunks[ci].get("startMs") or 0) / BLOCK_DURATION_MS)

    # 2. 已占用切片集合（全局排他约束：候选切片必须未被任何 result 占用）
    used_chunk_ids = set()
    for r in results:
        cid = r.get("chunkId") or ""
        if cid:
            used_chunk_ids.add(cid)

    CONTINUITY_TRIGGER = 0.55  # 惩罚超过该阈值才触发替换尝试（避免过度调整）
    MIN_SCORE_KEEP = 0.9       # 替代切片综合分不得低于原切片 90%（内容不劣化）
    # 🎬 决策 #7：景别律动破格——同一景别连续 CADENCE_RUN_LIMIT 段即尝试换景别（设 9999 可独立禁用）
    CADENCE_RUN_LIMIT = 3
    # 🔧 决策 #7 性能修复：id→chunk 索引，替代主循环内 next() 线性扫描（整体 O(N²)→O(N)）
    chunk_by_id = {}
    for _c in video_chunks:
        _cid = str(_c.get("id") or "")
        if _cid:
            chunk_by_id[_cid] = _c
    reranked = 0
    # 🎬 决策 #7：景别游程状态（基于相邻 prev/cur level 对推进；替换后在轮末重置，
    #   防止旧基准残留把 C C D C 序列误判为游程 4 而误触发破格）
    prev_level = None
    run_level = None
    run_len = 0

    # 3. 逐相邻对检查连续性
    for i in range(1, len(results)):
        prev_r, cur_r = results[i - 1], results[i]
        prev_cid, cur_cid = prev_r.get("chunkId") or "", cur_r.get("chunkId") or ""
        if not prev_cid or not cur_cid:
            continue
        # 🔧 决策 #7 性能修复：用预建 id→chunk 索引替代 next() 线性扫描（O(N²)→O(N)）
        prev_chunk = chunk_by_id.get(prev_cid)
        cur_chunk = chunk_by_id.get(cur_cid)
        if prev_chunk is None or cur_chunk is None:
            continue
        # 🎬 决策 #7：景别游程推进——基于相邻 prev/cur 对而非陈旧基准，
        #   防止原地替换后 C C D C 被误判为同景别游程 4（D≠C 自然断链）
        cur_level = _shot_type_level(cur_chunk.get('shotType'))
        if cur_level is not None and cur_level == prev_level and cur_level == run_level:
            run_len += 1
        elif cur_level is not None and cur_level == prev_level:
            run_level, run_len = cur_level, 2
        else:
            run_level, run_len = cur_level, 1
        prev_level = cur_level
        cadence_break = run_len >= CADENCE_RUN_LIMIT
        penalty = _continuity_penalty(prev_chunk, cur_chunk)
        # cadence_break 时不因衔接分低而跳过——仍需进入候选筛选为当前段寻找换景别替身
        if penalty < CONTINUITY_TRIGGER and not cadence_break:
            continue

        # 找到该 result 对应的 query 索引及其时间块候选池
        qi = None
        for idx, q in enumerate(queries):
            if q.shotId == cur_r.get("shotId"):
                qi = idx
                break
        if qi is None:
            continue
        block_idx = query_block[qi]
        candidate_indices = set()
        for offset in range(-3, 4):
            for ci_idx, cb in chunk_block.items():
                if cb == block_idx + offset:
                    candidate_indices.add(ci_idx)
        if not candidate_indices:
            continue

        # 原切片综合分（含情绪）作为内容保底基准
        cur_ci_idx = next(
            (ci_idx for ci_idx, ci in enumerate(valid_chunk_indices)
             if video_chunks[ci].get("id") == cur_cid), None)
        if cur_ci_idx is None:
            continue
        audio_dur_ms = queries[qi].audioDurationMs or 0

        def _score(ci_idx):
            """计算 (query qi, 切片 ci_idx) 的综合分（与 KM 主体一致，含关键词 boost）"""
            chunk = video_chunks[valid_chunk_indices[ci_idx]]
            sem = max(0.0, min(1.0, (float(semantic_sim[qi, ci_idx]) + 1.0) / 2.0))
            # 🎯 修复：关键词精确匹配 boost（与 KM 主代价矩阵同规则）
            kw_boost = _keyword_match_boost(
                query_text=getattr(queries[qi], 'text', '') or '',
                query_emotion=getattr(queries[qi], 'emotion', '') or '',
                query_visual=getattr(queries[qi], 'visualIntent', '') or '',
                chunk_desc=chunk.get('description') or '',
                chunk_emotion=chunk.get('emotion') or '',
                chunk_shot_type=chunk.get('shotType') or '',
                chunk_characters=chunk.get('characters'),
                chunk_keywords=chunk.get('keywords'),
            )
            if kw_boost > 0:
                sem = min(1.0, sem + kw_boost)
            emo = float(emotion_sim[qi, ci_idx])
            role = float(role_sim[qi, ci_idx])
            dur = 1.0
            vdur = chunk.get("durationMs", 0)
            if audio_dur_ms > 0 and vdur > 0:
                dur = _compute_duration_score(audio_dur_ms, vdur)
            return _compute_combined_score(sem, dur, emo, role, weights=weights), chunk

        cur_score, _ = _score(cur_ci_idx)

        # 在候选池中找"内容可接受 + 与前一切片衔接最优"的替代
        best_cand_ci = None
        best_cand_chunk = None
        best_penalty = penalty
        for ci_idx in sorted(candidate_indices):
            ci = valid_chunk_indices[ci_idx]
            cand = video_chunks[ci]
            cid = cand.get("id") or ""
            if cid in used_chunk_ids:
                continue
            cand_score, _ = _score(ci_idx)
            if cand_score < cur_score * MIN_SCORE_KEEP:
                continue
            cand_penalty = _continuity_penalty(prev_chunk, cand)
            if cand_penalty < best_penalty:
                best_penalty = cand_penalty
                best_cand_ci = ci_idx
                best_cand_chunk = cand

        if best_cand_ci is None:
            continue

        # 4. 替换：释放原切片占用，写入新切片，重算综合分与变速参考
        old_cid = cur_r.get("chunkId") or ""
        used_chunk_ids.discard(old_cid)
        used_chunk_ids.add(best_cand_chunk.get("id") or "")
        cur_r["chunkId"] = best_cand_chunk.get("id", f"chunk_{best_cand_ci:03d}")
        cur_r["coverPath"] = best_cand_chunk.get("coverPath", "")
        cur_r["chunkData"] = best_cand_chunk
        new_score, _ = _score(best_cand_ci)
        cur_r["confidence"] = round(new_score, 4)
        # 变速参考：切片时长 / 成品时间段（保持 KM 的 0.93~1.08 限制，剪辑师 ±8% 准则）
        final_dur = (cur_r.get("videoTimelineEndMs") or 0) - (cur_r.get("videoTimelineStartMs") or 0)
        cand_vdur = best_cand_chunk.get("durationMs", 0)
        if final_dur > 0 and cand_vdur > 0:
            spd = cand_vdur / final_dur
            cur_r["appliedSpeedFactor"] = round(max(0.93, min(1.08, spd)), 3)
        reranked += 1
        # 🎬 决策 #7：替换后重置游程——新切片与前段若仍同景别则游程从 2 起算（相邻对口径），
        #   否则从 1 起算；与循环头推进共用同一口径，防止陈旧基准误触发
        new_level = _shot_type_level(best_cand_chunk.get('shotType'))
        if new_level is not None and new_level == prev_level:
            run_level, run_len = new_level, 2
        else:
            run_level, run_len = new_level, 1
        prev_level = new_level
        _rr_reason = '景别律动破格' if cadence_break else '衔接流畅性'
        print(f"[衔接重排] shotId={cur_r.get('shotId')} {_rr_reason}({penalty:.2f}) → 替换为切片 "
              f"{best_cand_chunk.get('id')}（衔接 {best_penalty:.2f}）", file=sys.stderr)

    if reranked > 0:
        print(f"[衔接重排] 共 {reranked} 个匹配因衔接流畅性被替换", file=sys.stderr)
    return results


def _kuhn_munkres_match_sync(req: KMMatchReq) -> dict:
    """
    🚀 KM 全局排他性最优匹配算法
    - 优先使用切片中预提取的 CLIP 512维视觉特征（省去重复编码）
    - 代价矩阵：0.5 * 文本语义 + 0.2 * 画面运动 + 0.3 * 时长契合（多因子综合打分）
    - 5分钟时序块级联分治，将 O(n³) 复杂度压制在可控范围内
    带全局推理锁保护，防止并发原生库崩溃
    """
    import numpy as np
    from scipy.optimize import linear_sum_assignment

    # ============================
    # 任何返回路径都兜底释放 VideoCapture 句柄，防止文件句柄/解码缓存残留打爆系统
    # ============================
    try:
        return _kuhn_munkres_match_sync_impl(req)
    finally:
        _release_all_video_captures()
        # 🔧 R1 模型生命周期（PR-1）：步骤5 匹配请求结束（成功/失败/finally）后主动释放
        #   clip / chinese_clip / face 三件套，避免常驻叠加到下一个项目
        #   （release_* 内部判空幂等，未加载的模型直接跳过）
        try:
            AIModels.release_clip()
            AIModels.release_chinese_clip()
            AIModels.release_face_app()
        except Exception as e:
            print(f"[KM] R1 释放 CLIP/人脸模型警告: {e}", file=sys.stderr)
        print(f"[KM] finally 释放三件套后 RSS={_mem_rss_mb():.1f}MB（回落观测点）", file=sys.stderr)


def _kuhn_munkres_match_sync_impl(req: KMMatchReq) -> dict:
    """
    KM 匹配实际实现（外层 try/finally 保证句柄释放）。
    详见 `_kuhn_munkres_match_sync` 的 docstring。
    """
    import numpy as np
    from scipy.optimize import linear_sum_assignment
    n_queries = len(req.queries)

    video_chunks = req.videoChunks
    # 🔧 缓存隔离：与写入端（video_analyzer detect_scene_chunks）同构的兜底 key（<projectId>:<mediaId>），
    #   读取端必须脚手架一致，否则跨项目复用旧切片池/封面。无 projectId 时回退 bare mediaId（兼容单项目/老请求）。
    pool_key = f"{req.projectId}:{req.mediaId}" if req.projectId else (req.mediaId or "default")
    if (not video_chunks or len(video_chunks) == 0) and pool_key in PROJECT_MATERIAL_POOL:
        # 阶段 B：素材池缓存结构升级为 {"chunks","matchSegments"}，KM 消费的是匹配候选级 matchSegments
        pool_val = PROJECT_MATERIAL_POOL[pool_key]
        if isinstance(pool_val, dict) and "matchSegments" in pool_val:
            video_chunks = pool_val.get("matchSegments") or []
        else:
            # 兼容旧结构（缓存为数组，阶段 A 及更早）
            video_chunks = pool_val
        print(f"[KM] 命中 PROJECT_MATERIAL_POOL 缓存 (key={pool_key})，切片数: {len(video_chunks)}", file=sys.stderr)

    n_chunks = len(video_chunks)
    # 打印本次请求规模（卡死排查关键指标：长切片数量 × seek 次数）
    n_long_chunks = sum(
        1 for c in video_chunks
        if float(c.get("durationMs") or 0) > MULTI_FRAME_THRESHOLD_MS
        and c.get("filePath", "") and os.path.exists(c.get("filePath", ""))
    )
    print(f"[KM] 请求规模：{n_queries} queries × {n_chunks} chunks（其中 >{MULTI_FRAME_THRESHOLD_MS//1000}s 长切片={n_long_chunks}，"
          f"多帧采样限流上限={MULTI_FRAME_MAX_CHUNKS}，全局禁用={_MULTI_FRAME_DISABLED}）", file=sys.stderr)

    # 🔬 KM 耗时观测：请求规模确定后初始化总起点，后续各子阶段用 _km_tick 打点
    _km_t0()
    _km_tick("入口(规模确定后)")

    # 🔧 KM 真实进度：算法开始（Node 轮询映射到前端 60% 附近）
    _report_km_progress(req.taskId, 0.03, "开始求解全局最优组合...")

    if n_queries == 0 or n_chunks == 0:
        return {"success": True, "results": []}

    # 🎯 修复：空描述 chunk 的相邻画面描述继承（VLM 漏写时避免 sText=0 被淘汰）
    video_chunks = _inherit_empty_chunk_descriptions(video_chunks)

    original_texts = [q.text for q in req.queries]
    texts = list(original_texts)
    # 🎯 P3 画面意图优先：查询侧语义文本用 visualIntent（画面语言），无则回退解说词文本。
    # 解说词是抽象解读、画面是具体视觉，跨空间 CLIP 图文匹配天然错位；
    # visualIntent 与切片描述同属"画面语言"，文本↔文本匹配更准。
    query_texts = [q.visualIntent or q.text for q in req.queries]

    valid_chunk_indices = []
    for i, chunk in enumerate(video_chunks):
        if chunk.get("startMs") is not None:
            valid_chunk_indices.append(i)

    if not valid_chunk_indices:
        # ===== [KM-DIAG] 空结果定位:切片池非空但无 valid(startMs 全缺),直接返回空 =====
        _km_diag(f"★★★ 空匹配结果根因1: valid_chunk_indices 为空(raw chunks={n_chunks}). "
                 f"首个 chunk 键={list(video_chunks[0].keys()) if video_chunks else 'EMPTY_POOL'}")
        return {"success": True, "results": [], "warning": "No valid chunks for matching"}

    pre_embeddings = []
    has_pre_embeddings = False
    for ci in valid_chunk_indices:
        chunk = video_chunks[ci]
        ve = chunk.get("visionEmbedding", [])
        if ve and len(ve) > 0:
            pre_embeddings.append(np.array(ve, dtype=np.float32))
            has_pre_embeddings = True
        else:
            pre_embeddings.append(None)

    # 🚀 英文停用词集合：过滤无视觉语义的虚词，避免挤占 CLIP 关键词槽位
    STOP_WORDS = {
        "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
        "have", "has", "had", "do", "does", "did", "will", "would", "can", "could",
        "shall", "should", "may", "might", "must", "in", "on", "at", "to", "for",
        "of", "with", "by", "from", "as", "into", "through", "during", "before",
        "after", "above", "below", "between", "under", "over", "and", "but", "or",
        "nor", "not", "no", "if", "then", "else", "so", "it", "its", "he", "she",
        "they", "his", "her", "their", "we", "you", "i", "me", "my", "our",
        "this", "that", "these", "those", "thus", "there", "here", "also",
        "very", "just", "only", "some", "any", "all", "each", "every", "more",
        "most", "other", "such", "about", "up", "out", "when", "where", "how",
        "which", "what", "who", "whom", "whose", "one", "two",
    }

    enhanced_texts = []
    for t in texts:
        cn_keywords = re.findall(r'[\u4e00-\u9fff]{2,4}', t)
        en_keywords = re.findall(r'[a-zA-Z]{2,}', t)
        # 对英文关键词做停用词过滤 + 去重，保留视觉语义词在前
        seen = set()
        unique_kw = []
        for kw in cn_keywords:
            if kw not in seen:
                seen.add(kw)
                unique_kw.append(kw)
        for kw in en_keywords:
            kw_lower = kw.lower()
            if kw_lower in STOP_WORDS:
                continue
            if kw not in seen:
                seen.add(kw)
                unique_kw.append(kw)
        keywords = unique_kw[:8]

        if keywords:
            kw_str = ', '.join(keywords)
            enhanced = f"a scene showing {kw_str}. {t[:80]}"
        else:
            enhanced = t[:80]
        enhanced_texts.append(enhanced)

    model, processor = AIModels.get_clip()
    zh_model, zh_processor = AIModels.get_chinese_clip()
    print(f"[KM] CLIP/Chinese-CLIP 加载后 RSS={_mem_rss_mb():.1f}MB（峰值观测点）", file=sys.stderr)
    text_features = None
    # 🔧 R5 矩阵降精度（PR-2）：相似度矩阵 float64 → float32，驻留减半且不影响 0~1 量级精度
    semantic_sim = np.zeros((n_queries, len(valid_chunk_indices)), dtype=np.float32)

    if zh_model is not None and zh_processor is not None:
        # 🚀 分支1：中文 CLIP（优先）——中文文案直编（无需翻译），切片封面用中文 CLIP 重新编码
        #    注意：英文 CLIP 预提取的 visionEmbedding 与中文 CLIP 特征空间不对齐，必须重编码图片
        import torch
        import torch.nn.functional as F
        from PIL import Image

        # 🛑 卡死修复 4/4：所有需要 OpenCV 的 I/O 密集操作，在进入 INFERENCE_LOCK 之前批量预取。
        #    推理锁只保护 GPU/CPU 密集的 CLIP 编码，不再被磁盘 I/O / OpenCV 解码阻塞几十分钟。
        #    prefetch_pool 格式：{chunk_idx: [PIL_image, ...]}，缺失即回退封面图。
        multi_frame_pool = _prefetch_multi_frame_pool(video_chunks, valid_chunk_indices)
        print(f"[KM] 多帧采样预取完成：{len(multi_frame_pool)}/{len(valid_chunk_indices)} 切片启用头/中/尾平均池化"
              f"（限流上限={MULTI_FRAME_MAX_CHUNKS}，禁用={_MULTI_FRAME_DISABLED}）", file=sys.stderr)

        with INFERENCE_LOCK:
            # 🔧 修复：中文 CLIP 文本编码器 max_position_embeddings=512，
            #   超长输入会让 token_type buffer expand 越界崩溃（expanded size 570 vs 512），
            #   显式 max_length=512 截断，保证 seq ≤ 512
            zh_inputs = zh_processor(text=query_texts, return_tensors="pt", padding=True, truncation=True, max_length=512).to(AIModels.device)
            with torch.no_grad():
                zh_text_features = _extract_pooler(zh_model.get_text_features(
                    input_ids=zh_inputs["input_ids"],
                    attention_mask=zh_inputs["attention_mask"],
                ))
            zh_text_features = F.normalize(zh_text_features, p=2, dim=-1).cpu().numpy()

            IMAGE_ENCODE_BATCH = 64
            # 🃏 P2 缓存读取（本次改造核心）：命中 clipZhEmbedding 的切片直接还原特征张量，
            #   只对缺失/维度不符的切片做图像重编码。此前该缓存"只写不读"——Node 每次回写 DB、
            #   请求也带着字段过来，但本循环无条件重编全部切片（901 段 ≈ 500s），流式卡片因此
            #   没有任何可推送窗口（99.9% 耗时在编码，全部块 0.1s 内解完）。
            #   维度校验：缓存向量长度必须等于中文 CLIP 文本特征维（模型输出维），
            #   不符视为缓存失效重编（错就错：失效数据不静默参与相似度矩阵）。
            expected_dim = int(zh_text_features.shape[1])
            cached_feat = {}
            need_encode = []
            for ci in valid_chunk_indices:
                emb = video_chunks[ci].get("clipZhEmbedding")
                if isinstance(emb, list) and len(emb) == expected_dim:
                    cached_feat[ci] = torch.tensor(emb, dtype=torch.float32).unsqueeze(0)
                else:
                    need_encode.append(ci)
            if cached_feat:
                print(f"[KM] clipZhEmbedding 缓存命中：{len(cached_feat)}/{len(valid_chunk_indices)} 切片免重编码"
                      f"（缺失重编 {len(need_encode)} 段）", file=sys.stderr)

            encoded_feat = {}
            total_need_batches = (len(need_encode) + IMAGE_ENCODE_BATCH - 1) // IMAGE_ENCODE_BATCH
            _enc_batch_no = 0
            for batch_start in range(0, len(need_encode), IMAGE_ENCODE_BATCH):
                batch_ci = need_encode[batch_start:batch_start + IMAGE_ENCODE_BATCH]
                batch_imgs = []
                batch_frame_counts = []  # 每个切片的帧数（>6s 多点采样为 3，其余为 1），用于平均池化
                for ci in batch_ci:
                    chunk = video_chunks[ci]
                    cover = chunk.get("coverPath", "")
                    # 🎬 P0.5 封面多点采样：命中多帧预取池 → 直接使用锁外抽好的 PIL 帧列表
                    if ci in multi_frame_pool:
                        pre_fetched = multi_frame_pool[ci]
                        if len(pre_fetched) >= 2:
                            batch_imgs.extend(pre_fetched)
                            batch_frame_counts.append(len(pre_fetched))
                            continue
                    # 回退：封面图（<=6s / 超限流阈值 / 抽帧失败 / 全局禁用多点采样）
                    if cover and os.path.exists(cover):
                        try:
                            # 🔧 R13：封面立即缩放 224px 再入批，禁止原尺寸 PIL 驻留
                            batch_imgs.append(_load_and_resize_thumb(cover))
                        except Exception:
                            batch_imgs.append(Image.new('RGB', (224, 224), color=(128, 128, 128)))
                    else:
                        batch_imgs.append(Image.new('RGB', (224, 224), color=(128, 128, 128)))
                    batch_frame_counts.append(1)

                if not batch_imgs:
                    _enc_batch_no += 1
                    continue
                image_inputs = zh_processor(images=batch_imgs, return_tensors="pt", padding=True).to(AIModels.device)
                with torch.no_grad():
                    batch_features = _extract_pooler(zh_model.get_image_features(
                        pixel_values=image_inputs["pixel_values"],
                    ))
                batch_features = F.normalize(batch_features, p=2, dim=-1)
                # 按切片平均池化（>6s 多帧取均值后归一化）
                feat_idx = 0
                for n_frames, ci in zip(batch_frame_counts, batch_ci):
                    pooled = batch_features[feat_idx:feat_idx + n_frames].mean(dim=0, keepdim=True)
                    pooled = F.normalize(pooled, p=2, dim=-1)
                    encoded_feat[ci] = pooled
                    # 🔧 P2 缓存落库：把中文 CLIP 图像特征写回 chunk，Node 侧按 id 合并回写 DB，
                    #   下次匹配命中 DB 缓存时免去图像重编码（性能优化，不改变匹配结果）
                    # 🔧 R6 embedding 瘦身（PR-2）：写回前降 float16 半精度，驻留与落库 JSON 体积减半
                    video_chunks[ci]["clipZhEmbedding"] = pooled.detach().cpu().to(torch.float16).numpy().flatten().tolist()
                    feat_idx += n_frames
                del image_inputs, batch_features, batch_imgs
                # 🔧 R13：批处理完立即触发 GC，及时回收 batch tensor / PIL 帧，避免峰值内存叠加
                gc.collect()
                # 🃏 真流式进度：封面重编码阶段按批进度插值到 0.03→0.32，
                #   杜绝"61% 钉死数分钟"的假死观感；N=0/1 时跳过除零，阶段尾再统一锚定 0.32。
                _enc_batch_no += 1
                if total_need_batches > 1 and req.taskId:
                    _enc_ratio = min(1.0, _enc_batch_no / total_need_batches)
                    _enc_progress = 0.03 + (0.32 - 0.03) * _enc_ratio
                    _report_km_progress(
                        req.taskId, _enc_progress,
                        f"正在重新编码封面图为语义向量（{len(encoded_feat)}/{len(need_encode)}）..."
                    )

            # 按 valid_chunk_indices 原顺序组装特征（缓存命中 + 本轮新编码），供相似度矩阵对位
            all_image_features = [
                cached_feat[ci] if ci in cached_feat else encoded_feat[ci]
                for ci in valid_chunk_indices
            ]

            image_features = torch.cat(all_image_features, dim=0).cpu().numpy()
            del all_image_features

            image_sim = zh_text_features @ image_features.T  # (n_queries, n_chunks) 画面意图↔封面图像

            # 🎯 切片描述文本语义：画面意图 ↔ 切片描述（步骤2 逐帧 VLM 描述按时间轴聚合而来）
            #    有描述切片：语义 = TXT_WEIGHT×描述文本 + IMG_WEIGHT×图像（描述含动作/情绪/景别/台词，信息量远超单帧封面）
            #    无描述切片：语义 = 纯图像（空文本编码结果不可预测，必须掩码归零，不能参与混合）
            # 🎬 阶段2 2.2：长描述先"保头300字+保尾200字"智能截断再入编码器，避免 512 截断丢尾部角色/场景
            chunk_desc_texts = [_smart_truncate_desc(video_chunks[ci].get("description")) for ci in valid_chunk_indices]
            # 🔧 R5 矩阵降精度（PR-2）：描述掩码 float64 → float32
            has_desc = np.array([1.0 if t else 0.0 for t in chunk_desc_texts], dtype=np.float32)
            if has_desc.sum() > 0:
                # 🔧 修复：同上，切片描述文本（多帧描述拼接可能超长）截断到 512，避免 token_type buffer 越界
                desc_inputs = zh_processor(text=chunk_desc_texts, return_tensors="pt", padding=True, truncation=True, max_length=512).to(AIModels.device)
                with torch.no_grad():
                    desc_features = _extract_pooler(zh_model.get_text_features(
                        input_ids=desc_inputs["input_ids"],
                        attention_mask=desc_inputs["attention_mask"],
                    ))
                desc_features = F.normalize(desc_features, p=2, dim=-1).cpu().numpy()
                text_sim = zh_text_features @ desc_features.T
                del desc_features
                text_sim *= has_desc[None, :]  # 无描述切片文本语义归零
                # 🎬 阶段2 2.1：文本主导（0.65）+ 图像托底（0.35），无描述切片保持纯图像
                semantic_sim = np.where(
                    has_desc[None, :] > 0,
                    IMG_WEIGHT * image_sim + TXT_WEIGHT * text_sim,
                    image_sim,
                )
                print(f"[KM] 中文 CLIP + 切片描述文本语义(TXT {TXT_WEIGHT}/IMG {IMG_WEIGHT})，{int(has_desc.sum())}/{len(valid_chunk_indices)} 切片带描述",
                      file=sys.stderr)
            else:
                semantic_sim = image_sim

            del zh_text_features, image_features

        print(f"[KM] 使用中文 CLIP 直编，匹配维度: {semantic_sim.shape[1]}", file=sys.stderr)

    elif has_pre_embeddings and model is not None and processor is not None:
        import torch
        import torch.nn.functional as F

        with INFERENCE_LOCK:
            text_inputs = processor(text=enhanced_texts, return_tensors="pt", padding=True, truncation=True).to(AIModels.device)
            with torch.no_grad():
                text_features = _extract_pooler(model.get_text_features(**text_inputs))
            text_features = F.normalize(text_features, p=2, dim=-1).cpu().numpy()

            final_image_features = np.zeros((len(valid_chunk_indices), text_features.shape[1]), dtype=np.float32)
            for idx, (ci, pre_emb) in enumerate(zip(valid_chunk_indices, pre_embeddings)):
                if pre_emb is not None and pre_emb.shape[0] == text_features.shape[1]:
                    final_image_features[idx] = pre_emb
                elif pre_emb is not None and len(pre_emb) > 0:
                    norm = np.linalg.norm(pre_emb)
                    if norm > 0:
                        final_image_features[idx] = pre_emb / norm

            semantic_sim = text_features @ final_image_features.T

        print(f"[KM] 使用预提取 CLIP 特征，匹配维度: {text_features.shape[1]}", file=sys.stderr)
        del text_features, final_image_features

    elif model is not None and processor is not None:
        import torch
        import torch.nn.functional as F
        from PIL import Image

        with INFERENCE_LOCK:
            text_inputs = processor(text=enhanced_texts, return_tensors="pt", padding=True, truncation=True).to(AIModels.device)
            with torch.no_grad():
                text_features = _extract_pooler(model.get_text_features(**text_inputs))
            text_features = F.normalize(text_features, p=2, dim=-1)

            IMAGE_ENCODE_BATCH = 64
            all_image_features = []
            for batch_start in range(0, len(valid_chunk_indices), IMAGE_ENCODE_BATCH):
                batch_imgs = []
                for ci in valid_chunk_indices[batch_start:batch_start + IMAGE_ENCODE_BATCH]:
                    cover = video_chunks[ci].get("coverPath", "")
                    if cover and os.path.exists(cover):
                        try:
                            # 🔧 R13：封面立即缩放 224px 再入批，禁止原尺寸 PIL 驻留
                            batch_imgs.append(_load_and_resize_thumb(cover))
                        except Exception:
                            batch_imgs.append(Image.new('RGB', (224, 224), color=(128, 128, 128)))
                    else:
                        batch_imgs.append(Image.new('RGB', (224, 224), color=(128, 128, 128)))

                image_inputs = processor(images=batch_imgs, return_tensors="pt", padding=True).to(AIModels.device)
                with torch.no_grad():
                    batch_features = _extract_pooler(model.get_image_features(**image_inputs))
                all_image_features.append(F.normalize(batch_features, p=2, dim=-1))
                del image_inputs, batch_features, batch_imgs
                # 🔧 R13：批处理完立即触发 GC，及时回收 batch tensor / PIL 帧，避免峰值内存叠加
                gc.collect()

            image_features = torch.cat(all_image_features, dim=0)
            del all_image_features

            semantic_sim = torch.matmul(text_features, image_features.T).cpu().numpy()
            del text_features, image_features
        print(f"[KM] 使用封面图重新编码，完成 {len(valid_chunk_indices)} 个切片", file=sys.stderr)

    else:
        print("[KM] CLIP 不可用，降级为时长匹配模式", file=sys.stderr)
        # 🔧 R5 矩阵降精度（PR-2）：降级矩阵 float64 → float32
        semantic_sim = np.ones((n_queries, len(valid_chunk_indices)), dtype=np.float32) * 0.3
    # 🔧 KM 真实进度：CLIP/中文CLIP 特征提取与语义相似度矩阵计算完成
    _report_km_progress(req.taskId, 0.32, "视觉语义特征提取完成，正在聚合多维匹配矩阵...")
    # 🔬 KM 耗时观测：封面图编码/语义矩阵阶段结束（此阶段是"卡死"头号嫌疑，打点定位）
    _km_tick("中文CLIP封面重编码+语义矩阵")

    # 🎯 P3 时间轴锚定加成：query 携带画面时间起点（startMs）时，覆盖该时间点的切片获得语义加成。
    #    步骤3 的 microChunk 与步骤5 的场景切片同源于原片时间轴，锚定是"写词时已看过画面"的强信号；
    #    但只做软加成（不锁死），保留 KM 全局排他性，避免锚定切片时长不匹配时被强拉变速。
    #    加成幅度 0.15：与语义权重 0.4 相乘后约 +0.06 综合分，足以压过同语义候选的噪声差。
    ANCHOR_BONUS = 0.15
    for qi, q in enumerate(req.queries):
        q_start = float(q.startMs or 0)
        if q_start <= 0:
            continue
        for ci_idx, ci in enumerate(valid_chunk_indices):
            chunk = video_chunks[ci]
            c_start = float(chunk.get("startMs") or 0)
            c_end = float(chunk.get("endMs") or c_start)
            if c_start <= q_start < c_end:
                semantic_sim[qi, ci_idx] = min(1.0, semantic_sim[qi, ci_idx] + ANCHOR_BONUS)
                break  # 时间轴不重叠，命中首个覆盖切片即可

    # 🎬 方案 2.3 温和归一（作用点：semantic_sim → combined 之间，评审要求"原始分保留审计"）。
    #   仅 S_max≥0.70 的行仿射拉伸（行内单调、不影响 KM 排序，只抬分位）；<0.70 坚决不动；
    #   env ZENTECT_KM_NORM_GATE=0 可整体关闭（A/B）。raw_semantic_sim 仅供 [MATCH_DIAG] 审计，不参与打分。
    semantic_sim, raw_semantic_sim = _apply_2_3_gentle_normalization(semantic_sim)

    # 🎭 P0 意境维度：构建文案情绪 ↔ 切片情绪相容度矩阵 (n_queries, n_chunks)
    #    切片情绪由步骤2 帧情绪按时间轴聚合而来（chunk.emotion），文案情绪来自步骤3 生成（query.emotion）
    query_emotions = [(q.emotion or '') for q in req.queries]
    chunk_emotions = [(video_chunks[ci].get("emotion") or '') for ci in valid_chunk_indices]
    # 🔧 R5 矩阵降精度（PR-2）：情绪矩阵 float64 → float32
    emotion_sim = np.zeros((n_queries, len(valid_chunk_indices)), dtype=np.float32)
    for qi in range(n_queries):
        for ci_idx in range(len(valid_chunk_indices)):
            emotion_sim[qi, ci_idx] = _emotion_compatibility(query_emotions[qi], chunk_emotions[ci_idx])
    q_with_emotion = sum(1 for e in query_emotions if e.strip())
    c_with_emotion = sum(1 for e in chunk_emotions if e.strip())
    print(f"[KM] 情绪匹配就绪：{q_with_emotion}/{n_queries} 段文案带情绪，{c_with_emotion}/{len(valid_chunk_indices)} 切片带情绪",
          file=sys.stderr)

    # 🎭 P1 角色组合匹配：构建 Query 角色 ↔ 切片角色契合度矩阵 (n_queries, n_chunks)
    #    Query 角色来自步骤3 透传的 chunk 锚定角色（query.characters），切片角色来自步骤2 帧角色按时间轴聚合（chunk.characters）
    query_roles = [[r for r in (q.characters or []) if isinstance(r, str) and r.strip()] for q in req.queries]
    chunk_roles = [[r for r in (video_chunks[ci].get("characters") or []) if isinstance(r, str) and r.strip()]
                   for ci in valid_chunk_indices]
    # 🔧 R5 矩阵降精度（PR-2）：角色矩阵 float64 → float32
    role_sim = np.zeros((n_queries, len(valid_chunk_indices)), dtype=np.float32)
    for qi in range(n_queries):
        for ci_idx in range(len(valid_chunk_indices)):
            role_sim[qi, ci_idx] = _compute_role_score(query_roles[qi], chunk_roles[ci_idx])
    q_with_role = sum(1 for r in query_roles if r)
    c_with_role = sum(1 for r in chunk_roles if r)
    print(f"[KM] 角色匹配就绪：{q_with_role}/{n_queries} 段文案带角色，{c_with_role}/{len(valid_chunk_indices)} 切片带角色",
          file=sys.stderr)
    # 🔧 KM 真实进度：语义/情绪/角色矩阵全部就绪（进入分块求解前）
    _report_km_progress(req.taskId, 0.42, "语义·情绪·角色多维矩阵就绪，开始时序分块求解...")
    # 🔬 KM 耗时观测：锚定加成+情绪/角色矩阵就绪
    _km_tick("情绪/角色矩阵就绪")

    BLOCK_DURATION_MS = 300000
    # 🎯 方向2（2026-08-30）：跨 query 时间单调约束容差（ms）。
    #    8/29 事故复现：跨项目缓存命中后"文案时间递增但切片时间倒走"。
    #    切片允许轻微时间重叠/回退（<2s 视为相邻衔接），超过即判定为时间倒走并触发单调重选。
    MONOTONIC_TOLERANCE_MS = 2000.0
    results = []
    current_timeline_ms = 0
    # 🎯 方向2：上一段文案已匹配切片的 endMs（全局单调推进锚点，跨 block 保留）
    last_chunk_end_ms = None

    # 🔧 P2 #11 方案B：每个 query 的候选切片 id 白名单（来自 Node 端 preselectTopK 的 perQueryTopK）。
    #    candidateIds 为 { shotId: [chunkId, ...] }，空 dict → candidate_sets 全空 → 退化为老逻辑全量求解。
    #    per_query 构建 Set 以便 O(1) 判候选；chunk 用 "id" 匹配（与 Node 侧 videoChunks[].id 对齐）。
    req_candidate_ids = dict(getattr(req, 'candidateIds', None) or {})
    candidate_sets = []
    for q in req.queries:
        cand = req_candidate_ids.get(q.shotId) or []
        candidate_sets.append(set(str(c) for c in cand) if cand else None)
    # 是否真有 query 启用了候选白名单（用于统计与告警）
    active_candidate_rows = sum(1 for s in candidate_sets if s is not None)
    if active_candidate_rows > 0:
        print(f"[KM] 方案B Top-K 行级稀疏开启：{active_candidate_rows}/{n_queries} 段文案带候选白名单",
              file=sys.stderr)

    query_blocks = {}
    chunk_blocks = {}
    accumulated_ms = 0   # 🛡 仅供"无有效 startMs 的 query"退化分组兜底

    for qi in range(n_queries):
        # 🎛 Step2 删除"分块降级"根因：query 分组键从"累计音频时长"改为"源 startMs"。
        #   旧逻辑用 audioDurationMs 累计归块，会把 0 时长段落全部聚簇到 block0 → 与切片 startMs 时间块错位 → 全空
        #   （即 [KM-DIAG] 结论1 的"query最大块 < 切片最小块 必断"）。
        #   BLOCK 常量仍保留：作为 chunk 索引网格 + 进度 + 候选兜底，但 query 不再按累计音频归块。
        q_start_ms = float(req.queries[qi].startMs or 0)
        if q_start_ms > 0:
            block_idx = int(q_start_ms / BLOCK_DURATION_MS)
        else:
            # 无锚 query(源时间缺失)：退化按累计音频就近归块，避免与其它无锚段落无限挤压同块
            block_idx = int(accumulated_ms / BLOCK_DURATION_MS)
        if block_idx not in query_blocks:
            query_blocks[block_idx] = []
        query_blocks[block_idx].append(qi)
        accumulated_ms += req.queries[qi].audioDurationMs or 0

    for ci_idx, ci in enumerate(valid_chunk_indices):
        chunk = video_chunks[ci]
        start_ms = chunk.get("startMs", 0)
        block_idx = int(start_ms / BLOCK_DURATION_MS)
        if block_idx not in chunk_blocks:
            chunk_blocks[block_idx] = []
        chunk_blocks[block_idx].append(ci_idx)

    max_block = max(max(query_blocks.keys(), default=0), max(chunk_blocks.keys(), default=0))
    global_used_chunks = set()
    # video_chunks 全局索引 → semantic_sim 列索引 的映射，供变速超限重选后重算语义分
    chunk_rank = {ci: idx for idx, ci in enumerate(valid_chunk_indices)}

    # 🔬 Step1 Layer1：预计算每段窗口（Node 显式窗口优先，未透传用源锚派生，候选不足自适应扩张）
    _qw = {}
    for _qi in range(n_queries):
        _w = _query_window(req.queries[_qi], valid_chunk_indices, video_chunks)
        if _w is not None:
            _qw[_qi] = _w

    # ===== [KM-DIAG] 空结果定位计数(分块循环累计,仅在 results 为空时打印) =====
    dbg_zero_dur_queries = sum(1 for qi in range(n_queries) if not (req.queries[qi].audioDurationMs or 0))
    dbg_block_gap_query = 0   # 有 query 但 ±3 窗口空候选的块(时序错位症结)
    dbg_block_gap_chunk = 0   # 无 query 的块
    dbg_block_attempted = 0   # 有 query+候选、真正进入求解的块

    for block_idx in range(max_block + 1):
        # 🔧 R3 取消贯通（PR-1）：每处理一个时序块检查取消标记，命中立即提前返回，
        #   避免取消请求继续空烧 CPU / 重复重试
        if req.taskId and is_task_cancelled(req.taskId):
            print(f"[KM] R3 收到取消标记（taskId={req.taskId}），KM 求解提前终止", file=sys.stderr)
            return {"success": True, "cancelled": True, "results": [], "videoChunks": video_chunks}
        # 🔧 KM 真实进度（块入口）：块级锚定 0.42→0.80 的起点，段级在块内继续插值细化，
        #   避免大视频单块跑很久时进度外观长时间不动的"假死"。
        block_base_progress = 0.42 + 0.36 * block_idx / (max_block + 1)
        block_end_progress = 0.42 + 0.36 * (block_idx + 1) / (max_block + 1)
        _report_km_progress(req.taskId, min(block_base_progress, 0.80),
                            f"正在求解时序块 {block_idx + 1}/{max_block + 1} 的全局最优画面归属...")
        # 🃏 卡片流式：记录本块求解前的结果条数，据此切出本块新增的增量（块末推送）
        pre_results_len = len(results)
        block_queries = query_blocks.get(block_idx, [])
        block_chunk_indices = set()
        for offset in [-3, -2, -1, 0, 1, 2, 3]:
            block_chunk_indices.update(chunk_blocks.get(block_idx + offset, []))
        # 🔬 Step1 Layer1：若本块所有 query 都有有效窗口，块候选收窄到"成员窗口并集"，
        #   让候选池从全片降到段内 30~50（决策 #1 验收）；任一无窗口则退回旧 ±3 块并集兜底。
        if block_queries and all(_qi in _qw for _qi in block_queries):
            _narrowed = set()
            for _qi in block_queries:
                _w0, _w1 = _qw[_qi]
                for _ci_idx in block_chunk_indices:
                    _ci = valid_chunk_indices[_ci_idx]
                    _cs = float(video_chunks[_ci].get("startMs") or 0)
                    if _w0 <= _cs <= _w1:
                        _narrowed.add(_ci_idx)
            if _narrowed:
                block_chunk_indices = _narrowed
        block_chunk_idx_list = sorted(block_chunk_indices)

        if not block_queries or not block_chunk_idx_list:
            if not block_queries:
                dbg_block_gap_chunk += 1   # 有切片候选但无 query(多为尾部无词块)
            elif not block_chunk_idx_list:
                dbg_block_gap_query += 1   # 有 query 但 ±3 窗口兜不到切片(时序错位)
            continue

        # 🔬 KM 耗时观测：真正进入求解的块，块号+规模打点（若长时间停在同一块，即卡点）
        _km_tick(f"进入块{block_idx}(q={len(block_queries)}×c={len(block_chunk_idx_list)})")

        dbg_block_attempted += 1   # 进入真正的 KM 求解,若 attempted>0 但 results=0 → 块内选片被 continue 吃掉

        local_n_queries = len(block_queries)
        local_n_chunks = len(block_chunk_idx_list)

        # 🔧 R5 矩阵降精度 + 拒方阵（PR-2）：从源头避免 1000×1000 级别 O(n³) 超时
        #   ① 绝对规模过大（>1200）直接拒绝：KM 求解为 O(n³)，超过即认为请求不可解；
        #   ② "近全连接方阵"拒绝：短视频全落 block0 时 ±3 窗口候选≈全部切片，
        #      local_cost 退化为 1000×1000 方阵，是既有超时主因——候选数 >512 且占全量 90% 以上即拒绝。
        if local_n_queries > 1200 or local_n_chunks > 1200:
            raise ValueError(
                f"[KM] R5 拒绝求解：本时序块规模过大（{local_n_queries} 段文案 × {local_n_chunks} 个候选切片，"
                "上限 1200）。请减小输入规模或精简切片粒度后重试")
        if local_n_chunks > 512 and local_n_chunks >= len(valid_chunk_indices) * 0.9:
            raise ValueError(
                f"[KM] R5 拒绝求解：代价矩阵接近全连接方阵（本块候选 {local_n_chunks}/{len(valid_chunk_indices)} "
                "几乎等于全部切片），会退化为 O(n³) 大矩阵求解导致超时。"
                "请精简切片粒度或缩小时间范围后重试")

        # 🔧 R5 矩阵降精度（PR-2）：KM 代价矩阵 float64 → float32（驻留减半，精度不影响 0~1 量级打分）
        local_cost = np.zeros((local_n_queries, local_n_chunks), dtype=np.float32)

        for lqi, qi in enumerate(block_queries):
            for lci, ci_idx in enumerate(block_chunk_idx_list):
                ci = valid_chunk_indices[ci_idx]
                chunk = video_chunks[ci]
                audio_dur_ms = req.queries[qi].audioDurationMs or 0
                video_dur_ms = chunk.get("durationMs", 0)

                # 🔧 P2 #11 方案B：非候选格置强惩罚，让 KM 尽可能在候选内求解。
                #    用 5.0（远超 combined_score 的 [0,1] 量级）而非正无穷：
                #    若某个 query 候选全部落在本时序块之外，KM 仍能兜底选次优，不会触发 assign 无解。
                cand_set = candidate_sets[qi]
                if cand_set is not None:
                    chunk_id = str(chunk.get("id") or "")
                    if chunk_id and chunk_id not in cand_set:
                        local_cost[lqi, lci] = 5.0  # 强惩罚：绝不优先，但保留兜底可分配
                        continue

                # 🔬 Step1 Layer1：窗外强惩罚（决策 #1 硬边界）。与 candidateIds 同通道量级，
                #   保证 KM 绝不跨段落所属窗口去做全局退让，杜绝"跨幕次乱跳"。无有效窗口(qi 不在 _qw)不加。
                _wq = _qw.get(qi)
                if _wq is not None:
                    _w0, _w1 = _wq
                    _cstart = float(chunk.get("startMs") or 0)
                    if not (_w0 <= _cstart <= _w1):
                        local_cost[lqi, lci] = WINDOW_PENALTY
                        continue

                # 🔧 决策 #5：排他前移——跨块已消耗的切片在矩阵构造时直接置强惩罚（与 WINDOW_PENALTY
                #   同通道量级），KM 求解期自动为该查询选次优，取代消费时静默丢弃；
                #   消费时检查保留作双保险（同块合并/变速重选路径会在矩阵求解之后继续修改 global_used_chunks）。
                if ci in global_used_chunks:
                    local_cost[lqi, lci] = 5.0
                    continue

                q = req.queries[qi]
                if getattr(q, 'isAbstractNarration', False):
                    # 🎬 决策 #6：抽象旁白路由——文字语义即噪声（与任何具体画面低相关），
                    #   语义主分由景别分级抽象分取代（空镜优先）；跳过关键词 boost（抽象文本无具体实体可命中）
                    sem_score = _abstract_semantic_score(chunk.get('shotType'))
                else:
                    sem_score = float(semantic_sim[qi, ci_idx])
                    sem_score = max(0.0, min(1.0, (sem_score + 1.0) / 2.0))

                    # 🎯 修复：关键词精确匹配 boost（强视觉实体/动作），解决 TF-IDF/CLIP 文本低词频信号不足
                    kw_boost = _keyword_match_boost(
                        query_text=getattr(q, 'text', '') or '',
                        query_emotion=getattr(q, 'emotion', '') or '',
                        query_visual=getattr(q, 'visualIntent', '') or '',
                        chunk_desc=chunk.get('description') or '',
                        chunk_emotion=chunk.get('emotion') or '',
                        chunk_shot_type=chunk.get('shotType') or '',
                        chunk_characters=chunk.get('characters'),
                        chunk_keywords=chunk.get('keywords'),
                    )
                    if kw_boost > 0:
                        sem_score = min(1.0, sem_score + kw_boost)

                duration_penalty = _compute_duration_score(audio_dur_ms, video_dur_ms)

                # 🎭 P0 意境维度：文案情绪与切片情绪相容度
                emotion_score = float(emotion_sim[qi, ci_idx])

                # 🎭 P1 角色契合度：解说期望角色与切片出现角色的命中率（软加成）
                role_score = float(role_sim[qi, ci_idx])

                # 🔬 Step3 Layer3：时序软罚 + 情绪路由加权 入矩阵（决策 #2/#3 冻结值）。
                #   - 时序软罚基准：Δ = chunk.startMs − query.source startMs
                #     （反时 −0.12 / 顺承 +0.04 / 大跨距线性衰减封顶 −0.15），flashback/montage 段语义豁免；
                #   - 情绪路由加权：query 带非中性情绪时，空镜 +0.03 / 主角特写 +0.02；
                #   均为加性微调，绝不压过 0.68 语义主依据（断层 B 软罚原则）。
                _delta = float(chunk.get("startMs") or 0) - float(getattr(q, 'startMs', 0) or 0)
                _adjust = 0.0 if _is_temporal_exempt(q) else _temporal_penalty(_delta)
                if not getattr(q, 'isAbstractNarration', False):
                    # 🎬 决策 #6：抽象旁白跳过情绪路由加权——情绪已由 emotion_score 计入综合分，再路由即双计
                    _adjust += _shot_routing_boost(
                        chunk.get('shotType'), chunk.get('characters'),
                        getattr(q, 'characters', None),
                        getattr(q, 'emotion', None) or '',
                    )
                combined_score = _compute_combined_score(sem_score, duration_penalty, emotion_score, role_score, weights=req.weights) + _adjust
                local_cost[lqi, lci] = -combined_score

        if local_n_queries > local_n_chunks:
            # 🔧 R5 矩阵降精度（PR-2）：padding 补零块 float64 → float32，与 local_cost 一致
            padding = np.zeros((local_n_queries, local_n_queries - local_n_chunks), dtype=np.float32)
            local_cost = np.hstack([local_cost, padding])

        with INFERENCE_LOCK:
            row_ind, col_ind = linear_sum_assignment(local_cost)

        # 🃏 真流式：块内按匈牙利返回顺序逐段推送卡片，
        #   段级进度在 block_base→block_end 内插值，单块再大也能看到进度连续推进。
        #   local_n_queries==0 时除零保护（与下方 if not block_queries 的 continue 呼应）。
        _seg_local_total = max(1, int(local_n_queries))
        _seg_local_idx = 0
        for ri, ci in zip(row_ind, col_ind):
            if ri >= local_n_queries or ci >= local_n_chunks:
                continue
            qi = block_queries[ri]
            ci_idx = block_chunk_idx_list[ci]
            real_ci = valid_chunk_indices[ci_idx]

            if real_ci in global_used_chunks:
                continue
            global_used_chunks.add(real_ci)

            query = req.queries[qi]
            chunk = video_chunks[real_ci]
            audio_dur_ms = query.audioDurationMs or 0
            video_dur_ms = chunk.get("durationMs", 0)

            raw_end_time_ms = current_timeline_ms + audio_dur_ms
            target_end_time_ms = raw_end_time_ms

            # 🎵 P2 BPM 整拍网格磁吸：bpm>0 时按 60000/bpm 的整拍网格吸附（动态阈值 35% 拍间隔），
            # 替代原来固定 250ms 的单点最近鼓点吸附；bpm<=0 时回退旧 250ms 逻辑。
            bpm = float(getattr(req, 'bpm', 0) or 0)
            if bpm > 0:
                beat_interval_ms = 60000.0 / bpm
                grid_pos = round(raw_end_time_ms / beat_interval_ms) * beat_interval_ms
                if abs(grid_pos - raw_end_time_ms) < beat_interval_ms * 0.35:
                    target_end_time_ms = grid_pos
            elif req.bgmBeats:
                bgm_beats_ms = [b * 1000 for b in req.bgmBeats]
                closest_beat_ms = min(bgm_beats_ms, key=lambda x: abs(x - raw_end_time_ms))
                if abs(closest_beat_ms - raw_end_time_ms) < 250:
                    target_end_time_ms = closest_beat_ms

            final_video_duration_ms = target_end_time_ms - current_timeline_ms

            combined_score = -local_cost[ri, ci]

            raw_speed_factor = 1.0
            if final_video_duration_ms > 0 and video_dur_ms > 0:
                raw_speed_factor = video_dur_ms / final_video_duration_ms

            # 🎬 档1（2026-09-05）剪辑师原速窗口【素材≥目标】：素材不比目标短 → 直接截尾到目标（变速 1.0）。
            #    专业剪辑是"裁到正好长度"：素材长于目标一律裁剪（多余尾部还常是下一动作/字幕帧，弃之更干净），
            #    绝不为了"对齐"去变速快进素材。轻微超出(≤3%)由下方 speed clamp 微调，无感。
            if final_video_duration_ms > 0 and raw_speed_factor > 1.0 \
                    and video_dur_ms >= final_video_duration_ms * WINDOWIZE_COVER_MIN:
                _fs = float(chunk.get("startMs") or 0)
                if float(chunk.get("endMs") or 0) - _fs > final_video_duration_ms * WINDOWIZE_TAIL_MAX_RATIO:
                    chunk = dict(chunk)
                    chunk["endMs"] = round(_fs + final_video_duration_ms, 1)
                    chunk["durationMs"] = round(final_video_duration_ms, 1)
                    video_dur_ms = float(chunk["durationMs"] or 0)
                    print(f"[KM] shotId={query.shotId} 素材≥目标 → 原速截尾定窗（{video_dur_ms:.0f}ms，变速 1.0，弃长尾防字幕帧）", file=sys.stderr)

            # 变速超限重选（⚠️ 2026-09-05 起仅剩【放慢方向】入口；放快方向已被上方"原速截尾"吸收）：
            # 语音与素材时长不匹配（超出 0.93~1.08 变速能力，剪辑师 ±8% 准则）时，
            # 从当前时序块候选池中重选一个"语义0.6+时长0.4联合分"最高的未使用切片，
            # 以当前切片联合分为保底基准，只有候选联合分超过当前切片才重选，
            # 避免为了时长丢弃语义更贴合的切片（纯时长贴近会牺牲画面内容）。
            if raw_speed_factor < 0.93:
                cur_sem = max(0.0, min(1.0, (float(semantic_sim[qi, chunk_rank[real_ci]]) + 1.0) / 2.0))
                cur_chunk = video_chunks[real_ci]
                # 🎯 修复：变速重选同样计入关键词 boost
                cur_kw = _keyword_match_boost(
                    query_text=getattr(query, 'text', '') or '',
                    query_emotion=getattr(query, 'emotion', '') or '',
                    query_visual=getattr(query, 'visualIntent', '') or '',
                    chunk_desc=cur_chunk.get('description') or '',
                    chunk_emotion=cur_chunk.get('emotion') or '',
                    chunk_shot_type=cur_chunk.get('shotType') or '',
                    chunk_characters=cur_chunk.get('characters'),
                    chunk_keywords=cur_chunk.get('keywords'),
                )
                if cur_kw > 0:
                    cur_sem = min(1.0, cur_sem + cur_kw)
                cur_dur = _compute_duration_score(audio_dur_ms, video_dur_ms)
                # 🔧 P0（2026-08-22）：重选统一使用主综合权重（emotion/role 一并计入），
                # 替换原硬编码 0.6*sem + 0.4*dur，消除主 KM 与重选的打分断层
                cur_emotion = float(emotion_sim[qi, chunk_rank[real_ci]])
                cur_role = float(role_sim[qi, chunk_rank[real_ci]])
                cur_combined = _compute_combined_score(cur_sem, cur_dur, cur_emotion, cur_role, weights=req.weights)
                best_ci = real_ci
                best_combined = cur_combined

                # 🔧 P2（2026-08-22）：素材偏短（放慢方向）时，优先尝试拼接同父连续 seg 补时长，
                # 从根源规避变速超限，而非直接换成语义无关的"时长完美"镜头
                merged = None
                if raw_speed_factor < 0.93:
                    merged = _try_merge_contiguous_segs(real_ci, video_chunks, global_used_chunks, final_video_duration_ms)
                if merged is not None:
                    # 拼接成功：占用全部参与 seg（含兄弟），采用拼接切片；语义同父不变，取当前切片分
                    for _ci in merged["seg_indices"]:
                        global_used_chunks.add(_ci)
                    chunk = merged["chunk"]
                    video_dur_ms = merged["total_dur"]
                    # 🎬 档1 原速定窗：拼接覆盖≥目标 → 截尾到目标时长（变速 1.0）；仅轻微放慢(<1.03×)留给 clamp 补差
                    if final_video_duration_ms > 0 and video_dur_ms > final_video_duration_ms * WINDOWIZE_TAIL_MAX_RATIO:
                        _mcs = float(chunk.get("startMs") or 0)
                        chunk = dict(chunk)
                        chunk["endMs"] = round(_mcs + final_video_duration_ms, 1)
                        chunk["durationMs"] = round(final_video_duration_ms, 1)
                        video_dur_ms = float(chunk["durationMs"] or 0)
                    best_sem = cur_sem
                    best_dur_pen = _compute_duration_score(audio_dur_ms, video_dur_ms)
                    best_emotion = cur_emotion
                    best_role = cur_role
                    combined_score = _compute_combined_score(best_sem, best_dur_pen, best_emotion, best_role, weights=req.weights)
                    _spd = (video_dur_ms / final_video_duration_ms) if final_video_duration_ms > 0 else 1.0
                    print(f"[KM] shotId={query.shotId} 变速 {raw_speed_factor:.2f} 超限 → 拼接级联定窗（{'+'.join(merged['seg_ids'])}={video_dur_ms}ms，变速 {_spd:.2f}）", file=sys.stderr)
                else:
                    # 拼接不满足 → 回退单切片重选（P1 白名单 + P0 同权 + P3 语义门槛）
                    for cand_idx in block_chunk_idx_list:
                        cand_ci = valid_chunk_indices[cand_idx]
                        if cand_ci in global_used_chunks:
                            continue
                        cand_chunk = video_chunks[cand_ci]
                        cand_dur = cand_chunk.get("durationMs", 0)
                        if cand_dur <= 0:
                            continue
                        # 🔧 P1（2026-08-22）：重选候选同样受 perQueryTopK 白名单约束，
                        # 禁止被主流程白名单淘汰的弱相关素材"走后门"重选入替
                        cand_set = candidate_sets[qi]
                        if cand_set is not None:
                            cand_id_str = str(cand_chunk.get("id") or "")
                            if cand_id_str and cand_id_str not in cand_set:
                                continue
                        cand_sem = max(0.0, min(1.0, (float(semantic_sim[qi, chunk_rank[cand_ci]]) + 1.0) / 2.0))
                        # 🎯 修复：变速重选候选切片同样计入关键词 boost
                        cand_kw = _keyword_match_boost(
                            query_text=getattr(query, 'text', '') or '',
                            query_emotion=getattr(query, 'emotion', '') or '',
                            query_visual=getattr(query, 'visualIntent', '') or '',
                            chunk_desc=cand_chunk.get('description') or '',
                            chunk_emotion=cand_chunk.get('emotion') or '',
                            chunk_shot_type=cand_chunk.get('shotType') or '',
                            chunk_characters=cand_chunk.get('characters'),
                            chunk_keywords=cand_chunk.get('keywords'),
                        )
                        if cand_kw > 0:
                            cand_sem = min(1.0, cand_sem + cand_kw)
                        cand_dur_score = _compute_duration_score(audio_dur_ms, cand_dur)
                        # 🔧 P3（2026-08-22）：语义保护门槛（AND）——候选 sem ≥ 当前 sem×80% 且 ≥0.55，
                        # 任一不满足即拒绝替换，杜绝"时长唯上"的彻底错配
                        if cand_sem < cur_sem * 0.80 or cand_sem < 0.55:
                            continue
                        cand_emotion = float(emotion_sim[qi, chunk_rank[cand_ci]])
                        cand_role = float(role_sim[qi, chunk_rank[cand_ci]])
                        cand_combined = _compute_combined_score(cand_sem, cand_dur_score, cand_emotion, cand_role, weights=req.weights)
                        if cand_combined > best_combined:
                            best_combined = cand_combined
                            best_ci = cand_ci
                    if best_ci != real_ci:
                        # 单切片重选成功：占位新切片，并重算变速与综合得分
                        global_used_chunks.add(best_ci)
                        chunk = video_chunks[best_ci]
                        video_dur_ms = chunk.get("durationMs", 0)
                        print(f"[KM] shotId={query.shotId} 时长严重不匹配（变速 {raw_speed_factor:.2f} 超限），重选切片 {best_ci} 替代 {real_ci}", file=sys.stderr)
                        best_sem = float(semantic_sim[qi, chunk_rank[best_ci]])
                        best_sem = max(0.0, min(1.0, (best_sem + 1.0) / 2.0))
                        # 🎯 修复：变速重选成功后重算综合分同样计入关键词 boost
                        best_kw = _keyword_match_boost(
                            query_text=getattr(query, 'text', '') or '',
                            query_emotion=getattr(query, 'emotion', '') or '',
                            query_visual=getattr(query, 'visualIntent', '') or '',
                            chunk_desc=chunk.get('description') or '',
                            chunk_emotion=chunk.get('emotion') or '',
                            chunk_shot_type=chunk.get('shotType') or '',
                            chunk_characters=chunk.get('characters'),
                            chunk_keywords=chunk.get('keywords'),
                        )
                        if best_kw > 0:
                            best_sem = min(1.0, best_sem + best_kw)
                        best_dur_pen = _compute_duration_score(audio_dur_ms, video_dur_ms)
                        # 🎭 P0 意境维度：变速重选同样计入情绪相容度，避免为了时长丢弃意境更贴合的切片
                        best_emotion = float(emotion_sim[qi, chunk_rank[best_ci]])
                        # 🎭 P1 角色契合度：变速重选同样计入角色命中，避免为了时长丢弃角色更贴合的切片
                        best_role = float(role_sim[qi, chunk_rank[best_ci]])
                        combined_score = _compute_combined_score(best_sem, best_dur_pen, best_emotion, best_role, weights=req.weights)

            # 🎯 方向2（2026-08-30）：跨 query 时间单调约束（纵深防御）
            # 8/29 事故复现：跨项目缓存命中后"文案时间递增但切片时间倒走"（旧切片池时间轴错乱）。
            # 方向1 已从缓存键隔离根因；此处再加一道硬约束：主匹配/变速重选定稿后，
            # 若当前切片 startMs 明显早于上一段已匹配切片的 endMs（时间倒走），
            # 从当前 block 候选池重选一个"时间单调（startMs ≥ 上一 endMs）且语义不劣化"的切片，
            # 杜绝文案时间推进而画面时间回退的错乱观感。
            cur_start_ms = float(chunk.get("startMs") or 0)
            cur_end_ms = float(chunk.get("endMs") or cur_start_ms)
            if last_chunk_end_ms is not None and cur_start_ms < last_chunk_end_ms - MONOTONIC_TOLERANCE_MS:
                mono_best_ci = None
                mono_best_combined = -1.0
                base_combined = combined_score
                for cand_idx in block_chunk_idx_list:
                    cand_ci = valid_chunk_indices[cand_idx]
                    if cand_ci in global_used_chunks:
                        continue
                    cand_chunk = video_chunks[cand_ci]
                    cand_start = float(cand_chunk.get("startMs") or 0)
                    # 时间单调：候选切片起点不得早于上一段切片结束（2s 容差内允许轻微重叠衔接）
                    if cand_start < last_chunk_end_ms - MONOTONIC_TOLERANCE_MS:
                        continue
                    cand_dur = cand_chunk.get("durationMs", 0)
                    if cand_dur <= 0:
                        continue
                    # 白名单约束（与主流程/变速重选一致）：禁止被淘汰的弱相关素材走后门入替
                    cand_set = candidate_sets[qi]
                    if cand_set is not None:
                        cand_id_str = str(cand_chunk.get("id") or "")
                        if cand_id_str and cand_id_str not in cand_set:
                            continue
                    cand_sem = max(0.0, min(1.0, (float(semantic_sim[qi, chunk_rank[cand_ci]]) + 1.0) / 2.0))
                    cand_kw = _keyword_match_boost(
                        query_text=getattr(query, 'text', '') or '',
                        query_emotion=getattr(query, 'emotion', '') or '',
                        query_visual=getattr(query, 'visualIntent', '') or '',
                        chunk_desc=cand_chunk.get('description') or '',
                        chunk_emotion=cand_chunk.get('emotion') or '',
                        chunk_shot_type=cand_chunk.get('shotType') or '',
                        chunk_characters=cand_chunk.get('characters'),
                        chunk_keywords=cand_chunk.get('keywords'),
                    )
                    if cand_kw > 0:
                        cand_sem = min(1.0, cand_sem + cand_kw)
                    # 语义保护门槛：时间单调候选仍须语义达标，避免为了时间顺序牺牲内容正确性
                    if cand_sem < 0.55:
                        continue
                    cand_dur_score = _compute_duration_score(audio_dur_ms, cand_dur)
                    cand_emotion = float(emotion_sim[qi, chunk_rank[cand_ci]])
                    cand_role = float(role_sim[qi, chunk_rank[cand_ci]])
                    cand_combined = _compute_combined_score(cand_sem, cand_dur_score, cand_emotion, cand_role, weights=req.weights)
                    if cand_combined > mono_best_combined:
                        mono_best_combined = cand_combined
                        mono_best_ci = cand_ci
                # 仅当时间单调候选综合分不劣化（≥ 当前切片 95%）才替换，避免强行换出更贴合内容
                if mono_best_ci is not None and mono_best_combined >= base_combined * 0.95:
                    global_used_chunks.add(mono_best_ci)
                    chunk = video_chunks[mono_best_ci]
                    video_dur_ms = chunk.get("durationMs", 0)
                    combined_score = mono_best_combined
                    print(f"[KM] shotId={query.shotId} 时间倒走（切片 {cur_start_ms}ms 早于上一镜头 {last_chunk_end_ms}ms），重选时间单调切片 {mono_best_ci}", file=sys.stderr)

            speed_factor = 1.0
            if final_video_duration_ms > 0 and video_dur_ms > 0:
                speed_factor = video_dur_ms / final_video_duration_ms
                # 变速区间收紧到 0.93~1.08（专业剪辑师不超过 ±8%），防止强拉慢放导致的鬼畜/变相
                speed_factor = max(0.93, min(1.08, speed_factor))

            # 🎬 阶段2 2.4 匹配诊断：Q(段落) 命中切片，肉眼核对 VI↔desc 是否名副其实（防分高但画面不贴）。
            #    字段：RawSem=combined（2.3 启用后为归一后综合分）、Gate=该 query 是否被 2.3 温和归一拉伸(1/0)、
            #          Smax=该 query 候选池原始最大相似度（审计基准）、has_desc(0/1)、VI/ChunkDesc 截断样本
            try:
                _vi = str(getattr(query, 'visualIntent', '') or '')[:20]
                _desc = str(chunk.get('description') or '')[:24]
                _has_desc = 1 if str(chunk.get('description') or '').strip() else 0
                _smax = float(np.max(raw_semantic_sim[qi])) if raw_semantic_sim is not None else float('nan')
                _gate = 1 if (not MATCH_NORM_GATE_DISABLED and _smax >= MATCH_GATE_MIN_SMAX) else 0
                print(f"[MATCH_DIAG] Q:{query.shotId} | RawSem:{float(combined_score):.2f} | Gate:{_gate} | Smax:{_smax:.2f} | has_desc:{_has_desc} | VI:\"{_vi}\" <-> ChunkDesc:\"{_desc}\"", file=sys.stderr)
            except Exception:
                pass

            results.append({
                "shotId": query.shotId,
                "chunkId": chunk.get("id", f"chunk_{real_ci:03d}"),
                "confidence": round(float(combined_score), 4),
                "coverPath": chunk.get("coverPath", ""),
                "chunkData": chunk,
                "audioDurationMs": audio_dur_ms,
                "videoTimelineStartMs": round(current_timeline_ms, 1),
                "videoTimelineEndMs": round(target_end_time_ms, 1),
                "appliedSpeedFactor": round(speed_factor, 3)
            })

            current_timeline_ms = target_end_time_ms

            # 🎯 方向2：推进全局单调锚点（取当前切片 endMs 与历史锚点的最大值，防止时间轴回退）
            cur_end_ms = float(chunk.get("endMs") or float(chunk.get("startMs") or 0))
            if last_chunk_end_ms is None or cur_end_ms > last_chunk_end_ms:
                last_chunk_end_ms = cur_end_ms

            # 🃏 真流式（段级推送）：解完这一段就立刻把它推到前端，
            #   用户感知是"卡片一张一张跳出来"，而不是等整块解完才整批蹦出。
            #   进度同步在块区间内插值（段级），外观上百分比是连续推进的。
            _seg_local_idx += 1
            if req.taskId:
                # 段级进度：在当前块的 block_base→block_end 区间内按已处理段数比例线性插值
                _seg_ratio = min(1.0, _seg_local_idx / _seg_local_total)
                _seg_progress = block_base_progress + (block_end_progress - block_base_progress) * _seg_ratio
                _report_km_progress(
                    req.taskId, min(_seg_progress, 0.80),
                    f"正在求解时序块 {block_idx + 1}/{max_block + 1}（已解 {_seg_local_idx}/{_seg_local_total} 段）..."
                )
                _report_km_blocks(req.taskId, [results[-1]])

        # 🔬 KM 耗时观测：本块求解耗时（与"进入块"打点对比，可算出单块耗时；某块耗时异常高即求解卡点）
        _km_tick(f"块{block_idx}求解完毕")
        # 🃏 卡片流式：本块新增的匹配结果（results[pre_results_len:]）立即推入流式缓冲，
        #   Node 轮询 km_progress 时作为增量 results 弹出，前端据此逐个渲染卡片。
        #   （continue 跳过的空块不会到达此处，results 无新增时 _report_km_blocks 自动忽略。）
        _report_km_blocks(req.taskId, results[pre_results_len:])

    # ===== [KM-DIAG] 空结果定位:分块循环刚结束,若 results 为空打印根因统计 =====
    if len(results) == 0:
        sorted_q_blocks = sorted(query_blocks.keys())
        sorted_c_blocks = sorted(chunk_blocks.keys())
        _km_diag("★★★ 空匹配结果根因2/3(有 valid 但分块后无选中)! "
                 f"queries={n_queries} | raw_chunks={n_chunks} | valid_chunks={len(valid_chunk_indices)} | "
                 f"max_block={max_block} | zero_dur_queries={dbg_zero_dur_queries}(audioDurationMs=0 的数量) | "
                 f"gap_chunk块(无词)={dbg_block_gap_chunk} | gap_query块(有词兜不到片)={dbg_block_gap_query} | "
                 f"attempted求解块(有词+候选)={dbg_block_attempted}")
        _km_diag(f"错位线索: query块分布={sorted_q_blocks} | 切片块分布={sorted_c_blocks}")
        if dbg_block_attempted == 0 and sorted_q_blocks and sorted_c_blocks:
            _km_diag("结论1: 无任一快同时有 query+±3候选 → 时序错位/audioDurationMs 聚簇。"
                     f"query最大块={sorted_q_blocks[-1]} ≥ 切片最小块={sorted_c_blocks[0]}+3 时必断")
        elif dbg_block_attempted > 0:
            _km_diag(f"结论2: 有 {dbg_block_attempted} 块进入求解但仍 0 结果 → 块内选片全被 continue 跳过"
                     "(变速超限无候选/global_used_chunks 冲突/候选被强惩罚)。需看上方 [KM] shotId= 日志")

    # 🔬 KM 耗时观测：分块求解主体结束（对比"入口"打点可算出 KM 求解总耗时）
    _km_tick("分块求解主体完成")

    # VLM 二次裁决：对低置信度匹配调用 GPT-4o 重排
    # 🔧 KM 真实进度：分块求解结束，进入 VLM 内容裁决
    # 🔬 决策 #4：opt-in 双条件门控——需显式开启 req.useVlmRerank 且配齐 API 三件套，
    #   否则完全跳过云端 VLM 重排（默认关闭，不产生额外调用与耗时）。
    _report_km_progress(req.taskId, 0.86, "分块求解完成，正在进行云端 VLM 内容裁决...")
    if req.useVlmRerank and req.vlmApiKey and req.vlmApiBase and req.vlmApiModel:
        results = _apply_vlm_rerank(
            results, req.queries, video_chunks, valid_chunk_indices,
            semantic_sim, emotion_sim, role_sim, n_queries,
            req.vlmApiKey, req.vlmApiBase, req.vlmApiModel, req.weights,
        )

    # 🎬 P1 衔接流畅性重排：相邻切片色调/景别/情绪连续性优化。
    #    放在 VLM 内容裁决之后：先保证单点内容正确，再优化序列衔接，避免为了衔接牺牲内容。
    # 🔧 KM 真实进度：VLM 裁决完成，进行画面连续性优化
    _report_km_progress(req.taskId, 0.94, "VLM 内容裁决完成，正在优化相邻画面衔接...")
    if len(results) > 1:
        results = _apply_continuity_rerank(
            results, req.queries, video_chunks, valid_chunk_indices,
            semantic_sim, emotion_sim, role_sim, req.weights,
        )

    # 🔧 P2 缓存落库：把带 clipZhEmbedding 的切片回传 Node 侧，按 id 合并回写 DB 缓存

    # [ACCEPTANCE-DEBUG] 受环境变量保护的验收用 semantic_sim dump，生产默认关闭
    if os.environ.get("ZENTECT_KM_DUMP_SEM"):
        try:
            _dump = {
                "queryIds": [q.shotId for q in req.queries],
                "chunkIds": [c.get("id", "") for c in video_chunks],
                "valid_chunk_indices": valid_chunk_indices,
                "semantic_sim": semantic_sim.tolist(),
                "results": results,
            }
            with open(os.environ["ZENTECT_KM_DUMP_SEM"], "w", encoding="utf-8") as _f:
                json.dump(_dump, _f, ensure_ascii=False)
            print("[KM-DUMP] semantic_sim dumped", file=sys.stderr)
        except Exception as _e:
            print(f"[KM-DUMP] failed: {_e}", file=sys.stderr)

    # 🔧 KM 真实进度：全部结束（Node 轮询在 KM resolve 后置 80 收尾）
    _report_km_progress(req.taskId, 1.0, "全局最优组合求解完成")

    return {"success": True, "results": results, "videoChunks": video_chunks}
