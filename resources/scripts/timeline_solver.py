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
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from typing import List
from ai_config import (AIModels, PROJECT_MATERIAL_POOL, INFERENCE_LOCK,
                       set_task_cancel, is_task_cancelled, clear_task_cancel,
                       _load_and_resize_thumb)

router = APIRouter()


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


class KMMatchReq(BaseModel):
    """卡点匹配请求"""
    queries: List[KMMatchQuery]
    videoChunks: List[dict]
    bgmBeats: List[float] = []
    mediaId: str = 'default'
    vlmApiKey: str = ''
    vlmApiBase: str = ''
    vlmApiModel: str = ''
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


@router.post("/api/solver/kuhn_munkres_match")
async def kuhn_munkres_match(req: KMMatchReq, request: Request):
    """
    三维一体弹性时间轴对齐算法（时序块段级联匹配版）
    长电影场景下，将全局 O(N³) 的 KM 求解降级为时序分块的 K × O(n³) 级联匹配
    🚀 关键修复：CPU 密集型计算放入线程池，避免阻塞 uvicorn 事件循环
    🔧 R1 互斥（PR-1）：进入步骤5（KM 匹配）即释放步骤1 的 ASR/TTS 模型，避免跨步骤叠加常驻
    🔧 R3 取消贯通（PR-1）：从 X-Task-Id 请求头取取消标识，求解循环定期检查
    """
    # R1：进入步骤5 前释放步骤1 的 ASR 模型（步骤1 与步骤5 模型互斥）。
    #    TTS（Kokoro）由 tts_kokoro 独立管理且无 release 方法，暂不在此释放（见 PR-1 未做项说明）
    try:
        AIModels.release_faster_whisper()
        AIModels.release_funasr_sensevoice()
        AIModels.release_paraformer()
    except Exception as e:
        print(f"[KM] R1 释放 ASR 模型警告: {e}", file=sys.stderr)

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
    多因子综合打分：0.62 画面意图语义 + 0.20 时长契合 + 0.08 情绪意境 + 0.10 角色契合
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
    🎵 P2 权重可配置：从 weights 读取四项权重（缺省回退默认值），并对四项权重做归一化，
    让前端调参真正生效，不再依赖硬编码。
    """
    _default_weights = {
        'sem': 0.62, 'emotion': 0.08, 'duration': 0.20, 'role': 0.10,
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


def _try_merge_contiguous_segs(ci, video_chunks, used_chunks, target_dur_ms):
    """
    🔧 P2：变速超限（素材偏短需放慢）时，尝试把切片 ci 与其同 parentChunk 的连续兄弟 seg
    按段序索引递增拼接补时长（语义不变，仅补物理时长），规避单切片变速超限重选。
    - 物理连续性断言：|seg_{k+1}.startMs - seg_k.endMs| <= 100ms（与导出层 TIME_CONTINUITY_MS 口径一致），
      且按 segmentIndexInParent 段序递增拼接（seg0→seg1→seg2），从源头杜绝"挑段拼"的跨段瞬移。
    - 拼接验收：合并变速比落入 [0.80, 1.20] 即视为补足时长（轻微越界交由 speed clamp 0.85~1.15 兜底；
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
        speed = (merged_end - merged_start) / target_dur_ms
        if 0.80 <= speed <= 1.20:
            best_merge = (list(seg_indices), list(seg_ids), merged_end)
        if speed > 1.20:
            break  # 拼过头：采用最近一次达标组合或放弃
        next_idx += 1
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
    reranked = 0

    # 3. 逐相邻对检查连续性
    for i in range(1, len(results)):
        prev_r, cur_r = results[i - 1], results[i]
        prev_cid, cur_cid = prev_r.get("chunkId") or "", cur_r.get("chunkId") or ""
        if not prev_cid or not cur_cid:
            continue
        prev_chunk = next((c for c in video_chunks if c.get("id") == prev_cid), None)
        cur_chunk = next((c for c in video_chunks if c.get("id") == cur_cid), None)
        if prev_chunk is None or cur_chunk is None:
            continue
        penalty = _continuity_penalty(prev_chunk, cur_chunk)
        if penalty < CONTINUITY_TRIGGER:
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
        # 变速参考：切片时长 / 成品时间段（保持 KM 的 0.85~1.15 限制）
        final_dur = (cur_r.get("videoTimelineEndMs") or 0) - (cur_r.get("videoTimelineStartMs") or 0)
        cand_vdur = best_cand_chunk.get("durationMs", 0)
        if final_dur > 0 and cand_vdur > 0:
            spd = cand_vdur / final_dur
            cur_r["appliedSpeedFactor"] = round(max(0.85, min(1.15, spd)), 3)
        reranked += 1
        print(f"[衔接重排] shotId={cur_r.get('shotId')} 连续性差({penalty:.2f}) → 替换为切片 "
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


def _kuhn_munkres_match_sync_impl(req: KMMatchReq) -> dict:
    """
    KM 匹配实际实现（外层 try/finally 保证句柄释放）。
    详见 `_kuhn_munkres_match_sync` 的 docstring。
    """
    import numpy as np
    from scipy.optimize import linear_sum_assignment
    n_queries = len(req.queries)

    video_chunks = req.videoChunks
    if (not video_chunks or len(video_chunks) == 0) and req.mediaId in PROJECT_MATERIAL_POOL:
        # 阶段 B：素材池缓存结构升级为 {"chunks","matchSegments"}，KM 消费的是匹配候选级 matchSegments
        pool_val = PROJECT_MATERIAL_POOL[req.mediaId]
        if isinstance(pool_val, dict) and "matchSegments" in pool_val:
            video_chunks = pool_val.get("matchSegments") or []
        else:
            # 兼容旧结构（缓存为数组，阶段 A 及更早）
            video_chunks = pool_val
        print(f"[KM] 命中 PROJECT_MATERIAL_POOL 缓存 (mediaId={req.mediaId})，切片数: {len(video_chunks)}", file=sys.stderr)

    n_chunks = len(video_chunks)
    # 打印本次请求规模（卡死排查关键指标：长切片数量 × seek 次数）
    n_long_chunks = sum(
        1 for c in video_chunks
        if float(c.get("durationMs") or 0) > MULTI_FRAME_THRESHOLD_MS
        and c.get("filePath", "") and os.path.exists(c.get("filePath", ""))
    )
    print(f"[KM] 请求规模：{n_queries} queries × {n_chunks} chunks（其中 >{MULTI_FRAME_THRESHOLD_MS//1000}s 长切片={n_long_chunks}，"
          f"多帧采样限流上限={MULTI_FRAME_MAX_CHUNKS}，全局禁用={_MULTI_FRAME_DISABLED}）", file=sys.stderr)

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
            all_image_features = []
            for batch_start in range(0, len(valid_chunk_indices), IMAGE_ENCODE_BATCH):
                batch_imgs = []
                batch_frame_counts = []  # 每个切片的帧数（>6s 多点采样为 3，其余为 1），用于平均池化
                batch_chunk_indices = []  # 与 batch_imgs 一一对应的 video_chunks 索引，用于写回 clipZhEmbedding
                for ci in valid_chunk_indices[batch_start:batch_start + IMAGE_ENCODE_BATCH]:
                    chunk = video_chunks[ci]
                    batch_chunk_indices.append(ci)
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

                image_inputs = zh_processor(images=batch_imgs, return_tensors="pt", padding=True).to(AIModels.device)
                with torch.no_grad():
                    batch_features = _extract_pooler(zh_model.get_image_features(
                        pixel_values=image_inputs["pixel_values"],
                    ))
                batch_features = F.normalize(batch_features, p=2, dim=-1)
                # 按切片平均池化（>6s 多帧取均值后归一化）
                feat_idx = 0
                for n_frames, ci in zip(batch_frame_counts, batch_chunk_indices):
                    pooled = batch_features[feat_idx:feat_idx + n_frames].mean(dim=0, keepdim=True)
                    pooled = F.normalize(pooled, p=2, dim=-1)
                    all_image_features.append(pooled)
                    # 🔧 P2 缓存落库：把中文 CLIP 图像特征写回 chunk，Node 侧按 id 合并回写 DB，
                    #   下次匹配命中 DB 缓存时免去图像重编码（性能优化，不改变匹配结果）
                    # 🔧 R6 embedding 瘦身（PR-2）：写回前降 float16 半精度，驻留与落库 JSON 体积减半
                    video_chunks[ci]["clipZhEmbedding"] = pooled.detach().cpu().to(torch.float16).numpy().flatten().tolist()
                    feat_idx += n_frames
                del image_inputs, batch_features, batch_imgs
                # 🔧 R13：批处理完立即触发 GC，及时回收 batch tensor / PIL 帧，避免峰值内存叠加
                gc.collect()

            image_features = torch.cat(all_image_features, dim=0).cpu().numpy()
            del all_image_features

            image_sim = zh_text_features @ image_features.T  # (n_queries, n_chunks) 画面意图↔封面图像

            # 🎯 切片描述文本语义：画面意图 ↔ 切片描述（步骤2 逐帧 VLM 描述按时间轴聚合而来）
            #    有描述切片：语义 = 0.5*图像 + 0.5*描述文本（描述含动作/情绪/景别/台词，信息量远超单帧封面）
            #    无描述切片：语义 = 纯图像（空文本编码结果不可预测，必须掩码归零，不能参与混合）
            chunk_desc_texts = [(video_chunks[ci].get("description") or "").strip() for ci in valid_chunk_indices]
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
                semantic_sim = np.where(has_desc[None, :] > 0, 0.5 * image_sim + 0.5 * text_sim, image_sim)
                print(f"[KM] 中文 CLIP + 切片描述文本语义，{int(has_desc.sum())}/{len(valid_chunk_indices)} 切片带描述",
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

    BLOCK_DURATION_MS = 300000
    results = []
    current_timeline_ms = 0

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
    accumulated_ms = 0

    for qi in range(n_queries):
        audio_dur = req.queries[qi].audioDurationMs or 0
        block_idx = int(accumulated_ms / BLOCK_DURATION_MS)
        if block_idx not in query_blocks:
            query_blocks[block_idx] = []
        query_blocks[block_idx].append(qi)
        accumulated_ms += audio_dur

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

    for block_idx in range(max_block + 1):
        # 🔧 R3 取消贯通（PR-1）：每处理一个时序块检查取消标记，命中立即提前返回，
        #   避免取消请求继续空烧 CPU / 重复重试
        if req.taskId and is_task_cancelled(req.taskId):
            print(f"[KM] R3 收到取消标记（taskId={req.taskId}），KM 求解提前终止", file=sys.stderr)
            return {"success": True, "cancelled": True, "results": [], "videoChunks": video_chunks}
        block_queries = query_blocks.get(block_idx, [])
        block_chunk_indices = set()
        for offset in [-3, -2, -1, 0, 1, 2, 3]:
            block_chunk_indices.update(chunk_blocks.get(block_idx + offset, []))
        block_chunk_idx_list = sorted(block_chunk_indices)

        if not block_queries or not block_chunk_idx_list:
            continue

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

                sem_score = float(semantic_sim[qi, ci_idx])
                sem_score = max(0.0, min(1.0, (sem_score + 1.0) / 2.0))

                # 🎯 修复：关键词精确匹配 boost（强视觉实体/动作），解决 TF-IDF/CLIP 文本低词频信号不足
                q = req.queries[qi]
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

                combined_score = _compute_combined_score(sem_score, duration_penalty, emotion_score, role_score, weights=req.weights)
                local_cost[lqi, lci] = -combined_score

        if local_n_queries > local_n_chunks:
            # 🔧 R5 矩阵降精度（PR-2）：padding 补零块 float64 → float32，与 local_cost 一致
            padding = np.zeros((local_n_queries, local_n_queries - local_n_chunks), dtype=np.float32)
            local_cost = np.hstack([local_cost, padding])

        with INFERENCE_LOCK:
            row_ind, col_ind = linear_sum_assignment(local_cost)

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

            # 变速超限重选：语音与素材时长严重不匹配（超出 0.85~1.15 变速能力）时，
            # 从当前时序块候选池中重选一个"语义0.6+时长0.4联合分"最高的未使用切片，
            # 以当前切片联合分为保底基准，只有候选联合分超过当前切片才重选，
            # 避免为了时长丢弃语义更贴合的切片（纯时长贴近会牺牲画面内容）。
            if raw_speed_factor < 0.85 or raw_speed_factor > 1.15:
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
                if raw_speed_factor < 0.85:
                    merged = _try_merge_contiguous_segs(real_ci, video_chunks, global_used_chunks, final_video_duration_ms)
                if merged is not None:
                    # 拼接成功：占用全部参与 seg（含兄弟），采用拼接切片；语义同父不变，取当前切片分
                    for _ci in merged["seg_indices"]:
                        global_used_chunks.add(_ci)
                    chunk = merged["chunk"]
                    video_dur_ms = merged["total_dur"]
                    best_sem = cur_sem
                    best_dur_pen = _compute_duration_score(audio_dur_ms, video_dur_ms)
                    best_emotion = cur_emotion
                    best_role = cur_role
                    combined_score = _compute_combined_score(best_sem, best_dur_pen, best_emotion, best_role, weights=req.weights)
                    print(f"[KM] shotId={query.shotId} 变速 {raw_speed_factor:.2f} 超限，拼接同父连续 seg（{'+'.join(merged['seg_ids'])}={video_dur_ms}ms）规避变速", file=sys.stderr)
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

            speed_factor = 1.0
            if final_video_duration_ms > 0 and video_dur_ms > 0:
                speed_factor = video_dur_ms / final_video_duration_ms
                # 变速区间收紧到 0.85~1.15，防止强拉慢放导致的鬼畜/变相
                speed_factor = max(0.85, min(1.15, speed_factor))

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

    # VLM 二次裁决：对低置信度匹配调用 GPT-4o 重排
    if req.vlmApiKey and req.vlmApiBase and req.vlmApiModel:
        results = _apply_vlm_rerank(
            results, req.queries, video_chunks, valid_chunk_indices,
            semantic_sim, emotion_sim, role_sim, n_queries,
            req.vlmApiKey, req.vlmApiBase, req.vlmApiModel, req.weights,
        )

    # 🎬 P1 衔接流畅性重排：相邻切片色调/景别/情绪连续性优化。
    #    放在 VLM 内容裁决之后：先保证单点内容正确，再优化序列衔接，避免为了衔接牺牲内容。
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

    return {"success": True, "results": results, "videoChunks": video_chunks}
