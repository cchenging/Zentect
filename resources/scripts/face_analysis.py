"""
face_analysis.py — 人脸分析端点模块
  /api/vision         — 人脸检测 + 特征提取（InsightFace）
  /api/cluster_faces  — HDBSCAN 无监督人脸聚类
"""
import os
import sys
import json
import traceback

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List

from ai_daemon import AIModels

router = APIRouter()


# ==========================================
# DTOs
# ==========================================
class VisionReq(BaseModel):
    image_paths: List[str]
    output_dir: str

class FaceFeature(BaseModel):
    face_id: str
    embedding: List[float]

class ClusterRequest(BaseModel):
    media_id: str
    faces: List[FaceFeature]
    persist_dir: str = ""


class LoadClustersRequest(BaseModel):
    media_id: str
    persist_dir: str = ""


# ==========================================
# /api/vision — 人脸检测 + 特征提取
# ==========================================
@router.post("/api/vision")
def api_vision(req: VisionReq):
    import cv2
    import numpy as np
    try:
        app_face = AIModels.get_face_app()
        results = []
        for img_path in req.image_paths:
            if not os.path.exists(img_path):
                continue
            img = cv2.imdecode(np.fromfile(img_path, dtype=np.uint8), cv2.IMREAD_COLOR)
            if img is None: continue
            faces = app_face.get(img)
            face_data = []
            for i, face in enumerate(faces):
                box = face.bbox.astype(int).tolist()
                face_img = img[max(0, box[1]):box[3], max(0, box[0]):box[2]]
                if face_img.size > 0:
                    face_filename = f"{os.path.splitext(os.path.basename(img_path))[0]}_{i}.jpg"
                    face_save_path = os.path.join(req.output_dir, face_filename)
                    cv2.imencode('.jpg', face_img)[1].tofile(face_save_path)

                    gender_val = 1
                    if isinstance(face.sex, str):
                        gender_val = 1 if face.sex.upper() == 'M' else 0
                    elif face.sex is not None:
                        gender_val = int(face.sex)

                    age_val = int(float(face.age)) if face.age is not None else 0

                    face_data.append({
                        "id": face_filename,
                        "bbox": box,
                        "gender": gender_val,
                        "age": age_val,
                        "embedding": face.embedding.tolist()
                    })
            results.append({"frame": img_path, "faces": face_data})
        return {"success": True, "data": results}
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


# ==========================================
# /api/cluster_faces — HDBSCAN 无监督人脸聚类 + 持久化
# ==========================================
@router.post("/api/cluster_faces")
async def cluster_faces(req: ClusterRequest):
    import numpy as np
    import hdbscan
    try:
        if not req.faces or len(req.faces) == 0:
            return {"success": True, "clusters": {}}

        embeddings = np.array([f.embedding for f in req.faces], dtype=np.float32)
        face_ids = [f.face_id for f in req.faces]

        clusters_map = {}
        if len(embeddings) >= 3:
            clusterer = hdbscan.HDBSCAN(min_cluster_size=2, metric='euclidean')
            cluster_labels = clusterer.fit_predict(embeddings)

            for f_id, label in zip(face_ids, cluster_labels):
                clusters_map[f_id] = f"role_{label}" if label != -1 else "role_unknown"
        else:
            for f_id in face_ids:
                clusters_map[f_id] = "role_0"

        # Persist clusters + embeddings for future reuse
        if req.persist_dir:
            try:
                os.makedirs(req.persist_dir, exist_ok=True)
                persist_path = os.path.join(req.persist_dir, f"clusters_{req.media_id}.json")
                persist_data = {
                    "media_id": req.media_id,
                    "clusters": clusters_map,
                    "embeddings": {f.face_id: f.embedding for f in req.faces}
                }
                with open(persist_path, 'w', encoding='utf-8') as pf:
                    json.dump(persist_data, pf, ensure_ascii=False)
            except Exception as pe:
                print(f"WARNING: 聚类持久化失败: {pe}", file=sys.stderr)

        return {"success": True, "clusters": clusters_map}
    except Exception as e:
        print(f"ERROR: 聚类引擎崩溃 - {str(e)}", file=sys.stderr)
        return {"success": False, "error": str(e), "clusters": {f.face_id: "role_unknown" for f in req.faces}}


# ==========================================
# /api/load_clusters — 加载已持久化的人脸聚类
# ==========================================
@router.post("/api/load_clusters")
def load_clusters(req: LoadClustersRequest):
    try:
        if not req.persist_dir:
            return {"success": False, "error": "persist_dir required"}
        persist_path = os.path.join(req.persist_dir, f"clusters_{req.media_id}.json")
        if not os.path.exists(persist_path):
            return {"success": False, "error": "No persisted clusters found"}

        with open(persist_path, 'r', encoding='utf-8') as pf:
            data = json.load(pf)
        return {
            "success": True,
            "clusters": data.get("clusters", {}),
            "embeddings": data.get("embeddings", {})
        }
    except Exception as e:
        return {"success": False, "error": str(e)}
