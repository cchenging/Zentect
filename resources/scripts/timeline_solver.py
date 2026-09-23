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

import datetime
import tempfile
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from typing import List, Optional
from ai_config import (AIModels, PROJECT_MATERIAL_POOL, INFERENCE_LOCK,
                       set_task_cancel, is_task_cancelled, clear_task_cancel,
                       set_task_cancel, is_task_cancelled, clear_task_cancel)

router = APIRouter()

# 🛠 诊断日志可靠性（2026-09-16）：daemon 的 stderr 被 Node 以**管道**接管时是**块缓冲**，
#   当请求归还/进程被回收时，尾部缓冲可能整体丢失——实测导致 `空镜消费`/`空镜复用统计`/
#   `衔接重排`/`结构化字段覆盖` 等**验收关键行时有时无**（同一份代码不同轮次表现不同，
#   曾因此把"空镜确实被用了"误判为"零消费"）。
#   这里改为**行缓冲**：每条诊断按行即时落盘，验收不再依赖旁证推断。失败不影响主流程。
try:
    sys.stderr.reconfigure(line_buffering=True)  # type: ignore[attr-defined]
except Exception:  # pragma: no cover - 环境不支持时保持默认行为
    pass


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
    """🎭 人物归一（2026-09-18）：本段解说词期望角色的**注册表主键**集合（Node 侧按 person_registry.json
    的 aliasesHigh 长串优先子串命中得到；无注册表时为空数组）。
    与 characters 字段并存：role_score 优先吃 charIds（同一角色的"宋慧乔/宋慧乔饰演的角色/女子（宋慧乔）"
    等多种写法归一为一个 id），缺失时回退旧 characters 字符串比对（向后兼容）。
    🛑 人物仅作软排信号，永不参与硬门禁。"""
    charIds: List[str] = []
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
    """🎬 批1（2026-09-06）语义翻译层：query 场景组（SCENE_GROUPS 组名，如 教室系/医院系；空=该段无地点约束）。
    Node 侧按 visualIntent → 正文 推导（不做裸子串，R2-1），daemon 用它做三件事：
      ① 主矩阵场景命中加成（_scene_match_boost +0.08）
      ② _query_window 场景感知扩张（窗内无同组切片时继续扩，突破 5.0 硬边界，R2-3）
      ③ 矩阵窗外/候选白名单外 sceneGroup 命中格豁免 5.0 强惩罚（降软罚通道）
    仅当 query.sceneGroup == chunk.sceneGroup 才触发，场景词不在组表 → 空串（中性，不加不减）。"""
    sceneGroup: str = ''
    """🎬 批1（2026-09-06）语义翻译层：query 情绪终点态（平静舒缓/欢快轻松/紧张悬疑/悲伤沉重/愤怒激昂/中性）。
    Node 侧 VI 绝对优先锁定（R2-2）、正文仅在 VI 无情绪词时兜底并取转折终点状态；
    daemon 侧非空时**替换 query.emotion** 作为 emotion_sim 的 query 侧输入（复用既有 EMOTION_CATEGORIES/EMOTION_COMPAT 冲突抑制，R2-4）。"""
    moodIntent: str = ''
    """🎯 参考帧锚点（源视频坐标，ms）：步骤3 为该段文案选出的真实参考帧时间（与 startMs 等分插值并存）。
    ⚠️ 本期 daemon **不做任何消费**，仅接收以确保字段能到达请求体；后续"以真实画面锚点为 query"重构再启用。"""
    refFrameTimeMs: float = 0
    """🎯 参考帧画面描述（步骤2 帧描述；退化段为空字符串），本期仅接收不消费。"""
    refFrameDesc: str = ''
    """🎯 参考帧来源：matched=命中真实帧 / block_first=退化为母块首帧时间，本期仅接收不消费。"""
    refFrameSource: str = ''
    """📗 步骤1 ③ 句尾静音气口毫秒（原声段磁吸，补丁2/7 消费；None=无 ASR 气口数据，规则卡中性放行不造假）。"""
    silenceGapMs: Optional[float] = None
    """🎬 S3 分镜师工单（§24.15-B1）：由 S2/β 自动开单注入的段域契约字段。
    α 真工单由 Node 透传；β 过渡由 daemon 按视觉内容选段合成。
    默认 0/'' ⇒ 未开单时不触发段域硬候选（off/legacy 零行为变化，P6）。"""
    matchUnitId: str = ''
    """段号（剧情场次，来自场记单 §24.10）；>0 时候选=该段内全部切片（替代 ±3 块窗口）"""
    segmentId: int = 0
    """空间类型（门禁，B2 消费；本步仅接收不硬卡）"""
    spatialType: str = ''
    """工单模式：NEW_SHOT | CONTINUE_PREV（B4 消费；本步仅接收）"""
    shotMode: str = ''
    """允许降到第几级（§24.4 降级链，B3 消费；本步仅接收）"""
    fallbackLevel: int = 0
    """🎬 S3 分镜师工单（§24.15-B3）：动态门禁探测项——动作类别 / 关键道具 / 首选景别。
    α 真工单由 Node 透传（β 过渡为空=不做动态硬卡，P1 不混算）；空串=该项不参与门禁。"""
    actionType: str = ''
    keyProp: str = ''
    preferredShot: str = ''


# ============================================================
# 🎬 描述截断：_smart_truncate_desc 在描述超长时"保头300字(动作/景别) + 尾200字(角色/场景补全)"，
#   避免直接截前 512 丢尾、丢关键可匹配信息。
#   （原 IMG_WEIGHT / TXT_WEIGHT 图文混合权重随 CLIP 通道一并删除：语义分现为 BGE 纯文本余弦）
# ============================================================


def _smart_truncate_desc(text: str, head_chars: int = 300, tail_chars: int = 200) -> str:
    text = (text or '').strip()
    if len(text) <= head_chars + tail_chars:
        return text
    return text[:head_chars] + '……' + text[-tail_chars:]



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
STRONG_ANCHOR_FENCE_MS = 60000  # B域（§10.2.3 动作1）：真实参考帧强锚 ±60s 物理围栏
WINDOW_PENALTY = 5.0         # 窗外强惩罚（与 candidateIds 同通道量级，远超 combined 的 [0,1]）

# 🎬 P4 空镜复用硬额度（2026-09-15）：空镜允许跨段复用（B-Roll 是剪辑常规手法），
#   但必须受频次约束——空镜在影视素材中天然稀缺，无上限时全片抒情/哲思段会争抢同一个
#   "打分最高"的空镜，导致同一画面反复出现（观众穿帮）。
#   这是**合法性业务规则**：复用是克制，不是无限。额度用尽后该切片恢复排他语义。
BROLL_MAX_REUSE = 2


def _query_window(query, universe_indices, video_chunks):
    """段落级时间窗 [w0, w1]。
    - B域（§10.2.3 动作1）真实参考帧强锚优先：`refFrameSource=='matched'` → 以
      refFrameTimeMs 为中心的**强锚 ±60s 物理围栏**（替换近似 startMs 派生窗）；
      `block_first` → 同 ±60s，但窗内候选不足时放宽到近似派生窗（⟨段⟩ 的上界）。
    - 无锚（refFrameTimeMs≤0 / refFrameSource 空）→ 退章节映射：
      优先取 Node 显式透传的 windowStartMs/windowEndMs（决策 #1：Node 侧算好直接给）；
      仍未透传时由源锚派生：w0=max(0,startMs−30s)，w1=startMs+durationMs+60s。
    - 候选不足（窗内切片数 < WINDOW_MIN_CANDIDATES）时单向扩张：先 +120s 后延，仍不足再 −120s 前探。
    - 🎬 批1 R2-3 场景感知扩张：query 带 sceneGroup 时，扩张判据从"窗内切片数 ≥5"
      改为"窗内存在同组切片"——只要窗内无同组切片且未达上限(+600s)，继续 +120s 单向扩张，
      让散布全片的目标场景切片能进入候选（教室切片 0.5~24min 散布实证 F5）。
    返回 (w0, w1)；源锚也无效（startMs 与 durationMs 均 ≤0）返回 None，调用方走旧 ±3 块兜底。"""
    # ---- 强锚（B域 §10.2.3 动作1）：步骤3 真实参考帧优先 ----
    ref_frame = float(getattr(query, 'refFrameTimeMs', 0) or 0)
    ref_src = str(getattr(query, 'refFrameSource', '') or '')
    if ref_frame > 0 and ref_src in ('matched', 'block_first'):
        w0 = max(0.0, ref_frame - STRONG_ANCHOR_FENCE_MS)
        w1 = ref_frame + STRONG_ANCHOR_FENCE_MS
        # block_first 候选不足时放宽到章节派生窗（"放宽到段"的物理上界）。
        start = float(query.startMs or 0)
        dur = float(query.durationMs or 0)
        if ref_src == 'block_first' and universe_indices:
            def _in_win(_w0, _w1):
                return sum(1 for i in universe_indices
                           if _w0 <= float(video_chunks[i].get('startMs') or 0) <= _w1)
            if _in_win(w0, w1) < WINDOW_MIN_CANDIDATES and (start > 0 or dur > 0):
                w0 = max(0.0, start - WINDOW_LEAD_MS)
                w1 = start + dur + WINDOW_TAIL_MS
        return (w0, w1)

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
        q_scene_group = (getattr(query, 'sceneGroup', '') or '').strip()
        if q_scene_group:
            # 🎬 批1 R2-3：场景感知扩张——只要窗内尚无同组切片就继续单向 +120s（上限 +600s 防失控）
            def _scene_in_win(_w0, _w1):
                for i in universe_indices:
                    _cs = float(video_chunks[i].get('startMs') or 0)
                    if _w0 <= _cs <= _w1 \
                            and _map_scene_group(video_chunks[i].get('scene') or '') == q_scene_group:
                        return True
                return False
            _steps = 0
            while not _scene_in_win(w0, w1) and _steps < 5:   # 5×120s = 上限 +600s
                w1 += WINDOW_EXPAND_MS
                _steps += 1
        else:
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


# ==========================================
# 🎬 批1（2026-09-06）语义翻译层：SCENE_GROUPS 场景组表 + 场景命中加成
#   ⚠️ 与 SemanticAnalyzeStrategy.ts 的 SCENE_GROUPS/moodIntent 词表同源，改词表须两端同步
#   chunk 侧：Node 聚合 chunk.scene（帧场景众数 / desc「场景:」正则回捞）→ _map_scene_group 映射到组；
#   query 侧：Node buildMatchQueries 用同表从 visualIntent → 正文 推导 sceneGroup；
#   组等值命中（query.sceneGroup == chunk.sceneGroup）才触发加成/窗口豁免（防裸子串假阳性 R2-1）。
# ==========================================
SCENE_GROUPS = {
    '教室系': ['教室内', '教室一角', '教室过道', '教室后排', '明亮教室', '教室课桌', '讲台', '黑板前', '课堂', '教室'],
    '医院系': ['医院', '病房', '医院走廊', '病床前', '诊室', '候诊区'],
    '居室系': ['卧室', '客厅', '房间', '宿舍', '昏暗卧室'],
    # 🏨 酒店系（P0-1 2026-09-16 新增）：实测本片主线场景（酒店前台×8／酒店走廊×3／VIP接待处×5…）
    #    此前完全不在词表 → 整段落"无组→中性"。长词优先保证 '前台接待处' 不被 '前台' 抢走。
    '酒店系': ['酒店前台', '酒店走廊', '酒店大堂', '酒店房间', '酒店', '套房', '客房', 'VIP休息室',
               'VIP接待处', '前台接待处', '接待处', '前台', '大堂'],
    '办公系': ['办公室', '办公桌', '会议室', '办公桌前', '办公桌后', '银行'],
    '车间系': ['车间', '工厂', '流水线', '厂房'],
    '餐饮系': ['餐厅包间', '餐厅内景', '餐厅', '餐桌', '饭店', '食堂', '厨房', '宴席', '室内餐桌'],
    '户外系': ['户外街道', '街道', '马路', '街头', '广场', '操场', '室外'],
    # 🚉 交通枢纽系（2026-09-16 新增）：交通**场地**（非载具内部）。
    #    ⚠️ 与「载具系」必须分开成组：若机舱与机场同组，场景命中加成会反向强化
    #    "机舱对白配到机场大厅"这类空间穿越错配（实测痛点 B）。
    #    P0-1 补：机场通道/机场跑道/登机口（实测出现但此前落无组）。
    '交通枢纽系': ['机场候机厅', '机场大厅', '机场通道', '机场跑道', '登机口', '候机厅', '候机楼', '航站楼',
                   '机场', '车站', '火车站', '码头', '港口', '地铁站'],
    # 🚗 载具系（2026-09-16 新增）：载具内部空间（机舱/车厢/船舱…）。
    #    长词优先命中（'飞机客舱' > '客舱'/'飞机'），保证与 query 侧映射口径一致。
    #    P0-1 补：座位/窗边/过道/后座等载具内部**部位**词（实测出现但此前落无组）。
    '载具系': ['飞机客舱', '飞机机舱', '飞机座位', '机舱座位', '机舱窗边', '机舱过道', '车内后座',
               '机舱内', '客舱内', '机舱', '客舱', '车内', '车厢', '驾驶座', '副驾驶', '座位靠背',
               '出租车', '公交车', '地铁', '列车', '火车', '船舱', '甲板', '游轮',
               '飞机', '轿车', '船'],
    '场馆系': ['教室大厅', '复古大厅', '昏暗大厅', '大厅空镜', '大厅', '会场', '舞台'],
    '其他室内': ['昏暗室内', '室内近景', '室内特写', '室内', '楼梯间'],
}
# 场景组等值命中的软加成；地点核心词文本交集的软加成。
# ⚠️ 两者表达的是**同一件事**（地点一致性），只取其一（见 _scene_boost_for_query_chunk），
#    绝不求和——实测 +0.08+0.10=0.18 已达"语义差 0.065 的实际贡献(0.022)"的 8 倍。
SCENE_GROUP_BOOST = 0.08   # 主矩阵场景组命中加成（§4.1 维度A，软加成）
LOCATION_TEXT_BOOST = 0.10  # 地点核心词文本交集加成（query 侧场景组缺失/单侧含地点词时兜底；封闭词表，不覆盖未收录小众地点）
# 🎬 加性层总额上限（2026-09-16）：_adjust 聚合后硬夹逼。
#   依据实测：语义主分权重 0.68，BGE 余弦差 0.065 → 归一化 (x+1)/2 → ×0.68 = **0.022**；
#   而单个场景组加成 +0.08 即为其 3.6 倍。多个加性项（时序/情绪路由/运镜/场景）叠加
#   足以整体盖过语义主分，重演"教室文案被分到城市空镜"。故夹逼加性总额，
#   确保视听属性只做"破平局扰动"，不夺语义主导权。
ADJUST_CAP = 0.12

# ═══════════════════════════════════════════════════════════════════════════
# 🌐 P0-2/P0-3（2026-09-16，§23.2）：空间类型枚举 + 冲突矩阵
#   设计要点（改动前先读，均有实测依据）：
#   ① **组 → 空间类型**映射，把"内外景二元"升级为 7 值枚举；
#   ② **取消对载具/枢纽/场馆的排除**——旧实现（§20 第2步）把它们排除在一致性判定之外，
#      代价是本片 **48% 的候选**（载具 44 + 枢纽 39 = 83/173）在该维度完全空转；
#   ③ 冲突一律**软罚且并入同一信号池**（仍由 `_scene_boost_for_query_chunk` 返回单一标量），
#      **绝不删候选**（删池曾导致候选 884→0 空解）；
#   ④ 罚分取 `-ADJUST_CAP`（池上限）——**不采用提案里的 -0.30**：实测"语义差 0.065 × 0.68 权重
#      ≈ 0.022 分"，-0.30 是其 13.6 倍，会重演"维度膨胀盖过语义主分"（§15 的教训）。
# ═══════════════════════════════════════════════════════════════════════════
SPACE_TYPE_OF_GROUP = {
    '户外系': 'OUTDOOR',
    '载具系': 'VEHICLE',
    '交通枢纽系': 'HUB',
    '酒店系': 'HOTEL',
    '场馆系': 'VENUE',
    '居室系': 'INDOOR',
    '办公系': 'INDOOR',
    '教室系': 'INDOOR',
    '医院系': 'INDOOR',
    '餐饮系': 'INDOOR',
    '车间系': 'INDOOR',
    '其他室内': 'INDOOR',
}
# 互斥矩阵（对称，只列一次；两个方向都判）
SPACE_TYPE_CONFLICTS = frozenset({
    ('VEHICLE', 'OUTDOOR'), ('VEHICLE', 'HUB'), ('VEHICLE', 'HOTEL'),
    ('VEHICLE', 'VENUE'), ('VEHICLE', 'INDOOR'),
    ('OUTDOOR', 'INDOOR'), ('OUTDOOR', 'HOTEL'), ('OUTDOOR', 'VENUE'),
    ('HUB', 'HOTEL'), ('HUB', 'VENUE'), ('HUB', 'INDOOR'),
    ('HOTEL', 'VENUE'),
})
# 🌐 空间冲突罚分（P0-3）—— **实测为负收益，默认已回退为 0（只诊断不扣分）**
#   实测（2026-09-16 18:02 轮，25 段 Golden Set）：加 -0.12 罚分后 **Top-1 可接受率 8% → 4%**，
#   且 1098 对候选被压、16/25 段的命中被改动、未匹配段 6→7。机制：本片 飞机/机场/酒店 三类同空间
#   占候选 ~60%，罚分把"跨空间但语义最优"的候选压下去后，**反而强化了"就近顺承"**
#   （新命中出现 scene_102_seg1/2/3、scene_103_seg1/3、scene_166_seg0/1 这类连续段 id）。
#   ⇒ 结论（写入方案 §23.2）：**空间一致性应作为"召回信号"（三路召回第 3 路），而不是"打分信号"**；
#     在候选集未放开（P1/P2）之前，窗口内的加减分无法提升相关性（C1）。
#   保留常量与环境开关，便于后续按消融复测任意档位：`ZENTECT_KM_SPACE_PENALTY=0.12` 可启用扣分。
SPACE_CONFLICT_PENALTY = -abs(float(os.environ.get('ZENTECT_KM_SPACE_PENALTY', '0') or 0))
# 空间冲突命中统计（诊断用：KM 入口清零，主循环结束后打印）
_SPACE_CONFLICT_STATS = {'pairs': 0, 'samples': []}
# 脏值清洗统计（P0-4）：scene 被写成镜头语言/主体（如"男子特写"）时的计数
_SCENE_DIRTY_STATS = {'frames_chunks': 0, 'samples': []}

# ==========================================
# 🧪 P1 约束消融开关（2026-09-16，dev-only 实验框架；**默认全 on = 现状零变化**）
#   目的：量化四条"时间局部性 / 排他 / 变速"约束各自的价格（方案 §22.5 P1）。
#   依据：§21.6 / §23.2 / §23.7 三次印证——**离线"语义 Top-1"不能预测线上收益**，
#   唯一裁判是「端到端跑一次步骤5 + 25 段 Golden Set 按画面级复算」。
#
#   用法：`ZENTECT_KM_ABL_<NAME>=off` 关闭该条约束（每次求解读取，改后需重启 daemon）。
#   开关语义（off = 撤回该约束）：
#     · BLOCK_WINDOW —— 时域块窗口 ±3 块（±15min）→ 候选池放开到全片
#     · QUERY_WINDOW —— 段落级窗口硬边界（Layer1 收窄 + 窗外 WINDOW_PENALTY 5.0）
#     · MONOTONIC    —— 跨段"时间倒走重选"（关=允许画面时间回退，不做重选）
#     · EXCLUSIVE    —— 全局排他（关=所有切片按额度 BROLL_MAX_REUSE 复用，不再只限空镜）
#     · SPEED_CAP    —— 变速 ±3% 上限 + "变速超限重选"（关=允许任意变速且不换镜）
#     · ADDITIVE     —— 加性层（时序软罚 ±0.15 / 场景加成 +0.08~0.10 / 情绪路由 / 运镜，总额 ±0.12）
#     · KW_BOOST     —— 关键词精确匹配 boost（最高 +0.70，直接加在语义主分上）
#     · SHOT_BOOST   —— 景别精确匹配 boost
#   另有**三态**开关（见 read_exclusive_mode / read_cand_whitelist_mode）：
#     · EXCLUSIVE=on|quota|unlimited —— 排他强度（unlimited = 完全取消排他，用于测"同查询簇抢同一画面"）
#     · CAND_WHITELIST=on|soft|off    —— 行级白名单闸门强度
#   ⚠️ 全部为**实验用**：任何一条未经端到端复测不得改为默认 off（"无指标收益不进主干"）。
# ==========================================
_ABL_ENV_KEYS = {
    'block_window': 'ZENTECT_KM_ABL_BLOCK_WINDOW',
    'query_window': 'ZENTECT_KM_ABL_QUERY_WINDOW',
    'monotonic': 'ZENTECT_KM_ABL_MONOTONIC',
    'speed_cap': 'ZENTECT_KM_ABL_SPEED_CAP',
    'additive': 'ZENTECT_KM_ABL_ADDITIVE',
    'kw_boost': 'ZENTECT_KM_ABL_KW_BOOST',
    'shot_boost': 'ZENTECT_KM_ABL_SHOT_BOOST',
}

# 🧪 排他强度三态：on（默认）｜quota（叙事镜头也可在 BROLL_MAX_REUSE 额度内复用）｜unlimited（完全取消排他）
ABL_EXCLUSIVE_ENV = 'ZENTECT_KM_ABL_EXCLUSIVE'


def read_exclusive_mode() -> str:
    """函数级中文注释：读排他档位——'on' | 'quota' | 'unlimited'（非法值回落 'on'=线上现状）。
    unlimited 用于判定"多个子句共享同一查询、抢同一个画面"是否是 Top-1 的结构性墙。"""
    _m = (os.environ.get(ABL_EXCLUSIVE_ENV, 'on') or 'on').strip().lower()
    return _m if _m in ('on', 'quota', 'unlimited') else 'on'


def read_ablation_flags() -> dict:
    """函数级中文注释：读取 P1 约束消融开关（缺省/非 'off' 一律视为开启=保持现状约束）。
    返回 {'block_window': True, 'query_window': True, 'monotonic': True, 'exclusive': True, 'speed_cap': True}。"""
    flags = {}
    for _k, _env in _ABL_ENV_KEYS.items():
        flags[_k] = (os.environ.get(_env, 'on') or 'on').strip().lower() != 'off'
    return flags


# 🧪 ⑤ 行级白名单（`perQueryTopK`）三态开关——P1 归因实测它是**全矩阵里最大的一处压制**
#   （白名单外 11490 格），且 4/18 段人工接受的画面被它剔除（方案 §23.8 四）。
#   三态用于测"闸门"强度：on（默认，白名单外置 5.0 强惩罚 = 现状）｜soft（软罚 0.15，语义更强可翻盘）
#   ｜off（不罚，纯拼综合分）。**默认 on，未复测不得改。**
ABL_CAND_WL_ENV = 'ZENTECT_KM_ABL_CAND_WHITELIST'
CAND_WL_PENALTY_HARD = 5.0     # 与 WINDOW_PENALTY / candidateIds 同通道量级（远超 combined 的 [0,1]）
CAND_WL_PENALTY_SOFT = 0.15    # 软罚：略高于加性层上限 ADJUST_CAP=0.12（"候选资格"重于"微调"）


def read_cand_whitelist_mode() -> str:
    """函数级中文注释：读行级白名单档位——'on' | 'soft' | 'off'（非法值一律回落 'on' = 线上现状）。"""
    _m = (os.environ.get(ABL_CAND_WL_ENV, 'on') or 'on').strip().lower()
    return _m if _m in ('on', 'soft', 'off') else 'on'


# ============================================================================
# 🎬 S3 段域接线（2026-09-17，方案 §24.12-I 步骤 1）：把 KM 候选域从
#   「±3 块窗口(±15min) ∩ 段落窗口(±900s) 并集收窄」换成 **S1 场记单的段（segment）**。
#   段 = 同一地点类的连续父镜头集合（§24.10），中位 25 片、最小 9 片 ⇒ 候选池天然有界，
#   且比窗口更贴"这场戏里能用的料"。
#   ⚠️ 与"时间窗做双保险"互斥（§24.12-H 反模式）：若只把段域与旧窗口**取交集**，等于没改。
#      故 `on` 档是**替换**（段域 ∪ 段内切片豁免窗口死刑/白名单强惩罚，与 scene_hit/ent_hit 同通道）。
#   档位（标记文件，与 `temp/p1-dump-on` 同一套机制——env 不保证进 daemon 子进程）：
#     · `temp/storyboard-mode`     内容 = off | shadow | on（缺省 off ⇒ **零行为变化**）
#     · `temp/storyboard-segments` 内容 = segments.json 路径（缺省 temp/scene-log/segments.json）
#   `shadow` = 只算不用：统计「段域是否容纳了线上命中」，结果不生效（本步的验收仪器）。
# ============================================================================
_SB_SEGMENTS_DEFAULT = ('temp', 'scene-log', 'segments.json')
# 每个 query 取语义分最高的 3 个段作为「优先域」（§24.12-I：Top-3 段即可覆盖约 86% 的语义 Top-10）。
SB_TOP_SEGMENTS = 3
# 段分 = 段内切片 sim 的 top-N 均值——对段大小公平（用 max 会系统性偏袒切片多的大段）。
SB_SEG_TOP_N = 3
# 降级通道软罚：段外格**不再**置 5.0 死刑，改走此中等软罚（量级对齐 CAND_WL_PENALTY_SOFT）。
# 理由：优先域只覆盖 ~86% 语义 Top-10，不是硬门禁；软罚保证段外仍有可分配性、不会 assign 无解。
SB_OUT_DOMAIN_PENALTY = 0.15
# 低纯度段阈值（locPurity）：本步只采集/输出，为后续"低纯度段放开空间硬卡"预留，**不实现硬卡**。
SB_LOW_PURITY = 0.6


def load_storyboard() -> dict:
    """函数级中文注释：装载 S1 段域（segment）并读档位。
    返回 {'mode', 'parent2seg', 'seg_chunks', 'spans', 'seg_locpurity'}；任何异常 → mode='off'（保证零行为变化）。
    `seg_locpurity` = {段号: locPurity}（段地点纯度 0~1），本步只供诊断采集，不做空间硬卡。"""
    _off = {'mode': 'off', 'parent2seg': {}, 'seg_chunks': {}, 'spans': [], 'seg_locpurity': {}}
    try:
        _repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        _mode_file = os.path.join(_repo_root, 'temp', 'storyboard-mode')
        if not os.path.exists(_mode_file):
            return _off
        # ⚠️ 必须按 `utf-8-sig` 读：标记文件常由记事本/工具写入，**带 BOM** 时
        #   `utf-8` 会读出 '\ufeffon' 而静默回落 off（实测踩过：档位看起来设了却完全不生效）。
        with open(_mode_file, 'r', encoding='utf-8-sig') as _f:
            _mode = (_f.read() or '').strip().lstrip('\ufeff').lower()
        if _mode not in ('shadow', 'on'):
            return _off
        _seg_file = os.path.join(_repo_root, *_SB_SEGMENTS_DEFAULT)
        _path_file = os.path.join(_repo_root, 'temp', 'storyboard-segments')
        if os.path.exists(_path_file):
            with open(_path_file, 'r', encoding='utf-8-sig') as _f:
                _seg_file = (_f.read() or '').strip().lstrip('\ufeff') or _seg_file
        with open(_seg_file, 'r', encoding='utf-8') as _f:
            _segs = json.load(_f)
        _parent2seg, _seg_chunks, _spans, _seg_purity = {}, {}, [], {}
        for _s in _segs:
            _sid = f"S{int(_s['segmentId']):02d}"
            _pids = {str(_p) for _p in (_s.get('parentIds') or [])}
            _seg_chunks[_sid] = _pids
            for _p in _pids:
                _parent2seg[_p] = _sid
            _spans.append((float(_s.get('startMs') or 0), float(_s.get('endMs') or 0), _sid))
            # 段地点纯度：读进段域结构，供"优先域内低纯度段占比"诊断（本步不据此做空间硬卡）
            _seg_purity[_sid] = float(_s.get('locPurity') or 0.0)
        _spans.sort()
        print(f"[SB] 🎬 段域已装载（档位={_mode}）：{len(_segs)} 段 / {len(_parent2seg)} 父镜头｜{_seg_file}",
              file=sys.stderr)
        return {'mode': _mode, 'parent2seg': _parent2seg, 'seg_chunks': _seg_chunks,
                'spans': _spans, 'seg_locpurity': _seg_purity}
    except Exception as _e:
        print(f"[SB] ⚠️ 段域装载失败（按 off 处理）：{_e}", file=sys.stderr)
        return _off


def storyboard_seg_of_ms(sb: dict, ms: float) -> str:
    """函数级中文注释：按源时间戳找所属段（段覆盖之外返回 ''）。"""
    for _lo, _hi, _sid in sb.get('spans') or []:
        if _lo <= ms <= _hi:
            return _sid
    return ''


def storyboard_seg_of_parent(sb: dict, parent_id: str) -> str:
    """函数级中文注释：按父镜头 id 找所属段（切片侧归属用，O(1)）。"""
    return (sb.get('parent2seg') or {}).get(str(parent_id), '')


def storyboard_top_domains(sb_by_seg: dict, semantic_sim, n_queries: int,
                           top_k: int = SB_TOP_SEGMENTS, top_n: int = SB_SEG_TOP_N) -> tuple:
    """函数级中文注释：按**视觉内容**为每个 query 选 Top-K 段，构成它的「优先域」。
    段打分 = 段内切片语义 sim 的 top-N 均值（对段大小公平，避免大段靠 max 占便宜）。
    为什么不用 query.startMs 找段：query.startMs 是"母块内等分插值"的假锚点（§24.12-I），
    实测按它选段的语义 Top-10 覆盖率仅 4%；改用视觉内容选 Top-3 段后可覆盖约 86% 的 Top-10。
    入参：sb_by_seg = {段号: [有效切片下标...]}，semantic_sim 形状 (n_queries, n_chunks)。
    返回 (q_domain, q_topsegs)：
      · q_domain[qi]  = frozenset(优先域内切片下标)；
      · q_topsegs[qi] = [(段号, 段分, 段切片数), ...] 按段分降序（供诊断与低纯度统计）。"""
    _q_domain, _q_topsegs = {}, {}
    for _qi in range(int(n_queries)):
        _row = semantic_sim[_qi] if semantic_sim is not None else None
        _scored = []
        for _sid, _idxs in sb_by_seg.items():
            if not _idxs:
                continue
            if _row is None:
                _score = 0.0
            else:
                _vals = sorted((float(_row[_i]) for _i in _idxs), reverse=True)
                _take = _vals[:min(top_n, len(_vals))]
                _score = (sum(_take) / len(_take)) if _take else 0.0
            _scored.append((_score, _sid, len(_idxs)))
        _scored.sort(key=lambda _t: (-_t[0], _t[1]))
        _top = _scored[:int(top_k)]
        _q_domain[_qi] = frozenset(_i for _sc, _sid, _n in _top for _i in sb_by_seg.get(_sid, ()))
        _q_topsegs[_qi] = _top
    return _q_domain, _q_topsegs


def _seg_key(seg_id) -> str:
    """函数级中文注释：段号 → 段域字典键（daemon 段索引统一为 `S{n:02d}`）。
    seg_id≤0 / 无法解析 → ''（表示无契约段，触发走兜底路径）。"""
    try:
        _n = int(seg_id)
    except (TypeError, ValueError):
        return ''
    return '' if _n < 1 else f"S{_n:02d}"


def _contract_segment_id(q, top_segs: list) -> int:
    """函数级中文注释：解析 query 的段域契约段号（§24.15-B1）。
    - α 真工单：优先用 query.segmentId（Node 透传）；
    - β 过渡：无真实工单时，取视觉内容 Top-1 段（复用 storyboard_top_domains 的 Top-K 降序，
      绝不用 query.startMs——母块内等分插值假锚点，§24.12-I/2835 实证命中率仅 4%）；
    - 无比对 → 返回 0（调用方回退内容 Top-K 优先域兜底）。
    top_segs： _SB_Q_TOPSEGS[qi] = [(段号, 段分, 段切片数), ...]（按段分降序）。"""
    _seg = int(getattr(q, 'segmentId', 0) or 0)
    if _seg < 1 and top_segs:
        try:
            _seg = int(top_segs[0][1].lstrip('S'))  # β：内容 Top-1 段
        except (ValueError, TypeError, IndexError):
            _seg = 0
    return _seg if _seg > 0 else 0


def _segment_pool_of(sb_by_seg: dict, seg_id: int) -> list:
    """函数级中文注释：取契约段号段内的全部有效切片下标（替代 ±3 块窗口候选）。
    段号越界 / 段无切片 → 返回 []（空池，由调用方决定回退内容 Top-K 优先域）。"""
    _key = _seg_key(seg_id)
    if not _key:
        return []
    return list(sb_by_seg.get(_key, ())) if _key in sb_by_seg else []


# ═══════════════════════════════════════════════════════════════════════════
# 🎬 §24.15-B2 分级硬门禁（空间 gate）——C0 契约 7 类枚举的唯一收敛映射。
#   规则：段 locPurity≥0.6 → 硬卡 spatialType；<0.6 → 转软排（防整段候选归零逼出跨段跳戏）。
#   人物永不进硬门禁（P2）；不引第二套空间枚举（P4，只做 S1 locClass → 契约枚举的降级收敛）。
# ═══════════════════════════════════════════════════════════════════════════
# SCENE_GROUPS 组 → C0 契约 SpatialType（shot_spec.py 7 类），组粒度最贴近 S1 locClass。
_GROUP_TO_SPATIAL = {
    '居室系': 'INDOOR_RESIDENCE',   # 室内·住宅（卧室/客厅/房间/宿舍）
    '酒店系': 'INDOOR_PUBLIC',      # 室内·公共场所（酒店/办公/教室/医院/餐饮/车间/场馆）
    '办公系': 'INDOOR_PUBLIC',
    '教室系': 'INDOOR_PUBLIC',
    '医院系': 'INDOOR_PUBLIC',
    '餐饮系': 'INDOOR_PUBLIC',
    '车间系': 'INDOOR_PUBLIC',
    '场馆系': 'INDOOR_PUBLIC',
    '其他室内': 'INDOOR_PUBLIC',
    '户外系': 'OUTDOOR_STREET',     # 室外·街道（户外系词表为街道/马路/广场）
    '载具系': 'VEHICLE',            # 载具内部
    '交通枢纽系': 'TRANSIT_HUB',    # 交通枢纽
}
# 旧 P0-2 空间枚举 → C0 契约枚举（组表未覆盖时的收敛兜底，仅降级收敛不新增类目）。
_OLD_SPATIAL_TO_CONTRACT = {
    'OUTDOOR': 'OUTDOOR_STREET',
    'VEHICLE': 'VEHICLE',
    'HUB': 'TRANSIT_HUB',
    'HOTEL': 'INDOOR_PUBLIC',
    'VENUE': 'INDOOR_PUBLIC',
    'INDOOR': 'INDOOR_PUBLIC',
    'UNKNOWN': 'UNKNOWN',
}


def _chunk_spatial_of(chunk: dict) -> str:
    """函数级中文注释：切片 → C0 契约空间枚举（§24.15-B2）。
    先按 SCENE_GROUPS 组映射（最贴近 S1 locClass），组表未覆盖再回落旧 P0-2 枚举收敛。"""
    _grp = _map_scene_group(str(chunk.get('scene') or ''))
    if _grp:
        return _GROUP_TO_SPATIAL.get(_grp, 'UNKNOWN')
    _old = space_type_of(str(chunk.get('scene') or ''))
    return _OLD_SPATIAL_TO_CONTRACT.get(_old, 'UNKNOWN')


def _dominant_spatial_of(candidates: list, video_chunks: list) -> str:
    """函数级中文注释：β 过渡合成契约空间——段内候选切片的众数空间（无 α 真工单时）。
    候选空 → 'UNKNOWN'（无契约空间 ⇒ 不做硬卡，转软排）。"""
    _cnt: dict = {}
    for _ci in candidates:
        _sp = _chunk_spatial_of(video_chunks[_ci])
        _cnt[_sp] = _cnt.get(_sp, 0) + 1
    if not _cnt:
        return 'UNKNOWN'
    return max(_cnt.items(), key=lambda _kv: (_kv[1], _kv[0] != 'UNKNOWN'))[0]


def _spatial_gate(contract_spatial: str, seg_purity: float, candidates: list,
                  video_chunks: list) -> tuple:
    """函数级中文注释：分级硬门禁（§24.15-B2）。
    - 段 locPurity≥0.6 且契约空间有效 → 只保留空间==契约的切片（硬卡）；
    - 硬卡命中为空 → 记 blocked 并**回退全段候选**（0 否决=0，交由 B3 降级链处理，绝不弃整段）；
    - 段 locPurity<0.6 或契约空间为 UNKNOWN → **转软排**（全放行，空间由软排层表达，防归零）。
    返回 (通过门禁的切片下标列表, blocked:bool)。"""
    if seg_purity < SB_LOW_PURITY or not contract_spatial or contract_spatial == 'UNKNOWN':
        return candidates, False
    _passed = [_ci for _ci in candidates if _chunk_spatial_of(video_chunks[_ci]) == contract_spatial]
    if _passed:
        return _passed, False
    return candidates, True


# ═══════════════════════════════════════════════════════════════════════════
# 🎬 §24.15-B3 动态门禁 + 降级链 L0-L5（探测 actionType/keyProp/preferredShot 可满足性）。
#   规则（§24.12-B/2718-2723）：探测项**可满足 → 升为门禁**（level 0 只在满足者中选）；
#   不可满足 → 按 fallbackLevel 逐级放宽（L1 弃道具 → L2 弃动作 → L3 弃景别 → L4 同段任意 → L5 段内复用）。
#   每降一级只放宽一类约束，并只在该级新增的非空候选上停步；`fallbackLevel`=允许降到的最低级。
#   ⚠️ P1 铁律：人物永不进硬门禁；β 过渡探测项为空 → 不做动态硬卡（避免假信号否决正确切片）。
# ═══════════════════════════════════════════════════════════════════════════
# 景别契约枚举 ↔ 切片 scene 关键词（收敛映射，与 shot_spec.py PREFERRED_SHOT 对齐）。
_SHOT_KEYWORDS = (
    ('EXTREME_LONG', ('大全景', '远景')),
    ('LONG_SHOT', ('全景',)),
    ('FULL_SHOT', ('中全景',)),
    ('MEDIUM_SHOT', ('中景',)),
    ('MEDIUM_CLOSE', ('中近景',)),
    ('CLOSE_SHOT', ('近景',)),
    ('EXTREME_CLOSE', ('特写',)),
)


def _shot_of_chunk(chunk: dict) -> str:
    """函数级中文注释：切片 scene 文本 → 景别契约枚举（B3 探测用）。
    未命中返回 ''（不参与景别门禁，避免无景别信号时误否决）。"""
    _t = str(chunk.get('scene') or '')
    for _code, _toks in _SHOT_KEYWORDS:
        for _tok in _toks:
            if _tok in _t:
                return _code
    return ''


def _prop_of_chunk(chunk: dict) -> str:
    """函数级中文注释：切片 描述/关键词 → 命中道具类别（ENTITY_CLASSES，B3 探测用）。
    取命中类别之一；未命中返回 ''。"""
    _s = (str(chunk.get('description') or '') + ' ' + ' '.join(
        str(k) for k in (chunk.get('keywords') or []) if k)).strip()
    _hit = _classes_hit(_s, ENTITY_CLASSES)
    return next(iter(_hit)) if _hit else ''


def _action_of_chunk(chunk: dict) -> str:
    """函数级中文注释：切片 描述/关键词 → 命中动作类别（ACTION_CLASSES，B3 探测用）。
    取命中类别之一；未命中返回 ''。"""
    _s = (str(chunk.get('description') or '') + ' ' + ' '.join(
        str(k) for k in (chunk.get('keywords') or []) if k)).strip()
    _hit = _classes_hit(_s, ACTION_CLASSES)
    return next(iter(_hit)) if _hit else ''


def _dynamic_gate(q_action: str, q_keyprop: str, q_shot: str, fallback_level: int,
                  candidates: list, video_chunks: list) -> tuple:
    """函数级中文注释：动态门禁 + 降级链 L0-L5（§24.15-B3）。
    输入该 query 的探测项契约值（空=不参与）+ 空间门禁后候选，返回 (通过候选, 实际level, 卡项)。
    - L0：探测项全满足（缺省项跳过）→ 只在这些切片中选；
    - L1..L3：逐级放宽 道具→动作→景别，取该级放宽后**非空**候选；
    - L4：同段任意（环境/空镜）；
    - L5：段内复用（额度 ≤2，由 B5/BROLL_MAX_REUSE 消费，本函数仅标记）。
    ⚠️ 实降级 level > fallbackLevel（允许最低级）→ 仍返回空候选（上层走 soft 兜底/空池回退）。"""
    _need_action = bool(q_action)
    _need_prop = bool(q_keyprop)
    _need_shot = bool(q_shot)
    # 无任何探测项 → 无动态硬卡，直接 L0 全通过（β 过渡/无契约字段）
    if not (_need_action or _need_prop or _need_shot):
        return candidates, 0, ''
    _act_of = {_ci: _action_of_chunk(video_chunks[_ci]) for _ci in candidates}
    _prop_of = {_ci: _prop_of_chunk(video_chunks[_ci]) for _ci in candidates}
    _shot_of = {_ci: _shot_of_chunk(video_chunks[_ci]) for _ci in candidates}

    def _ok(_ci):
        if _need_action and _act_of[_ci] != q_action:
            return False
        if _need_prop and _prop_of[_ci] != q_keyprop:
            return False
        if _need_shot and _shot_of[_ci] != q_shot:
            return False
        return True

    # L0：全满足
    _l0 = [_ci for _ci in candidates if _ok(_ci)]
    if _l0:
        return _l0, 0, ''
    # L1：放宽 道具
    if _need_prop:
        _l1 = [_ci for _ci in candidates
               if (not _need_action or _act_of[_ci] == q_action)
               and (not _need_shot or _shot_of[_ci] == q_shot)]
        if _l1 and 1 <= fallback_level:
            return _l1, 1, 'keyProp'
    # L2：再放宽 动作
    if _need_action:
        _l2 = [_ci for _ci in candidates
               if not _need_shot or _shot_of[_ci] == q_shot]
        if _l2 and 2 <= fallback_level:
            return _l2, 2, 'actionType'
    # L3：再放宽 景别 → 同段任意
    if _need_shot and 3 <= fallback_level:
        if candidates:
            return candidates, 3, 'preferredShot'
    # L4：同段任意（环境/空镜）——与 L3 同集但语义不同（L3 已覆盖，仅当无需景别约束时到达）
    if 4 <= fallback_level and candidates:
        return candidates, 4, 'any_in_segment'
    # L5：段内复用（额度由 B5 消费）——允许时回到空间池全量
    if 5 <= fallback_level and candidates:
        return candidates, 5, 'reuse'
    # 降级超限 → 上层软兜底
    return [], 0, 'fallback_overrun'


# ═══════════════════════════════════════════════════════════════════════════
# 🎬 §24.15-B4 CONTINUE_PREV 顺延推进（段内 KM 之后按 query 顺序推演，严禁跨段）。
#   规则（§24.12-D/2756-2768）：anchor=同段上一张已定镜；候选=段内 startMs>anchor 的**未用**切片；
#   视觉连续性：同父镜头 > 同景别 > 同人物组（同级内取 startMs 最早，紧随上镜最连贯）；
#   时间上续用尽 → 降级链：L3 段内未用空镜 → L4 段内任意未用 → L5 段内复用（镜像继承上镜，额度≤2）。
#   ⚠️ P3 铁律：只在段内选片，段内全部用尽也不越段（跨段跳戏=0 的硬保证）。
# ═══════════════════════════════════════════════════════════════════════════

def _sb_pick_continuity(picks: list, anchor_chunk: dict) -> tuple:
    """函数级中文注释：B4 视觉连续性选片——同父镜头 > 同景别 > 同人物组，同级内取 startMs 最早者。
    入参 picks=[(real_ci, chunk), ...]（已过滤未用+时间上续）；anchor_chunk=同段上一张已定镜。
    返回 (real_ci, chunk)。"""
    _a_parent = str(anchor_chunk.get('parentChunkId') or '')
    _a_shot = str(anchor_chunk.get('shotType') or '')
    _a_roles = set(str(_r) for _r in (anchor_chunk.get('characters') or []) if _r)

    def _tier(_t) -> int:
        _c = _t[1]
        if _a_parent and str(_c.get('parentChunkId') or '') == _a_parent:
            return 0
        if _a_shot and str(_c.get('shotType') or '') == _a_shot:
            return 1
        if _a_roles and set(str(_r) for _r in (_c.get('characters') or []) if _r) & _a_roles:
            return 2
        return 3

    return min(picks, key=lambda _t: (_tier(_t), float(_t[1].get('startMs') or 0)))


def _sb_continue_prev(seg_idxs: list, valid_chunk_indices: list, video_chunks: list,
                      used_chunks: set, anchor_chunk: dict) -> tuple:
    """函数级中文注释：B4 CONTINUE_PREV 顺延取片（纯函数，单测友好）。
    规则（§24.15-B4）：① 候选=段内 startMs>上镜.startMs 的未用切片，按视觉连续性选最佳；
    ② 时间上续为空 → L3 段内未用空镜 → L4 段内任意未用（均取时间最早）；
    ③ 段内用尽 → L5 段内复用（返回 anchor 镜像 dict，仅时限推进，额度由调用方消费）；
    ④ 严禁跨段（P3）：只在 seg_idxs 段内选。
    入参：seg_idxs=段内有效切片下标；valid_chunk_indices=下标→真实切片下标；video_chunks=切片池；
          used_chunks=已占用真实切片下标集合；anchor_chunk=同段上一张已定镜。
    返回 (real_ci, chunk, level)：level∈{'l0','l3','l4','l5','none'}；'none'=段空无可推演（调用方记 miss）。"""
    if not seg_idxs:
        return None, None, 'none'
    _seg_reals = [valid_chunk_indices[_i] for _i in seg_idxs]
    _a_start = float(anchor_chunk.get('startMs') or 0)
    # ① 时间上续（startMs 紧随上镜）+ 未用
    _next_picks = []
    for _ci in _seg_reals:
        if _ci in used_chunks:
            continue
        _c = video_chunks[_ci]
        if float(_c.get('startMs') or 0) <= _a_start + 1.0:
            continue
        _next_picks.append((_ci, _c))
    if _next_picks:
        _chosen = _sb_pick_continuity(_next_picks, anchor_chunk)
        return _chosen[0], _chosen[1], 'l0'
    # ② 时间上续用尽 → 降级
    _all_unused = [_ci for _ci in _seg_reals if _ci not in used_chunks]
    _broll = [_ci for _ci in _all_unused if _is_reusable_broll(video_chunks[_ci])]
    if _broll:
        _ci = min(_broll, key=lambda _x: float(video_chunks[_x].get('startMs') or 0))
        return _ci, video_chunks[_ci], 'l3'
    if _all_unused:
        _ci = min(_all_unused, key=lambda _x: float(video_chunks[_x].get('startMs') or 0))
        return _ci, video_chunks[_ci], 'l4'
    # ③ 段内用尽 → L5 段内复用：anchor 镜像（仅时限推进）
    return None, dict(anchor_chunk), 'l5'


def p1_dump_target() -> str:
    """函数级中文注释：P1 消融「输入快照」落盘目标路径（dev-only 仪器；未开启返回 ''=零开销）。
      ① 环境变量 `ZENTECT_KM_DUMP_REQ`（目标绝对路径）；
      ② 仓库 `temp/p1-dump-on` 标记文件（**内容=目标绝对路径**）——只需照常重启 dev，不必改启动命令。
    打包运行时两级都不存在 → 恒返回 ''，不影响生产行为。"""
    _p = (os.environ.get('ZENTECT_KM_DUMP_REQ') or '').strip()
    if _p:
        return _p
    try:
        _repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        _marker = os.path.join(_repo_root, 'temp', 'p1-dump-on')
        if os.path.exists(_marker):
            with open(_marker, 'r', encoding='utf-8') as _mf:
                return _mf.read().strip()
    except Exception:
        pass
    return ''


# ============================================================================
# 🎭 实体通道（Entity-Channel，2026-09-16 §23.13）：把「文案要求的**实体类别**」做成检索/排序信号。
#   动机（真实案例 `seg_6_sub_3`：文案「还塞给她一点零钱，」）：这句要的是
#   「施与者 + 接受者 + 道具(钱) + 动作(塞)」，而线上只用**母句画面意图**检索
#   （"朋友们围住智恩挥手告别，行囊堆在脚边，门口逆光"）——动作是"挥手"不是"塞"，
#   且余弦被角色名"智恩"主导 ⇒ 检索回来的全是「夜晚街头·韩智恩微笑」（与"给钱"无关），
#   而池里真实存在的「机场通道·双人并排·道具:金色钱包/信封·左手持物右手前伸」被排到很后。
#   做法：**类别级**（不是字面词）匹配——`零钱 → {钱,钱包,信封,钞票…}`，否则字面匹配同样会漏掉
#   "金色钱包/信封"这种正确镜头。命中只读**切片描述 + keywords**（零新增模型/零新增依赖）。
#   实测（离线实验台，非人工标注的自动判据）：动作类满足率 0/2 → **2/2**、道具类 0/3 → 1/3、
#   接受项名次中位 6 → 4，且人工标签指标不退化（§23.13）。
#   ⚠️ **默认 0（关闭）**：2026-09-16 端到端实测——实体通道与三闸豁免在**真实流水线**里
#     只把扰动从 28 段抬到 45 段、标签指标不动（8.0%→8.0%）。根因是更上游的**时序先验错位**
#     （18/18 段的人工认可画面都不在段落窗口内，中位偏移 +6.2 分，见 §23.13）。
#     按"无指标收益不进主干"纪律：**代码与开关保留、默认关闭**，待时序先验问题裁决后再启用。
#     启用方式：`ZENTECT_KM_ENTITY_W=0.05`（实测最优点；0.05~0.12 为平台期）。
# ============================================================================
ENTITY_W_DEFAULT = 0.0
ENTITY_ACTION_RATIO = 0.5     # 动作命中按半个道具计（道具是硬实体，动作是软佐证）

ENTITY_CLASSES = {
    '钱': ('零钱', '钞票', '现金', '纸币', '硬币', '钱包', '信封', '红包', '钱'),
    '票据': ('机票', '登机牌', '护照', '证件', '车票', '门票', '票据'),
    '行李': ('行李箱', '行囊', '包袱', '背包', '提包', '行李', '箱子'),
    '手机': ('手机', '电话', '话筒', '座机'),
    '餐饮': ('咖啡', '茶', '饭', '碗', '酒杯', '餐具', '餐盘'),
    '文件': ('合同', '文件', '名单', '表格', '体检单', '资料'),
    '钥匙': ('钥匙', '门卡', '房卡'),
}
ACTION_CLASSES = {
    '递物': ('塞', '递', '掏', '拿', '交给', '给', '伸手', '持物', '夹', '放'),
    '告别': ('挥手', '告别', '送行', '拥抱', '送别'),
    '注视': ('注视', '凝视', '目光', '看向', '望向', '低头看'),
    '移动': ('走入', '走出', '走进', '转身', '离开', '奔跑', '快步'),
    '落座': ('落座', '坐下', '对坐', '沙发'),
}


def entity_real_clause(text: str, visual_intent: str = '') -> str:
    """函数级中文注释：取**真子句**——Node 下发的 `text` 是「真子句 + " | " + 母句画面意图」，
    实体抽取必须只用前半段，否则会被母句的动作/道具（挥手/行囊）稀释（实测 `seg_6_sub_3` 即如此）。"""
    head = (text or '').split(' | ')[0].strip()
    return head or (visual_intent or '').strip()


def _classes_hit(text: str, table: dict) -> set:
    """函数级中文注释：文本命中的**类别集合**（按同义词表匹配，落类别而非字面词）。"""
    t = text or ''
    return {cls for cls, words in table.items() if any(w in t for w in words)}


def build_entity_channel(queries, video_chunks, valid_chunk_indices, table) -> tuple:
    """函数级中文注释：构建「query × 切片」的类别命中矩阵（1.0=该类的任一近义词出现在切片文本里）。
    返回 (矩阵 float32, 抽到该类的 query 数, 命中格数)；切片侧文本 = `description + keywords`。"""
    import numpy as np
    n_q, n_c = len(queries), len(valid_chunk_indices)
    mat = np.zeros((n_q, n_c), dtype=np.float32)
    cls_index = {c: i for i, c in enumerate(sorted(table))}
    chunk_cls = []
    for ci in valid_chunk_indices:
        c = video_chunks[ci]
        s = (c.get('description') or '') + ' ' + ' '.join(
            str(k) for k in (c.get('keywords') or []) if k)
        chunk_cls.append({cls_index[k] for k in _classes_hit(s, table)})
    q_with, cells = 0, 0
    for qi, q in enumerate(queries):
        want = {cls_index[k] for k in _classes_hit(
            entity_real_clause(getattr(q, 'text', '') or '', getattr(q, 'visualIntent', '') or ''),
            table)}
        if not want:
            continue
        q_with += 1
        for j, got in enumerate(chunk_cls):
            if want & got:
                mat[qi, j] = 1.0
                cells += 1
    return mat, q_with, cells


def _window_soft_penalty(w0: float, w1: float, cstart: float) -> float:
    """函数级中文注释：**窗外弱软罚**（§23.13 裁决 B）——把"段落窗口 5.0 死刑"降级为按
    「超出窗口的距离」衰减的软罚，封顶 `WINDOW_SOFT_MAX`（0.15，与 `_temporal_penalty` 同量级）。
    依据：实测 18/18 段的人工认可画面都落在窗外（中位偏 6.2 分），硬窗等于系统性排除正确答案；
    但完全放开（消融①b）会让 KM 全片乱跳，故保留"越远越罚"的软约束。"""
    if w0 <= cstart <= w1:
        return 0.0
    _out_ms = (w0 - cstart) if cstart < w0 else (cstart - w1)
    return min(WINDOW_SOFT_MAX, WINDOW_SOFT_PER_SEC * (_out_ms / 1000.0))


WINDOW_SOFT_MAX = 0.15       # 窗外软罚上限（= 时序软罚的封顶量级，保证"远但贴"的镜头能翻盘）
WINDOW_SOFT_PER_SEC = 0.0025  # 每超出 1 秒的罚分（60 秒即封顶）


# 🎬 P0-4：非空间 scene 值识别——VLM 偶把**镜头语言/主体**写进 scene（实测 `男子特写/近景特写/门口特写`）。
#   规则：短文本（≤8 字）且以景别/镜头词结尾 → 判为脏值，不参与空间判定（避免污染冲突矩阵）。
_SHOT_WORD_TAIL = ('特写', '近景', '中景', '全景', '远景', '镜头', '视角')


def space_type_of(scene_text: str) -> str:
    """函数级中文注释：scene 文本 → 空间类型枚举（P0-2）。
    ⚠️ 判定顺序很关键：**先查词表**（'室内近景' 这类合法词以景别词结尾，不能被脏值闸误杀），
    只有"词表查不到 **且** 以景别/镜头词结尾"才判为脏值（如 `男子特写/门口特写`）；
    其余未识别一律 'UNKNOWN'（中性，不加不减，但计入无组率诊断）。"""
    text = (scene_text or '').strip()
    if not text:
        return 'UNKNOWN'
    group = _map_scene_group(text)
    if group:
        return SPACE_TYPE_OF_GROUP.get(group, 'UNKNOWN')
    if len(text) <= 8 and text.endswith(_SHOT_WORD_TAIL):
        _SCENE_DIRTY_STATS['frames_chunks'] += 1
        if len(_SCENE_DIRTY_STATS['samples']) < 3:
            _SCENE_DIRTY_STATS['samples'].append(text)
        return 'UNKNOWN'
    return 'UNKNOWN'


def _is_space_conflict(q_group: str, c_group: str) -> bool:
    """函数级中文注释：空间冲突判定（P0-3）——两侧都能映射到空间类型且构成互斥对时为真；
    任一侧 UNKNOWN（未识别/脏值）或同类型 → 不冲突（中性）。"""
    qs = SPACE_TYPE_OF_GROUP.get(q_group or '', 'UNKNOWN')
    cs = SPACE_TYPE_OF_GROUP.get(c_group or '', 'UNKNOWN')
    if qs == 'UNKNOWN' or cs == 'UNKNOWN' or qs == cs:
        return False
    return (qs, cs) in SPACE_TYPE_CONFLICTS or (cs, qs) in SPACE_TYPE_CONFLICTS


# 🌤 P0-5（2026-09-16，§23.2）：环境介质 `envMedium` —— **只采集与暴露覆盖率，暂不参与打分**。
#   依据 §22.6 反模式 5：本片 雨/雪 信号实测为 0，若直接接线就是"永不触发的规则"。
#   先收集覆盖率证据，下一轮再决定是否接线（以及需要哪些互斥对）。
ENV_MEDIUM_TOKENS = (
    ('天空', 'SKY'), ('云层', 'SKY'), ('云海', 'SKY'), ('高空', 'SKY'),
    ('雨夜', 'RAIN'), ('雨中', 'RAIN'), ('下雨', 'RAIN'), ('暴雨', 'RAIN'),
    ('雪', 'SNOW'), ('雾', 'FOG'),
    ('黄昏', 'DUSK'), ('傍晚', 'DUSK'), ('夕阳', 'DUSK'), ('日落', 'DUSK'),
    ('深夜', 'NIGHT'), ('夜晚', 'NIGHT'), ('夜景', 'NIGHT'), ('夜间', 'NIGHT'), ('夜', 'NIGHT'),
    ('白天', 'DAY'), ('白天光线', 'DAY'), ('明亮日常', 'DAY'),
)


def env_medium_of(scene_text: str, atmosphere: str = '') -> str:
    """函数级中文注释：从 scene + visualAtmosphere 抽取环境介质枚举（长词优先）。
    未识别返回 'UNKNOWN'（中性）；本函数**不产生任何打分**，仅供覆盖率诊断。"""
    text = f"{scene_text or ''} {atmosphere or ''}"
    best, best_len = 'UNKNOWN', 0
    for tok, code in ENV_MEDIUM_TOKENS:
        if len(tok) > best_len and tok in text:
            best, best_len = code, len(tok)
    return best


def _map_scene_group(scene_text: str) -> str:
    """场景文本 → 场景组（R2-1 防假阳性核心）：
    - 只做「完整组词包含」匹配，绝不做单字/过短子串匹配（防'车'伤'工厂车间'、'室'伤'室外操场'）；
    - 命中多个组时取【最长组词】所属组（'教室大厅' 同时含 教室/大厅 时归词更长的 场馆系）；
    - 无任何组词命中返回 ''（中性，场景维度不加不减，不影响正确性）。"""
    text = (scene_text or '').strip()
    if not text:
        return ''
    best_group, best_len = '', -1
    for _group, _tokens in SCENE_GROUPS.items():
        for _tok in _tokens:
            if _tok and len(_tok) > best_len and _tok in text:
                best_group, best_len = _group, len(_tok)
    return best_group


# 地点核心词表：场景组词表扁平化 + 通用地点词。用于"地点字面交集"兜底
# （覆盖组表未收录的小众场景，如"防空洞/钟楼/码头"），长词优先。
_LOCATION_TOKENS = tuple(sorted(
    {_t for _toks in SCENE_GROUPS.values() for _t in _toks}
    | {'走廊', '门口', '大厅', '房间', '室内', '室外', '街道', '广场', '天台', '阳台', '楼梯', '电梯'},
    key=len, reverse=True,
))


def _location_tokens_in(text: str) -> set:
    """函数级中文注释：抽取文本中出现的地点核心词集合（供地点交集判定）。"""
    _t = text or ''
    return {_tok for _tok in _LOCATION_TOKENS if _tok in _t}


def _scene_boost_for_query_chunk(query, chunk) -> float:
    """地点一致性加成（**单一信号，取大不求和**）——主矩阵/变速重选/单调重选/衔接重排共用。

    ① 场景组等值命中（query.sceneGroup == chunk.scene 映射组）→ SCENE_GROUP_BOOST(0.08)
    ② 否则地点核心词文本交集（query 的 visualIntent+正文 ∩ chunk 的 scene+描述）→ LOCATION_TEXT_BOOST(0.10)
    ③ 返回 max(①, ②)。

    设计依据（2026-09-16）：①②表达同一件事（地点一致），求和多算 = 同一信号双计；
    且单个 +0.08 已是"语义差 0.065 经归一化与 0.68 加权后 0.022"的 3.6 倍，叠加会矫枉过正
    （把"地点对但动作完全无关"的镜头推上台）。

    ② 的两级兜底（实测校准，勿夸大）：
      - 一级（推荐）：query 侧 sceneGroup 缺失时（实测 99 段中 43 段无场景组），
        用 query 文本**本地推导组**再比组——**能覆盖同义词**
        （实测"机舱"与"客舱/飞机客舱"字面无交集，但同属载具系，此级可命中）；
      - 二级（末级）：地点核心词**字面交集**，仅覆盖极近表述，且词表是封闭集合，
        **不对未收录的小众地点生效**（如"防空洞/钟楼"）——别指望它兜长尾。"""
    csg = _map_scene_group(chunk.get('scene') or '')
    qsg = (getattr(query, 'sceneGroup', '') or '').strip()
    q_text = (getattr(query, 'visualIntent', '') or '') + ' ' + (getattr(query, 'text', '') or '')
    c_text = (chunk.get('scene') or '') + ' ' + (chunk.get('description') or '')
    if qsg and csg and qsg == csg:
        return SCENE_GROUP_BOOST
    if not qsg:
        # 一级兜底：query 无场景组 → 本地从文本推导组后再比组（覆盖同义词）
        _qsg_derived = _map_scene_group(q_text)
        if _qsg_derived and csg and _qsg_derived == csg:
            return LOCATION_TEXT_BOOST
    # 🌐 P0-3（2026-09-16，§23.2）：**空间类型冲突** → 负向（仍并入同一信号池：整个函数对同一对
    #   (query, chunk) 只返回一个标量，取大不求和语义不变）。放在字面交集之前：
    #   空间冲突是比"地点词碰巧同现"更硬的判据。
    #   ⚠️ 与旧 §20 实现的关键差异：载具/枢纽/场馆/酒店**参与**判定（旧版排除它们 → 本片 48% 候选空转）；
    #      且 query 侧仍只认显式 sceneGroup（不从文本推导，避免词表顺序摇摆）。
    if _is_space_conflict(qsg, csg):
        _SPACE_CONFLICT_STATS['pairs'] += 1
        if len(_SPACE_CONFLICT_STATS['samples']) < 3:
            _SPACE_CONFLICT_STATS['samples'].append(
                f"{SPACE_TYPE_OF_GROUP.get(qsg, '?')}↔{SPACE_TYPE_OF_GROUP.get(csg, '?')}")
        # 罚分档位由常量控制：默认 0 = **只诊断不扣分**，此时**继续往下走**字面交集分支
        # （保持与"未引入空间冲突前"完全一致的打分行为，避免"零罚分却提前返回 0"的隐性行为变更）。
        if SPACE_CONFLICT_PENALTY < 0:
            return SPACE_CONFLICT_PENALTY
    # 二级兜底：地点核心词字面交集（覆盖能力有限，见 docstring）
    if _location_tokens_in(q_text) & _location_tokens_in(c_text):
        return LOCATION_TEXT_BOOST
    return 0.0


# ==========================================
# 🎬 B 立项（2026-09-08）同源拆分句的画面承接（SAME_SCENE 承接补配）
#   背景：诊断老舅09 seg_8_sub_2「先超越它，再造自己的航母」空卡——它与前一句 seg_8_sub_1
#   （同段演说被断句拆出的孪生子句，visualIntent 逐字一致）共用同一理想画面（scene_050_seg0，
#   441.8s 唯一"激昂演讲"切点），sub_1 已按全局排他占用后，sub_2 在自己的窗口内没有第二个
#   达标候选 → KM 不产出（错就错，不挂无关画面）。
#   承接规则：若某 query 未获分配，且与【前一个已产出的相邻段落】构成"同源承接对"
#   （visualIntent 逐字一致 或 同属同一断句子句族 seg_N_sub_k），则在其源时间近邻、
#   同 scene 组的未用切片中找时间紧随的承接段；素材覆盖达 97% 目标时长即补配并原位推进时间轴
#   （不再制造变速超限）。素材覆盖不足则如实保持未匹配并打 [承接] 日志——把
#   "分配没给" 与 "素材真的不够" 分开暴露，绝不强行拉伸变速/挂无关画面。
# ==========================================
CONTINUATION_MAX_GAP_MS = 6000.0   # 承接段起点相对前段结束的最大间距（ms）
CONTINUATION_COVER_MIN = 0.97      # 承接素材需覆盖目标时长的下限（沿用档1 原速准则，绝不强拉变速）


def _is_same_continuation(q_prev, q_cur) -> bool:
    """同源承接对判定：两段满足任一即视为同一画面源的连续叙述——
    ① visualIntent 去空白后逐字一致（孪生子句由同源断句产生，画面意图完全相同）；
    ② 同属一个断句子句族（seg_N_sub_1 / seg_N_sub_2 共享 base seg_N）。
    仅作承接触发器，具体能否补配还须过场景组/时间近邻/素材覆盖三道闸。"""
    if q_prev is None or q_cur is None:
        return False
    _vp = (getattr(q_prev, 'visualIntent', None) or '').strip()
    _vc = (getattr(q_cur, 'visualIntent', None) or '').strip()
    if _vp and _vp == _vc:
        return True

    def _base(sid):
        _m = re.match(r'^(.+?)_sub_\d+$', str(sid or '').strip())
        return _m.group(1) if _m else None

    _bp = _base(getattr(q_prev, 'shotId', None))
    _bc = _base(getattr(q_cur, 'shotId', None))
    return bool(_bp and _bc and _bp == _bc)


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
                result = await loop.run_in_executor(executor, _km_dispatch, req)
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


def _char_ids_of_query(q) -> list:
    """
    🎭 人物归一（2026-09-18）：取 query 侧的**归一角色主键**列表。
    优先 query.charIds（注册表主键）；缺失/为空时回退旧的 query.characters 字符串（向后兼容，
    老工程数据/无注册表项目行为与旧版完全一致）。
    """
    ids = [str(x).strip() for x in (getattr(q, 'charIds', None) or []) if str(x).strip()]
    if ids:
        return ids
    return [str(x).strip() for x in (getattr(q, 'characters', None) or []) if str(x).strip()]


def _char_ids_of_chunk(chunk: dict) -> list:
    """
    🎭 人物归一（2026-09-18）：取切片侧的**归一角色主键**列表。
    优先 chunk['charIds']（Node 侧归一写入）；缺失/为空时回退旧的 chunk['characters']（向后兼容）。
    """
    ids = [str(x).strip() for x in (chunk.get('charIds') or []) if str(x).strip()]
    if ids:
        return ids
    return [str(x).strip() for x in (chunk.get('characters') or []) if str(x).strip()]


def _compute_role_score(query_roles, chunk_roles) -> float:
    """
    🎭 P1 角色契合度（软加成）：只加分不惩罚。
    入参为**归一后的角色主键集合**（query.charIds / chunk.charIds，见 _char_ids_of_query/_char_ids_of_chunk），
    不再比原始 characters 字面值——同一角色的"宋慧乔/宋慧乔饰演的角色/女子（宋慧乔）"归一后能真正相交。
    - Query（query_roles）或 Chunk（chunk_roles）任一方无角色名单 → 中性 0.5（该维度无信息，不参与加分也不惩罚）
    - 双方都有 → 命中率 = 交集数量 / Query 角色数（以解说段落期望角色为基准，优先主角命中；
      切片缺少某路人角色不扣分——"优先不排除"，避免因角色误识别导致匹配失败）
    🛑 用户级铁律（粒度不可信）：角色维**只能作软排信号**，任何时候不得升级为硬门禁——
      切片 characters 由 VLM 帧聚合而来、存在父镜头并集回填污染，误识别一旦当门禁就会否决正确切片。
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




# ═══════════════════════════════════════════════════════════════════════════
# 🎯 C：两阶段语义（组意图召回 → 子句文案精排）（2026-09-16，方案 §23.6 落地）
#   实测依据（离线 18 段 Golden Set，画面级口径）：
#     现状 text+VI 直检 11.1% ｜ 组意图(VI) 单路 16.7% ｜ **组意图召回→子句文案精排 27.8%** ｜ 上限 66.7%
#   机制：簇内多句共享同一组意图（同父段拆句继承），"全局检索"该用上下文更强的**组意图**，
#        而"簇内区分"该用**本句文案**（弱信号在局部候选内具备判别力：文案全局 r@10 仅 11.1%，
#        但在 Top-K 局部重排时把 p@1 从 5.6% 拉到 16.7%）。两者各司其职，故拆两阶段。
#   ⚠️ 禁用开关：`ZENTECT_KM_C_MODE=off` → 回到"text+VI 拼接单路"，便于 A/B 复测。
# ═══════════════════════════════════════════════════════════════════════════
C_RECALL_K = 15          # 组意图召回的每行候选数——**实测标定值**（画面级）：
                         #   K=15 → p@1 22.2% / r@3 38.9% / r@10 **66.7%**（追平召回上限）
                         #   K=20 → 22.2% / 38.9% / 55.6% ｜ K=30 → 16.7% / 38.9% / 44.4%
C_MISS_PENALTY = 0.5     # 召回集外候选降权——实测 ≥0.5 后指标进入平台（0.5/0.8/1.0/1.5/3.0 结果全同），
                         #   说明集外已被稳定压到不争首位；取最小有效值 0.5，保留"时长/情绪可救回"的余地。
                         #   ⚠️ 0.1~0.3 会让集外高意图候选混入首位，实测 p@1 掉到 5.6~16.7%。


def _two_stage_semantic(sim_intent, sim_clause, recall_k: int = C_RECALL_K,
                        miss_penalty: float = C_MISS_PENALTY):
    """函数级中文注释：C 两阶段语义分（§23.6）。
    ① **召回**：每行按「组意图」相似度取 Top-K 作为候选集（场景上下文更强，召回更广）；
    ② **精排**：召回集内改用「子句文案」相似度（细粒度语义区分，实测 p@1 最优）；
    ③ **集外**：给 `intent - miss_penalty`，保留可用性（时长/情绪/角色等仍可把它拉上来），
       但不与集内候选争首位——避免"直接删候选"（删池曾致空解，见 §22.6 反模式）。
    返回与输入同形状的 float32 矩阵，可直接替换 `semantic_sim` 参与既有综合打分。"""
    import numpy as np  # 本文件按需局部导入 numpy（与既有风格一致，避免模块级重依赖）
    sim_intent = np.asarray(sim_intent, dtype=np.float32)
    sim_clause = np.asarray(sim_clause, dtype=np.float32)
    n_q, n_c = sim_intent.shape
    out = sim_intent - float(miss_penalty)
    k = max(1, min(int(recall_k), n_c))
    topk = np.argpartition(-sim_intent, k - 1, axis=1)[:, :k]
    rows = np.arange(n_q, dtype=np.int64)[:, None]
    out[rows, topk] = sim_clause[rows, topk]
    return out


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
        'sem': 0.71, 'emotion': 0.05, 'duration': 0.15, 'role': 0.09,
    }
    w = {key: float(weights.get(key, _default_weights[key]))
         for key in _default_weights} if isinstance(weights, dict) else dict(_default_weights)
    total = sum(w.values())
    if total > 0:
        w = {key: value / total for key, value in w.items()}
    else:
        w = dict(_default_weights)
    # 🎯 动态权重归一（2026-09-06 根治匹配度天花板 83~87%）：
    #   情绪/角色维度为中性 0.5（该维度无信息：文案或切片缺失情绪/角色名单）时，
    #   不再让中性分 0.5 硬性拉低总分，而是把该维度权重让渡给语义主依据。
    #   让渡仅做权重搬运（sem += emotion/role，总和恒为 1.0），不改候选排序、不伪造信息；
    #   真正"有情绪/角色信号"（≠0.5）的维度保留原权重参与打分，信号仍在。
    if abs(emotion_score - 0.5) < 1e-6:
        w['sem'] += w['emotion']
        w['emotion'] = 0.0
    if abs(role_score - 0.5) < 1e-6:
        w['sem'] += w['role']
        w['role'] = 0.0
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
    - 主角特写：_shot_type_level≤2（特写/大特写/近景）且 chunk.charIds ∩ query.charIds 非空 → +0.02。
      🎭 人物归一（2026-09-18）：两侧角色均取**归一主键**（_char_ids_of_chunk/_char_ids_of_query，
      charIds 缺失时各自回退旧 characters 字符串），保证与 role_score 同一口径。
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
    空镜/远景 0.90（景物抒情托底，抽象旁白的第一画面语言）＞ 近景/特写 0.80（情绪脸谱可承接抽象抒情）
    ＞ 中景 0.55 ＞ 未识别 0.45。
    ⚠️ 口径一致性修复（2026-09-15）：VLM 的 shotType 枚举为「特写|近景|中景|全景」，**不会产出"空镜"字样**，
    原实现只认字面"空镜"→ 真空镜（全景）反而落到最低档 0.45，把抽象段推向近景人脸。
    现与 `_is_reusable_broll` 保持同一口径：**景别等级 5（全景/大远景/航拍）= 空镜载体**，给最高分。"""
    stype = (chunk_shot_type or '')
    if '空镜' in stype:
        return 0.90
    level = _shot_type_level(stype)
    if level is None:
        return 0.45
    if level == 5 or level == 4:
        # 全景/远景/大远景/航拍：空镜/意境镜头的主要载体（与 _is_reusable_broll 判定同源）。
        # VLM 枚举最高只到"全景"（等级 4），故 4/5 同档处理。
        return 0.90
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
    - 拼接验收：合并变速比落入 [0.80, 1.20] 即视为补足时长（轻微越界交由 speed clamp 0.97~1.03 兜底；
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
            # 轻微放慢仍可（变速 clamp 0.97~1.03 补差），记录为后备但继续拼到覆盖
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


def _is_reusable_broll(chunk: dict) -> bool:
    """🎬 空镜/意境镜头可复用判定：全景/远景/大远景/空镜/航拍等无具体叙事主体的镜头，
    允许多段文案复用——抒情/哲思/情绪过渡段落共用同一代表性空镜是剪辑常规手法（B-Roll）。
    判定：shotType 景别等级 ≥4（全景/远景/大远景/空镜/航拍）或文本含"空镜"。
    叙事动作/对话镜头（含具体角色/人脸/明确动作）严格排他，不在此列，防"动作复读"回归。

    ⚠️ 口径一致性修复（2026-09-15）：原判定要求等级=5，但步骤2 VLM 的 shotType 枚举为
    「特写|近景|中景|全景」，**最高只到"全景"（等级 4）**，等级 5 永不产出 →
    本函数在生产中恒为 False，空镜复用（P4）从未生效。现放宽为 ≥4，与生产者口径对齐。"""
    st = (chunk.get('shotType') or '').strip()
    if not st:
        return False
    if '空镜' in st:
        return True
    level = _shot_type_level(st)
    return level is not None and level >= 4


def _broll_usage_from_results(results: list, video_chunks: list) -> dict:
    """函数级中文注释：按**最终成片结果**统计每个空镜切片被使用的次数（P4 验收的正确口径）。

    ⚠️ 不能复用主循环里的消费计数：那只覆盖 KM 主循环，漏掉「时间单调重选 / 变速重选 /
    承接补配 / 衔接重排」等循环后路径——实测因此把"空镜确实被用了"误报成"零消费"。
    统计来源：结果的 chunkId，以及合并/拼接结果可能携带的 chunkIds/segIds/segments。"""
    id_to_chunk = {str(c.get('id')): c for c in (video_chunks or []) if c.get('id')}
    use: dict = {}
    for r in (results or []):
        if not isinstance(r, dict):
            continue
        ids = []
        if r.get('chunkId'):
            ids.append(str(r['chunkId']))
        for _key in ('chunkIds', 'segIds', 'sourceChunkIds'):
            _v = r.get(_key)
            if isinstance(_v, (list, tuple)):
                ids.extend([str(x) for x in _v if x])
        _segs = r.get('segments')
        if isinstance(_segs, list):
            for _s in _segs:
                if isinstance(_s, dict) and _s.get('id'):
                    ids.append(str(_s['id']))
        for cid in ids:
            c = id_to_chunk.get(cid)
            if c is not None and _is_reusable_broll(c):
                use[cid] = use.get(cid, 0) + 1
    return use


# 🚫 伪内容切片判定词表（2026-09-16）：抽帧/转场（溶接、淡入淡出）残影产生的无画面切片，
#    VLM 会如实描述为"无内容/纯白背景/黑场"。这类切片没有任何可匹配的画面语义，
#    却因描述文本极短而拿到中高相似度，会把真实镜头挤掉（实测：飞机客舱对白被配到
#    「【特写】无内容 场景:纯白背景 主体:空镜」）。作为数据质量门禁在候选池构造时剔除。
_PSEUDO_CONTENT_PATTERNS = ('无内容', '纯白背景', '纯黑背景', '全黑', '黑场', '黑屏', '白屏')


def _is_pseudo_content(chunk: dict) -> bool:
    """函数级中文注释：判断切片是否为「无实际画面」的伪内容（转场残影 / 纯色填充 / 空白帧）。

    判定依据：`description` 中**显式声明**无内容（命中词表）。只认明确措辞，不做模糊猜测，
    避免误伤"画面元素少但有效"的正常镜头（如纯色墙面前的静物特写）。"""
    desc = str(chunk.get('description') or '')
    if not desc:
        return False
    return any(p in desc for p in _PSEUDO_CONTENT_PATTERNS)


def _color_histogram_distance(hist_a, hist_b) -> float:
    """两切片 HSV 色相直方图 L1 距离归一化到 0~1（0 完全一致，1 完全不同）。
    缺色调特征时给中性 0.5（与 P0 情绪掩码同哲学：缺失不参与惩罚也不加分）。"""
    import numpy as np
    if not hist_a or not hist_b or len(hist_a) != len(hist_b):
        return 0.5
    return min(1.0, float(np.sum(np.abs(
        np.array(hist_a, dtype=np.float64) - np.array(hist_b, dtype=np.float64)))) / 2.0)


def _motion_score_distance(prev_chunk: dict, next_chunk: dict) -> float:
    """🎬 P1 动静衔接：相邻切片运动强度差异归一化到 0~1（0 同动/同静，1 剧烈动静跳变）。
    缺 motionScore 时给中性 0.5（缺失不参与惩罚也不加分）。"""
    mp = prev_chunk.get('motionScore')
    mn = next_chunk.get('motionScore')
    if mp is None or mn is None:
        return 0.5
    try:
        return min(1.0, abs(float(mp) - float(mn)))
    except (TypeError, ValueError):
        return 0.5


def _camera_movement_distance(prev_chunk: dict, next_chunk: dict) -> float:
    """🎬 P1 运镜衔接：相邻切片运镜突变惩罚（0 同向顺承 / 0.7 异向突变 / 0.5 缺失中性）。
    运镜枚举固定/推/拉/摇/移，同向=顺承自然衔接，异向=视觉跳跃突兀。"""
    cp = (prev_chunk.get('cameraMovement') or '').strip()
    cn = (next_chunk.get('cameraMovement') or '').strip()
    if not cp or not cn:
        return 0.5
    return 0.0 if cp == cn else 0.7


# 🎬 P1 运镜匹配关键词表：query 画面意图(visualIntent)中「运镜词+镜」或「/运镜」形式 → 运镜枚举
_CAMERA_MOVEMENT_QUERY_HINTS = (
    ('推', '推'), ('拉', '拉'), ('摇', '摇'), ('移', '移'),
)


def _camera_movement_match_boost(query_visual: str, chunk_camera_movement: str) -> float:
    """🎬 P1 运镜匹配加成：query 画面意图明确要求某运镜时，切片运镜命中则 +0.03（轻量结构化加分）。
    检测 query 侧「运镜词+镜」或「/运镜」形式（如「推镜头」「/推」），避免单字误伤；绝不压过语义主依据。"""
    if not query_visual or not chunk_camera_movement:
        return 0.0
    qv = (query_visual or '').strip()
    cc = (chunk_camera_movement or '').strip()
    if not qv or not cc:
        return 0.0
    for hint, cam in _CAMERA_MOVEMENT_QUERY_HINTS:
        if (hint + '镜') in qv or ('/' + hint) in qv:
            if cc == cam:
                return 0.03
    return 0.0


def _structured_shot_type_match_boost(query_visual: str, chunk_shot_type: str) -> float:
    """🎬 P3 景别精确匹配（2026-09-06）：query 画面意图要求的景别层级 == 切片 shotType 层级 → +0.06。
    突破 CLIP 对景别词不敏感的天花板；不同层级不加分（避免粗匹配虚高）。
    层级复用 SHOT_TYPE_LEVELS / _shot_type_level（1特写~5远景），同层级词互认。"""
    if not query_visual or not chunk_shot_type:
        return 0.0
    qv = query_visual or ''
    q_level = None
    for kw, lv in SHOT_TYPE_LEVELS.items():
        if kw in qv:
            q_level = lv
            break
    c_level = _shot_type_level(chunk_shot_type)
    if q_level is not None and c_level is not None and q_level == c_level:
        return 0.06
    return 0.0


# 👗 §20 第3步（2026-09-16）：同场服装跳变（Costume Jump）——复用 colorHistogram 的等效实现
#   为什么要做：影视剪辑最怕"同场换装"事故（上一秒黑风衣、下一秒白衬衫）。
#   为什么不新增 VLM 字段：实测服装信息只活在 description 自由文本里（服装词命中 65/665=9.8%、
#   道具词 38/665，且为子串匹配噪声大），而 `keyProps` 在 VLM v4 输出里 0/665 —— 且改 schema
#   会 bump prompt_version → 全量重跑 665 帧 VLM。故用**已有的 colorHistogram + characters** 做代理：
#   同角色在场 + 源时间同场次 + 画面主色突变 = 疑似换装/换景，给衔接重排一个额外破格理由。
COSTUME_JUMP_HIST_THRESHOLD = 0.45   # 色相直方图距离阈值。**实测标定（非拍脑袋）**：本片源 605 镜头中
                                     # "同角色在场 + 源起点差 ≤60s"的判定池 n=3756 对，L1/2 色距分布
                                     # p50=0.255 / p75=0.346 / p90=0.455 / p95=0.546 / p99=0.684，
                                     # 取 0.45≈p90 → 只对最突变的约 10% 生效（"换装级"色变）。
COSTUME_JUMP_PENALTY = 0.25          # 命中后的额外衔接惩罚（叠加在 5 维基分上，最终 clamp 1.0）
COSTUME_JUMP_MAX_GAP_MS = 60000.0    # 仅"同一场次"内判定：两切片源起点差 ≤60s 才算同场
_COSTUME_JUMP_STATS = {'pairs': 0, 'samples': []}


def _costume_jump_penalty(prev_chunk: dict, next_chunk: dict) -> float:
    """函数级中文注释：同场服装跳变惩罚（命中返回 COSTUME_JUMP_PENALTY，否则 0.0）。
    三条件同时成立才判命中，缺一不罚（宁可漏判，不误伤合法的"换景/换场"）：
      ① 角色交集非空 —— 同一批人物在场的连续叙述；
      ② 源时间跨度 ≤ COSTUME_JUMP_MAX_GAP_MS —— 属于同一场次（跨场换装是正常的）；
      ③ 色相直方图距离 > COSTUME_JUMP_HIST_THRESHOLD —— 画面主色突变。
    统计写入 _COSTUME_JUMP_STATS 供 KM 诊断行打印（复核是否误伤）。"""
    _pc = prev_chunk.get('characters')
    _nc = next_chunk.get('characters')
    if not (isinstance(_pc, list) and isinstance(_nc, list)):
        return 0.0
    if not (set(str(x).strip() for x in _pc if str(x).strip())
            & set(str(x).strip() for x in _nc if str(x).strip())):
        return 0.0
    try:
        _gap = abs(float(next_chunk.get('startMs') or 0) - float(prev_chunk.get('startMs') or 0))
    except (TypeError, ValueError):
        return 0.0
    if _gap > COSTUME_JUMP_MAX_GAP_MS:
        return 0.0
    _hist_dist = _color_histogram_distance(
        prev_chunk.get('colorHistogram'), next_chunk.get('colorHistogram'))
    if _hist_dist <= COSTUME_JUMP_HIST_THRESHOLD:
        return 0.0
    _COSTUME_JUMP_STATS['pairs'] += 1
    if len(_COSTUME_JUMP_STATS['samples']) < 3:
        _COSTUME_JUMP_STATS['samples'].append(
            f"{prev_chunk.get('id')}↔{next_chunk.get('id')}(色差{_hist_dist:.2f})")
    return COSTUME_JUMP_PENALTY


def _continuity_penalty(prev_chunk: dict, next_chunk: dict) -> float:
    """
    🎬 P1 衔接流畅性惩罚（0~1，越大越突兀）：
    - 色调：相邻切片 HSV 色相直方图差异（权重 0.25）
    - 动静：相邻切片运动强度差异（权重 0.25，P1 动接动/静接静）
    - 运镜：相邻切片运镜突变（权重 0.20，P1 运镜衔接）
    - 景别：特写↔全景 大跨级跳跃（权重 0.15）
    - 情绪：相邻切片情绪突变（权重 0.15，复用 P0 情绪相容度）
    - 👗 §20 第3步：同场服装跳变（条件命中才叠加，见 _costume_jump_penalty），最终 clamp 到 1.0
    缺某项特征时该项给 0.5 中性，不参与惩罚也不加分。
    """
    hist_dist = _color_histogram_distance(
        prev_chunk.get('colorHistogram'), next_chunk.get('colorHistogram'))
    motion_dist = _motion_score_distance(prev_chunk, next_chunk)
    camera_dist = _camera_movement_distance(prev_chunk, next_chunk)
    level_prev = _shot_type_level(prev_chunk.get('shotType'))
    level_next = _shot_type_level(next_chunk.get('shotType'))
    if level_prev is not None and level_next is not None:
        shot_dist = min(1.0, abs(level_prev - level_next) / 4.0)
    else:
        shot_dist = 0.5
    emotion_dist = 1.0 - _emotion_compatibility(
        prev_chunk.get('emotion'), next_chunk.get('emotion'))
    _base = (0.25 * hist_dist + 0.25 * motion_dist + 0.20 * camera_dist
             + 0.15 * shot_dist + 0.15 * emotion_dist)
    return min(1.0, _base + _costume_jump_penalty(prev_chunk, next_chunk))


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
    # 🎬 整镜头级复用计数（2026-09-16）：parentChunkId → 已占用的"使用位"数。
    #   排他只到 seg 粒度，同一长镜头可经不同子段在多处出现，故额外按镜头计数限流。
    parent_use: dict = {}
    for r in results:
        _pc = (r.get("chunkData") or {}).get("parentChunkId")
        if _pc:
            parent_use[_pc] = parent_use.get(_pc, 0) + 1

    CONTINUITY_TRIGGER = 0.55  # 惩罚超过该阈值才触发替换尝试（避免过度调整）
    MIN_SCORE_KEEP = 0.9       # 替代切片综合分不得低于原切片 90%（内容不劣化）
    # 👗 §20 第3步：服装跳变统计清零（本轮重排结束后打印，供人工复核误伤）
    _COSTUME_JUMP_STATS['pairs'] = 0
    _COSTUME_JUMP_STATS['samples'] = []
    # 🎬 决策 #7（2026-09-16 **收窄**）：景别律动破格——同景别连续 CADENCE_RUN_LIMIT 段才视为"破格"。
    #   原值 3 过激：实测一轮 95 段里触发 **14 次替换（≈15%）且全部是"景别律动破格"**（无一条是真衔接问题），
    #   而对话戏连续近景本就是常态剪辑手法 → 该规则"为变而变"，会搬动语义正确的匹配。
    #   收窄为 5 段，并叠加"内容近乎等价"判据（CADENCE_SCORE_TOL）后才允许替换。
    CADENCE_RUN_LIMIT = 5
    # cadence（仅为换景别）触发的替换，额外要求候选与原切片**内容近乎等价**：
    #   综合分落差 ≤ CADENCE_SCORE_TOL（0.03，比 MIN_SCORE_KEEP 的 10% 更严，用于高分区间）。
    CADENCE_SCORE_TOL = 0.03
    # 🎬 整镜头级复用上限（2026-09-16）：同一镜头（parentChunkId）在成片中最多占
    #   PARENT_CHUNK_MAX_USE 个"使用位"。背景：排他粒度是 seg（3s 子段）而非镜头，
    #   同一长镜头可经**不同子段**反复出现（实测 scene_006 被用了 4 个不同子段）；
    #   而 P4 空镜额度只管空镜，管不到普通镜头。
    PARENT_CHUNK_MAX_USE = 2
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
            """计算 (query qi, 切片 ci_idx) 的综合分——**与 KM 主代价矩阵同口径**。

            ⚠️ 口径一致性修复（2026-09-15）：此前实现漏了 决策 #6 抽象路由分支（抽象段的语义主分
            应取"景别分级抽象分"而非 BGE 余弦），也未计入时序软罚/情绪路由微调。
            后果：抽象段语义差距被压缩（如 空镜 0.75 vs 近景 0.72），
            「内容保底 90%」判据形同失效 → 衔接重排把 KM 正解（空镜）换成近景人脸。
            现与 KM 主体完全同口径，保证"重排只在内容等价时才能为衔接让路"。"""
            chunk = video_chunks[valid_chunk_indices[ci_idx]]
            q_obj = queries[qi]
            is_abstract = bool(getattr(q_obj, 'isAbstractNarration', False))
            if is_abstract:
                # 抽象旁白：文字语义即噪声，语义主分 = 景别分级抽象分（空镜/全景优先）
                sem = _abstract_semantic_score(chunk.get('shotType'))
            else:
                sem = max(0.0, min(1.0, (float(semantic_sim[qi, ci_idx]) + 1.0) / 2.0))
                # 🎯 关键词精确匹配 boost（与 KM 主代价矩阵同规则）
                kw_boost = _keyword_match_boost(
                    query_text=getattr(q_obj, 'text', '') or '',
                    query_emotion=getattr(q_obj, 'emotion', '') or '',
                    query_visual=getattr(q_obj, 'visualIntent', '') or '',
                    chunk_desc=chunk.get('description') or '',
                    chunk_emotion=chunk.get('emotion') or '',
                    chunk_shot_type=chunk.get('shotType') or '',
                    chunk_characters=chunk.get('characters'),
                    chunk_keywords=chunk.get('keywords'),
                )
                if kw_boost > 0:
                    sem = min(1.0, sem + kw_boost)
                # 🎬 P3 景别精确匹配（与 KM 主体一致；抽象分支不叠加）
                _shot_boost = _structured_shot_type_match_boost(
                    getattr(q_obj, 'visualIntent', '') or '',
                    chunk.get('shotType') or '',
                )
                if _shot_boost > 0:
                    sem = min(1.0, sem + _shot_boost)
            emo = float(emotion_sim[qi, ci_idx])
            role = float(role_sim[qi, ci_idx])
            dur = 1.0
            vdur = chunk.get("durationMs", 0)
            if audio_dur_ms > 0 and vdur > 0:
                dur = _compute_duration_score(audio_dur_ms, vdur)
            # 🎬 加性微调与 KM 主体**同口径 + 同受 ADJUST_CAP 夹逼**（地点一致性/时序软罚/情绪路由/运镜）
            _adj = _scene_boost_for_query_chunk(q_obj, chunk)
            _delta = float(chunk.get("startMs") or 0) - float(getattr(q_obj, 'startMs', 0) or 0)
            _adj += 0.0 if _is_temporal_exempt(q_obj) else _temporal_penalty(_delta)
            if not is_abstract:
                _adj += _shot_routing_boost(
                    chunk.get('shotType'), _char_ids_of_chunk(chunk),
                    _char_ids_of_query(q_obj), getattr(q_obj, 'emotion', None) or '',
                )
                _adj += _camera_movement_match_boost(
                    getattr(q_obj, 'visualIntent', '') or '', chunk.get('cameraMovement') or '',
                )
            _adj = max(-ADJUST_CAP, min(ADJUST_CAP, _adj))
            return _compute_combined_score(sem, dur, emo, role, weights=weights) + _adj, chunk

        cur_score, _ = _score(cur_ci_idx)

        # 在候选池中找"内容可接受 + 与前一切片衔接最优"的替代
        best_cand_ci = None
        best_cand_chunk = None
        best_penalty = penalty
        # 触发原因分离：penalty 触发 = 真衔接问题（沿用 90% 保底）；
        # cadence 触发 = 仅为换景别（额外要求内容近乎等价，见下）
        _penalty_triggered = penalty >= CONTINUITY_TRIGGER
        for ci_idx in sorted(candidate_indices):
            ci = valid_chunk_indices[ci_idx]
            cand = video_chunks[ci]
            cid = cand.get("id") or ""
            if cid in used_chunk_ids:
                continue
            # 🎬 整镜头级复用上限：该镜头的使用位已满 → 不再作为替补（防同一长镜头经子段反复出现）
            _cand_parent = cand.get("parentChunkId")
            if _cand_parent and parent_use.get(_cand_parent, 0) >= PARENT_CHUNK_MAX_USE:
                continue
            cand_score, _ = _score(ci_idx)
            if cand_score < cur_score * MIN_SCORE_KEEP:
                continue
            # 🎬 cadence 仅为换景别时，要求**内容近乎等价**（分数落差 ≤ CADENCE_SCORE_TOL）——
            #   避免"为变而变"把语义正确的匹配搬走（实测原规则 100% 的替换都出自这条路径）。
            if cadence_break and not _penalty_triggered and cand_score < cur_score - CADENCE_SCORE_TOL:
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
        # 🎬 整镜头级计数同步：释放原镜头使用位、占用新镜头使用位
        _old_pc = (chunk_by_id.get(old_cid) or {}).get("parentChunkId")
        if _old_pc:
            parent_use[_old_pc] = max(0, parent_use.get(_old_pc, 1) - 1)
        _new_pc = best_cand_chunk.get("parentChunkId")
        if _new_pc:
            parent_use[_new_pc] = parent_use.get(_new_pc, 0) + 1
        used_chunk_ids.discard(old_cid)
        used_chunk_ids.add(best_cand_chunk.get("id") or "")
        cur_r["chunkId"] = best_cand_chunk.get("id", f"chunk_{best_cand_ci:03d}")
        cur_r["coverPath"] = best_cand_chunk.get("coverPath", "")
        cur_r["chunkData"] = best_cand_chunk
        new_score, _ = _score(best_cand_ci)
        cur_r["confidence"] = round(new_score, 4)
        # 变速参考：切片时长 / 成品时间段（保持 KM 的 0.97~1.03 限制，剪辑师 ±3% 准则）
        final_dur = (cur_r.get("videoTimelineEndMs") or 0) - (cur_r.get("videoTimelineStartMs") or 0)
        cand_vdur = best_cand_chunk.get("durationMs", 0)
        if final_dur > 0 and cand_vdur > 0:
            spd = cand_vdur / final_dur
            cur_r["appliedSpeedFactor"] = round(max(0.97, min(1.03, spd)), 3)
            # 🔧 E域（§10.2.6 动作2）：solver 明确选择原速（==1.0）即纯子窗裁剪段，
            #   导出端据此强制 1.00x、禁 linear stretch（补丁12 哨兵）。
            cur_r["isExactSpeed"] = round(max(0.97, min(1.03, spd)), 3) == 1.0
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
    # 👗 §20 第3步 诊断：同场服装跳变命中数（候选对级，非最终替换数）+ 样例，供人工复核是否误伤
    if _COSTUME_JUMP_STATS['pairs'] > 0:
        print(f"[衔接重排] 同场服装跳变判定：{_COSTUME_JUMP_STATS['pairs']} 对候选命中"
              f"（额外惩罚+{COSTUME_JUMP_PENALTY}），样例={'/'.join(_COSTUME_JUMP_STATS['samples'])}",
              file=sys.stderr)
    else:
        print("[衔接重排] 同场服装跳变判定：0 对命中（无「同角色+同场次+主色突变」候选）", file=sys.stderr)
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
        #   text_embedder（BGE 语义主分）+ face，避免常驻叠加到下一个项目
        #   （release_* 内部判空幂等，未加载的模型直接跳过）
        #   注：CLIP / Chinese-CLIP 已彻底退出步骤5（图文通道由 BGE 文本↔文本替代），
        #       步骤2 的镜头语义索引仍独立使用 CLIP，不在此处释放。
        try:
            AIModels.release_text_embedder()
            AIModels.release_face_app()
        except Exception as e:
            print(f"[KM] R1 释放 BGE/人脸模型警告: {e}", file=sys.stderr)
        print(f"[KM] finally 释放模型后 RSS={_mem_rss_mb():.1f}MB（回落观测点）", file=sys.stderr)


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
    # 打印本次请求规模（长耗时排查关键指标：query × chunk 规模）
    print(f"[KM] 请求规模：{n_queries} queries × {n_chunks} chunks", file=sys.stderr)
    # 🎯 诊断（本期不消费）：确认步骤3 产出的参考帧锚点确实随请求体到达 daemon
    _ref_frame_cnt = sum(
        1 for _q in req.queries if float(getattr(_q, "refFrameTimeMs", 0) or 0) > 0
    )
    print(f"[KM] 收到 refFrameTimeMs 的 query 数: {_ref_frame_cnt}/{n_queries}", file=sys.stderr)

    # 🧪 P1 消融复现用：把**本次求解的有效输入**（queries + 实际消费的 videoChunks）整体落盘。
    #   目的：约束消融需要 N 次「改开关→跑步骤5」，每次都要用户在 App 里点一遍；
    #   落盘一次后即可用 scripts/step5-replay.py 离线重放任意开关组合（输入完全相同）。
    #   生产默认关闭（不设开关即零开销）；开启方式见 p1_dump_target()。
    _dump_req_path = p1_dump_target()
    if _dump_req_path:
        try:
            _req_dump = req.model_dump()
            _req_dump["videoChunks"] = video_chunks
            with open(_dump_req_path, "w", encoding="utf-8") as _f:
                json.dump(_req_dump, _f, ensure_ascii=False)
            print(f"[KM-DUMP] 消融用请求体已落盘（{n_queries}q × {n_chunks}c）→ {_dump_req_path}",
                  file=sys.stderr)
        except Exception as _e:
            print(f"[KM-DUMP] req dump failed: {_e}", file=sys.stderr)

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
    # 🎯 2026-09-06 贴解说词：语义文本融合「解说词 text」+「画面意图 visualIntent」双通道。
    # 旧版仅用 visualIntent（画面语言）匹配，解说词 text（文学语言）完全不参与，
    # → 匹配偶发"画面对、文案不贴"。现拼接 text + visualIntent 一起编码：
    #   text 匹配切片描述的情绪/意境/台词（文学语义），visualIntent 匹配画面（画面语义），
    #   二者互补，让"匹配结果更贴解说词内容"。缺失任一侧时回退另一侧，保持旧行为。
    # 🎬 2026-09-16 §23.13「VI 重复拼接」修复开关：`ZENTECT_KM_QUERY_MODE=dedup` 启用，
    #   缺省 `legacy`（=线上现状：daemon 再拼一次 VI ⇒「子句 | VI VI」）。
    #   ⚠️ 默认保持 legacy：端到端实测 dedup 后标签指标不变（8.0%）、但命中扰动 **28/94 段**，
    #   按"无指标收益不进主干"纪律不翻转默认；离线上它更优（接受项名次中位 6→4）。
    _qmode = (os.environ.get('ZENTECT_KM_QUERY_MODE', 'legacy') or 'legacy').strip().lower()
    if _qmode == 'dedup':
        print("[KM] 🎬 query 表示=dedup（尊重 Node 契约：text 已含 VI，不再重复拼接）", file=sys.stderr)
    query_texts = []
    for q in req.queries:
        vi = (q.visualIntent or '').strip()
        t = (q.text or '').strip()
        if _qmode == 'dedup' and vi and t.endswith(vi):
            # Node 侧契约已是 `text = 台词正文 | visualIntent`（SemanticAnalyzeStrategy.buildMatchQueries），
            # 且下游 `stripVisualIntentSuffix` 会剥离该后缀供字幕；daemon 此前**又拼一次 VI**
            # ⇒ 送进 BGE 的实为「子句 | VI VI」，**VI 权重是子句的两倍**、子句信息被淹没
            # （实测 `seg_0_sub_1/2/3` 三条子句检索结果完全同质）。
            query_texts.append(t)
        elif vi and t and vi != t:
            query_texts.append(f"{t} {vi}")
        else:
            query_texts.append(vi or t)

    valid_chunk_indices = []
    for i, chunk in enumerate(video_chunks):
        if chunk.get("startMs") is not None:
            valid_chunk_indices.append(i)

    if not valid_chunk_indices:
        # ===== [KM-DIAG] 空结果定位:切片池非空但无 valid(startMs 全缺),直接返回空 =====
        _km_diag(f"★★★ 空匹配结果根因1: valid_chunk_indices 为空(raw chunks={n_chunks}). "
                 f"首个 chunk 键={list(video_chunks[0].keys()) if video_chunks else 'EMPTY_POOL'}")
        return {"success": True, "results": [], "warning": "No valid chunks for matching"}

    # 🚫 A：伪内容切片硬门禁（2026-09-16）——见 `_is_pseudo_content`。
    #   剔除"无内容/纯色填充/黑场"类转场残影切片：它们没有可匹配的画面语义，
    #   却因描述文本短而拿到中高相似度，会把真实镜头挤掉。剔除数量显式打印，不静默丢数据。
    _kept_idx, _pseudo_dropped = [], 0
    for _ci in valid_chunk_indices:
        if _is_pseudo_content(video_chunks[_ci]):
            _pseudo_dropped += 1
            continue
        _kept_idx.append(_ci)
    if _pseudo_dropped > 0:
        print(f"[KM] 🚫 剔除伪内容切片 {_pseudo_dropped}/{len(valid_chunk_indices)} 个"
              f"（无内容/纯色/黑场帧，不参与匹配）", file=sys.stderr)
        valid_chunk_indices = _kept_idx
        if not valid_chunk_indices:
            _km_diag("★★★ 空匹配结果根因2: 候选池在剔除伪内容切片后为空")
            return {"success": True, "results": [], "warning": "All chunks are pseudo content"}

    # 🔬 B：结构化字段送达诊断（2026-09-16）——P4 空镜额度与抽象段路由都依赖 shotType。
    #   本行直接给出 daemon **实际收到**的字段覆盖率与首切片键名，用于判定断点在 Node 侧还是 daemon 侧。
    _pool_n = len(valid_chunk_indices)
    _st_n = sum(1 for ci in valid_chunk_indices if str(video_chunks[ci].get('shotType') or '').strip())
    _scene_n = sum(1 for ci in valid_chunk_indices if str(video_chunks[ci].get('scene') or '').strip())
    _cam_n = sum(1 for ci in valid_chunk_indices if str(video_chunks[ci].get('cameraMovement') or '').strip())
    _broll_n = sum(1 for ci in valid_chunk_indices if _is_reusable_broll(video_chunks[ci]))
    _first_keys = sorted(video_chunks[valid_chunk_indices[0]].keys())[:14] if valid_chunk_indices else []
    print(f"[KM] 结构化字段覆盖：池={_pool_n} shotType={_st_n} scene={_scene_n} "
          f"cameraMovement={_cam_n} 空镜(可复用)={_broll_n} | 首切片键={_first_keys}", file=sys.stderr)

    # 🌐 P0 表示层诊断（2026-09-16，§23.2）：空间类型分布 + 无组率 + 脏值 + envMedium 覆盖率。
    #   这一行是 P0 的验收仪器：**无组率**（目标 ≤5%）与**空间类型可判定率**（目标 ≥95%）直接读这里。
    _space_dist: dict = {}
    _space_unknown = 0
    _env_dist: dict = {}
    for ci in valid_chunk_indices:
        _c = video_chunks[ci]
        _st = space_type_of(_c.get('scene') or '')
        _space_dist[_st] = _space_dist.get(_st, 0) + 1
        if _st == 'UNKNOWN':
            _space_unknown += 1
        _em = env_medium_of(_c.get('scene') or '', _c.get('visualAtmosphere') or '')
        _env_dist[_em] = _env_dist.get(_em, 0) + 1
    _ungroup_rate = (_space_unknown / _pool_n * 100) if _pool_n else 0.0
    _space_top = sorted(_space_dist.items(), key=lambda kv: -kv[1])
    print(f"[KM] 🌐 空间类型（P0）：可判定={_pool_n - _space_unknown}/{_pool_n}"
          f"（{100 - _ungroup_rate:.1f}%）无组/脏值={_space_unknown}（{_ungroup_rate:.1f}%）"
          f" 脏值样例={_SCENE_DIRTY_STATS['samples']} | 分布={_space_top}", file=sys.stderr)
    print(f"[KM] 🌤 环境介质（P0-5 只采集不接线）："
          f"{sorted(_env_dist.items(), key=lambda kv: -kv[1])}", file=sys.stderr)



    # ============================================================================
    # 🎯 语义主分：BGE 文本↔文本 Dense Retrieval（**唯一语义通道**）
    #   旧实现：Chinese-CLIP 做「文案文本 × 切片封面单帧图像」跨模态对齐。两个致命缺陷：
    #     ① 单帧封面承载不了切片语义——抽象/复合动作/情绪转折都分布在多帧里；
    #     ② Chinese-CLIP 文本端编码能力弱，抽象文案与任意画面的余弦区分度不足（≈76% 天花板）。
    #   新实现：切片侧已有步骤2 产出的结构化 VLM 描述（description），与 query 侧
    #     visualIntent/text 同为文本、同构 → 用 BGE 做纯文本检索，是无损通道。
    #   实测区分度：sim("喧闹的教室瞬间安静了一秒", 教室安静描述)=0.743 vs (海边日落)=0.268。
    # ============================================================================
    chunk_desc_texts = [
        # 🎬 长描述「保头300字 + 保尾200字」截断：防尾部角色/场景信息被 512 token 上限截掉
        _smart_truncate_desc(video_chunks[ci].get("description") or "")
        for ci in valid_chunk_indices
    ]
    _q_emb = AIModels.encode_texts(query_texts)
    _c_emb = AIModels.encode_texts(chunk_desc_texts)
    # 两侧均已 L2 归一化 → 点积即余弦相似度（float32 矩阵，与下游打分量级一致）
    semantic_sim = np.matmul(_q_emb, _c_emb.T).astype(np.float32)
    print(f"[KM] BGE 文本↔文本语义主分就绪：queries={len(query_texts)} "
          f"chunks={len(chunk_desc_texts)} dim={_c_emb.shape[1]}", file=sys.stderr)

    # 🎯 C 两阶段语义（§23.6 落地）：组意图召回 → 子句文案精排。
    #   仅需**额外的 query 侧编码**（2×N，N 很小），切片侧复用已算好的 `_c_emb`，成本可忽略。
    # ⚠️ 默认 **off**（2026-09-16 端到端实测结论）：离线画面级 p@1 11.1%→22.2%，
    #   但**线上未转化**（画面级 1/25 = 4.0%，对比基线 2/25 = 8.0%），故按纪律回退为默认关闭，
    #   保留代码与开关供后续 A/B。三条原因（均有实测证据）：
    #     ① 线上决策 ≠ 语义 top-1：最终命中由 KM 全局指派 ×（时长 0.15/情绪 0.08/角色 0.09/加性层/窗口/排他/空镜额度）共同决定；
    #     ② **25 段中 13 段的线上命中落在 C 召回集（意图 Top15）之外** ⇒ 语义层的约束在线上常被绕过（窗口/排他/时长使集内候选不可用）；
    #     ③ 量纲副作用：C 集内用「子句相似度」（典型 0.2~0.5），普遍低于原「text+VI 拼接」（0.5~0.7），
    #        使语义项绝对量级变小 → 其他因子相对权重被动上升（需"量纲对齐"后重试）。
    #   重启用：`ZENTECT_KM_C_MODE=on`。
    _c_mode = (os.environ.get('ZENTECT_KM_C_MODE', 'off') or 'off').strip().lower()
    if _c_mode != 'off':
        _intent_texts, _clause_texts, _c_fallback = [], [], 0
        for q in req.queries:
            _vi = (q.visualIntent or '').strip()
            _tx = (q.text or '').strip()
            if not _vi:
                _c_fallback += 1
            _intent_texts.append(_vi or _tx)
            _clause_texts.append(_tx or _vi)
        _i_emb = AIModels.encode_texts(_intent_texts)
        _t_emb = AIModels.encode_texts(_clause_texts)
        _sim_intent = np.matmul(_i_emb, _c_emb.T).astype(np.float32)
        _sim_clause = np.matmul(_t_emb, _c_emb.T).astype(np.float32)
        semantic_sim = _two_stage_semantic(_sim_intent, _sim_clause)
        del _i_emb, _t_emb, _sim_intent, _sim_clause
        print(f"[KM] 🎯 C 两阶段语义：召回K={C_RECALL_K} 集外降权={C_MISS_PENALTY} "
              f"（组意图缺省回退={_c_fallback} 段；关本文档用 ZENTECT_KM_C_MODE=off）", file=sys.stderr)
    else:
        print("[KM] 🎯 C 两阶段语义：off（使用 text+VI 拼接单路，A/B 对照口径）", file=sys.stderr)
    del _q_emb, _c_emb

    # 🔧 KM 真实进度：CLIP/中文CLIP 特征提取与语义相似度矩阵计算完成
    _report_km_progress(req.taskId, 0.32, "视觉语义特征提取完成，正在聚合多维匹配矩阵...")
    # 🔬 KM 耗时观测：封面图编码/语义矩阵阶段结束（此阶段是"卡死"头号嫌疑，打点定位）
    _km_tick("BGE文本编码+语义矩阵")

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

    # 🎭 实体通道（2026-09-16 §23.13）：把「文案要求的实体类别」叠加到语义主分上。
    #   与锚定加分同层（都是"语义矩阵上的加性先验"），一起构成最终语义主分；
    #   `ZENTECT_KM_ENTITY_W=0` 可一键回退（默认 0.05 = 离线实验台实测最优点）。
    _ent_w = float(os.environ.get('ZENTECT_KM_ENTITY_W', str(ENTITY_W_DEFAULT)) or ENTITY_W_DEFAULT)
    _ent_prop = None      # 🎭 实体命中矩阵（供窗口豁免判定使用；未启用时为 None）
    if _ent_w > 0:
        _ent_prop, _qp, _cp = build_entity_channel(req.queries, video_chunks, valid_chunk_indices,
                                                   ENTITY_CLASSES)
        _ent_act, _qa, _ca = build_entity_channel(req.queries, video_chunks, valid_chunk_indices,
                                                  ACTION_CLASSES)
        if _qp or _qa:
            semantic_sim = semantic_sim + _ent_w * (_ent_prop + ENTITY_ACTION_RATIO * _ent_act)
        print(f"[KM] 🎭 实体通道：W={_ent_w}｜抽到实体类的段 道具={_qp}/动作={_qa}"
              f"（命中格 道具={_cp} 动作={_ca}）｜关闭用 ZENTECT_KM_ENTITY_W=0", file=sys.stderr)

    # 🎬 BGE 时代的语义分口径：**不做任何归一/拉伸**。
    #   旧「方案 2.3 温和归一」是为 Chinese-CLIP 被压缩的余弦区间（S_max 多在 0.2~0.4）抬分位而设；
    #   BGE 文本余弦天然落在 0.4~0.8 且区分度良好，行内仿射拉伸只会把候选间差异按 λ 压缩，
    #   使语义主分被后续加性微调（情绪/景别/时间锚）淹没 —— 实测表现为「教室文案被分到城市空镜」。
    #   故：语义主分 = BGE 原始余弦；raw 与 final 同源，审计口径一致。
    raw_semantic_sim = semantic_sim

    # 🎭 P0 意境维度：构建文案情绪 ↔ 切片情绪相容度矩阵 (n_queries, n_chunks)
    #    切片情绪由步骤2 帧情绪按时间轴聚合而来（chunk.emotion），文案情绪来自步骤3 生成（query.emotion）
    #    🎬 批1 R2-4：query 侧 moodIntent（Node 按 VI 闸门推导的终点态）**优先替换** query.emotion——
    #    情绪转折文案（"喧闹…瞬间安静"）的画面期望态应由 moodIntent 表达；moodIntent 为空仍用 q.emotion（老行为不变）。
    query_emotions = []
    _mood_count = 0
    for _q in req.queries:
        _mi = (getattr(_q, 'moodIntent', '') or '').strip()
        if _mi:
            query_emotions.append(_mi)
            _mood_count += 1
        else:
            query_emotions.append(_q.emotion or '')
    chunk_emotions = [(video_chunks[ci].get("emotion") or '') for ci in valid_chunk_indices]
    # 🔧 R5 矩阵降精度（PR-2）：情绪矩阵 float64 → float32
    emotion_sim = np.zeros((n_queries, len(valid_chunk_indices)), dtype=np.float32)
    for qi in range(n_queries):
        for ci_idx in range(len(valid_chunk_indices)):
            emotion_sim[qi, ci_idx] = _emotion_compatibility(query_emotions[qi], chunk_emotions[ci_idx])
    q_with_emotion = sum(1 for e in query_emotions if e.strip())
    c_with_emotion = sum(1 for e in chunk_emotions if e.strip())
    print(f"[KM] 情绪匹配就绪：{q_with_emotion}/{n_queries} 段文案带情绪（其中 moodIntent 优先 {_mood_count} 段），{c_with_emotion}/{len(valid_chunk_indices)} 切片带情绪",
          file=sys.stderr)

    # 🎭 P1 角色组合匹配：构建 Query 角色 ↔ 切片角色契合度矩阵 (n_queries, n_chunks)
    #    🎭 人物归一（2026-09-18）：输入改为 **query.charIds ∩ chunk.charIds**（注册表主键交集），
    #    不再比原始 characters 字符串——同一角色的"宋慧乔/宋慧乔饰演的角色/女子（宋慧乔）"归一后才能真正相交；
    #    charIds 缺失/为空时由 _char_ids_of_query/_char_ids_of_chunk 回退旧 characters（向后兼容）。
    #    🛑 用户级铁律（粒度不可信）：角色维仅作软排信号，**任何时候不得作硬门禁**（不得出现 5.0 级惩罚）——
    #       切片 characters 来自 VLM 帧聚合，存在"父镜头并集回填"污染，误识别一旦当门禁就会否决正确切片。
    query_roles = [_char_ids_of_query(q) for q in req.queries]
    chunk_roles = [_char_ids_of_chunk(video_chunks[ci]) for ci in valid_chunk_indices]
    # 🎭 切片角色粒度标记（Node 侧 charGrain 透传）：union_suspect=疑似父镜头并集回填；缺省 'ok'（老数据）。
    chunk_grains = [str(video_chunks[ci].get('charGrain') or 'ok') for ci in valid_chunk_indices]
    # 🔧 R5 矩阵降精度（PR-2）：角色矩阵 float64 → float32
    role_sim = np.zeros((n_queries, len(valid_chunk_indices)), dtype=np.float32)
    for qi in range(n_queries):
        for ci_idx in range(len(valid_chunk_indices)):
            _role = _compute_role_score(query_roles[qi], chunk_roles[ci_idx])
            # 🎭 粒度降权（2026-09-18）：charGrain == 'union_suspect'（切片 characters 条数 > 3，
            #    疑似父镜头并集回填）时把 role_score 向中性 0.5 收缩一半（偏差 × 0.5）——
            #    粒度不可信 → 只降权、不否决（软排底线），避免"全景切片挂 12 个人"误伤角色分。
            if chunk_grains[ci_idx] == 'union_suspect':
                _role = 0.5 + (_role - 0.5) * 0.5
            role_sim[qi, ci_idx] = _role
    q_with_role = sum(1 for r in query_roles if r)
    c_with_role = sum(1 for r in chunk_roles if r)
    print(f"[KM] 角色匹配就绪：{q_with_role}/{n_queries} 段文案带角色，{c_with_role}/{len(valid_chunk_indices)} 切片带角色",
          file=sys.stderr)
    # 📊 人物归一接线验收诊断（2026-09-18）：用于判定"两条死代码通路是否被激活"——
    #    query 带 charIds / chunk 带 charIds 为**严格计数**（只数归一主键本身，不计 fallback 的 characters）；
    #    role_score 非中性格 = 与 0.5 偏离超过浮点容差的格数（>0 说明角色维真正参与了打分）。
    _q_with_charids = sum(1 for q in req.queries if [str(x).strip() for x in (getattr(q, 'charIds', None) or []) if str(x).strip()])
    _c_with_charids = sum(1 for ci in valid_chunk_indices if [str(x).strip() for x in (video_chunks[ci].get('charIds') or []) if str(x).strip()])
    _role_non_neutral = int(np.count_nonzero(np.abs(role_sim - 0.5) > 1e-6))
    print(f"[KM] 人物归一：query 带 charIds={_q_with_charids}/{n_queries}｜chunk 带 charIds={_c_with_charids}/{len(valid_chunk_indices)}｜role_score 非中性格={_role_non_neutral}",
          file=sys.stderr)

    # 🎬 批1（2026-09-06）语义翻译层：query/chunk 场景组预计算（R2-1/R2-3 共用）
    #    query 组来自 Node buildMatchQueries 推导（visualIntent → 正文），chunk 组由 _map_scene_group 映射
    #    chunk.scene（Node 聚合的帧场景众数 / desc「场景:」正则回捞）。两数组索引与 semantic_sim 行列一一对应：
    #    query_scene_groups[qi]  ↔ 第 qi 个 query；chunk_scene_groups[ci_idx] ↔ valid_chunk_indices 第 ci_idx 个切片。
    query_scene_groups = [(getattr(q, 'sceneGroup', '') or '').strip() for q in req.queries]
    chunk_scene_groups = [_map_scene_group(video_chunks[ci].get('scene') or '') for ci in valid_chunk_indices]
    q_with_scene = sum(1 for g in query_scene_groups if g)
    c_with_scene = sum(1 for g in chunk_scene_groups if g)
    print(f"[KM] 场景分组就绪：{q_with_scene}/{n_queries} 段文案带场景约束（{query_scene_groups and {g for g in query_scene_groups if g} or set()}），"
          f"{c_with_scene}/{len(valid_chunk_indices)} 切片映射到场景组",
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
    # 🎯 方向2b（2026-09-20）硬回跳一票否决：无 flashback 时，若当前切片起点比上一确定镜头
    #    退回过久（>5s，远超相邻衔接容差，属剧情跨幕倒流），重选结果**不再受 0.95 退化门槛约束**，
    #    只要池内有语义达标的时间单调候选即强制换入，杜绝 110s 级硬倒流（如 scene_146_seg1→seg_36）。
    #    仍受语义门槛(L4032)与白名单/段域约束，不会把窗外弱相关素材换进来。
    MONOTONIC_HARD_REJECT_MS = 5000.0
    # 🧪 P1 约束消融：开关快照 + 触发计数（一次运行即得"约束绑定度"画像）。
    #   计数**不受开关影响**（关掉约束后仍照常计数），故"全 on 跑一次"就能看出谁在真绑定。
    _ABL = read_ablation_flags()
    _cand_wl = read_cand_whitelist_mode()   # 🧪 消融⑤ 行级白名单档位：on / soft / off
    _excl = read_exclusive_mode()           # 🧪 消融③ 排他档位：on / quota / unlimited
    # 🧪 裁决 B（§23.13）：段落窗口档位——hard（默认，窗外置 5.0 死刑=线上现状）｜soft（窗外改弱软罚）
    _window_mode = (os.environ.get('ZENTECT_KM_WINDOW_MODE', 'hard') or 'hard').strip().lower()
    if _window_mode not in ('hard', 'soft'):
        _window_mode = 'hard'
    if _window_mode == 'soft':
        print(f"[KM] 🧪 段落窗口=soft（窗外弱软罚，封顶 {WINDOW_SOFT_MAX}；裁决 B 实验档）", file=sys.stderr)
    _ABL_STATS = {
        'win_penalty_cells': 0,     # ①b 窗外被 WINDOW_PENALTY 压制的候选格数
        'win_soft_cells': 0,        # 🧪 裁决 B：窗外改走弱软罚的候选格数
        'whitelist_cells': 0,       # perQueryTopK 白名单外被压制格数（Node 侧 preselectTopK 决定）
        'excl_cells': 0,            # ③ 跨块已用切片（排他）被压制格数
        'excl_skips': 0,            # ③ 消费期"分配到的切片已被跨块消费"的段数（含额度内复用放行的）
        'mono_events': 0,           # ② 触发"时间倒走"判定的段数
        'mono_switched': 0,         # ② 其中真的换镜成功的段数
        'mono_hard': 0,             # ②其中"硬回跳（>5s 无 flashback）一票否决"档的段数
        'mono_slop_used': 0,        # ②A类兜底：硬回跳本段无单调候选时，靠"近邻后段单调候选"补配成功的段数
        'speed_over': 0,            # ④ 变速比超出 ±3%（需"超限重选"）的段数
        'speed_merge': 0,           # ④ 其中靠拼接级联化解的段数
        'kw_boost_cells': 0,        # 关键词 boost 命中的候选格数
        'shot_boost_cells': 0,      # 景别 boost 命中的候选格数
        'entity_window_exempt': 0,  # 🎭 靠"道具命中"逃过段落窗口死刑的候选格数（实体通道诊断）
        'entity_kept_cells': 0,     # 🎭 靠"道具命中"免于块级窗口收窄的（query×切片）格数
        'sb_in_seg_cells': 0,       # 🎬 段内格（豁免窗口/白名单用；仅 on 档生效）
        'sb_exempt_cells': 0,       # 🎬 实际靠"段内"逃过窗口死刑的格数
        'sb_out_seg_cells': 0,      # 🎬 段外格被段域门禁压制（仅 on 档生效）
    }
    # 🎬 S3 段域（§24.12-I 步骤 1）：off=零行为变化｜shadow=只算不用（验收仪器）｜on=替换候选域
    _SB = load_storyboard()
    _SB_STATS = {'q_no_seg': 0, 'q_total': 0, 'dom_size': [], 'hit_in_seg': 0, 'miss_out_seg': 0,
                 'no_data': 0, 'blocks_replaced': 0, 'top_seg_counts': [], 'out_domain_soft_cells': 0,
                 'out_domain_hard_cells': 0, 'seg_pool_sizes': [], 'q_with_seg_pool': 0,
                 'spatial_pool_sizes': [], 'q_with_spatial_pool': 0, 'spatial_gate_blocked': 0,
                 'dyn_pool_sizes': [], 'q_with_dyn_pool': 0, 'q_dyn_levels': {},
                 'fallback_l0': 0, 'fallback_l1': 0, 'fallback_l2': 0, 'fallback_l3': 0,
                 'fallback_l4': 0, 'fallback_l5': 0,
                 'cont_prev_total': 0, 'cont_prev_taken': 0, 'cont_prev_miss': 0,
                 'cont_prev_l0': 0, 'cont_prev_l3': 0, 'cont_prev_l4': 0, 'cont_prev_l5': 0,
                 'shadow_compare': None}
    # 🎬 S3 段域（视觉 Top-3 选段）：qi → 优先域切片下标集合 / 优先域段明细（供块循环与终局诊断）
    _SB_Q_DOMAIN, _SB_Q_TOPSEGS = {}, {}
    # 预计算「段 → 有效切片下标」，避免在块循环里对每个 query 全池扫描（O(q×c) → O(1) 查表）
    _SB_BY_SEG = {}
    if _SB['mode'] != 'off':
        for _ci_idx in range(len(valid_chunk_indices)):
            _ch = video_chunks[valid_chunk_indices[_ci_idx]]
            _pp = str(_ch.get("parentChunkId") or "")
            _sid = storyboard_seg_of_parent(_SB, _pp or str(_ch.get("id") or ""))
            if _sid:
                _SB_BY_SEG.setdefault(_sid, []).append(_ci_idx)
        # 按视觉内容为每个 query 选 Top-3 段作为优先域（不再按 query.startMs 找段——假锚点，§24.12-I）
        _SB_Q_DOMAIN, _SB_Q_TOPSEGS = storyboard_top_domains(_SB_BY_SEG, semantic_sim, n_queries)
        _SB_STATS['top_seg_counts'] = [len(_SB_Q_TOPSEGS.get(_qi, ())) for _qi in range(n_queries)]
        _SB_STATS['dom_size'] = [len(_SB_Q_DOMAIN.get(_qi, ())) for _qi in range(n_queries)]
        _SB_STATS['q_total'] = n_queries
    # 🎬 S3 段域硬候选池（§24.15-B1）：候选 = 契约 segmentId 段内全部切片（替代 ±3 块窗口）。
    #   `_SB_Q_SEGPOOL[qi]` = 该 query 契约段内有效切片下标列表；空池 ⇒ 回退内容 Top-K 优先域兜底。
    #   ⚠️ 段号解析绝不用 query.startMs（假锚点，§24.12-I 实证命中率仅 4%）——β 走内容 Top-1 段。
    _SB_Q_SEGPOOL = {}
    if _SB['mode'] != 'off':
        for _qi in range(n_queries):
            _pool = _segment_pool_of(_SB_BY_SEG, _contract_segment_id(req.queries[_qi], _SB_Q_TOPSEGS.get(_qi) or ()))
            _SB_Q_SEGPOOL[_qi] = _pool
        _SB_STATS['seg_pool_sizes'] = [len(_SB_Q_SEGPOOL.get(_qi, ())) for _qi in range(n_queries)]
        _SB_STATS['q_with_seg_pool'] = sum(1 for _qi in range(n_queries) if _SB_Q_SEGPOOL.get(_qi))
    # 🎬 S3 空间门禁池（§24.15-B2）：在段域硬候选池上叠加「分级硬门禁」——
    #   段 locPurity≥0.6 → 只保留空间==契约者（硬卡）；<0.6 或硬卡空 → 转软排/回退全段（0 否决=0）。
    #   `_SB_Q_SPATIAL_POOL[qi]` = 空间门禁后的候选池（query 无段域时为空 ⇒ 兜底走内容 Top-K 优先域）。
    #   β 过渡无 α 工单 → 契约空间取段内众数（_dominant_spatial_of）；α 真工单用 query.spatialType。
    _SB_Q_SPATIAL_POOL = {}
    if _SB['mode'] != 'off':
        for _qi in range(n_queries):
            _pool = _SB_Q_SEGPOOL.get(_qi) or []
            _q = req.queries[_qi]
            _contract_sp = str(getattr(_q, 'spatialType', '') or '')
            if not _contract_sp:
                _contract_sp = _dominant_spatial_of(_pool, video_chunks)   # β：段内众数空间
            _seg_key_id = _seg_key(_contract_segment_id(_q, _SB_Q_TOPSEGS.get(_qi) or ()))
            _purity = _SB['seg_locpurity'].get(_seg_key_id, 0.0) if _seg_key_id else 0.0
            _gated, _blocked = _spatial_gate(_contract_sp, _purity, _pool, video_chunks)
            _SB_Q_SPATIAL_POOL[_qi] = _gated
            if _blocked:
                _SB_STATS['spatial_gate_blocked'] += 1
        _SB_STATS['spatial_pool_sizes'] = [len(_SB_Q_SPATIAL_POOL.get(_qi, ())) for _qi in range(n_queries)]
        _SB_STATS['q_with_spatial_pool'] = sum(1 for _qi in range(n_queries) if _SB_Q_SPATIAL_POOL.get(_qi))
    # 🎬 S3 动态门禁池（§24.15-B3）：在空间门禁池上叠加「动态门禁+降级链 L0-L5」——
    #   探测 actionType/keyProp/preferredShot 可满足性，可满足则只在满足者中选（level0），
    #   不可满足则按 fallbackLevel 逐级放宽（L1 弃道具→L2 弃动作→L3 弃景别→L4 同段任意→L5 段内复用）。
    #   `_SB_Q_DYNAMIC_POOL[qi]` = 最终候选池（query 无段域时为空 ⇒ 兜底走内容 Top-K 优先域）。
    #   β 过渡探测项为空 → 无动态硬卡（P1 不混算）；level/卡项记入 _SB_STATS 供降级率统计（验收门 B3）。
    _SB_Q_DYNAMIC_POOL = {}
    _SB_Q_DYN_LEVEL = {}
    if _SB['mode'] != 'off':
        for _qi in range(n_queries):
            _q = req.queries[_qi]
            _fbl = int(getattr(_q, 'fallbackLevel', 0) or 0)
            _gated_pool = _SB_Q_SPATIAL_POOL.get(_qi) or []
            _dyn, _lvl, _rsn = _dynamic_gate(
                str(getattr(_q, 'actionType', '') or ''),
                str(getattr(_q, 'keyProp', '') or ''),
                str(getattr(_q, 'preferredShot', '') or ''),
                _fbl, _gated_pool, video_chunks)
            _SB_Q_DYNAMIC_POOL[_qi] = _dyn
            _SB_Q_DYN_LEVEL[_qi] = _lvl
            if _rsn:
                _SB_STATS['fallback_reason_' + _rsn] = _SB_STATS.get('fallback_reason_' + _rsn, 0) + 1
            _SB_STATS['fallback_l' + str(_lvl)] = _SB_STATS.get('fallback_l' + str(_lvl), 0) + 1
        _SB_STATS['dyn_pool_sizes'] = [len(_SB_Q_DYNAMIC_POOL.get(_qi, ())) for _qi in range(n_queries)]
        _SB_STATS['q_with_dyn_pool'] = sum(1 for _qi in range(n_queries) if _SB_Q_DYNAMIC_POOL.get(_qi))
        _SB_STATS['q_dyn_levels'] = _SB_Q_DYN_LEVEL
    if not all(_ABL.values()) or _cand_wl != 'on' or _excl != 'on':
        print(f"[KM] 🧪 P1 约束消融开关已启用："
              + ", ".join(f"{k}={'on' if v else 'OFF'}" for k, v in _ABL.items())
              + f", cand_whitelist={_cand_wl}, exclusive={_excl}", file=sys.stderr)
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

    # 🎬 §24.15-B5 段内分组 KM（on 档）：分区键从「源 startMs / BLOCK_DURATION_MS 时间块」改为「契约 segmentId」。
    #   · 段就是分区：每段一个 cost 子矩阵 = 段内 query 子集 × 段内候选切片（中位 25×25，最大 112×112）；
    #   · 段内不再二次按块收窄（P5：候选=段内，不与旧时间窗取交集）；
    #   · CONTINUE_PREV query（B4）**不入 KM 矩阵**，段内 KM 之后再按 query 顺序推演顺延（不抢 NEW_SHOT）；
    #   · 段间排他仍走 global_used_chunks（保持现状），可并行。
    #   ⚠️ off/shadow 档：shadow 的派工对照由 B6 双轨统一引入，本步仅 on 档启用段分区，off 档零行为变化（P6）。
    _sb_partition_by_seg = _SB['mode'] == 'on'
    _sb_cont_by_seg = {}   # B4：{seg_id: [query 下标...]}（CONTINUE_PREV 队列，on 档消费）

    if _sb_partition_by_seg:
        # 切片 → 所属段号反查表（_SB_BY_SEG 键 'S{n:02d}' → int 段号；未入段切片归 0 段兜底）
        _sb_seg_of_ci = {}
        for _sid_key, _idxs in _SB_BY_SEG.items():
            _seg_n = int(_sid_key.lstrip('S')) if _sid_key[:1] == 'S' else 0
            for _ci_idx in _idxs:
                _sb_seg_of_ci[_ci_idx] = _seg_n
        for qi in range(n_queries):
            _q = req.queries[qi]
            _seg = _contract_segment_id(_q, _SB_Q_TOPSEGS.get(qi) or ())
            if str(getattr(_q, 'shotMode', '') or '') == 'CONTINUE_PREV':
                _sb_cont_by_seg.setdefault(_seg, []).append(qi)
                _SB_STATS['cont_prev_total'] += 1
                continue
            block_idx = _seg if _seg > 0 else 0
            if block_idx not in query_blocks:
                query_blocks[block_idx] = []
            query_blocks[block_idx].append(qi)
        for ci_idx, ci in enumerate(valid_chunk_indices):
            block_idx = _sb_seg_of_ci.get(ci_idx, 0)
            if block_idx not in chunk_blocks:
                chunk_blocks[block_idx] = []
            chunk_blocks[block_idx].append(ci_idx)
    else:
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
    # 🎬 P4 空镜复用额度计数：key=真实切片索引，value=已消费次数。
    #   空镜稀缺，无上限时全片抒情段会争抢同一个高分空镜 → 同一画面反复出现（穿帮）。
    #   达到 BROLL_MAX_REUSE 后该切片恢复排他语义，逼分配器换镜。叙事镜头不计数（恒排他）。
    broll_usage_count: dict = {}

    def _broll_still_available(ci: int, chunk: dict) -> bool:
        """函数级中文注释：该切片此刻是否仍可作为空镜复用——需同时满足「是空镜」且「额度未用尽」。
        额度用尽后返回 False，调用方按普通叙事镜头处理（走既有排他惩罚）。
        🧪 消融③：quota 档把豁免范围从"空镜"放大到"全部切片"；unlimited 档**完全取消排他**
        （同一画面可被任意多段复用——用于测"多子句共享同一查询抢同一画面"是否是 Top-1 的墙）。"""
        if _excl == 'unlimited':
            return True
        if not _is_reusable_broll(chunk) and _excl == 'on':
            return False
        return broll_usage_count.get(ci, 0) < BROLL_MAX_REUSE

    # video_chunks 全局索引 → semantic_sim 列索引 的映射，供变速超限重选后重算语义分
    chunk_rank = {ci: idx for idx, ci in enumerate(valid_chunk_indices)}

    # 🔬 Step1 Layer1：预计算每段窗口（Node 显式窗口优先，未透传用源锚派生，候选不足自适应扩张）
    _qw = {}
    for _qi in range(n_queries):
        _w = _query_window(req.queries[_qi], valid_chunk_indices, video_chunks)
        if _w is not None:
            _qw[_qi] = _w

    # 🎬 B 立项（2026-09-08）同源拆分句的画面承接：前序锚（最近一个已产出的相邻叙述段）。
    #   消费改为按脚本顺序（行序升序）处理，保证该锚 = 时间轴上紧邻的上一个叙述段，
    #   同源承接补配才能锚定正确的前段。
    _km_prev_anchor = None

    def _backfill_continuation_for(_qi):
        """同源拆分句承接补配（B 立项）：当前 query 因排他/候选不足未获实体分配时，
        若与前一个已产出段落构成同源承接对（visualIntent 逐字一致 或 同断句子句族 seg_N_sub_k），
        从其源时间近邻、同 scene 组的未用切片中取时间紧随的承接段；素材覆盖 ≥ CONTINUATION_COVER_MIN
        才补配并原位推进时间轴（沿用档1 原速截尾，绝不制造变速超限/挂无关画面）。
        素材覆盖不足则保持未匹配并打 [承接] 日志——把"分配没给"与"素材真的不够"分开暴露。
        返回 True=已补配，False=未补（保持原未匹配行为）。"""
        nonlocal current_timeline_ms, last_chunk_end_ms, _km_prev_anchor
        _q = req.queries[_qi]
        if getattr(_q, 'keepOriginalAudio', False) or _km_prev_anchor is None:
            return False
        _pa = _km_prev_anchor
        if not _is_same_continuation(_pa['query'], _q):
            return False
        _pc = _pa['chunk']
        _pcs = float(_pc.get('startMs') or 0)
        _pce = float(_pc.get('endMs') or _pcs)
        _qst = float(getattr(_q, 'startMs', 0) or 0)
        if not (_pcs - 2000.0 <= _qst <= _pce + CONTINUATION_MAX_GAP_MS):
            return False
        _pg = _map_scene_group(_pc.get('scene') or '')
        if not _pg:
            print(f"[承接] Q:{_q.shotId} 前段无 scene 场景组，无法判定承接，保持未匹配", file=sys.stderr)
            return False
        _audio = float(getattr(_q, 'audioDurationMs', 0) or 0)
        if _audio <= 0:
            return False
        # 1) 承接候选：起点紧随前段结束（±500ms 容差内，≤ 前段结束+gap）、同 scene 组、未占用，取时间最早者
        _best_ci = None
        _best_cs = None
        for _ci in range(len(video_chunks)):
            if _ci in global_used_chunks:
                continue
            _c = video_chunks[_ci]
            _cs = float(_c.get('startMs') or 0)
            _ce = float(_c.get('endMs') or _cs)
            if _cs < _pce - 500.0 or _cs > _pce + CONTINUATION_MAX_GAP_MS or _ce <= _pce:
                continue
            if _map_scene_group(_c.get('scene') or '') != _pg:
                continue
            if _best_ci is None or _cs < _best_cs:
                _best_ci, _best_cs = _ci, _cs
        if _best_ci is None:
            print(f"[承接] Q:{_q.shotId} 前段后 {CONTINUATION_MAX_GAP_MS / 1000.0:.0f}s 内无同场景未用承接段，保持未匹配", file=sys.stderr)
            return False
        # 2) 素材覆盖：单段覆盖达标直接采用；不足则尝试同父级联补足（复用既有级联定窗，仅取覆盖达标的）
        _b_c = video_chunks[_best_ci]
        _b_dur = float(_b_c.get('durationMs') or 0)
        if _b_dur <= 0:
            _b_dur = float(_b_c.get('endMs') or 0) - float(_b_c.get('startMs') or 0)
        _use_ci = None
        _chunk = None
        if _b_dur >= _audio * CONTINUATION_COVER_MIN:
            _use_ci = _best_ci
            _chunk = _b_c
        else:
            _merged = _try_merge_contiguous_segs(_best_ci, video_chunks, global_used_chunks, _audio)
            if _merged is not None and _merged['total_dur'] >= _audio * CONTINUATION_COVER_MIN:
                for _mi in _merged['seg_indices']:
                    global_used_chunks.add(_mi)
                _use_ci = _merged['seg_indices'][0]
                _chunk = _merged['chunk']
            else:
                print(f"[承接] Q:{_q.shotId} 承接素材覆盖 < {CONTINUATION_COVER_MIN * 100:.0f}% 目标({_audio:.0f}ms)，"
                      f"保持未匹配（不拉变速、不挂无关画面）", file=sys.stderr)
                return False
        # 3) 原速截尾定窗：承接段长于目标时按目标截尾（变速 1.0），与档1 同口径，弃长尾防字幕帧
        _chunk = dict(_chunk)
        _s0 = float(_chunk.get('startMs') or 0)
        _e0 = float(_chunk.get('endMs') or _s0)
        if (_e0 - _s0) > _audio * WINDOWIZE_TAIL_MAX_RATIO:
            _chunk['endMs'] = round(_s0 + _audio, 1)
            _chunk['durationMs'] = round(_audio, 1)
        _c_dur = float(_chunk.get('durationMs') or 0)
        # 4) 占位 + 时间轴原位推进 + 结果入列（承接不虚高：confidence ≤0.85 且不超过前段）
        global_used_chunks.add(_use_ci)
        _t0 = current_timeline_ms
        _t1 = _t0 + _audio
        _spd = (_c_dur / _audio) if _audio > 0 and _c_dur > 0 else 1.0
        _spd = max(0.97, min(1.03, _spd))
        _prev_conf = float((_pa['result'] or {}).get('confidence') or 0.8)
        results.append({
            "shotId": _q.shotId,
            "chunkId": _chunk.get("id", f"chunk_{_use_ci:03d}"),
            "confidence": round(min(0.85, _prev_conf), 4),
            "coverPath": _chunk.get("coverPath", ""),
            "chunkData": _chunk,
            "audioDurationMs": _audio,
            "videoTimelineStartMs": round(_t0, 1),
            "videoTimelineEndMs": round(_t1, 1),
            "appliedSpeedFactor": round(_spd, 3),
            # 🔧 E域（§10.2.6 动作2）：承接原速截尾准则——变速==1.0 即纯子窗裁剪段，禁拉伸
            "isExactSpeed": round(_spd, 3) == 1.0,
            # 🛑 回退降级兜底后无降级段，degraded 恒 False（保留字段供前端兼容）
            "degraded": False,
        })
        _km_prev_anchor = {'query': _q, 'chunk': _chunk, 'result': results[-1]}
        current_timeline_ms = _t1
        _cce = float(_chunk.get('endMs') or 0)
        if last_chunk_end_ms is None or _cce > last_chunk_end_ms:
            last_chunk_end_ms = _cce
        print(f"[承接] Q:{_q.shotId} 同源承接补配 → {_chunk.get('id')}（源 {_s0:.0f}~{_e0:.0f}ms，"
              f"变速 {_spd:.2f}，时间轴 {_t0:.0f}→{_t1:.0f}ms）", file=sys.stderr)
        return True

    # 🎬 §24.15-B4：段内锚与 L5 复用额度（on 档段分区后消费）。
    #   _sb_seg_anchor[seg_id] = 段内最近一张已定镜（KM 消费时更新）；_sb_cont_reuse_n 计 L5 镜像复用次数。
    _sb_seg_anchor = {}
    _sb_cont_reuse_n = {}

    def _sb_run_continue_prev(_seg_id: int) -> None:
        """函数级中文注释：B4 段内 CONTINUE_PREV 顺延推演（on 档，段内 KM 全部 NEW_SHOT 分配完之后调用）。
        按 query 行序对 _seg_id 段内 shotMode==CONTINUE_PREV 的 query 逐条顺延：
        anchor=段内上一张已定镜（无段锚时回退全局前序锚），候选=段内 startMs 紧随 anchor 的**未用**切片
        （视觉连续性：同父镜头 > 同景别 > 同人物组，§24.12-D）；时间上续用尽 → L3 空镜 → L4 任意未用
        → L5 段内复用（镜像继承上镜，额度≤2，超出记 miss）；段空/无锚 → 记 miss。
        严禁跨段（P3）：取片只走 _sb_continue_prev 的段内下标，绝不出段。"""
        nonlocal current_timeline_ms, last_chunk_end_ms, _km_prev_anchor
        _qs = _sb_cont_by_seg.get(_seg_id, [])
        for _qi in sorted(_qs):
            _q = req.queries[_qi]
            _anchor = _sb_seg_anchor.get(_seg_id) or _km_prev_anchor
            _seg_idxs = _SB_BY_SEG.get(_seg_key(_seg_id), [])
            if _anchor is None or not _seg_idxs:
                _SB_STATS['cont_prev_miss'] = _SB_STATS.get('cont_prev_miss', 0) + 1
                continue
            _ci, _chunk, _lvl = _sb_continue_prev(
                _seg_idxs, valid_chunk_indices, video_chunks, global_used_chunks, _anchor['chunk'])
            if _lvl == 'none':
                _SB_STATS['cont_prev_miss'] = _SB_STATS.get('cont_prev_miss', 0) + 1
                continue
            _audio = float(getattr(_q, 'audioDurationMs', 0) or 0)
            if _lvl == 'l5':
                # L5 段内复用：镜像继承上镜画面（不占新切片），额度 ≤2（防同一画面无限复映穿帮）
                _rkey = (_seg_id, _anchor['chunk'].get('id') or '')
                if _sb_cont_reuse_n.get(_rkey, 0) >= 2:
                    _SB_STATS['cont_prev_miss'] = _SB_STATS.get('cont_prev_miss', 0) + 1
                    continue
                _sb_cont_reuse_n[_rkey] = _sb_cont_reuse_n.get(_rkey, 0) + 1
            else:
                global_used_chunks.add(_ci)
            _SB_STATS['cont_prev_taken'] = _SB_STATS.get('cont_prev_taken', 0) + 1
            _SB_STATS['cont_prev_l' + _lvl] = _SB_STATS.get('cont_prev_l' + _lvl, 0) + 1
            # 结果入列：续镜继承上镜 confidence（复用镜像正确性：仅时限推进，§24.14.3-B4）
            _base_conf = float((_anchor['result'] or {}).get('confidence') or 0.8)
            _t0 = current_timeline_ms
            _t1 = _t0 + _audio
            _c_dur = float(_chunk.get('durationMs') or 0)
            _spd = (_c_dur / _audio) if _audio > 0 and _c_dur > 0 else 1.0
            _spd = max(0.97, min(1.03, _spd))
            _res = {
                "shotId": _q.shotId,
                "chunkId": _chunk.get("id", "reuse") if _ci is None else _chunk.get("id", f"chunk_{_ci:03d}"),
                "confidence": round(_base_conf, 4),
                "coverPath": _chunk.get("coverPath", ""),
                "chunkData": _chunk,
                "audioDurationMs": _audio,
                "videoTimelineStartMs": round(_t0, 1),
                "videoTimelineEndMs": round(_t1, 1),
                "appliedSpeedFactor": round(_spd, 3),
                "isExactSpeed": round(_spd, 3) == 1.0,
                "degraded": False,
            }
            results.append(_res)
            current_timeline_ms = _t1
            _cce = float(_chunk.get('endMs') or 0)
            if last_chunk_end_ms is None or _cce > last_chunk_end_ms:
                last_chunk_end_ms = _cce
            _sb_seg_anchor[_seg_id] = {'query': _q, 'chunk': _chunk, 'result': _res}
            _km_prev_anchor = _sb_seg_anchor[_seg_id]

    # ===== [KM-DIAG] 空结果定位计数(分块循环累计,仅在 results 为空时打印) =====
    dbg_zero_dur_queries = sum(1 for qi in range(n_queries) if not (req.queries[qi].audioDurationMs or 0))
    dbg_block_gap_query = 0   # 有 query 但 ±3 窗口空候选的块(时序错位症结)
    dbg_block_gap_chunk = 0   # 无 query 的块
    dbg_block_attempted = 0   # 有 query+候选、真正进入求解的块
    # 🏠 §20 第2步：室内/外景矛盾计数清零（主循环结束后统一打印一行诊断）
    _SPACE_CONFLICT_STATS['pairs'] = 0
    _SPACE_CONFLICT_STATS['samples'] = []
    _SCENE_DIRTY_STATS['frames_chunks'] = 0
    _SCENE_DIRTY_STATS['samples'] = []

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
        if _sb_partition_by_seg:
            # 🎬 §24.15-B5：候选 = 本段内全部有效切片（分区键已是契约 segmentId，块=段）。
            #   不再走 ±3 块窗口并集、不做窗口二次收窄（P5：候选=段内，不与旧时间窗取交集）。
            block_chunk_indices.update(chunk_blocks.get(block_idx, []))
        elif _ABL['block_window']:
            for offset in [-3, -2, -1, 0, 1, 2, 3]:
                block_chunk_indices.update(chunk_blocks.get(block_idx + offset, []))
        else:
            # 🧪 消融①a：撤回 ±3 块窗口（±15min）→ 本块候选池放开到全片。
            #   注意：此时下方 Layer1 收窄（若 query_window 仍 on）与 WINDOW_PENALTY 依旧生效，
            #   二者是**更细的时间局部性约束**，各自由 ①b 独立开关控制。
            block_chunk_indices.update(range(len(valid_chunk_indices)))
        # 🔬 Step1 Layer1：若本块所有 query 都有有效窗口，块候选收窄到"成员窗口并集"，
        #   让候选池从全片降到段内 30~50（决策 #1 验收）；任一无窗口则退回旧 ±3 块并集兜底。
        #   🎬 B5：段分区时跳过窗口收窄（P5：段内不再二次按块收窄）。
        if _ABL['query_window'] and not _sb_partition_by_seg \
                and block_queries and all(_qi in _qw for _qi in block_queries):
            _narrowed = set()
            for _qi in block_queries:
                _w0, _w1 = _qw[_qi]
                for _ci_idx in block_chunk_indices:
                    _ci = valid_chunk_indices[_ci_idx]
                    _cs = float(video_chunks[_ci].get("startMs") or 0)
                    if _w0 <= _cs <= _w1:
                        _narrowed.add(_ci_idx)
            # 🎭 2026-09-16 §23.13：**实体道具命中格不受"窗口并集收窄"限制**——
            #   文案点名了道具（「零钱」）时，对应镜头可能在剧情上离源起点很远
            #   （实测 `seg_6_sub_3`：源 3.5 分，而含钱类道具的镜头全在 8.0~8.7 分，相差 4.5 分）。
            #   若不在此放行，收窄后矩阵里连该格都不存在，后面的窗口/白名单豁免都无从谈起。
            if _ent_prop is not None:
                _ent_extra = 0
                for _qi in block_queries:
                    for _ci_idx in block_chunk_indices:
                        if _ent_prop[_qi, _ci_idx] > 0:
                            _narrowed.add(_ci_idx)
                            _ent_extra += 1
                if _ent_extra:
                    _ABL_STATS['entity_kept_cells'] += _ent_extra
            if _narrowed:
                block_chunk_indices = _narrowed
        # 🎬 S3 段域接线（§24.12-I 步骤 1 / §24.15-B1 升级）：候选域 = 本块各 query「段域」的并集。
        #   `on`  → **替换**上面的窗口/收窄结果（不是取交集——"双保险"会让段域形同虚设，§24.12-H）；
        #           B1/B2/B3 优先用「动态门禁后段域池」（_SB_Q_DYNAMIC_POOL=段内∩空间硬卡∩动态门禁），
        #           空池 query 回退「内容 Top-K 优先域」（_SB_Q_DOMAIN）兜底，保证整块不因单句空池而空；
        #   `shadow` → 只算不用（域规模已在 per-query 阶段记入 _SB_STATS，此处不改候选域）。
        if _SB['mode'] == 'on' and block_queries:
            # 🎬 2026-09-20 方案C（A+B 组合）：候选域 = 「契约段内切片」优先，
            #   仅当本段切片不足以覆盖本块 query 数时，才并入视觉 Top-3 域并集兜底（防饿死）。
            #   根因（实测 8/72 未匹配）：原逻辑无条件用视觉 Top-3 并集**整体替换**整块候选，
            #   使同一批"视觉讨喜"切片被多个段块在 global_used_chunks 升序消费下跨块疯抢，
            #   后段 query 的 KM 命中切片提前被前块占走 → 非承接句无补配 → 未匹配。
            #   改「段内优先」后不同段的块候选互不重叠，根治跨块疯抢；段内不足才借近邻段兜底。
            #   `_seg_owned` 在段分区（on 档）下已于上方填入本契约段全部有效切片（chunk_blocks[block_idx]）。
            _seg_owned = block_chunk_indices
            if len(_seg_owned) < len(block_queries):
                _sb_domain = set()
                for _qi in block_queries:
                    _pool = _SB_Q_DYNAMIC_POOL.get(_qi) or ()
                    _base = _pool if _pool else _SB_Q_DOMAIN.get(_qi, ())
                    _sb_domain.update(_base)
                block_chunk_indices = _seg_owned | _sb_domain
                _SB_STATS['blocks_replaced'] += 1
        block_chunk_idx_list = sorted(block_chunk_indices)

        if not block_queries:
            dbg_block_gap_chunk += 1   # 有切片候选但无 query(多为尾部无词块)
            # 🎬 §24.15-B4：段内无 NEW_SHOT 时仍可推演本段 CONTINUE_PREV（段有切片即可，段=块）
            if _sb_partition_by_seg:
                _sb_run_continue_prev(block_idx)
            continue

        # 🛑 回退"候选不足降级全池"（2026-09-06）：降级全池会强制匹配语义不相关的切片，
        #    导致"4~9 段同镜头来回倒腾 + 喧闹教室配到户外"的回归。恢复"候选空 → 整块跳过"（错就错），
        #    候选非空但不足时继续求解（padding 补零），多余 query 保持未匹配。
        if not block_chunk_idx_list:
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
        #      local_cost 退化为大矩阵，是既有超时主因。匈牙利算法复杂度 O(min(q,c)³)，
        #      故仅当「短维也 >512」且候选占全量 90% 以上才拒绝；候选不足降级全池是「瘦长矩阵」
        #      （query 少、候选多，min=q 小），不触发此处，避免误伤兜底路径。
        # 🧪 消融①a 例外：R5 两条守卫的**目的**就是压制"±3 窗口退化为全片"的矩阵规模，
        #   故在 block_window=off（人为放开候选池）时对"切片维"放行——此时矩阵是
        #   query少×切片多的瘦长形，匈牙利复杂度 O(min(q,c)³)=O(q³) 仍然可控。
        #   query 维上限（1200）与"近全连接方阵"守卫照旧生效。
        if local_n_queries > 1200 or (local_n_chunks > 1200 and _ABL['block_window']):
            raise ValueError(
                f"[KM] R5 拒绝求解：本时序块规模过大（{local_n_queries} 段文案 × {local_n_chunks} 个候选切片，"
                "上限 1200）。请减小输入规模或精简切片粒度后重试")
        if min(local_n_queries, local_n_chunks) > 512 and local_n_chunks >= len(valid_chunk_indices) * 0.9 and _ABL['block_window']:
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

                # 🎬 批1 R2-1/R2-3：场景组等值命中（query.sceneGroup == chunk.sceneGroup）。
                #    命中的格子在下方豁免【候选白名单强惩罚】与【窗外 5.0 死刑】（降软罚通道），
                #    让"文案明确要教室 + 全片只有远处有教室"时能跨窗取到目标场景切片；
                #    豁免只作用于 sceneGroup 命中格，防"所有切片都能跨窗"破坏时序约束。
                _q_sg = query_scene_groups[qi] if qi < len(query_scene_groups) else ''
                scene_hit = bool(_q_sg) and ci_idx < len(chunk_scene_groups) and _q_sg == chunk_scene_groups[ci_idx]
                # 🎭 2026-09-16 §23.13：**实体道具命中格**——与 scene_hit 同级的"资格豁免"信号
                #   （文案点名了道具 ⇒ 该道具镜头即便在窗口外/白名单外也应保留候选资格）。
                _ent_hit = bool(_ent_prop is not None and _ent_prop[qi, ci_idx] > 0)
                # 🎬 S3 段域（§24.12-I 步骤 1 / §24.15-B1/B2/B3，仅 on 档）：**本切片是否落在本 query 的「段域」内**。
                #   B1/B2/B3 升级：优先以**动态门禁后段域池**（_SB_Q_DYNAMIC_POOL=段内∩空间硬卡∩动态门禁）为段域判定——
                #   query 有段域池时，非池内格 = 硬候选外（不再只是软罚），真正"候选=段内∩门禁链"；
                #   query 无段域池（空池）才回退内容 Top-3 优先域（_SB_Q_DOMAIN，老软罚语义兜底）。
                #   ⚠️ 块级并集只是预筛，这里必须单元格级判定，否则同块内 A 句能拿到 B 句段里的切片。
                _sb_hit = False
                _sb_gated = False
                if _SB['mode'] == 'on':
                    # 🎬 2026-09-20 方案C 阶段2：**段内全放行**——命中判定改用「本段全部有效切片」
                    #   （_SB_Q_SEGPOOL），不再叠加空间/动态硬门禁相加。
                    #   根因（实测 23→348 段外格暴增 + 6/86 仍饿死）：阶段1 锁段内后，cell 级仍要求命中
                    #   _SB_Q_DYNAMIC_POOL(=段内∩空间∩动态)，把"本段内但未过门禁"的切片当段外格硬门禁 5.0
                    #   杀掉 → 段内素材被滤空 → 该段 query 无候选饿死。段内素材应可直用，门禁只对其下
                    #   「借段」片段按需维持（由 L3643 分支以"本段是否有片"判别）。
                    _seg_slices = _SB_Q_SEGPOOL.get(qi) or ()
                    if _seg_slices:
                        _sb_hit = ci_idx in _seg_slices
                        _sb_gated = not _sb_hit
                        if _sb_hit:
                            _ABL_STATS['sb_in_seg_cells'] += 1
                        else:
                            _ABL_STATS['sb_out_seg_cells'] += 1
                    else:
                        # 本段无有效切片（异常/越界）→ 回退内容 Top-K 优先域兜底（不硬禁防整行无解）
                        _sb_dom = _SB_Q_DOMAIN.get(qi)
                        if _sb_dom is not None:
                            _sb_hit = ci_idx in _sb_dom
                            _sb_gated = not _sb_hit
                            if _sb_hit:
                                _ABL_STATS['sb_in_seg_cells'] += 1
                            else:
                                _ABL_STATS['sb_out_seg_cells'] += 1

                # 🔧 P2 #11 方案B：非候选格置强惩罚，让 KM 尽可能在候选内求解。
                #    用 5.0（远超 combined_score 的 [0,1] 量级）而非正无穷：
                #    若某个 query 候选全部落在本时序块之外，KM 仍能兜底选次优，不会触发 assign 无解。
                #    🧪 消融⑤（三态）：soft → 本格改走"常规综合分 + 0.15 软罚"（不 continue，
                #       让语义更强但被白名单剔除的候选有机会翻盘）；off → 完全不罚（纯拼综合分）。
                _wl_penalty = 0.0
                _win_soft = 0.0   # 🧪 裁决 B：窗外弱软罚（默认 hard 模式下恒 0）
                _sb_out_penalty = 0.0   # 🎬 段域外降级通道软罚（非 on 档或域内格恒 0）
                cand_set = candidate_sets[qi]
                if cand_set is not None and not scene_hit and not _ent_hit and not _sb_hit:
                    chunk_id = str(chunk.get("id") or "")
                    if chunk_id and chunk_id not in cand_set:
                        _ABL_STATS['whitelist_cells'] += 1
                        if _cand_wl == 'on':
                            local_cost[lqi, lci] = CAND_WL_PENALTY_HARD  # 强惩罚：绝不优先，但保留兜底可分配
                            continue
                        _wl_penalty = CAND_WL_PENALTY_SOFT if _cand_wl == 'soft' else 0.0

                # 🔬 Step1 Layer1：窗外强惩罚（决策 #1 硬边界）。与 candidateIds 同通道量级，
                #   保证 KM 绝不跨段落所属窗口去做全局退让，杜绝"跨幕次乱跳"。无有效窗口(qi 不在 _qw)不加。
                #   🎬 批1 R2-3：sceneGroup 命中格豁免 5.0 死刑 → 落入下方软罚通道（时序距离衰减，最高 −0.15）。
                #   🎭 2026-09-16 §23.13：**实体道具命中格同样豁免**——文案点名了道具（如「零钱」），
                #     该道具对应的镜头可以在剧情上离源时间较远（实测 `seg_6_sub_3`：正确镜头
                #     「机场通道·金色钱包/信封」在 8.3 分，而源起点 3.5 分 ⇒ 被窗口判 5.0 死刑，
                #     这才是"找错镜头"的真凶）。豁免后仍受时序软罚（±0.15）约束，不是无限制放开。
                # 🎬 B5：段分区时跳过窗口判定（P5：候选=段内，不与旧时间窗取交集）——
                #   段内切片即为合法候选，窗口死刑/豁免计数在段分区下均无意义。
                _wq = None if _sb_partition_by_seg else _qw.get(qi)
                if _wq is not None and not scene_hit and not _ent_hit and not _sb_hit:
                    _w0, _w1 = _wq
                    _cstart = float(chunk.get("startMs") or 0)
                    if not (_w0 <= _cstart <= _w1):
                        _ABL_STATS['win_penalty_cells'] += 1
                        if _ABL['query_window']:
                            if _window_mode == 'soft':
                                # 🧪 裁决 B（§23.13）：硬窗 → 弱软罚（不 continue，让"远但贴"的镜头
                                #   有机会靠语义翻盘；越远罚越多，60s 外封顶 0.15）
                                _win_soft = _window_soft_penalty(_w0, _w1, _cstart)
                                _ABL_STATS['win_soft_cells'] += 1
                            else:
                                local_cost[lqi, lci] = WINDOW_PENALTY
                                continue
                        # 🧪 消融①b：撤回段落窗口硬边界 → 窗外候选不作强惩罚，
                        #   继续走下方常规打分（语义+时长+情绪+加性层），由分数自然决定归属。
                elif _wq is not None and _ent_hit and not scene_hit \
                        and not (_wq[0] <= float(chunk.get("startMs") or 0) <= _wq[1]):
                    # 🎭 诊断计数：本格靠「道具命中」逃过窗口死刑（若无实体通道此处会置 5.0）
                    _ABL_STATS['entity_window_exempt'] += 1
                elif _wq is not None and _sb_hit and not scene_hit and not _ent_hit \
                        and not (_wq[0] <= float(chunk.get("startMs") or 0) <= _wq[1]):
                    # 🎬 诊断计数：本格靠「段域」逃过窗口死刑（若与窗口取交集此处会置 5.0）
                    _ABL_STATS['sb_exempt_cells'] += 1

                # 🎬 S3 段域**降级通道**（§24.12-I 步骤 1 / §24.15-B1/B2，仅 on 档）：段外格 = 本 query 段域之外的切片。
                #   这里必须做**单元格级**判断（块级并集只是预筛，否则同块内 A 句能拿到 B 句段里的切片）。
                #   ⚠️ 两种语义（B1/B2/B3 关键）：
                #   `有段域池`（_SB_Q_DYNAMIC_POOL 非空 = "候选=段内∩空间硬卡∩动态门禁"）→ 段外格是**硬门禁外**，
                #       置 WINDOW_PENALTY(5.0)（与候选白名单同通道）；KM 仍可在本行兜底选次优（非无穷大）。
                #   `无段域池`（回退内容 Top-K 优先域）→ 保持老软罚语义（域只覆盖 ~86% Top-10，非硬门禁，
                #       中等软罚 SB_OUT_DOMAIN_PENALTY），避免整行被禁导致无解。
                if _sb_gated:
                    # 🎬 2026-09-20 方案C 阶段2：借段片段（本段外的"段外格"）处理——
                    #   · 本段有片（_SB_Q_SEGPOOL 非空，但数量不足才借近邻段）→ 借片一律**软罚**（不 5.0）：
                    #     否则本段素材被门禁滤空后整行禁死又饿死（段外格 23→348 的教训）。段内全放行。
                    #   · 本段彻底无片（回退内容 Top-K 兜底）→ 维持硬门禁，防无界借走神（候选白名单同通道）。
                    _sb_dom_for_hard = False if _SB_Q_SEGPOOL.get(qi) else bool(_SB_Q_DYNAMIC_POOL.get(qi) or ())
                    if _sb_dom_for_hard:
                        # 硬门禁外（本段无片且区段外）：与候选白名单同通道强惩罚，立即跳过最终赋值
                        local_cost[lqi, lci] = WINDOW_PENALTY
                        _SB_STATS['out_domain_hard_cells'] += 1
                        continue
                    # 借段/兜底区 → 软罚通道（fallthrough 到最终赋值叠加中等软罚 SB_OUT_DOMAIN_PENALTY）
                    _sb_out_penalty = SB_OUT_DOMAIN_PENALTY
                    _SB_STATS['out_domain_soft_cells'] += 1

                # 🔧 决策 #5：排他前移——跨块已消耗的切片在矩阵构造时直接置强惩罚（与 WINDOW_PENALTY
                #   同通道量级），KM 求解期自动为该查询选次优，取代消费时静默丢弃；
                #   消费时检查保留作双保险（同块合并/变速重选路径会在矩阵求解之后继续修改 global_used_chunks）。
                # 🎬 空镜/意境镜头豁免排他：抒情/过渡段可跨块复用同一空镜，不置惩罚（叙事镜头仍严格排他）。
                #   🎬 P4：豁免受**硬额度**约束——额度用尽后按叙事镜头处理（走下方 5.0 排他惩罚）。
                if ci in global_used_chunks and not _is_reusable_broll(chunk):
                    _ABL_STATS['excl_cells'] += 1   # 🧪 计数不受开关影响：本格是"真排他"（非空镜复用）压制
                if ci in global_used_chunks and not _broll_still_available(ci, chunk):
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
                        _ABL_STATS['kw_boost_cells'] += 1   # 🧪 计数不受开关影响
                        if _ABL['kw_boost']:
                            sem_score = min(1.0, sem_score + kw_boost)

                    # 🎬 P3 景别精确匹配（2026-09-06）：query 画面意图要求景别 == 切片 shotType → 加分，
                    #    突破 CLIP 对景别词不敏感的天花板（抽象旁白分支不叠加，其语义已由景别分级抽象分取代）
                    _shot_boost = _structured_shot_type_match_boost(
                        getattr(q, 'visualIntent', '') or '',
                        chunk.get('shotType') or '',
                    )
                    if _shot_boost > 0:
                        _ABL_STATS['shot_boost_cells'] += 1   # 🧪 计数不受开关影响
                        if _ABL['shot_boost']:
                            sem_score = min(1.0, sem_score + _shot_boost)

                duration_penalty = _compute_duration_score(audio_dur_ms, video_dur_ms)

                # 🎭 P0 意境维度：文案情绪与切片情绪相容度
                emotion_score = float(emotion_sim[qi, ci_idx])

                # 🎭 P1 角色契合度：解说期望角色与切片出现角色的命中率（软加成）
                role_score = float(role_sim[qi, ci_idx])

                # 🔬 Step3 Layer3：时序软罚 + 情绪路由加权 入矩阵（决策 #2/#3 冻结值）。
                #   - 时序软罚基准：Δ = chunk.startMs − query.source startMs
                #     （反时 −0.12 / 顺承 +0.04 / 大跨距线性衰减封顶 −0.15），flashback/montage 段语义豁免；
                #   - 情绪路由加权：query 带非中性情绪时，空镜 +0.03 / 主角特写 +0.02；
                #   - 🎬 批1 §4.1 维度A：场景组等值命中 +0.08（软加成，绝不否决语义主分）；
                #   均为加性微调，绝不压过 0.68 语义主依据（断层 B 软罚原则）。
                _delta = float(chunk.get("startMs") or 0) - float(getattr(q, 'startMs', 0) or 0)
                _adjust = 0.0 if _is_temporal_exempt(q) else _temporal_penalty(_delta)
                if not getattr(q, 'isAbstractNarration', False):
                    # 🎬 决策 #6：抽象旁白跳过情绪路由加权——情绪已由 emotion_score 计入综合分，再路由即双计
                    _adjust += _shot_routing_boost(
                        chunk.get('shotType'), _char_ids_of_chunk(chunk),
                        _char_ids_of_query(q),
                        getattr(q, 'emotion', None) or '',
                    )
                    # 🎬 P1 运镜匹配加成：query 画面意图要求某运镜时，切片运镜命中 +0.03（轻量结构化加分）
                    _adjust += _camera_movement_match_boost(
                        getattr(q, 'visualIntent', '') or '',
                        chunk.get('cameraMovement') or '',
                    )
                # 🎬 地点一致性加成（2026-09-16）：统一走 _scene_boost_for_query_chunk——
                #   组等值命中(+0.08) 与 地点核心词文本交集(+0.10) **取大不求和**（同一信号，防双计）。
                #   文本交集分支兜底组表未覆盖场景（实测"飞机客舱"曾落空组 → 空间约束失效）。
                _adjust += _scene_boost_for_query_chunk(q, chunk)
                # 🎬 加性层总额上限（2026-09-16）：夹逼后视听属性只做"破平局扰动"，
                #   不夺语义主分主导权（依据见 ADJUST_CAP 常量注释）。
                _adjust = max(-ADJUST_CAP, min(ADJUST_CAP, _adjust))
                # 🧪 消融⑥ ADDITIVE=off：关闭整层加性微调（时序软罚/场景加成/情绪路由/运镜），
                #   用于判定"纯语义 + 时长/情绪/角色权重"能否单独撑起排序（剂量见 §23.8）。
                if not _ABL['additive']:
                    _adjust = 0.0
                combined_score = _compute_combined_score(sem_score, duration_penalty, emotion_score, role_score, weights=req.weights) + _adjust
                # 🧪 后两项仅消融/裁决开关非零；末项为段域外降级软罚（仅 on 档的段外格非零）
                local_cost[lqi, lci] = -combined_score + _wl_penalty + _win_soft + _sb_out_penalty

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
        # 🎬 B 立项：按脚本顺序（行序升序）消费——保证承接补配的"前序锚"=时间轴上紧邻的上一个叙述段；
        #   scipy 行序本就升序，显式排序为稳定契约（承接补配依赖它做正确锚定）。
        for ri, ci in sorted(zip(row_ind, col_ind), key=lambda p: p[0]):
            qi = block_queries[ri]
            if ci >= local_n_chunks:
                # 🎬 B 立项：padding 行（本块 query 多于切片，query 无实体分配）→ 尝试同源承接补配
                if _backfill_continuation_for(qi):
                    _seg_local_idx += 1
                continue
            ci_idx = block_chunk_idx_list[ci]
            real_ci = valid_chunk_indices[ci_idx]

            if real_ci in global_used_chunks:
                _ABL_STATS['excl_skips'] += 1   # 🧪 计数不受开关影响：本段分配到的切片已被跨块消费
            if real_ci in global_used_chunks and not _broll_still_available(real_ci, video_chunks[real_ci]):
                # 🎬 B 立项：命中跨块已用切片（该 query 在本块可分配候选已耗尽）→ 尝试同源承接补配
                if _backfill_continuation_for(qi):
                    _seg_local_idx += 1
                continue
            global_used_chunks.add(real_ci)
            # 🎬 P4 空镜额度扣减：本切片被消费即计数 +1；额度用尽后 `_broll_still_available` 自动转 False，
            #   从而对该切片恢复排他语义（叙事镜头恒走排他，不计数）。
            #   🧪 消融③（exclusive=off）：全部切片都纳入额度计数，额度用尽后同样恢复排他。
            if _is_reusable_broll(video_chunks[real_ci]) or _excl != 'on':
                broll_usage_count[real_ci] = broll_usage_count.get(real_ci, 0) + 1

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
            # 语音与素材时长不匹配（超出 0.97~1.03 变速能力，剪辑师 ±3% 准则）时，
            # 从当前时序块候选池中重选一个"语义0.6+时长0.4联合分"最高的未使用切片，
            # 以当前切片联合分为保底基准，只有候选联合分超过当前切片才重选，
            # 避免为了时长丢弃语义更贴合的切片（纯时长贴近会牺牲画面内容）。
            # 🧪 消融④：speed_cap=off 时跳过"变速超限重选"——保留当前（语义最优但时长不合）切片，
            #   配合下方 clamp 一并放开，按自然变速比播放。触发计数与开关无关，用于量化绑定度。
            _speed_over = raw_speed_factor < 0.97
            if _speed_over:
                _ABL_STATS['speed_over'] += 1
            if _speed_over and _ABL['speed_cap']:
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
                # 🎬 批1：变速重选基准同样计入场景加成（防"场景命中切片因时长偏短被换成场景外镜头"）
                cur_combined = _compute_combined_score(cur_sem, cur_dur, cur_emotion, cur_role, weights=req.weights) \
                    + _scene_boost_for_query_chunk(query, cur_chunk)
                best_ci = real_ci
                best_combined = cur_combined

                # 🔧 P2（2026-08-22）：素材偏短（放慢方向）时，优先尝试拼接同父连续 seg 补时长，
                # 从根源规避变速超限，而非直接换成语义无关的"时长完美"镜头
                merged = None
                if raw_speed_factor < 0.97:
                    merged = _try_merge_contiguous_segs(real_ci, video_chunks, global_used_chunks, final_video_duration_ms)
                if merged is not None:
                    _ABL_STATS['speed_merge'] += 1   # 🧪 记录"靠拼接级联化解变速超限"的段数
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
                    combined_score = _compute_combined_score(best_sem, best_dur_pen, best_emotion, best_role, weights=req.weights) \
                        + _scene_boost_for_query_chunk(query, chunk)
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
                        cand_combined = _compute_combined_score(cand_sem, cand_dur_score, cand_emotion, cand_role, weights=req.weights) \
                            + _scene_boost_for_query_chunk(query, cand_chunk)
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
                        combined_score = _compute_combined_score(best_sem, best_dur_pen, best_emotion, best_role, weights=req.weights) \
                            + _scene_boost_for_query_chunk(query, chunk)

            # 🎯 方向2（2026-08-30）：跨 query 时间单调约束（纵深防御）
            # 8/29 事故复现：跨项目缓存命中后"文案时间递增但切片时间倒走"（旧切片池时间轴错乱）。
            # 方向1 已从缓存键隔离根因；此处再加一道硬约束：主匹配/变速重选定稿后，
            # 若当前切片 startMs 明显早于上一段已匹配切片的 endMs（时间倒走），
            # 从当前 block 候选池重选一个"时间单调（startMs ≥ 上一 endMs）且语义不劣化"的切片，
            # 杜绝文案时间推进而画面时间回退的错乱观感。
            cur_start_ms = float(chunk.get("startMs") or 0)
            cur_end_ms = float(chunk.get("endMs") or cur_start_ms)
            # 🧪 消融②：monotonic=off 时不做"时间倒走重选"，允许画面时间相对文案回退（不做任何替换）。
            #   触发计数与开关无关（关掉后仍计数），用于量化该约束的绑定度。
            _mono_trigger = (last_chunk_end_ms is not None
                             and cur_start_ms < last_chunk_end_ms - MONOTONIC_TOLERANCE_MS)
            # 🎯 方向2b 硬回跳判定：无 flashback 且比上一确定镜头退回过久（>5s）→ 一票否决档。
            #   该档下单调重选结果不受 0.95 退化门槛约束，只要池内有语义达标的单调候选即强制换入。
            _is_flashback = bool(getattr(query, 'isFlashback', False))
            _hard_regress = (_mono_trigger and not _is_flashback
                             and last_chunk_end_ms - cur_start_ms > MONOTONIC_HARD_REJECT_MS)
            if _mono_trigger:
                _ABL_STATS['mono_events'] += 1
                if _hard_regress:
                    _ABL_STATS['mono_hard'] += 1
            if _mono_trigger and _ABL['monotonic']:
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
                    # ✅ 2026-09-20 方案B修复：换镜重选**绕过白名单**。
                    #   根因（诊断确认）：B类段白名单拒=最大单一瓶颈——candidateIds（Node 侧 Top-K 语义预选）
                    #   与时段域候选池天然错位，"时间单调+语义达标"的本段切片往往不在 Top-K 白名单内，
                    #   于是被 cand_set 一票排除 → 换镜失败只能保留回跳切片。
                    #   白名单语义本意是"主 KM 别选弱素材"，而此处候选已在段分区块池（block_chunk_idx_list）
                    #   内 + 语义≥0.55（下方 cand_sem 门槛把关），只差时间正确性问题——故重选环节不再查白名单，
                    #   改由语义门槛统一把关，杜绝"时间正确却因预选清单不重合而换不过去"的失配。
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
                    cand_combined = _compute_combined_score(cand_sem, cand_dur_score, cand_emotion, cand_role, weights=req.weights) \
                        + _scene_boost_for_query_chunk(query, cand_chunk)
                    if cand_combined > mono_best_combined:
                        mono_best_combined = cand_combined
                        mono_best_ci = cand_ci
                # 🧪 诊断（2026-09-20）：硬回跳换镜失败（mono_best_ci is None）时，导致"池内单调候选空缺"的
                #   根因通常是候选池时间构成问题，而非语义/白名单。此处对该样式唯一失败分支做五类归因统计：
                #   ① 池内总候选数（时间窗内全部切片）
                #   ② 时间单调过门数（startMs ≥ 上一镜头 endMs - 容差）
                #   ③ 单调内被 global_used_chunks 占用的切片数
                #   ④ 单调内被"白名单外"拒绝的切片数（cand_set 有值但切片不在其内）
                #   ⑤ 单调内被"语义<0.55"拒绝的切片数（含 dur<=0 归为语义拒）
                #   据此三分："纯时间就差在锚点之前"（②≈0 即 A 类）；"时间够但白名单误判"（④大）；
                #   "时间够但语义门槛过严"（⑤大）。④⑤分开才可定修复方向。
                #   仅硬回跳档打印，避免普通微倒走刷屏；其余路径不加日志。
                if _hard_regress and mono_best_ci is None:
                    _diag_total = len(block_chunk_idx_list)
                    _diag_mono = 0
                    _diag_used = 0
                    _diag_wl = 0
                    _diag_sem = 0
                    for cand_idx in block_chunk_idx_list:
                        cand_ci = valid_chunk_indices[cand_idx]
                        cand_chunk = video_chunks[cand_ci]
                        cand_start = float(cand_chunk.get("startMs") or 0)
                        # 时间单调过门：与重选循环同口径（L4020）
                        if cand_start < last_chunk_end_ms - MONOTONIC_TOLERANCE_MS:
                            continue
                        _diag_mono += 1
                        if cand_ci in global_used_chunks:
                            _diag_used += 1
                            continue
                        cand_dur = cand_chunk.get("durationMs", 0)
                        if cand_dur <= 0:
                            _diag_sem += 1
                            continue
                        cand_set = candidate_sets[qi]
                        if cand_set is not None:
                            cand_id_str = str(cand_chunk.get("id") or "")
                            if cand_id_str and cand_id_str not in cand_set:
                                _diag_wl += 1
                                continue
                        cand_sem = max(0.0, min(1.0, (float(semantic_sim[qi, chunk_rank[cand_ci]]) + 1.0) / 2.0))
                        if cand_sem < 0.55:
                            _diag_sem += 1
                    print(f"[KM] shotId={query.shotId} 硬回跳换镜失败诊断：池候选={_diag_total} 时间单调过门={_diag_mono}"
                          f" 单调内已占用={_diag_used} 白名单拒={_diag_wl} 语义拒={_diag_sem}", file=sys.stderr)

                # 🛡 2026-09-20 A类修复：近邻后段单调候选兜底（独立兜底块，方案B-2）。
                #   根因（诊断确认）：段分区（on档）下块=段，last_chunk_end_ms 是跨段全局单调锚、取历史最大值不重置；
                #   一旦前段某定镜 endMs 被长切片推高过本段所有切片 startMs，本段池内物理不存在
                #   startMs≥锚点-容差的候选 → 保值循环过门=0 → 换镜失败（A类"时间单调过门=0"签名）。
                #   兜底策略：仅当"硬回跳档且本段重选仍无结果（mono_best_ci is None）"这一种罕见情况下，
                #   从时间上更靠后的近邻段（紧邻优先，最多 _mono_slop_max_segs 段）里挑一个
                #   "语义达标(≥0.55) + 时间单调(startMs≥锚点-容差)" 的切片顶上，杜绝候选都在锚点之前的空隙。
                #   不关闭段分区、不改变主 KM 求解——只是硬回跳失败时的补充候选来源（借用的切片会被占用）。
                if _hard_regress and mono_best_ci is None:
                    _mono_slop_max_segs = 3            # 最多向后看 3 个近邻段，紧邻优先，避免语义跨度过大
                    _mono_slop_best_ci = None
                    _mono_slop_best_combined = -1.0
                    for _slop_k in range(1, _mono_slop_max_segs + 1):
                        _slop_block = block_idx + _slop_k
                        if _slop_block not in chunk_blocks:
                            continue
                        for _slop_ci_idx in chunk_blocks[_slop_block]:
                            _scand_ci = valid_chunk_indices[_slop_ci_idx]
                            if _scand_ci in global_used_chunks:
                                continue
                            _scand_chunk = video_chunks[_scand_ci]
                            _scand_start = float(_scand_chunk.get("startMs") or 0)
                            # 时间单调：与重选循环同口径（L4020）
                            if _scand_start < last_chunk_end_ms - MONOTONIC_TOLERANCE_MS:
                                continue
                            _scand_dur = _scand_chunk.get("durationMs", 0)
                            if _scand_dur <= 0:
                                continue
                            _scand_sem = max(0.0, min(1.0, (float(semantic_sim[qi, chunk_rank[_scand_ci]]) + 1.0) / 2.0))
                            _scand_kw = _keyword_match_boost(
                                query_text=getattr(query, 'text', '') or '',
                                query_emotion=getattr(query, 'emotion', '') or '',
                                query_visual=getattr(query, 'visualIntent', '') or '',
                                chunk_desc=_scand_chunk.get('description') or '',
                                chunk_emotion=_scand_chunk.get('emotion') or '',
                                chunk_shot_type=_scand_chunk.get('shotType') or '',
                                chunk_characters=_scand_chunk.get('characters'),
                                chunk_keywords=_scand_chunk.get('keywords'),
                            )
                            if _scand_kw > 0:
                                _scand_sem = min(1.0, _scand_sem + _scand_kw)
                            # 语义保护门槛：兜底同样须语义达标，避免为了时间顺序牺牲内容正确性
                            if _scand_sem < 0.55:
                                continue
                            _scand_dur_score = _compute_duration_score(audio_dur_ms, _scand_dur)
                            _scand_emotion = float(emotion_sim[qi, chunk_rank[_scand_ci]])
                            _scand_role = float(role_sim[qi, chunk_rank[_scand_ci]])
                            _scand_combined = _compute_combined_score(_scand_sem, _scand_dur_score, _scand_emotion, _scand_role, weights=req.weights) \
                                + _scene_boost_for_query_chunk(query, _scand_chunk)
                            if _scand_combined > _mono_slop_best_combined:
                                _mono_slop_best_combined = _scand_combined
                                _mono_slop_best_ci = _scand_ci
                        # 紧邻段已命中单调候选即停（紧邻优先）；本段一个合格候选都没有才继续看更后一段
                        if _mono_slop_best_ci is not None:
                            break
                    if _mono_slop_best_ci is not None:
                        mono_best_ci = _mono_slop_best_ci
                        mono_best_combined = _mono_slop_best_combined
                        _ABL_STATS['mono_slop_used'] += 1
                        print(f"[KM] shotId={query.shotId} A类近邻后段兜底：本段过门=0，"
                              f"改用近邻段单调切片 {mono_best_ci}", file=sys.stderr)

                # 换入门槛：硬回跳（无 flashback、退回过 >5s）时只要池内存在语义达标的单调候选即
                # 无条件强制换入（不再受 0.95 退化门槛约束）；普通微倒走仍要求综合分不劣化（≥ 当前 95%），
                # 避免为轻微回跳强行换出更贴合内容的切片。
                if mono_best_ci is not None and (mono_best_combined >= base_combined * 0.95 or _hard_regress):
                    _ABL_STATS['mono_switched'] += 1
                    global_used_chunks.add(mono_best_ci)
                    chunk = video_chunks[mono_best_ci]
                    video_dur_ms = chunk.get("durationMs", 0)
                    combined_score = mono_best_combined
                    print(f"[KM] shotId={query.shotId} 时间倒走（切片 {cur_start_ms}ms 早于上一镜头 {last_chunk_end_ms}ms）{'（硬回跳一票否决）' if _hard_regress else ''}重选时间单调切片 {mono_best_ci}", file=sys.stderr)

            speed_factor = 1.0
            if final_video_duration_ms > 0 and video_dur_ms > 0:
                speed_factor = video_dur_ms / final_video_duration_ms
                # 变速区间收紧到 0.97~1.03（专业剪辑师 ±3% 近无感），彻底消除相邻镜头速度跳变与加速破坏动作真实感
                # 🧪 消融④：speed_cap=off 时不夹逼，按自然变速比播放（用于量化"±3% 准则"的价格）
                if _ABL['speed_cap']:
                    speed_factor = max(0.97, min(1.03, speed_factor))

            # 🎬 阶段2 2.4 匹配诊断：Q(段落) 命中切片，肉眼核对 VI↔desc 是否名副其实（防分高但画面不贴）。
            #    字段：RawSem=combined（2.3 启用后为归一后综合分）、Gate=该 query 是否被 2.3 温和归一拉伸(1/0)、
            #          Smax=该 query 候选池原始最大相似度（审计基准）、has_desc(0/1)、VI/ChunkDesc 截断样本
            #    🎬 批1 新增：Scene组 = query场景组↔切片场景组（空=中性）、Mood = query moodIntent（为空回退 q.emotion）
            try:
                _vi = str(getattr(query, 'visualIntent', '') or '')[:20]
                _desc = str(chunk.get('description') or '')[:24]
                _has_desc = 1 if str(chunk.get('description') or '').strip() else 0
                _smax = float(np.max(raw_semantic_sim[qi])) if raw_semantic_sim is not None else float('nan')
                # 归一化机制已删除（BGE 原始余弦即语义主分），Gate 恒 0，仅保留字段以兼容既有日志解析
                _gate = 0
                _q_sg = query_scene_groups[qi] if qi < len(query_scene_groups) else ''
                _c_sg = chunk_scene_groups[chunk_rank[real_ci]] if real_ci in chunk_rank and chunk_rank[real_ci] < len(chunk_scene_groups) else ''
                _mood = (getattr(query, 'moodIntent', '') or '').strip() or (query.emotion or '')
                print(f"[MATCH_DIAG] Q:{query.shotId} | RawSem:{float(combined_score):.2f} | Gate:{_gate} | Smax:{_smax:.2f} | has_desc:{_has_desc} | "
                      f"Scene组:\"{_q_sg}\"↔\"{_c_sg}\" | Mood:\"{_mood}\" | VI:\"{_vi}\" <-> ChunkDesc:\"{_desc}\"", file=sys.stderr)
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
                "appliedSpeedFactor": round(speed_factor, 3),
                # 🔧 E域（§10.2.6 动作2）：solver 明确原速（==1.0）即纯子窗裁剪段，禁拉伸
                "isExactSpeed": round(speed_factor, 3) == 1.0,
                # 🛑 回退降级兜底后无降级段，degraded 恒 False（保留字段供前端兼容）
                "degraded": False
            })

            current_timeline_ms = target_end_time_ms

            # 🎯 方向2：推进全局单调锚点（取当前切片 endMs 与历史锚点的最大值，防止时间轴回退）
            cur_end_ms = float(chunk.get("endMs") or float(chunk.get("startMs") or 0))
            if last_chunk_end_ms is None or cur_end_ms > last_chunk_end_ms:
                last_chunk_end_ms = cur_end_ms
            # 🎬 B 立项：记录前序锚（最近一个已产出的相邻叙述段），供后续同源承接补配定位紧邻前段
            _km_prev_anchor = {'query': query, 'chunk': chunk, 'result': results[-1]}
            # 🎬 §24.15-B4：段内锚（on 档段分区后块=段）——本段 CONTINUE_PREV 顺延定位"上一张已定镜"用
            if _sb_partition_by_seg:
                _sb_seg_anchor[block_idx] = _km_prev_anchor

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
        # 🎬 §24.15-B4：段内 KM 全部 NEW_SHOT 分配完后，按 query 顺序推演本段 CONTINUE_PREV——
        #   延续句只取**剩余未用**切片（不抢实指句的镜头，§24.12-D/2767）
        if _sb_partition_by_seg:
            _sb_run_continue_prev(block_idx)
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

    # 🧪 P1 约束消融·约束绑定度画像（一次运行即得，**计数与开关状态无关**）：
    #   读数判据——某条约束的"压制格数/触发段数"若接近 0，则消融它必然零收益（可零成本排除）；
    #   若量级很大，才值得做端到端消融复测（省掉无谓的"改开关→跑步骤5"回合）。
    _abl_shot_ids = {str(r.get('shotId') or '') for r in results}
    # 🧪 逐段诊断"未被 KM 分配"的段（2026-09-21 新增）：外层无块内归因，故打印可观测维度——
    #   shotId / audioDurationMs(0=无独立语音YL的结转段) / 文本首4字 / 段始startMs，
    #   用于揪出"哪些叙述句整段没画面"。命中结果集合 _abl_shot_ids 均已含 _sub 子段（拆段映射用父 id 无法命中时会误报，下方留意跳过 _sub）。
    _abl_unmatched = 0
    for _q in req.queries:
        _qid = str(_q.shotId or '')
        if _qid in _abl_shot_ids:
            continue
        # 子段（*_sub_1/_sub_2）属拆段映射，父 id 本就不在结果集，不计入未分配（避免把拆段误报成空缺）
        if '_sub_' in _qid:
            continue
        _abl_unmatched += 1
        _q_text = (str(getattr(_q, 'text', '') or '') or '').replace('\n', ' ').strip()[:4]
        print(f"[KM] 🧪 未被KM分配段诊断: shotId={_qid} | audioDurMs={getattr(_q,'audioDurationMs',0)} "
              f"| startMs={getattr(_q,'startMs',0)} | 文本前4字=\"{_q_text}\"", file=sys.stderr)
    print(f"[KM] 🧪 约束绑定度画像：①b窗外压制格={_ABL_STATS['win_penalty_cells']} "
          f"（档位={_window_mode}，其中 {_ABL_STATS['win_soft_cells']} 格改走弱软罚）"
          f"｜白名单外压制格={_ABL_STATS['whitelist_cells']}（档位={_cand_wl}）"
          f"｜③排他压制格={_ABL_STATS['excl_cells']}（档位={_excl}，消费期命中已用切片={_ABL_STATS['excl_skips']} 段）"
          f"｜②时间倒走={_ABL_STATS['mono_events']} 段（换镜成功={_ABL_STATS['mono_switched']}，其中硬回跳一票否决={_ABL_STATS['mono_hard']}）"
          f"｜④变速超限={_ABL_STATS['speed_over']} 段（拼接化解={_ABL_STATS['speed_merge']}）"
          f"｜boost命中格：关键词={_ABL_STATS['kw_boost_cells']} 景别={_ABL_STATS['shot_boost_cells']}"
          f"｜🎭实体窗口豁免格={_ABL_STATS['entity_window_exempt']}"
          f"（另有 {_ABL_STATS['entity_kept_cells']} 格免于窗口收窄）"
          f"｜未被 KM 分配={_abl_unmatched}/{n_queries} 段",
          file=sys.stderr)

    # 🎬 S3 段域诊断（§24.12-I 步骤 1 的验收仪器，**视觉 Top-3 选段版**）：
    #   ① 优先域规模：每 query 优先域段数（目标 3）与切片数 min/中位/max；
    #   ② 单元格分布：段内格 / 段外格，以及**被降级通道接住的段外格数**（验证"段外不再 5.0 死刑"）；
    #   ③ 低纯度段占比：优先域内 locPurity<SB_LOW_PURITY 的段数/占比（为后续放开空间硬卡预留，本步不实施）；
    #   ④ shadow 对照（仅 shadow 档，见下）：线上命中是否落在"源时间所属段"（旧仪器的反证数据）。
    if _SB['mode'] != 'off':
        _scnt = sorted(_SB_STATS.get('top_seg_counts') or [])
        _dsz = sorted(_SB_STATS.get('dom_size') or [])
        _scnt_txt = f"{_scnt[0]}/{_scnt[len(_scnt) // 2]}/{_scnt[-1]}" if _scnt else "—"
        _dsz_txt = f"{_dsz[0]}/{_dsz[len(_dsz) // 2]}/{_dsz[-1]}" if _dsz else "—"
        _dom_segs = set()
        for _tops in _SB_Q_TOPSEGS.values():
            _dom_segs.update(_sid for _sc, _sid, _n in _tops)
        _pur = _SB.get('seg_locpurity') or {}
        _low = sum(1 for _sid in _dom_segs if float(_pur.get(_sid, 1.0)) < SB_LOW_PURITY)
        _low_txt = (f"{_low}/{len(_dom_segs)}（{100.0 * _low / len(_dom_segs):.0f}%）"
                    if _dom_segs else "—")
        print(f"[SB] 🎬 段域(视觉Top-{SB_TOP_SEGMENTS}选段)：档位={_SB['mode']}"
              f"｜每query优先域段数(min/中位/max)={_scnt_txt}（目标 {SB_TOP_SEGMENTS}）"
              f"｜优先域切片数(min/中位/max)={_dsz_txt}"
              f"｜替换候选域的块={_SB_STATS['blocks_replaced']}"
              f"｜段内格={_ABL_STATS['sb_in_seg_cells']}"
              f"（靠段域逃过窗口死刑={_ABL_STATS['sb_exempt_cells']}）"
              f"｜段外格={_ABL_STATS['sb_out_seg_cells']}"
              f"（降级通道接住={_SB_STATS['out_domain_soft_cells']}）"
              f"｜优先域内低纯度段(locPurity<{SB_LOW_PURITY})={_low_txt}", file=sys.stderr)
        if _SB['mode'] == 'shadow':
            _q_ms_by_id = {str(_q.shotId): float(_q.startMs or 0) for _q in req.queries}
            _hit = _miss = _nod = 0
            _samples = []
            for _r in results:
                _sid_q = storyboard_seg_of_ms(_SB, _q_ms_by_id.get(str(_r.get('shotId')), -1.0))
                _ch = _r.get('chunkData') or {}
                _sid_c = storyboard_seg_of_parent(_SB, str(_ch.get('parentChunkId')
                                                          or _ch.get('id') or ''))
                if not _sid_q or not _sid_c:
                    _nod += 1
                elif _sid_q == _sid_c:
                    _hit += 1
                else:
                    _miss += 1
                    if len(_samples) < 5:
                        _samples.append(f"{_r.get('shotId')}:{_sid_q}≠{_sid_c}")
            print(f"[SB] 🎬 shadow 对照：**线上命中落段 = {_hit}/{_hit + _miss}**"
                  f"（段外 {_miss}｜无段可比 {_nod}）｜段外样例={'/'.join(_samples) or '无'}",
                  file=sys.stderr)

    # 🌐 P0-3 诊断：空间类型冲突惩罚命中数 + 样例（供人工复核是否误伤）
    if _SPACE_CONFLICT_STATS['pairs'] > 0:
        print(f"[KM] 🌐 空间冲突惩罚：{_SPACE_CONFLICT_STATS['pairs']} 对候选被压"
              f"（penalty={SPACE_CONFLICT_PENALTY}），样例={'/'.join(_SPACE_CONFLICT_STATS['samples'])}",
              file=sys.stderr)
    else:
        print("[KM] 🌐 空间冲突惩罚：0 对（本批无「两侧可判定且互斥」的候选）", file=sys.stderr)

    # 🎬 P4 空镜消费（**主循环口径**，仅用于区分"KM 没选空镜" vs "重选路径补进来的"）：
    #   真正的验收口径在函数末尾按**最终成片**统计（旧实现只有这一处，会误报"零消费"）。
    if broll_usage_count:
        _reused = {ci: n for ci, n in broll_usage_count.items() if n > 1}
        _max_use = max(broll_usage_count.values())
        print(f"[KM] 空镜消费（主循环口径）：{len(broll_usage_count)} 个空镜被消费，"
              f"其中复用过的 {len(_reused)} 个，最大复用次数={_max_use}（额度上限={BROLL_MAX_REUSE}）",
              file=sys.stderr)
    else:
        print(f"[KM] 空镜消费（主循环口径）：0 个（KM 主循环未选空镜，成片中的空镜来自重选/承接路径）",
              file=sys.stderr)

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

    # 🎬 P4 空镜复用验收（2026-09-16 **成片口径**，修仪器）：在最终 results 上统计，
    #   覆盖循环后的「时间单调重选 / 变速重选 / 承接补配 / 衔接重排」路径。
    #   验收标准：使用次数最大复用 ≤ BROLL_MAX_REUSE。
    _final_use = _broll_usage_from_results(results, video_chunks)
    if _final_use:
        _reused_final = {k: v for k, v in _final_use.items() if v > 1}
        print(f"[KM] 空镜复用统计（成片口径）：使用空镜 {len(_final_use)} 个，"
              f"其中复用 {len(_reused_final)} 个，最大复用次数={max(_final_use.values())}"
              f"（额度上限={BROLL_MAX_REUSE}）"
              + (f"；复用明细={_reused_final}" if _reused_final else ""), file=sys.stderr)
    else:
        print("[KM] 空镜复用统计（成片口径）：0 个空镜被使用", file=sys.stderr)

    # 🔧 KM 真实进度：全部结束（Node 轮询在 KM resolve 后置 80 收尾）
    _report_km_progress(req.taskId, 1.0, "全局最优组合求解完成")

    # 🎬 §24.15-B6 shadow 双轨对照（P7：只计算不采用，主结果仍为 above 旧路径结果）。
    #   同一次 run 在段粒度上对比「派工管线候选（_SB_Q_DYNAMIC_POOL=段内∩空间硬卡∩动态门禁）」
    #     与「旧路径主结果实际命中的切片」，输出 段级命中 / 可满足率 / 降级率 / 跨段跳戏 / 复用 对照。
    #   ⚠️ off 档完全跳过（P6 零行为变化）；on 档主结果即派工结果，不该再对照旧路径。
    if _SB['mode'] == 'shadow':
        _sb_shot_to_qi = {getattr(_q, 'shotId', ''): _qi for _qi, _q in enumerate(req.queries)}
        _seg_hit = 0
        _cross_seg = 0
        _scanned = 0
        for _r in results:
            _qi = _sb_shot_to_qi.get(_r.get('shotId', ''))
            if _qi is None:
                continue
            _q = req.queries[_qi]
            _contr_seg = _seg_key(_contract_segment_id(_q, _SB_Q_TOPSEGS.get(_qi) or ()))
            _ch = _r.get('chunkData') or {}
            _sid_r = storyboard_seg_of_parent(_SB, str(_ch.get('parentChunkId') or '') or str(_ch.get('id') or ''))
            _scanned += 1
            if _contr_seg and _sid_r == _contr_seg:
                _seg_hit += 1
            elif _contr_seg:
                _cross_seg += 1
        _q_total = _SB_STATS.get('q_total', 0) or 1
        _cmp = {
            'mode': 'shadow',
            'q_total': _SB_STATS.get('q_total', 0),
            'q_with_seg_pool': _SB_STATS.get('q_with_seg_pool', 0),
            'q_with_spatial_pool': _SB_STATS.get('q_with_spatial_pool', 0),
            'q_with_dyn_pool': _SB_STATS.get('q_with_dyn_pool', 0),
            'satisfiable_rate': round(_SB_STATS.get('q_with_dyn_pool', 0) / _q_total, 4),
            'fallback_dist': {k: _SB_STATS.get('fallback_' + str(lvl), 0) for lvl, k in
                              [(0, 'l0'), (1, 'l1'), (2, 'l2'), (3, 'l3'), (4, 'l4'), (5, 'l5')]},
            'scanned_results': _scanned,
            'legacy_seg_hit': _seg_hit,
            'cross_seg_jumps': _cross_seg,
            'legacy_seg_hit_rate': round(_seg_hit / _scanned, 4) if _scanned else 0.0,
        }
        _SB_STATS['shadow_compare'] = _cmp
        print(f"[SB-SHADOW] 双轨对照（旧路径 vs 派工池）：可满足率={_cmp['satisfiable_rate']} "
              f"降级分布={_cmp['fallback_dist']} 主结果扫描={_scanned} "
              f"段级命中={_seg_hit}（{_cmp['legacy_seg_hit_rate']}）跨段跳戏={_cross_seg}", file=sys.stderr)

    return {"success": True, "results": results, "videoChunks": video_chunks}


# ===========================================================================
# #8 新引擎接入（montage_router 接通真实 KMMatchReq）
#   legacy_run = 旧 KM（_kuhn_munkres_match_sync，含 finally 释放句柄/模型）
#   new_run    = 新引擎整条管道（validate→build_context→build_match_cost→beam_search.solve）
#   档位复用具义 `ZENTECT_KM_STORYBOARD_MODE`（on 生效 / shadow 对账 / off 回退）。
#   函数内延迟 import：match_cost 顶部 `from timeline_solver import ...` 与 timeline_solver
#   双向往来，须在模块完全初始化后再 import 新引擎，杜绝循环初始化。
# ===========================================================================

def _kmmatch_to_segment_request(req) -> dict:
    """将 KMMatchReq（pydantic）转成 SegmentRequest 输入契约字典（#8 接入适配）。

    KMMatchReq 不带 videoChunks（为空时旧 KM 走素材池缓存兜底），此处与旧 KM 同口径
    补缓存，保证新引擎吃到真实切片——否则空池→全句空候选→束搜索全跳过，shadow 无对账价值。
    """
    payload = req.model_dump() if hasattr(req, 'model_dump') else dict(req)
    chunks = payload.get('videoChunks') or []
    if not chunks:
        pool_key = (
            f"{payload.get('projectId') or ''}:{payload.get('mediaId') or ''}"
            if payload.get('projectId')
            else (payload.get('mediaId') or 'default')
        )
        pool_val = PROJECT_MATERIAL_POOL.get(pool_key)
        if pool_val is not None:
            if isinstance(pool_val, dict) and 'matchSegments' in pool_val:
                chunks = pool_val.get('matchSegments') or []
            elif isinstance(pool_val, list):
                chunks = pool_val
    return {
        'projectId': payload.get('projectId', ''),
        'mediaId': payload.get('mediaId', ''),
        'queries': payload.get('queries') or [],
        'videoChunks': chunks,
        'segments': payload.get('segments') or [],
        'storyboardOrders': payload.get('storyboardOrders') or payload.get('orders') or [],
        # CandidateIds（P2 #11 方案B）：shotId → [chunkId]，daemon/legacy 实际行域的真实候选。
        #   KMMatchReq 无 segments、matchSegments 切片也不带 storyboard segmentId，新引擎既有
        #   段域漏斗（query.segmentId vs chunk.segmentId）在此数据形态下恒空。注入后由
        #   build_context 优先以此为候选池，让 shadow A/B 与 legacy 在同一批真实候选上对账。
        'candidateIds': payload.get('candidateIds') or {},
        'routerMode': 'on',
    }


def _run_new_engine(req) -> dict:
    """新引擎整条管道（#8）：validate → build_context → build_match_cost → beam_search.solve。

    返回结构与 legacy `_kuhn_munkres_match_sync_impl` 同构
    {success, results[], videoChunks}，供 on 档 Node 直接消费、shadow 档 Router 对账提取。
    任一步骤契约/资源缺失原样上抛——shadow 档由 Router 捕获记日志，不影响线上（错就错）。
    """
    from montage_contract import validate_request, default_result, validate_result
    from build_context import build_req_context
    from match_cost import build_match_cost
    from beam_search import solve as _beam_solve
    from rules import build_rule_cards

    seg_req = _kmmatch_to_segment_request(req)
    validate_request(seg_req)
    ctx = build_req_context(seg_req)
    cost = build_match_cost(ctx.queries, ctx.chunk_by_id, ctx.cands_by_shotid, None)
    tts = {str(q['shotId']): float(q.get('audioDurationMs') or 0.0) for q in ctx.queries}
    rules = build_rule_cards()  # available_keys=None → 全量规则卡启用（守「不可造假门」）
    solved = _beam_solve(ctx, cost, rules, tts)

    results = []
    for q in ctx.queries:
        sid = str(q['shotId'])
        r = solved.get(sid)
        if r is None:
            continue  # 空候选/无分配：错就错，本句不产出（对齐「旧7空段→新引擎必0」验收）
        item = default_result()
        item.update(r)
        item['id'] = item.get('id') or sid
        item['shotId'] = sid
        item['text'] = q.get('text', '')
        item['audioDurationMs'] = q.get('audioDurationMs', 0.0)
        # 与 legacy 结果项同构：步骤5 消费端读 `chunkId` 取选中切片（legacy L3334 详）。
        # 新引擎骨架用 `chosenChunkId`/`chunkData`，欠 legacy 的 `chunkId` 会让 on 档
        # 读不到切片 → 「匹配不到」。这里按 chunkData.id 兜齐 chunkId（错就错，空则空）。
        item['chunkId'] = (r.get('chunkData') or {}).get('id', '') or r.get('chunkId') or ''
        item['chunkData'] = r.get('chunkData') or {}
        # G 域（§10.2.8 动作2）：输出项经输出侧权威校验（缺必填字段即抛，schema 漂移 fail-fast）。
        #   补 isExactSpeed/appliedSpeedFactor 变速口径（对齐 legacy _spd 的 [0.97,1.03] 剪辑师准则），
        #   让 on 档也带 E 域哨兵（否则 default_result 恒 False，导出端只能退化为自检源时>=目标）。
        _cdur = float(item['chunkData'].get('durationMs') or 0)
        if not (_cdur > 0):
            _cdur = float(item['chunkData'].get('endMs', 0)) - float(item['chunkData'].get('startMs', 0))
        _aud = float(item.get('audioDurationMs') or 0)
        if _aud > 0 and _cdur > 0:
            _spd = max(0.97, min(1.03, _cdur / _aud))
            item['appliedSpeedFactor'] = round(_spd, 3)
            item['isExactSpeed'] = item.get('isExactSpeed') is True or round(_spd, 3) == 1.0
        validate_result(item)
        # 与 legacy 同构：legacy 结果条目带 coverPath（`_chunk.get("coverPath")`，L3338），
        # on 档 default_result 的 coverPath/thumbnail 恒空 → step5 卡片 `m.thumbnail` 读到空、
        # 只显示占位 Film 图标（用户实测「有卡片框但无图」）。这里从命中切片 chunkData 回填封面。
        _fc = item['chunkData']
        if not item.get('coverPath') and (_fc and _fc.get('coverPath')):
            item['coverPath'] = _fc.get('coverPath') or ''
        if not item.get('thumbnail') and (_fc and (_fc.get('thumbnail') or _fc.get('coverPath'))):
            item['thumbnail'] = _fc.get('thumbnail') or _fc.get('coverPath') or ''
        results.append(item)

    _cover_n = sum(1 for it in results if it.get('coverPath') or it.get('thumbnail'))
    _append_engine_trace(f"[on-engine] 卡片封面回填：coverPath/thumbnail 非空 {_cover_n}/{len(results)}")

    # 🔍 per-query 命中/未命中统计（诊断）：query 总数 = 请求侧所有碎片查询；未命中 =
    #   beam 未给该 query 分配切片（solved 无键）。未命中里 `is_orig` 标记原声段——原声段本
    #   应在 Node 侧走 originalMatches 定位、不依赖 beam，故应剔除后才是"真正匹配不到的普通解说段"。
    _hit_sids = {str(it.get('shotId')) for it in results}
    _miss_parts = []
    for _qm in ctx.queries:
        _qsid = str(_qm.get('shotId'))
        if _qsid not in _hit_sids:
            _q_is_orig = bool(_qm.get('keepOriginalAudio')) or str(_qm.get('audioMode', '')) == 'original'
            _q_txt = str(_qm.get('text') or '')[:18].replace(chr(10), ' ')
            _miss_parts.append(f"{_qsid}|orig={_q_is_orig}|{_q_txt}")
    _append_engine_trace(
        "[on-engine] 本次查询统计 query_total=%d 命中=%d 未命中=%d 未命中列表=[%s]" % (
            len(ctx.queries), len(results), len(_miss_parts), ", ".join(_miss_parts)))

    # 🎬 前段选片明细落盘（临时诊断）：逐句输出选中切片的源时间窗/时长/变速/原声哨兵，
    #   用于核对「画面重复（同根切片复用/邻时间段）/配音卡顿（变速无结论)/画面跳（源窗不单调）」。
    for _it in results:
        _cd = _it.get('chunkData') or {}
        _s = float(_cd.get('startMs') or 0.0)
        _e = float(_cd.get('endMs') or float(_cd.get('startMs') or 0.0))
        _d = float(_cd.get('durationMs') or max(0.0, _e - _s))
        _it_isx = bool(_it.get('isExactSpeed'))
        _it_spd = _it.get('appliedSpeedFactor')
        _it_spd = round(float(_it_spd), 3) if _it_spd is not None else None
        _it_sid = _it.get('shotId', '')
        _it_txt = str(_it.get('text') or '')[:18].replace(chr(10), ' ')
        _append_engine_trace(
            "[选片明细] %s | ck=%s src=[%d,%d] dur=%d | spd=%s isExact=%s | txt=%s" % (
                _it_sid, _it.get('chunkId', ''), int(_s), int(_e), int(_d),
                _it_spd, _it_isx, _it_txt))

    # 🃏 on 档卡片流式补齐：legacy KM 在分块求解过程中调 _report_km_progress/_report_km_blocks
    #   把逐块结果推给 Node 的 /api/solver/km_progress 轮询（前端据此逐个渲染卡片）。新引擎是
    #   一次性求解返回，若不喂进度前端只收到原声首卡、语义卡全空（用户实测「除了原声一个画面
    #   都没有」）。这里在返回前补齐 same 喂法：整批 results 作为唯一增量点，Node 轮询一次即取
    #   到全部语义卡，最终全量由 Node 覆写收敛，与 legacy 流式最终一致性一致。
    _task_id = str(getattr(req, 'taskId', '') or '')
    if _task_id:
        _report_km_progress(_task_id, 1.0, "全局最优组合求解完成")
        _report_km_blocks(_task_id, results)
        _append_engine_trace(f"[on-engine] 喂流式 task={_task_id} 条数={len(results)}")
    else:
        _append_engine_trace("[on-engine] ⚠️ req.taskId 为空，跳过喂流式（前端将只有原声首卡）")

    return {'success': True, 'results': results, 'videoChunks': seg_req.get('videoChunks') or []}


_KM_DISPATCH_ROUTER = None


def _append_engine_trace(m: str) -> None:
    """把引擎对账/诊断 trace 落盘到 data/new-engine-shadow.log（追加，UTF-8），
    便于离线读取核对 shadow A/B 与 on 档，不依赖终端实时转发。
    print 仍保留走 stderr 供开发时实时查看；落盘失败仅告警不抛错，
    因 trace 属诊断旁路，不能因写盘问题拖垮 KM 求解主流程。"""
    try:
        path = os.path.join(
            os.environ.get('ZENTECT_DATA_DIR') or os.getcwd(),
            'data',
            'new-engine-shadow.log',
        )
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'a', encoding='utf-8') as f:
            f.write(f"[new-engine] {m}\n")
    except Exception as e:  # noqa: BLE001
        print(f"[new-engine] <trace落盘失败:{e}>", file=sys.stderr)


def _km_dispatch(req) -> dict:
    """KM 求解分发入口：经 Router 按 `ZENTECT_KM_STORYBOARD_MODE` 择旧/新/shadow。

    首次惰性构造缓存单例并注入 legacy_run/new_run；Router 本身为 K 域已交付薄壳，
    本函数只做「把真实 KMMatchReq 喂进去」这一接入动作。
    """
    global _KM_DISPATCH_ROUTER
    if _KM_DISPATCH_ROUTER is None:
        from montage_router import Router
        _KM_DISPATCH_ROUTER = Router(
            legacy_run=_kuhn_munkres_match_sync,
            new_run=_run_new_engine,
            trace=_append_engine_trace,
        )
    return _KM_DISPATCH_ROUTER.run(req)
