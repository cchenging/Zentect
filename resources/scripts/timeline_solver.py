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
from ai_daemon import AIModels, KMMatchReq, PROJECT_MATERIAL_POOL

router = APIRouter()


@router.post("/api/solver/kuhn_munkres_match")
async def kuhn_munkres_match(req: KMMatchReq):
    """
    三维一体弹性时间轴对齐算法（时序块段级联匹配版）
    长电影场景下，将全局 O(N³) 的 KM 求解降级为时序分块的 K × O(n³) 级联匹配
    🚀 关键修复：CPU 密集型计算放入线程池，避免阻塞 uvicorn 事件循环
    """
    loop = asyncio.get_event_loop()
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


def _call_vlm_rerank(script_text: str, candidate_descriptions: list,
                     api_key: str, api_base: str, model: str = "gpt-4o") -> int:
    """
    调用 VLM（GPT-4o）从 top-3 候选切片中选出与文案最匹配的一个。
    返回 0/1/2，失败时返回 0（保持原匹配）。
    """
    import requests

    if not api_key or not api_base:
        print("[VLM裁决] 凭据不完整，跳过", file=sys.stderr)
        return 0

    prompt = (
        "从以下3个候选视频切片中，选出与解说词最匹配的一个。只输出数字 0、1 或 2。\n\n"
        f"解说词: {script_text}\n\n"
        f"切片0: {candidate_descriptions[0]}\n"
        f"切片1: {candidate_descriptions[1]}\n"
        f"切片2: {candidate_descriptions[2]}\n\n"
        "最佳匹配切片序号:"
    )

    try:
        url = api_base.rstrip('/') + "/chat/completions"
        payload = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
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
        content = body["choices"][0]["message"]["content"].strip()

        match = re.search(r'[0-2]', content)
        if match:
            return int(match.group())
        print(f"[VLM裁决] 响应无法解析数字: {content[:100]}", file=sys.stderr)
        return 0

    except Exception as e:
        print(f"[VLM裁决] 调用失败: {e}", file=sys.stderr)
        return 0


def _apply_vlm_rerank(results: list, queries, video_chunks: list,
                      valid_chunk_indices: list, semantic_sim,
                      n_queries: int, api_key: str, api_base: str,
                      model: str = "gpt-4o") -> list:
    """
    对置信度低于 VLM_CONFIDENCE_THRESHOLD 的匹配结果，收集 top-3 候选切片，
    调用 VLM 二次裁决，替换低置信度匹配。
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
        candidate_list = sorted(candidate_ci_indices)

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

            combined_score = sem_score * 0.8 + duration_penalty * 0.2
            scores.append((ci_idx, ci, combined_score))

        scores.sort(key=lambda x: x[2], reverse=True)
        top3 = scores[:3]

        if len(top3) < 2:
            continue

        # 补齐到 3 个
        while len(top3) < 3:
            top3.append(top3[-1])

        # 提取候选切片描述
        descriptions = []
        for _, ci, _ in top3:
            chunk = video_chunks[ci]
            desc = chunk.get("description") or chunk.get("visualDescription") or "无视觉描述"
            descriptions.append(str(desc))

        # 调用 VLM
        script_text = queries[qi].text
        chosen = _call_vlm_rerank(script_text, descriptions, api_key, api_base, model)

        if chosen == 0:
            continue  # VLM 认可当前最佳候选（即原匹配），无需替换

        # 替换匹配结果
        new_ci_idx, new_ci, new_score = top3[chosen]
        new_chunk = video_chunks[new_ci]

        result["chunkId"] = new_chunk.get("id", f"chunk_{new_ci:03d}")
        result["confidence"] = round(new_score, 4)
        result["coverPath"] = new_chunk.get("coverPath", "")
        result["chunkData"] = new_chunk
        vlm_reranked += 1

        print(f"[VLM裁决] {result['shotId']}: 置信度 {result['confidence']:.3f} → VLM 选择切片 {chosen}",
              file=sys.stderr)

    if vlm_reranked > 0:
        print(f"[VLM裁决] 共 {vlm_reranked} 条匹配被 VLM 重排", file=sys.stderr)

    return results


def _kuhn_munkres_match_sync(req: KMMatchReq) -> dict:
    """
    🚀 KM 全局排他性最优匹配算法
    - 优先使用切片中预提取的 CLIP 512维视觉特征（省去重复编码）
    - 代价矩阵：semantic_score * 0.8 + time_penalty * 0.2
    - 5分钟时序块级联分治，将 O(n³) 复杂度压制在可控范围内
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

    texts = [q.text for q in req.queries]

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
    text_features = None
    semantic_sim = np.zeros((n_queries, len(valid_chunk_indices)), dtype=np.float64)

    if has_pre_embeddings and model is not None and processor is not None:
        import torch
        import torch.nn.functional as F

        text_inputs = processor(text=enhanced_texts, return_tensors="pt", padding=True, truncation=True).to(AIModels.device)
        with torch.no_grad():
            text_features = model.get_text_features(**text_inputs)
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

        text_inputs = processor(text=enhanced_texts, return_tensors="pt", padding=True, truncation=True).to(AIModels.device)
        with torch.no_grad():
            text_features = model.get_text_features(**text_inputs)
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
                batch_features = model.get_image_features(**image_inputs)
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

                combined_score = sem_score * 0.8 + duration_penalty * 0.2
                local_cost[lqi, lci] = -combined_score

        if local_n_queries > local_n_chunks:
            padding = np.zeros((local_n_queries, local_n_queries - local_n_chunks), dtype=np.float64)
            local_cost = np.hstack([local_cost, padding])

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

            if req.bgmBeats:
                bgm_beats_ms = [b * 1000 for b in req.bgmBeats]
                closest_beat_ms = min(bgm_beats_ms, key=lambda x: abs(x - raw_end_time_ms))
                if abs(closest_beat_ms - raw_end_time_ms) < 250:
                    target_end_time_ms = closest_beat_ms

            final_video_duration_ms = target_end_time_ms - current_timeline_ms

            speed_factor = 1.0
            if final_video_duration_ms > 0 and video_dur_ms > 0:
                speed_factor = video_dur_ms / final_video_duration_ms
                speed_factor = max(0.7, min(1.5, speed_factor))

            combined_score = -local_cost[ri, ci]

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
            semantic_sim, n_queries,
            req.vlmApiKey, req.vlmApiBase, req.vlmApiModel,
        )

    return {"success": True, "results": results}
