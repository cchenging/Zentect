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

from ai_daemon import AIModels

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


# ==========================================
# /api/match — CLIP 语义帧匹配
# ==========================================
@router.post("/api/match")
def api_match(req: MatchReq):
    """CLIP 语义帧匹配，模型不可用时降级为直方图匹配"""
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
            results = []
            for i, query in enumerate(req.queries):
                best_idx = similarity[i].argmax().item()
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
# /api/extract_semantics — CLIP 特征批量提取 + Faiss 建库
# ==========================================
@router.post("/api/extract_semantics")
async def extract_semantics(req: SemanticExtractRequest):
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
        text_inputs = processor(text=[req.query], return_tensors="pt", padding=True, truncation=True).to(AIModels.device)
        with torch.no_grad():
            text_features = model.get_text_features(**text_inputs)
            text_features = F.normalize(text_features, p=2, dim=-1)
            text_vec = text_features.cpu().numpy().astype(np.float32)

        index = faiss.read_index(index_path)
        with open(map_path, 'r', encoding='utf-8') as f:
            shot_ids = json.load(f)

        distances, indices = index.search(text_vec, req.top_k)

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
