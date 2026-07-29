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

from ai_config import AIModels, INFERENCE_LOCK

router = APIRouter()


# ==========================================
# 辅助：统一错误响应格式（含 errorCode，便于 Node 端按错误类型分流处理）
# ==========================================
def _error(msg: str, code: str = "AI_PROCESS_FAILED") -> dict:
    return {"success": False, "error": msg, "errorCode": code}


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
    """人脸检测 + 特征提取（带全局推理锁保护，防止并发原生库崩溃）"""
    import cv2
    import numpy as np
    try:
        with INFERENCE_LOCK:
            app_face = AIModels.get_face_app()
            results = []
            # 💥 诊断日志：统计检测总数与过滤数
            total_detected = 0
            total_kept = 0
            for img_path in req.image_paths:
                if not os.path.exists(img_path):
                    continue
                img = cv2.imdecode(np.fromfile(img_path, dtype=np.uint8), cv2.IMREAD_COLOR)
                if img is None: continue
                faces = app_face.get(img)
                total_detected += len(faces)
                face_data = []
                for i, face in enumerate(faces):
                    box = face.bbox.astype(int).tolist()
                    # 💥 过滤过小的人脸：边长 < 40 像素的低质量检测
                    # 过小人脸通常是远景/模糊/侧脸，embedding 质量差，
                    # 进入聚类后会拉扯簇心或形成噪声点，反而降低角色识别准确率
                    box_w = max(0, box[2] - box[0])
                    box_h = max(0, box[3] - box[1])
                    if box_w < 40 or box_h < 40:
                        continue
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
                            "face_path": face_save_path,
                            "bbox": box,
                            "gender": gender_val,
                            "age": age_val,
                            "embedding": face.embedding.tolist()
                        })
                total_kept += len(face_data)
                results.append({"frame": img_path, "faces": face_data})
            print(f"[vision] 本批 {len(req.image_paths)} 帧: 检测 {total_detected} 张, 保留 {total_kept} 张 (过滤小脸 {total_detected - total_kept})", file=sys.stdout)
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
            # 💥 优化聚类参数，解决"只识别2个角色"的问题：
            # 1. min_cluster_size=2：最小簇大小（至少2张相似人脸才能成簇）
            # 2. min_samples=1：降低核心点阈值，让更多边界点被吸收到簇中（默认等于 min_cluster_size，过严格）
            # 3. cluster_selection_method='leaf'：leaf 方法保留更多小簇，适合人物识别（EOM 会合并相似簇）
            # 4. 移除 cluster_selection_epsilon：旧版 0.3 会合并距离 <0.3 的簇，
            #    但 InsightFace 512维归一化 embedding 在 euclidean 下 0.3 对应 cosine similarity ≈ 0.955，
            #    在数据少时可能误合并不同人 → 移除让算法自动决定
            clusterer = hdbscan.HDBSCAN(
                min_cluster_size=2,
                min_samples=1,
                metric='euclidean',
                cluster_selection_method='leaf',
            )
            cluster_labels = clusterer.fit_predict(embeddings)

            # 统计聚类结果用于日志
            unique_labels = set(cluster_labels)
            label_counts = {label: list(cluster_labels).count(label) for label in unique_labels}
            n_clusters = len(unique_labels) - (1 if -1 in unique_labels else 0)
            n_noise = label_counts.get(-1, 0)
            print(f"[cluster] 总人脸: {len(face_ids)}, 聚类数: {n_clusters}, 噪声点: {n_noise}, 分布: {label_counts}", file=sys.stdout)

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
        err = _error(str(e))
        err["clusters"] = {f.face_id: "role_unknown" for f in req.faces}
        return err


# ==========================================
# /api/load_clusters — 加载已持久化的人脸聚类
# ==========================================
@router.post("/api/load_clusters")
def load_clusters(req: LoadClustersRequest):
    try:
        if not req.persist_dir:
            return _error("persist_dir required", "FS_PATH_INVALID")
        persist_path = os.path.join(req.persist_dir, f"clusters_{req.media_id}.json")
        if not os.path.exists(persist_path):
            return _error("No persisted clusters found", "FS_PATH_INVALID")

        with open(persist_path, 'r', encoding='utf-8') as pf:
            data = json.load(pf)
        return {
            "success": True,
            "clusters": data.get("clusters", {}),
            "embeddings": data.get("embeddings", {})
        }
    except Exception as e:
        return _error(str(e))
