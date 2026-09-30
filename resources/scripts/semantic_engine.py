"""
semantic_engine.py — CLIP 语义端点模块
  /api/match            — CLIP 语义帧匹配（不可用时降级直方图）
  /api/extract_semantics — CLIP 特征批量提取 + Faiss 建库
  /api/search_semantics  — 文本搜画面
"""
import os
import sys
import traceback
import json

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List

from ai_config import AIModels, INFERENCE_LOCK

router = APIRouter()


# ==========================================
# DTOs
# ==========================================
class MatchQuery(BaseModel):
    shotId: str
    text: str

class MatchReq(BaseModel):
    queries: List[MatchQuery]
    frames_dir: str

class ShotImage(BaseModel):
    shot_id: str
    image_path: str

class SemanticExtractRequest(BaseModel):
    media_id: str
    shots: List[ShotImage]

class SemanticSearchRequest(BaseModel):
    media_id: str
    query: str
    top_k: int = 5

class TextEmbedRequest(BaseModel):
    texts: List[str]
    batch_size: int = 32


# ==========================================
# /api/match — CLIP 语义帧匹配
# ==========================================
@router.post("/api/match")
def api_match(req: MatchReq):
    """
    CLIP 语义帧匹配，模型不可用时降级为直方图匹配
    带全局推理锁保护，防止并发原生库崩溃
    """
    from PIL import Image
    try:
        model, processor = AIModels.get_clip()
        valid_frame_files = [f for f in os.listdir(req.frames_dir) if f.endswith('.jpg')]
        if not valid_frame_files or not req.queries:
            return {"success": True, "data": []}

        if model is not None and processor is not None:
            import torch
            import torch.nn.functional as F

            images = []
            for f in valid_frame_files:
                img_path = os.path.join(req.frames_dir, f)
                with Image.open(img_path) as img:
                    images.append(img.convert("RGB"))

            with INFERENCE_LOCK:
                inputs = processor(images=images, return_tensors="pt").to(AIModels.device)
                with torch.no_grad():
                    image_features = model.get_image_features(**inputs)
                image_features = F.normalize(image_features, p=2, dim=-1)

                texts = [q.text for q in req.queries]
                text_inputs = processor(text=texts, return_tensors="pt", padding=True, truncation=True).to(AIModels.device)
                with torch.no_grad():
                    text_features = model.get_text_features(**text_inputs)
                text_features = F.normalize(text_features, p=2, dim=-1)

                similarity = torch.matmul(text_features, image_features.T)
                similarity_np = similarity.cpu().numpy()

            results = []
            for i, query in enumerate(req.queries):
                best_idx = int(similarity_np[i].argmax())
                best_frame_name = valid_frame_files[best_idx]
                start_sec = max(0, int(''.join(filter(str.isdigit, best_frame_name)) or 1) - 1)
                results.append({
                    "shotId": query.shotId,
                    "text": query.text,
                    "matchedFrame": best_frame_name,
                    "startSec": start_sec
                })
            return {"success": True, "data": results}
        else:
            import cv2
            import numpy as np
            print("[AI Daemon] ⚠️ CLIP 不可用，/api/match 降级为直方图匹配", file=sys.stderr)

            frame_hists = []
            with INFERENCE_LOCK:
                for f in valid_frame_files:
                    img_path = os.path.join(req.frames_dir, f)
                    img = cv2.imdecode(np.fromfile(img_path, dtype=np.uint8), cv2.IMREAD_COLOR)
                    if img is not None:
                        hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
                        hist = cv2.calcHist([hsv], [0], None, [50], [0, 180])
                        cv2.normalize(hist, hist)
                        frame_hists.append(hist)
                    else:
                        frame_hists.append(None)

            results = []
            for i, query in enumerate(req.queries):
                frame_idx = int(i * len(valid_frame_files) / max(len(req.queries), 1))
                frame_idx = min(frame_idx, len(valid_frame_files) - 1)
                best_frame_name = valid_frame_files[frame_idx]
                start_sec = max(0, int(''.join(filter(str.isdigit, best_frame_name)) or 1) - 1)
                results.append({
                    "shotId": query.shotId,
                    "text": query.text,
                    "matchedFrame": best_frame_name,
                    "startSec": start_sec
                })
            return {"success": True, "data": results, "warning": "CLIP unavailable, using histogram fallback"}
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


# ==========================================
# /api/embed_texts — BGE 文本批量编码（帧级召回统一通道）
# ==========================================
@router.post("/api/embed_texts")
def api_embed_texts(req: TextEmbedRequest):
    """用 BGE 文本通道批量编码，返回 L2 归一化向量（余弦相似度 == 点积）。

    定位（P2 帧向量索引 / P3 帧召回）：与 match_cost 的「文案↔切片」语义主分**同源**
    （`AIModels.encode_texts`，[CLS] 池化 + L2 归一化），保证「帧召回」与「供给打分」
    用同一语义空间，召回进白名单的帧不会因编码口径漂移而与打分结论相悖。

    设计取舍：与 `get_text_embedder` 一致——模型缺失/加载失败**直接抛错**（HTTP 500），
    不静默降级返回常量向量；帧召回没有替代通道，降级会让召回退化为噪声并掩盖真实故障。
    """
    try:
        if not req.texts:
            return {"success": True, "dim": 0, "vectors": []}
        vecs = AIModels.encode_texts(req.texts, batch_size=req.batch_size)
        return {
            "success": True,
            "dim": int(vecs.shape[1]) if vecs.size else 0,
            "vectors": vecs.tolist(),
        }
    except Exception as e:
        print(f"ERROR: BGE 文本编码崩溃 - {str(e)}", file=sys.stderr)
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


# ==========================================
# /api/extract_semantics — CLIP 特征批量提取 + Faiss 建库
# ==========================================
@router.post("/api/extract_semantics")
async def extract_semantics(req: SemanticExtractRequest):
    """
    CLIP 特征批量提取 + Faiss 建库
    带全局推理锁保护，防止并发原生库崩溃
    """
    try:
        model, processor = AIModels.get_clip()
        if model is None or processor is None:
            return {"success": False, "error": "CLIP model unavailable, semantic extraction requires CLIP"}

        import torch
        import torch.nn.functional as F
        import numpy as np
        from PIL import Image
        import faiss

        shot_ids = []
        image_features_list = []

        BATCH_SIZE = 16

        with INFERENCE_LOCK:
            with torch.no_grad():
                for batch in AIModels.get_batches(req.shots, BATCH_SIZE):
                    valid_images = []
                    valid_ids = []

                    for shot in batch:
                        if os.path.exists(shot.image_path):
                            with Image.open(shot.image_path) as img:
                                valid_images.append(img.convert("RGB"))
                                valid_ids.append(shot.shot_id)

                    if not valid_images:
                        continue

                    inputs = processor(images=valid_images, return_tensors="pt", padding=True).to(AIModels.device)
                    features = model.get_image_features(**inputs)
                    features = F.normalize(features, p=2, dim=-1)

                    image_features_list.append(features.cpu().numpy().astype(np.float32))
                    shot_ids.extend(valid_ids)

        if not shot_ids:
            return {"success": True, "message": "No valid images found."}

        dimension = 512
        embeddings_matrix = np.vstack(image_features_list)

        with INFERENCE_LOCK:
            index = faiss.IndexFlatIP(dimension)
            index.add(embeddings_matrix)

            faiss_dir = os.path.join(AIModels.MODELS_DIR, "vector_dbs")
            os.makedirs(faiss_dir, exist_ok=True)

            index_path = os.path.join(faiss_dir, f"{req.media_id}.index")
            faiss.write_index(index, index_path)

        map_path = os.path.join(faiss_dir, f"{req.media_id}_map.json")
        with open(map_path, 'w', encoding='utf-8') as f:
            json.dump(shot_ids, f)

        print(f"[SEMANTIC SUCCESS] Indexed {len(shot_ids)} frames for media {req.media_id}", file=sys.stderr)
        return {"success": True, "indexed_count": len(shot_ids)}
    except Exception as e:
        print(f"ERROR: 语义提取崩溃 - {str(e)}", file=sys.stderr)
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


# ==========================================
# /api/search_semantics — 文本搜画面
# ==========================================
@router.post("/api/search_semantics")
async def search_semantics(req: SemanticSearchRequest):
    """
    文本搜画面
    带全局推理锁保护，防止并发原生库崩溃
    """
    try:
        faiss_dir = os.path.join(AIModels.MODELS_DIR, "vector_dbs")
        index_path = os.path.join(faiss_dir, f"{req.media_id}.index")
        map_path = os.path.join(faiss_dir, f"{req.media_id}_map.json")

        if not os.path.exists(index_path) or not os.path.exists(map_path):
            return {"success": False, "error": "Index not found. Please extract semantics first."}

        model, processor = AIModels.get_clip()
        if model is None or processor is None:
            return {"success": False, "error": "CLIP model unavailable, semantic search requires CLIP"}

        import torch
        import torch.nn.functional as F
        import numpy as np
        import faiss

        with INFERENCE_LOCK:
            text_inputs = processor(text=[req.query], return_tensors="pt", padding=True, truncation=True).to(AIModels.device)
            with torch.no_grad():
                text_features = model.get_text_features(**text_inputs)
                text_features = F.normalize(text_features, p=2, dim=-1)
                text_vec = text_features.cpu().numpy().astype(np.float32)

            index = faiss.read_index(index_path)
            distances, indices = index.search(text_vec, req.top_k)

        with open(map_path, 'r', encoding='utf-8') as f:
            shot_ids = json.load(f)

        results = []
        for dist, idx in zip(distances[0], indices[0]):
            if idx != -1 and idx < len(shot_ids):
                results.append({
                    "shot_id": shot_ids[idx],
                    "score": float(dist)
                })

        return {"success": True, "results": results}
    except Exception as e:
        print(f"ERROR: 语义检索崩溃 - {str(e)}", file=sys.stderr)
        raise HTTPException(status_code=500, detail=str(e))
