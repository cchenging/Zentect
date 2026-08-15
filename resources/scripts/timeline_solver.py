"""
timeline_solver.py — KM 全局排他性最优匹配模块
  /api/solver/kuhn_munkres_match — 三维一体弹性时间轴对齐算法
"""
import os
import sys
import traceback
import re
import json
import asyncio
import concurrent.futures

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List
from ai_config import AIModels, PROJECT_MATERIAL_POOL, INFERENCE_LOCK

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


class KMMatchReq(BaseModel):
    """卡点匹配请求"""
    queries: List[KMMatchQuery]
    videoChunks: List[dict]
    bgmBeats: List[float] = []
    mediaId: str = 'default'
    translateToEnglish: bool = False
    llmApiKey: str = ''
    llmApiBase: str = ''
    llmApiModel: str = ''
    vlmApiKey: str = ''
    vlmApiBase: str = ''
    vlmApiModel: str = ''
    """🎵 P2 BPM 对齐卡点：BGM 曲目 BPM（librosa tempo 检测），>0 时启用整拍网格磁吸，<=0 回退单点鼓点吸附"""
    bpm: float = 0
    """🎵 P2 权重可配置：五项打分权重字典，键为 sem/emotion/motion/duration/role，缺省回退并归一化"""
    weights: dict = {}


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
async def kuhn_munkres_match(req: KMMatchReq):
    """
    三维一体弹性时间轴对齐算法（时序块段级联匹配版）
    长电影场景下，将全局 O(N³) 的 KM 求解降级为时序分块的 K × O(n³) 级联匹配
    🚀 关键修复：CPU 密集型计算放入线程池，避免阻塞 uvicorn 事件循环
    """
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


def _compute_combined_score(sem_score: float, duration_penalty: float, motion_score: float,
                            emotion_score: float = 0.5, role_score: float = 0.5,
                            weights: dict = None) -> float:
    """
    多因子综合打分：0.35 文本语义 + 0.2 情绪意境 + 0.15 画面运动 + 0.25 时长契合 + 0.05 角色契合
    - 语义：CLIP 图文余弦相似度归一化到 0~1
    - 情绪：文案情绪与切片情绪相容度（0~1，任一方缺失给中性 0.5）
    - 运动：切片 motionScore（0~1），画面运动越显著越贴合解说节奏
    - 时长：语音与切片时长契合度（exp 衰减，0~1）
    - 角色：解说期望角色与切片出现角色的契合度（0~1，任一方缺失给中性 0.5）
    权重设计防止"只看文字匹配，却选中一个时长严重不匹配、被强拉变速的怪异画面"；
    🎭 P0 意境维度：引入情绪项后语义权重从 0.5 降至 0.4，让"画面情绪符合文案意境"参与决策
    （情绪全缺失时 emotion_score=0.5 贡献常数 0.1，其余维度权重与旧权重接近，排序基本不变）。
    🎭 P1 角色维度：语义权重由 0.4 微降至 0.35，让出 0.05 给角色契合——软加成，命中主角加分、
    未命中仅中性值，不因角色信息缺失或误识别而破坏既有匹配排序。
    🎵 P2 权重可配置：从 weights 读取五项权重（缺省回退默认值），并对五项权重做归一化，
    让前端调参真正生效，不再依赖硬编码。
    """
    _default_weights = {
        'sem': 0.35, 'emotion': 0.2, 'motion': 0.15, 'duration': 0.25, 'role': 0.05,
    }
    w = {key: float(weights.get(key, _default_weights[key]))
         for key in _default_weights} if isinstance(weights, dict) else dict(_default_weights)
    total = sum(w.values())
    if total > 0:
        w = {key: value / total for key, value in w.items()}
    else:
        w = dict(_default_weights)
    return w['sem'] * sem_score + w['emotion'] * emotion_score + w['motion'] * motion_score \
        + w['duration'] * duration_penalty + w['role'] * role_score


def _call_llm_translate(texts: list, api_key: str, api_base: str, model: str) -> list:
    """
    调用 LLM 将中文文案批量翻译为英文，用于 CLIP 英文匹配。
    使用 OpenAI 兼容 API 接口，支持 GPT-4o/DeepSeek/Qwen 等任意模型。
    返回与 texts 等长的英文列表，翻译失败时返回空列表。"""
    import requests

    if not api_key or not api_base or not texts:
        print("[KM翻译] LLM 凭据不完整或 texts 为空，跳过翻译", file=sys.stderr)
        return []

    try:
        # 构建批量翻译 prompt
        texts_json = json.dumps(texts, ensure_ascii=False)
        prompt = (
            "You are a translator. Translate each Chinese text below into concise English "
            "suitable for CLIP image-text matching. Keep visual description keywords, "
            "remove filler words. Return a JSON array of translated strings, one per input text.\n\n"
            f"Input: {texts_json}\n\n"
            "Output (JSON array only, no markdown):"
        )

        url = api_base.rstrip('/') + "/chat/completions"
        payload = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.3,
            "max_tokens": 2048,
        }
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

        print(f"[KM翻译] 调用 {model} 翻译 {len(texts)} 条文案...", file=sys.stderr)
        resp = requests.post(url, json=payload, headers=headers, timeout=60)
        resp.raise_for_status()

        body = resp.json()
        content = body["choices"][0]["message"]["content"].strip()

        # 清洗 markdown 代码块包裹
        if content.startswith("```"):
            content = re.sub(r'^```(?:json)?\s*\n?', '', content)
            content = re.sub(r'\n?```\s*$', '', content)

        translated = json.loads(content)
        if not isinstance(translated, list):
            print(f"[KM翻译] LLM 返回非数组: {type(translated)}", file=sys.stderr)
            return []

        # 补齐长度：LLM 可能返回数量不一致
        result = [str(t).strip() for t in translated[:len(texts)]]
        while len(result) < len(texts):
            result.append("")
        print(f"[KM翻译] 翻译成功，返回 {len(result)} 条英文文案", file=sys.stderr)
        return result

    except requests.exceptions.Timeout:
        print(f"[KM翻译] LLM 翻译超时 (60s)", file=sys.stderr)
        return []
    except requests.exceptions.RequestException as e:
        print(f"[KM翻译] HTTP 请求失败: {e}", file=sys.stderr)
        return []
    except (json.JSONDecodeError, KeyError, IndexError) as e:
        print(f"[KM翻译] 响应解析失败: {e}，原始内容: {content[:200] if 'content' in dir() else 'N/A'}", file=sys.stderr)
        return []
    except Exception as e:
        print(f"[KM翻译] 未知错误: {e}", file=sys.stderr)
        traceback.print_exc()
        return []


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

            duration_penalty = 1.0
            if audio_dur_ms > 0 and video_dur_ms > 0:
                delta = abs(video_dur_ms - audio_dur_ms) / max(audio_dur_ms, 1)
                if video_dur_ms < audio_dur_ms:
                    duration_penalty = float(np.exp(-delta * 2))
                else:
                    duration_penalty = float(np.exp(-delta * 0.5))

            motion_score = float(chunk.get("motionScore") or 0.0)
            motion_score = max(0.0, min(1.0, motion_score))

            # 🎭 P0 意境维度：候选打分与 KM 主体一致计入情绪相容度
            emotion_score = float(emotion_sim[qi, ci_idx])

            # 🎭 P1 角色契合度：候选打分与 KM 主体一致计入角色命中
            role_score = float(role_sim[qi, ci_idx])

            combined_score = _compute_combined_score(sem_score, duration_penalty, motion_score, emotion_score, role_score, weights=weights)
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
            """计算 (query qi, 切片 ci_idx) 的综合分（与 KM 主体一致）"""
            chunk = video_chunks[valid_chunk_indices[ci_idx]]
            sem = max(0.0, min(1.0, (float(semantic_sim[qi, ci_idx]) + 1.0) / 2.0))
            emo = float(emotion_sim[qi, ci_idx])
            role = float(role_sim[qi, ci_idx])
            motion = max(0.0, min(1.0, float(chunk.get("motionScore") or 0.0)))
            dur = 1.0
            vdur = chunk.get("durationMs", 0)
            if audio_dur_ms > 0 and vdur > 0:
                d = abs(vdur - audio_dur_ms) / max(audio_dur_ms, 1)
                dur = float(np.exp(-d * 2)) if vdur < audio_dur_ms else float(np.exp(-d * 0.5))
            return _compute_combined_score(sem, dur, motion, emo, role, weights=weights), chunk

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
    n_queries = len(req.queries)

    video_chunks = req.videoChunks
    if (not video_chunks or len(video_chunks) == 0) and req.mediaId in PROJECT_MATERIAL_POOL:
        video_chunks = PROJECT_MATERIAL_POOL[req.mediaId]
        print(f"[KM] 命中 PROJECT_MATERIAL_POOL 缓存 (mediaId={req.mediaId})，切片数: {len(video_chunks)}", file=sys.stderr)

    n_chunks = len(video_chunks)

    if n_queries == 0 or n_chunks == 0:
        return {"success": True, "results": []}

    original_texts = [q.text for q in req.queries]
    texts = list(original_texts)

    # 🚀 英文匹配：将中文文案翻译为英文后参与 CLIP 文本编码
    if req.translateToEnglish and req.llmApiKey and req.llmApiBase and req.llmApiModel:
        print(f"[KM] 英文匹配已启用，翻译模型: {req.llmApiModel}", file=sys.stderr)
        try:
            english_texts = _call_llm_translate(texts, req.llmApiKey, req.llmApiBase, req.llmApiModel)
            if english_texts and len(english_texts) == len(texts):
                texts = [et if et else ct for et, ct in zip(english_texts, texts)]
                print(f"[KM] 英文匹配翻译完成，{sum(1 for i, t in enumerate(texts) if t != req.queries[i].text)}/{len(texts)} 条已替换", file=sys.stderr)
            else:
                print("[KM] 英文匹配翻译返回空，回退到中文匹配", file=sys.stderr)
        except Exception as e:
            print(f"[KM] 英文匹配翻译异常: {e}，回退到中文匹配", file=sys.stderr)
            traceback.print_exc()

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
    semantic_sim = np.zeros((n_queries, len(valid_chunk_indices)), dtype=np.float64)

    if zh_model is not None and zh_processor is not None:
        # 🚀 分支1：中文 CLIP（优先）——中文文案直编（无需翻译），切片封面用中文 CLIP 重新编码
        #    注意：英文 CLIP 预提取的 visionEmbedding 与中文 CLIP 特征空间不对齐，必须重编码图片
        import torch
        import torch.nn.functional as F
        from PIL import Image

        with INFERENCE_LOCK:
            zh_inputs = zh_processor(text=original_texts, return_tensors="pt", padding=True, truncation=True).to(AIModels.device)
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
                for ci in valid_chunk_indices[batch_start:batch_start + IMAGE_ENCODE_BATCH]:
                    cover = video_chunks[ci].get("coverPath", "")
                    if cover and os.path.exists(cover):
                        try:
                            with Image.open(cover) as img:
                                batch_imgs.append(img.convert("RGB"))
                        except Exception:
                            batch_imgs.append(Image.new('RGB', (224, 224), color=(128, 128, 128)))
                    else:
                        batch_imgs.append(Image.new('RGB', (224, 224), color=(128, 128, 128)))

                image_inputs = zh_processor(images=batch_imgs, return_tensors="pt", padding=True).to(AIModels.device)
                with torch.no_grad():
                    batch_features = _extract_pooler(zh_model.get_image_features(
                        pixel_values=image_inputs["pixel_values"],
                    ))
                all_image_features.append(F.normalize(batch_features, p=2, dim=-1))
                del image_inputs, batch_features, batch_imgs

            image_features = torch.cat(all_image_features, dim=0).cpu().numpy()
            del all_image_features

            image_sim = zh_text_features @ image_features.T  # (n_queries, n_chunks) 文案↔封面图像

            # 🎯 切片描述文本语义：文案 ↔ 切片描述（步骤2 逐帧 VLM 描述按时间轴聚合而来）
            #    有描述切片：语义 = 0.5*图像 + 0.5*描述文本（描述含动作/情绪/景别/台词，信息量远超单帧封面）
            #    无描述切片：语义 = 纯图像（空文本编码结果不可预测，必须掩码归零，不能参与混合）
            chunk_desc_texts = [(video_chunks[ci].get("description") or "").strip() for ci in valid_chunk_indices]
            has_desc = np.array([1.0 if t else 0.0 for t in chunk_desc_texts], dtype=np.float64)
            if has_desc.sum() > 0:
                desc_inputs = zh_processor(text=chunk_desc_texts, return_tensors="pt", padding=True, truncation=True).to(AIModels.device)
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
                            with Image.open(cover) as img:
                                batch_imgs.append(img.convert("RGB"))
                        except Exception:
                            batch_imgs.append(Image.new('RGB', (224, 224), color=(128, 128, 128)))
                    else:
                        batch_imgs.append(Image.new('RGB', (224, 224), color=(128, 128, 128)))

                image_inputs = processor(images=batch_imgs, return_tensors="pt", padding=True).to(AIModels.device)
                with torch.no_grad():
                    batch_features = _extract_pooler(model.get_image_features(**image_inputs))
                all_image_features.append(F.normalize(batch_features, p=2, dim=-1))
                del image_inputs, batch_features, batch_imgs

            image_features = torch.cat(all_image_features, dim=0)
            del all_image_features

            semantic_sim = torch.matmul(text_features, image_features.T).cpu().numpy()
            del text_features, image_features
        print(f"[KM] 使用封面图重新编码，完成 {len(valid_chunk_indices)} 个切片", file=sys.stderr)

    else:
        print("[KM] CLIP 不可用，降级为时长匹配模式", file=sys.stderr)
        semantic_sim = np.ones((n_queries, len(valid_chunk_indices)), dtype=np.float64) * 0.3

    # 🎭 P0 意境维度：构建文案情绪 ↔ 切片情绪相容度矩阵 (n_queries, n_chunks)
    #    切片情绪由步骤2 帧情绪按时间轴聚合而来（chunk.emotion），文案情绪来自步骤3 生成（query.emotion）
    query_emotions = [(q.emotion or '') for q in req.queries]
    chunk_emotions = [(video_chunks[ci].get("emotion") or '') for ci in valid_chunk_indices]
    emotion_sim = np.zeros((n_queries, len(valid_chunk_indices)), dtype=np.float64)
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
    role_sim = np.zeros((n_queries, len(valid_chunk_indices)), dtype=np.float64)
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
        block_queries = query_blocks.get(block_idx, [])
        block_chunk_indices = set()
        for offset in [-3, -2, -1, 0, 1, 2, 3]:
            block_chunk_indices.update(chunk_blocks.get(block_idx + offset, []))
        block_chunk_idx_list = sorted(block_chunk_indices)

        if not block_queries or not block_chunk_idx_list:
            continue

        local_n_queries = len(block_queries)
        local_n_chunks = len(block_chunk_idx_list)
        local_cost = np.zeros((local_n_queries, local_n_chunks), dtype=np.float64)

        for lqi, qi in enumerate(block_queries):
            for lci, ci_idx in enumerate(block_chunk_idx_list):
                ci = valid_chunk_indices[ci_idx]
                chunk = video_chunks[ci]
                audio_dur_ms = req.queries[qi].audioDurationMs or 0
                video_dur_ms = chunk.get("durationMs", 0)

                sem_score = float(semantic_sim[qi, ci_idx])
                sem_score = max(0.0, min(1.0, (sem_score + 1.0) / 2.0))

                duration_penalty = 1.0
                if audio_dur_ms > 0 and video_dur_ms > 0:
                    delta = abs(video_dur_ms - audio_dur_ms) / max(audio_dur_ms, 1)
                    if video_dur_ms < audio_dur_ms:
                        duration_penalty = float(np.exp(-delta * 2))
                    else:
                        duration_penalty = float(np.exp(-delta * 0.5))

                motion_score = float(chunk.get("motionScore") or 0.0)
                motion_score = max(0.0, min(1.0, motion_score))

                # 🎭 P0 意境维度：文案情绪与切片情绪相容度
                emotion_score = float(emotion_sim[qi, ci_idx])

                # 🎭 P1 角色契合度：解说期望角色与切片出现角色的命中率（软加成）
                role_score = float(role_sim[qi, ci_idx])

                combined_score = _compute_combined_score(sem_score, duration_penalty, motion_score, emotion_score, role_score, weights=req.weights)
                local_cost[lqi, lci] = -combined_score

        if local_n_queries > local_n_chunks:
            padding = np.zeros((local_n_queries, local_n_queries - local_n_chunks), dtype=np.float64)
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
            # 从当前时序块候选池中重选一个时长更贴近语音的未使用切片，避免强拉变速造成的鬼畜/变相
            if raw_speed_factor < 0.85 or raw_speed_factor > 1.15:
                best_ci = real_ci
                best_gap = abs(video_dur_ms - final_video_duration_ms)
                for cand_idx in block_chunk_idx_list:
                    cand_ci = valid_chunk_indices[cand_idx]
                    if cand_ci in global_used_chunks:
                        continue
                    cand_dur = video_chunks[cand_ci].get("durationMs", 0)
                    if cand_dur <= 0:
                        continue
                    gap = abs(cand_dur - final_video_duration_ms)
                    if gap < best_gap:
                        best_gap = gap
                        best_ci = cand_ci
                if best_ci != real_ci:
                    # 重选成功：占位新切片，并重算变速与综合得分
                    global_used_chunks.add(best_ci)
                    chunk = video_chunks[best_ci]
                    video_dur_ms = chunk.get("durationMs", 0)
                    print(f"[KM] shotId={query.shotId} 时长严重不匹配（变速 {raw_speed_factor:.2f} 超限），重选切片 {best_ci} 替代 {real_ci}", file=sys.stderr)
                    best_sem = float(semantic_sim[qi, chunk_rank[best_ci]])
                    best_sem = max(0.0, min(1.0, (best_sem + 1.0) / 2.0))
                    best_motion = float(chunk.get("motionScore") or 0.0)
                    best_motion = max(0.0, min(1.0, best_motion))
                    best_dur_pen = 1.0
                    if audio_dur_ms > 0 and video_dur_ms > 0:
                        d = abs(video_dur_ms - audio_dur_ms) / max(audio_dur_ms, 1)
                        best_dur_pen = float(np.exp(-d * 2)) if video_dur_ms < audio_dur_ms else float(np.exp(-d * 0.5))
                    # 🎭 P0 意境维度：变速重选同样计入情绪相容度，避免为了时长丢弃意境更贴合的切片
                    best_emotion = float(emotion_sim[qi, chunk_rank[best_ci]])
                    # 🎭 P1 角色契合度：变速重选同样计入角色命中，避免为了时长丢弃角色更贴合的切片
                    best_role = float(role_sim[qi, chunk_rank[best_ci]])
                    combined_score = _compute_combined_score(best_sem, best_dur_pen, best_motion, best_emotion, best_role, weights=req.weights)

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

    return {"success": True, "results": results}
