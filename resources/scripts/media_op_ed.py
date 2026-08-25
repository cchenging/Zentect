"""
media_op_ed.py — OP/ED 自动识别两级流水线（P1 音视频信号启发式 + P2 跨集指纹对齐）

路由表：
  POST /api/media/detect_op_ed       → P1：FFmpeg blackdetect + silencedetect 启发式找 OP/ED 端点（置信度 ~0.95）
  POST /api/media/chromaprint        → P2：输出该视频的 chroma 指纹（用于同 IP 多集 0 成本对齐 OP/ED）

设计取舍：自动识别结果置信度低于阈值（0.6）时不写入生效值，仅作为"待确认建议"展示；
识别不可靠的场景交由用户手动选择（前端候选点一键采纳 / 手动输入 + 锁定）。
"""
import os
import re
import math
import json
import asyncio
import hashlib
import subprocess
import tempfile
from typing import Optional, List, Tuple, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from ai_config import FFMPEG_PATH, INFERENCE_LOCK, PROJECT_MATERIAL_POOL

router = APIRouter()


# ============================================================
# DTOs
# ============================================================
class DetectOpEdReq(BaseModel):
    """OP/ED 启发式检测请求（P1）"""
    file_path: str
    # 只在前/后该秒数内搜索（默认 300s=5min，99% 剧集 OP/ED 不超过这个范围）
    search_window_sec: float = 300.0
    # ✅ OP/ED 最短长度从 10s → 25s（片头曲至少 25s 才结束，17s 那种 logo/转场黑场直接被过滤）
    min_theme_duration_sec: float = 25.0
    # OP/ED 最长长度（默认 180s=3min）
    max_theme_duration_sec: float = 180.0


class ChromaprintReq(BaseModel):
    """Chromaprint 指纹请求（P2）"""
    file_path: str
    # 仅提取该秒数区间的指纹（默认前 90s 足够对齐 OP）
    start_sec: float = 0.0
    duration_sec: float = 90.0
    # fpcalc 算法分段时长（默认 2s/段 → 90s = 45 段指纹，省带宽）
    segment_sec: float = 2.0


# ============================================================
# 工具：ffmpeg 静默执行 + 解析 ffmpeg 日志
# ============================================================
def _run_ffmpeg_sync(args: List[str], timeout: int = 600) -> str:
    """阻塞运行 FFmpeg（在 executor 中被调用），返回 stderr 日志（FFmpeg 滤镜输出在 stderr）。"""
    exe = FFMPEG_PATH or "ffmpeg"
    # Windows 上避免弹出 cmd 黑窗
    si = None
    if os.name == "nt":
        si = subprocess.STARTUPINFO()
        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    p = subprocess.Popen([exe, "-hide_banner", "-nostdin", *args],
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         startupinfo=si)
    try:
        _, stderr = p.communicate(timeout=timeout)
        return stderr.decode("utf-8", errors="ignore")
    except subprocess.TimeoutExpired:
        p.kill()
        raise RuntimeError(f"ffmpeg timeout (> {timeout}s)")


def _get_duration_sec(file_path: str) -> float:
    """读视频时长（秒）"""
    log = _run_ffmpeg_sync(["-i", file_path], timeout=30)
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", log)
    if not m: return 0.0
    h, mn, s = m.groups()
    return int(h)*3600 + int(mn)*60 + float(s)


# ============================================================
# P1：blackdetect + silencedetect 启发式
# ============================================================
_BLACK_RE = re.compile(r"black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)")
_SILENCE_START_RE = re.compile(r"silence_start:\s*(-?[\d.]+)")
_SILENCE_END_RE = re.compile(r"silence_end:\s*([\d.]+)\s*\|\s*silence_duration:([\d.]+)")


def _run_black_silent_detect_sync(file_path: str, search_window_sec: float, duration_sec: float) -> dict:
    """
    前 5 分钟 + 后 5 分钟跑两次 FFmpeg：
      - blackdetect：d=1.0（连续黑 1s 认为是转场），pic_th=0.10
      - silencedetect：n=-30dB（音量 < -30dB 算静音），d=0.8
    返回 {"front": {"blacks": [(start,end,dur)], "silences": [(start,end,dur)]}, "tail": {...}}
    """
    def _one_pass(seek: float, win: float, tag: str) -> dict:
        if seek + win > duration_sec: win = max(0.1, duration_sec - seek)
        if win <= 0: return {"blacks": [], "silences": []}
        vf = (f"blackdetect=d=1.0:pic_th=0.10,"
              f"select='gte(t,{seek})*lte(t,{seek+win})',"
              f"showinfo")
        af = f"silencedetect=n=-30dB:d=0.8,atrim=start_sample=0"
        # 使用 -ss + -t 先截段再进滤镜（性能关键：不用扫全片）
        args = [
            "-ss", f"{seek:.3f}", "-t", f"{win:.3f}", "-i", file_path,
            "-map", "0:v:0", "-map", "0:a:0?",
            "-vf", vf, "-af", af,
            "-f", "null", "-"
        ]
        log = _run_ffmpeg_sync(args, timeout=180)
        blacks, silences = [], []
        for s, e, d in _BLACK_RE.findall(log):
            blacks.append((float(s)+seek, float(e)+seek, float(d)))
        starts = [float(x)+seek for x in _SILENCE_START_RE.findall(log)]
        for m in _SILENCE_END_RE.finditer(log):
            end = float(m.group(1)) + seek
            dur = float(m.group(2))
            # 找最近的 start：end - dur
            silences.append((end-dur, end, dur))
        return {"blacks": blacks, "silences": silences}

    front = _one_pass(0.0, search_window_sec, "front")
    tail_seek = max(0.0, duration_sec - search_window_sec)
    tail = _one_pass(tail_seek, search_window_sec, "tail")
    return {"front": front, "tail": tail, "duration_sec": duration_sec}


def _heuristic_infer_op(front: dict, min_dur: float, max_dur: float) -> Tuple[float, float, List[Tuple[float, float]]]:
    """
    OP = [0s, 正剧第一个明显分界点]
    🔧 修复误判 17s 小转场：
      · 不再取第一个候选点 valid[0]（片头曲中间有大量 0.5-1s 一闪而过的转场黑场）
      · 引入 OP「黄金区间权重」：1min-1min45s（60s-105s）是 95% 国产剧 OP 结束区间，该区间内候选点权重 × 1.6；30-60s ×1.2；<30s 是中间转场权重降为 0.35；>105s ×0.6
      · 黑场/静音时长的贡献：d 越长权重越高（OP 结尾转场是 2-3s 整段黑屏，而 0.5-1s 一闪而过的不应该被选中）
    返回 (op_end_sec, confidence, top3_candidates[(sec, score)])
    """
    # OP 黄金区间（95% 剧集 OP 结束位置）：(lo_center, hi_center, boost, cap_weight)
    OP_POS_BOOST = [
        (60.0, 105.0, 1.6, 1.0),  # 1:00 - 1:45 → 最高 1.6× 权重（真正 OP 结束点）
        (30.0, 60.0, 1.2, 0.7),   # 0:30 - 1:00 → 1.2×（偶见短 OP）
        (105.0, 140.0, 0.7, 0.5), # 1:45 - 2:20 → 0.7×（少数长 OP）
        (10.0, 30.0, 0.35, 0.25), # 0:10 - 0:30 → 0.35×（片头曲中间转场，绝对不可能是 OP 结尾）
    ]
    def position_score(t: float) -> float:
        """根据候选点在黄金区间的位置给出 0-1.6 位置权重"""
        for lo, hi, boost, cap in OP_POS_BOOST:
            if lo <= t <= hi:
                # 区间中心附近最高，两端衰减（高斯风，避免硬切）
                center = (lo + hi) / 2
                half = (hi - lo) / 2
                dist = abs(t - center)
                falloff = max(0.0, 1.0 - (dist / max(1e-6, half)) ** 2)
                return min(boost, 0.4 + (boost - 0.4) * falloff)
        return 0.2

    blacks = sorted(front["blacks"], key=lambda x: x[0])
    silences = sorted(front["silences"], key=lambda x: x[0])
    # 候选分界点：所有黑场的 end / 所有 > 1s 静音的 end
    scored: List[Tuple[float, float]] = []  # (end_sec, final_score)
    for s, e, d in blacks:
        if s < 5.0: continue
        # 黑场时长贡献：0.5s 才 0.1，1s 0.4，2s 0.9，≥3s 1.0（OP 结尾转场一般 2-3s 黑屏）
        d_score = max(0.0, min(1.0, (d - 0.2) / 2.6))
        base = 0.6 + 0.35 * d_score  # 黑场信号本身比静音更可信一点
        pos = position_score(e)
        score = round(base * (0.35 + 0.65 * pos), 4)
        scored.append((e, score, d_score, pos, 'black'))
    for s, e, d in silences:
        if s < 5.0: continue
        # 静音时长贡献：0.8s 才 0.1，1.5s 0.5，≥3s 1.0（OP 结尾转场一般伴随 2-3s 静音）
        d_score = max(0.0, min(1.0, (d - 0.6) / 2.4))
        base = 0.35 + 0.40 * d_score
        pos = position_score(e)
        score = round(base * (0.25 + 0.75 * pos), 4)
        scored.append((e, score, d_score, pos, 'silence'))

    # 过滤超出 OP 合理范围 [min_dur, max_dur] 的点
    valid = [(p, s) for p, s, *_ in scored if min_dur <= p <= max_dur]
    # ✅ 核心修复：按「综合分数」降序（而不是按时间升序取第一个！）
    valid_sorted = sorted(valid, key=lambda x: (-x[1], x[0]))
    top3 = valid_sorted[:3]
    if top3:
        best_p, best_score = top3[0]
        # 置信度：best_score * 唯一性（top1 - top2 的差距越大越唯一）
        second_score = top3[1][1] if len(top3) >= 2 else 0.0
        uniqueness = 1.0 if len(top3) == 1 else max(0.5, min(1.0, 1.0 - (second_score / max(1e-6, best_score)) * 0.8))
        confidence = round(min(0.99, best_score * (0.6 + 0.4 * uniqueness)), 3)
        return (round(best_p, 3), confidence, [(round(p,2), round(s,3)) for p, s in top3])
    # 启发失败：兜底返回 1 分 5 秒（绝大多数剧集 OP 长度的众数），置信度 0.3
    fallback = max(min_dur, 65.0 if max_dur >= 65 else max_dur * 0.65)
    return (round(fallback, 3), 0.30, [(round(fallback,2), 0.30)])


def _heuristic_infer_ed(tail: dict, tail_start_sec: float, min_dur: float, max_dur: float,
                        total_dur: float) -> Tuple[float, float, List[Tuple[float, float]]]:
    """
    ED = [正剧最后一个明显分界点, total_dur]
    🔧 同样引入「ED 黄金区间权重」：大多数剧集 ED 从最后 1:45s 左右开始（即 total - 105s ~ total - 60s），越靠近中心权重越高；
      · 最后 30s 以内的分界不算（结尾 credits 最后黑场不是 ED 开始）
      · 取最后一个高分候选（或按综合分数最高者 + 时间越晚越优先）
    返回 (ed_start_sec, confidence, top3_candidates[(sec, score)])
    """
    # ED 开始黄金区间（距离片尾多少秒）：(lo_seconds_before_end, hi_seconds_before_end, boost, cap_weight)
    ED_POS_BOOST_FROM_END = [
        (60.0,  105.0, 1.6, 1.0),  # 距离片尾 60s-105s → 1:00-1:45 → 最常见 ED 开始区间
        (45.0,  60.0,  1.2, 0.7),  # 距片尾 45-60s → 偶见短 ED
        (105.0, 150.0, 0.7, 0.5),  # 距片尾 105-150s → 长 ED
        (25.0,  45.0,  0.35, 0.25),# 距片尾 25-45s → 几乎不可能是 ED 开始（正剧片尾小转场）
    ]
    def position_score_from_end(t: float) -> float:
        """基于「距离片尾多少秒」给 0-1.6 位置权重"""
        seconds_before = max(0.0, total_dur - t)
        for lo, hi, boost, cap in ED_POS_BOOST_FROM_END:
            if lo <= seconds_before <= hi:
                center = (lo + hi) / 2
                half = (hi - lo) / 2
                dist = abs(seconds_before - center)
                falloff = max(0.0, 1.0 - (dist / max(1e-6, half)) ** 2)
                return min(boost, 0.4 + (boost - 0.4) * falloff)
        return 0.2

    blacks = sorted(tail["blacks"], key=lambda x: x[0])
    silences = sorted(tail["silences"], key=lambda x: x[0])
    scored: List[Tuple[float, float]] = []
    for s, e, d in blacks:
        if e > total_dur - 15.0: continue  # 最后 15s 纯黑 credits 不算
        d_score = max(0.0, min(1.0, (d - 0.2) / 2.6))
        base = 0.6 + 0.35 * d_score
        pos = position_score_from_end(s)
        # 对于 ED：时间越晚（越靠近片尾）再额外加一点正向分（鼓励选后候选）
        lateness = max(0.0, min(1.0, (s - (total_dur - max_dur)) / max(1e-6, (total_dur - min_dur) - (total_dur - max_dur))))
        score = round(base * (0.35 + 0.65 * pos) * (0.85 + 0.15 * lateness), 4)
        scored.append((s, score, d_score, pos, 'black'))
    for s, e, d in silences:
        if e > total_dur - 15.0: continue
        d_score = max(0.0, min(1.0, (d - 0.6) / 2.4))
        base = 0.35 + 0.40 * d_score
        pos = position_score_from_end(s)
        lateness = max(0.0, min(1.0, (s - (total_dur - max_dur)) / max(1e-6, (total_dur - min_dur) - (total_dur - max_dur))))
        score = round(base * (0.25 + 0.75 * pos) * (0.85 + 0.15 * lateness), 4)
        scored.append((s, score, d_score, pos, 'silence'))

    lo, hi = total_dur - max_dur, total_dur - min_dur
    valid = [(p, s) for p, s, *_ in scored if lo <= p <= hi]
    # 综合排序：分数降序（主要），时间降序（同分下选更晚的那个 = 更靠近片尾，更符合 ED 语义）
    valid_sorted = sorted(valid, key=lambda x: (-x[1], -x[0]))
    top3 = valid_sorted[:3]
    if top3:
        best_p, best_score = top3[0]
        second_score = top3[1][1] if len(top3) >= 2 else 0.0
        uniqueness = 1.0 if len(top3) == 1 else max(0.5, min(1.0, 1.0 - (second_score / max(1e-6, best_score)) * 0.8))
        confidence = round(min(0.99, best_score * (0.6 + 0.4 * uniqueness)), 3)
        return (round(best_p, 3), confidence, [(round(p,2), round(s,3)) for p, s in top3])
    # 兜底：距片尾 85s 开始（多数剧集 ED 众数），置信度 0.3
    fallback = max(0.0, total_dur - 85.0 if total_dur > 85.0 else total_dur - max_dur * 0.5)
    return (round(fallback, 3), 0.30, [(round(fallback,2), 0.30)])


def _run_scenecut_detect_sync(file_path: str, seek: float, win: float, threshold: float = 0.35) -> List[float]:
    """
    对 [seek, seek+win] 窗口用 FFmpeg scene 滤镜扫描场景切换点（只对 I 帧级差异 > threshold 的帧输出）。
    showinfo 会为每个命中帧打印一行 pts_time:XX → 还原为绝对时间。
    """
    vf = f"select='gt(scene,{threshold})',showinfo"
    args = [
        "-ss", f"{seek:.3f}", "-t", f"{win:.3f}", "-i", file_path,
        "-map", "0:v:0", "-vf", vf, "-f", "null", "-"
    ]
    try:
        log = _run_ffmpeg_sync(args, timeout=180)
    except Exception:
        return []
    times = []
    for m in re.finditer(r"pts_time:([\d.]+)", log or ""):
        t = float(m.group(1)) + seek
        if seek <= t <= seek + win:
            times.append(t)
    return sorted(set(round(x, 3) for x in times))


def _heuristic_infer_credits_start(cuts: List[float], total_dur: float,
                                   min_credits_dur: float = 40.0,
                                   max_credits_dur: float = 540.0) -> Tuple[float, float, List[Tuple[float, float]]]:
    """
    电影片尾 credits 检测：滚动字幕段画面变化率极低 → 场景切点长时间缺失。
    · 只在最后 max_credits_dur 秒窗口内找「相邻切点（含窗口边界）之间的最大无切点间隙」
    · 约束：间隙结束距片尾 ≤ 180s（过滤正剧中部的文戏长镜头）；间隙起点距片尾 ≥ 45s（排除纯黑屏片尾）
    返回 (credits_start_sec, confidence, top3_candidates[(sec, gap_sec)])
    """
    if not cuts:
        return None, 0.0, []
    window_start = max(0.0, total_dur - max_credits_dur)
    cuts_in = [c for c in cuts if c >= window_start]
    pts = [window_start] + cuts_in + [total_dur]
    gaps: List[Tuple[float, float, float]] = []
    for a, b in zip(pts, pts[1:]):
        gaps.append((a, b, b - a))
    # 约束过滤
    valid = []
    for s, e, d in gaps:
        if e > total_dur - 180.0 and (total_dur - s) >= 45.0 and d >= min_credits_dur:
            valid.append((s, e, d))
    if not valid:
        return None, 0.0, []
    valid_sorted = sorted(valid, key=lambda g: -g[2])
    best_s, best_e, best_d = valid_sorted[0]
    # 置信度：间隙越长越可信；越晚越可疑（可能是片尾黑屏前静帧）轻微折损
    conf = round(min(0.95, 0.4 + best_d / 120.0 - max(0.0, (total_dur - best_s) - 540.0) / 2000.0), 3)
    top3 = [(round(s, 2), round(d, 2)) for s, _, d in valid_sorted[:3]]
    return (round(best_s, 3), conf, top3)


@router.post("/api/media/detect_op_ed")
async def detect_op_ed(req: DetectOpEdReq):
    """P1：OP/ED 黑场+静音启发式检测。"""
    try:
        if not os.path.exists(req.file_path):
            raise HTTPException(400, f"file not found: {req.file_path}")
        cache_key = f"oped:detect_v2:{hashlib.md5(req.file_path.encode()).hexdigest()}:{req.search_window_sec}:{req.min_theme_duration_sec}:{req.max_theme_duration_sec}"
        cached = PROJECT_MATERIAL_POOL.get(cache_key)
        if cached is not None:
            return {"success": True, **cached, "fromCache": True}

        loop = asyncio.get_running_loop()
        # 1. 拿总时长
        dur = await loop.run_in_executor(None, _get_duration_sec, req.file_path)
        if dur <= 0:
            return {"success": False, "error": "unable to probe video duration"}
        # 2. 黑场 + 静音扫描（前/后 5 分钟）
        sig = await loop.run_in_executor(None, _run_black_silent_detect_sync,
                                         req.file_path, req.search_window_sec, dur)
        # 3. 启发式推导 OP end / ED start（现在返回 3 个值：best + confidence + Top3 候选点）
        op_end, op_conf, top3_op = _heuristic_infer_op(sig["front"], req.min_theme_duration_sec, req.max_theme_duration_sec)
        ed_start, ed_conf, top3_ed = _heuristic_infer_ed(sig["tail"], dur - req.search_window_sec,
                                                        req.min_theme_duration_sec, req.max_theme_duration_sec, dur)
        # 4. 电影片尾 credits 检测：尾部窗口 scenecut 扫描 → 最大无切点间隙 = 滚动字幕段起点
        #    （credits 置信度高时覆盖黑场法 ED，专门解决电影 credits 3-8 分钟、ED 黄金区间完全错位的问题）
        credits_start: Optional[float] = None
        credits_conf: float = 0.0
        credits_top3: List[Tuple[float, float]] = []
        try:
            cuts = await loop.run_in_executor(None, _run_scenecut_detect_sync,
                                              req.file_path, max(0.0, dur - req.search_window_sec),
                                              min(req.search_window_sec, dur))
            credits_start, credits_conf, credits_top3 = _heuristic_infer_credits_start(cuts, dur)
            if credits_start is not None and credits_conf > ed_conf:
                ed_start, ed_conf = credits_start, credits_conf
        except Exception:
            pass
        result = {
            "source": "P1_FFMPEG_HEURISTIC",
            "file_path": req.file_path,
            "duration_sec": round(dur, 3),
            "search_window_sec": req.search_window_sec,
            "op_end_sec": round(op_end, 3),
            "op_confidence": op_conf,
            "op_candidates": top3_op,  # ✅ 新增：Top 3 OP 结束候选点（前端可展示给用户对比选择）
            "ed_start_sec": round(ed_start, 3),
            "ed_confidence": ed_conf,
            "ed_candidates": top3_ed,  # ✅ 新增：Top 3 ED 开始候选点
            "credits_start_sec": round(credits_start, 3) if credits_start is not None else None,
            "credits_confidence": credits_conf,
            "credits_candidates": credits_top3,
            "trim_start_ms": int(round(op_end * 1000)),
            "trim_end_ms": int(round(max(0.0, dur - ed_start) * 1000)),
            "raw_signals": {
                "front_blacks": [(round(a,3),round(b,3),round(c,3)) for a,b,c in sig["front"]["blacks"][:20]],
                "front_silences": [(round(a,3),round(b,3),round(c,3)) for a,b,c in sig["front"]["silences"][:20]],
                "tail_blacks": [(round(a,3),round(b,3),round(c,3)) for a,b,c in sig["tail"]["blacks"][-20:]],
                "tail_silences": [(round(a,3),round(b,3),round(c,3)) for a,b,c in sig["tail"]["silences"][-20:]],
            },
        }
        PROJECT_MATERIAL_POOL[cache_key] = result
        return {"success": True, **result}
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": f"{type(e).__name__}: {e}"}


# ============================================================
# P2：Chromaprint 指纹（跨集 OP/ED 0 成本对齐）
# ============================================================
def _run_chromaprint_sync(file_path: str, start_sec: float, duration_sec: float, segment_sec: float) -> List[List[float]]:
    """
    按 segment_sec 秒/段 提取 librosa chroma 12 维指纹（抗重混/响度差异，支持跨集 OP/ED 对齐）。
    · start_sec < 0 表示「距片尾 |start_sec| 秒」（如 -90 = 尾部 90s），调用方无需预知视频总时长。
    · 返回 [[12 floats], ...]，每段已 L2 归一化。
    依赖：ai-env 已内置 librosa/numpy（函数内 import，避免拖慢 daemon 启动）。
    """
    import numpy as np
    import librosa
    if start_sec < 0:
        dur_total = _get_duration_sec(file_path)
        if dur_total <= 0:
            return []
        start_sec = max(0.0, dur_total + start_sec)
    try:
        y, sr = librosa.load(file_path, sr=22050, mono=True,
                             offset=start_sec, duration=duration_sec)
    except Exception:
        return []
    if y.size == 0:
        return []
    hop = 512
    chroma = librosa.feature.chroma_stft(y=y, sr=sr, hop_length=hop, n_fft=2048)
    seg_frames = int(segment_sec * sr / hop)
    if seg_frames <= 0:
        return []
    n_segs = chroma.shape[1] // seg_frames
    out: List[List[float]] = []
    for i in range(n_segs):
        block = chroma[:, i * seg_frames:(i + 1) * seg_frames].mean(axis=1)
        norm = float(np.linalg.norm(block))
        if norm > 1e-9:
            block = block / norm
        out.append([round(float(x), 4) for x in block])
    return out


@router.post("/api/media/chromaprint")
async def chromaprint(req: ChromaprintReq):
    """P2：返回按段切分的音频指纹数组，用于同 IP 多集 0 成本对齐 OP 长度。"""
    try:
        if not os.path.exists(req.file_path):
            raise HTTPException(400, f"file not found: {req.file_path}")
        cache_key = f"oped:cp_v1:{hashlib.md5(req.file_path.encode()).hexdigest()}:{req.start_sec}:{req.duration_sec}:{req.segment_sec}"
        cached = PROJECT_MATERIAL_POOL.get(cache_key)
        if cached is not None:
            return {"success": True, **cached, "fromCache": True}
        loop = asyncio.get_running_loop()
        fps = await loop.run_in_executor(None, _run_chromaprint_sync,
                                         req.file_path, req.start_sec, req.duration_sec, req.segment_sec)
        result = {
            "source": "P2_CHROMAPRINT",
            "file_path": req.file_path,
            "start_sec": req.start_sec,
            "duration_sec": req.duration_sec,
            "segment_sec": req.segment_sec,
            "segments": fps,
            "segment_count": len(fps),
        }
        PROJECT_MATERIAL_POOL[cache_key] = result
        return {"success": True, **result}
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": f"{type(e).__name__}: {e}"}



