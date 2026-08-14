"""
face_analysis.py — 人脸分析端点模块
  /api/vision         — 人脸检测 + 特征提取（InsightFace）
  /api/cluster_faces  — HDBSCAN 无监督人脸聚类
"""
import os
import sys
import json
import traceback

import numpy as np  # 🎭 P0.5+ 模块级导入：后处理辅助函数也需使用，避免重复导入
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List

from ai_config import AIModels, INFERENCE_LOCK

router = APIRouter()


# ==========================================
# 方案 A：检测保持 CPU，识别(ArcFace)/3D关键点切换 DirectML 加速
# ==========================================
# _DML_PATCH_STATE 取值：
#   None  — 尚未尝试注入
#   True  — 已成功将 recognition / landmark_3d_68 切换到 DmlExecutionProvider
#   False — DirectML 不可用或注入失败，已回退原 CPU session
_DML_PATCH_STATE = None
_DML_TARGET_MODELS = ("recognition", "landmark_3d_68")


def _try_patch_dml(app_face):
    """将 recognition 与 landmark_3d_68 的 session 替换为 DmlExecutionProvider。

    - detection(det_10g) 保持 CPU 1280 不变（该模型在 1280 输入下 DML 无法运行）
    - DML 不可用、模型缺失或任一 session 创建失败时，整体回退原 CPU session
    - 幂等：仅首次调用尝试，结果缓存于 _DML_PATCH_STATE，避免每次请求重复建会话
    """
    global _DML_PATCH_STATE
    if _DML_PATCH_STATE is not None:
        return

    _DML_PATCH_STATE = False  # 默认按回退处理，全部成功后再置 True
    try:
        import onnxruntime as ort
        if "DmlExecutionProvider" not in ort.get_available_providers():
            print("[AI Daemon] ⚠️ DirectML 不可用，人脸识别/关键点保持 CPU",
                  file=sys.stderr)
            return

        new_sessions = {}
        for name in _DML_TARGET_MODELS:
            model = app_face.models.get(name)
            if model is None:
                print(f"[AI Daemon] ⚠️ 模型 {name} 缺失，DirectML 注入中止",
                      file=sys.stderr)
                return
            src = (getattr(model, "model_file", None)
                   or getattr(model.session, "_model_path", None))
            if not src or not os.path.exists(src):
                print(f"[AI Daemon] ⚠️ 模型 {name} 路径无效，DirectML 注入中止",
                      file=sys.stderr)
                return
            # 先全部创建成功，再统一替换，保证原子性（任一失败整体回退 CPU）
            new_sessions[name] = ort.InferenceSession(
                src, providers=["DmlExecutionProvider", "CPUExecutionProvider"]
            )

        for name, sess in new_sessions.items():
            app_face.models[name].session = sess
            print(f"[AI Daemon] ✅ {name} 已切换 DirectML (DmlExecutionProvider)",
                  file=sys.stderr)
        _DML_PATCH_STATE = True
    except Exception as e:
        print(f"[AI Daemon] ⚠️ DirectML 注入失败，人脸识别/关键点保持 CPU: {e}",
              file=sys.stderr)


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
    # 🎭 四重质量门禁参数（可调，缺省用经验最优值）
    #   洋葱式过滤：先尺寸 → 再姿态角 → 再清晰度 → 再置信度，
    #   提前剔除低质量人脸，避免脏向量进入聚类污染角色识别
    min_size: float = 60          # 人脸 BBox 最小边长（px），小于视为背景路人
    max_pose_angle: float = 30    # 俯仰/偏航角上限（度），过滤大侧脸/低头抬头脸
    min_clarity: float = 100      # 拉普拉斯方差下限，过滤运动模糊脸
    min_confidence: float = 0.70  # 检测置信度下限（InsightFace det_score）

class FaceFeature(BaseModel):
    face_id: str
    embedding: List[float]

class ClusterRequest(BaseModel):
    media_id: str
    faces: List[FaceFeature]
    persist_dir: str = ""
    # 🎭 P0.5+ 余弦相似度阈值：HDBSCAN 聚类后，用于合并过拆簇 + 分配噪声点
    # InsightFace ArcFace 512维归一化 embedding 经验值：
    #   0.65 — 宽松（同一人不同角度/表情基本能合并，偶有误合并）
    #   0.70 — 平衡（推荐默认，多数场景准确）
    #   0.75 — 严格（同人物差异较大时可能仍拆分）
    #   0.82 — 极严格（旧版隐式行为，导致同人物被拆成多个角色）
    cosine_threshold: float = 0.70


class LoadClustersRequest(BaseModel):
    media_id: str
    persist_dir: str = ""


# ==========================================
# /api/vision — 人脸检测 + 特征提取
# ==========================================
@router.post("/api/vision")
def api_vision(req: VisionReq):
    """人脸检测 + 特征提取（带全局推理锁保护，防止并发原生库崩溃）

    四重质量门禁（洋葱式过滤，任一不合格直接丢弃该人脸）：
      ① 尺寸：边长 < min_size(60px) 视为背景路人
      ② 姿态角：yaw/pitch > max_pose_angle(30°) 的大侧脸/低头抬头脸剔除
      ③ 清晰度：ROI 拉普拉斯方差 < min_clarity(100) 的运动模糊脸剔除
      ④ 置信度：det_score < min_confidence(0.70) 的低置信检测剔除
    """
    import cv2
    try:
        with INFERENCE_LOCK:
            app_face = AIModels.get_face_app()
            _try_patch_dml(app_face)  # 方案 A：识别/关键点切 DirectML，检测保持 CPU
            results = []
            # 💥 诊断日志：统计检测总数与各门禁过滤数
            total_detected = 0
            total_kept = 0
            gate_stats = {"size": 0, "pose": 0, "clarity": 0, "confidence": 0}
            for frame_index, img_path in enumerate(req.image_paths):
                if not os.path.exists(img_path):
                    continue
                img = cv2.imdecode(np.fromfile(img_path, dtype=np.uint8), cv2.IMREAD_COLOR)
                if img is None: continue
                faces = app_face.get(img)
                total_detected += len(faces)
                face_data = []
                for i, face in enumerate(faces):
                    box = face.bbox.astype(int).tolist()

                    # ① 尺寸门禁：过滤过小/远景模糊脸
                    box_w = max(0, box[2] - box[0])
                    box_h = max(0, box[3] - box[1])
                    if box_w < req.min_size or box_h < req.min_size:
                        gate_stats["size"] += 1
                        continue

                    # ② 姿态角门禁：过滤大侧脸/低头抬头脸（pose = [pitch, yaw, roll]）
                    #    侧脸/极端角度下 embedding 失真，易被聚类成新角色
                    pose = getattr(face, 'pose', None)
                    if pose is not None:
                        pitch = float(pose[0])
                        yaw = float(pose[1])
                        if abs(yaw) > req.max_pose_angle or abs(pitch) > req.max_pose_angle:
                            gate_stats["pose"] += 1
                            continue

                    face_img = img[max(0, box[1]):box[3], max(0, box[0]):box[2]]
                    if face_img.size == 0:
                        continue

                    # ③ 清晰度门禁：ROI 拉普拉斯方差，过滤运动撕裂/失焦模糊脸
                    gray_roi = cv2.cvtColor(face_img, cv2.COLOR_BGR2GRAY)
                    clarity = float(cv2.Laplacian(gray_roi, cv2.CV_64F).var())
                    if clarity < req.min_clarity:
                        gate_stats["clarity"] += 1
                        continue

                    # ④ 置信度门禁：过滤低置信度检测
                    det_score = float(getattr(face, 'det_score', 1.0))
                    if det_score < req.min_confidence:
                        gate_stats["confidence"] += 1
                        continue

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
                        "embedding": face.embedding.tolist(),
                        # 🎭 质量门禁原始值：供下游聚类/角色分级参考
                        "pose": [float(x) for x in pose] if pose is not None else None,
                        "det_score": det_score,
                        "clarity": clarity,
                        # 🎭 P0.5 帧级锚定：补 frame/frame_index 字段
                        # 让下游能知道该人脸来自哪一帧，构建 frameRoles 映射
                        "frame": img_path,
                        "frame_index": frame_index
                    })
                total_kept += len(face_data)
                results.append({"frame": img_path, "frame_index": frame_index, "faces": face_data})
            filtered = sum(gate_stats.values())
            print(
                f"[vision] 本批 {len(req.image_paths)} 帧: 检测 {total_detected} 张, 保留 {total_kept} 张 "
                f"(过滤 {filtered} 张: 尺寸{gate_stats['size']} 姿态{gate_stats['pose']} "
                f"清晰度{gate_stats['clarity']} 置信度{gate_stats['confidence']})",
                file=sys.stdout,
            )
        return {"success": True, "data": results}
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


# ==========================================
# /api/cluster_faces — HDBSCAN 无监督人脸聚类 + 持久化
# ==========================================
@router.post("/api/cluster_faces")
async def cluster_faces(req: ClusterRequest):
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

            # 🎭 P0.5+ 后处理 1：基于余弦相似度合并过拆簇
            # HDBSCAN 的 leaf 法会保留小簇，导致同一人物因角度/表情差异被拆成多个簇。
            # 这里计算每个簇的中心（归一化 embedding 均值），用余弦相似度合并相似簇。
            cluster_labels = _merge_clusters_by_cosine(
                embeddings, cluster_labels, req.cosine_threshold
            )

            # 🎭 P0.5+ 后处理 2：噪声点就近分配
            # label=-1 的噪声点（模糊/侧脸/远景）若与某簇心的余弦相似度超过阈值，
            # 则分配到该簇，避免高质量人脸因孤立而被丢弃。
            cluster_labels = _assign_noise_points(
                embeddings, cluster_labels, req.cosine_threshold
            )

            # 统计聚类结果用于日志
            unique_labels = set(cluster_labels)
            label_counts = {label: list(cluster_labels).count(label) for label in unique_labels}
            n_clusters = len(unique_labels) - (1 if -1 in unique_labels else 0)
            n_noise = label_counts.get(-1, 0)
            print(f"[cluster] 总人脸: {len(face_ids)}, 聚类数: {n_clusters}, 噪声点: {n_noise}, 分布: {label_counts} (cosine_threshold={req.cosine_threshold})", file=sys.stdout)

            # 🎭 P0.5+ 重新编号簇 label（合并后可能不连续，统一重排为 0,1,2,...）
            unique_sorted = sorted([l for l in unique_labels if l != -1])
            label_remap = {old: new_idx for new_idx, old in enumerate(unique_sorted)}
            for f_id, label in zip(face_ids, cluster_labels):
                new_label = label_remap.get(label, -1)
                clusters_map[f_id] = f"role_{new_label}" if new_label != -1 else "role_unknown"
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
# 🎭 P0.5+ 聚类后处理：基于余弦相似度合并过拆簇 + 分配噪声点
# ==========================================

def _compute_cluster_centers(embeddings: "np.ndarray", labels: "np.ndarray") -> dict:
    """计算每个簇的中心向量（归一化 embedding 的均值，再归一化）
    @param embeddings [N, D] 所有人脸的 embedding（已归一化）
    @param labels [N] 簇标签，-1 为噪声
    @return {label: center_vector [D]} 不含 -1 噪声簇
    """
    centers = {}
    unique_labels = set(labels.tolist())
    for label in unique_labels:
        if label == -1:
            continue
        mask = labels == label
        cluster_embeddings = embeddings[mask]
        # 归一化 embedding 的均值，再归一化（保证中心也在单位球面）
        center = cluster_embeddings.mean(axis=0)
        norm = np.linalg.norm(center)
        if norm > 1e-6:
            center = center / norm
        centers[label] = center
    return centers


def _cosine_similarity(a: "np.ndarray", b: "np.ndarray") -> float:
    """计算两个向量的余弦相似度（假设已归一化，直接点积）"""
    return float(np.dot(a, b))


def _merge_clusters_by_cosine(embeddings: "np.ndarray", labels: "np.ndarray", threshold: float) -> "np.ndarray":
    """合并余弦相似度超过阈值的簇
    算法：贪心合并
      1. 计算所有簇心两两余弦相似度
      2. 按相似度降序排列，依次合并（合并后重新计算簇心）
      3. 直到所有相似度都低于阈值
    @param embeddings [N, D] 所有人脸 embedding
    @param labels [N] 原始簇标签
    @param threshold 余弦相似度阈值，相似度 > threshold 的簇合并
    @return 合并后的 labels（label 值可能不连续，后续会重排）
    """
    if threshold <= 0 or threshold >= 1:
        return labels  # 阈值无效时不处理

    labels = labels.copy()
    while True:
        centers = _compute_cluster_centers(embeddings, labels)
        cluster_ids = list(centers.keys())
        if len(cluster_ids) < 2:
            break

        # 计算所有簇心两两相似度，找最高的一对
        best_pair = None
        best_sim = threshold  # 必须严格 > threshold 才合并
        for i in range(len(cluster_ids)):
            for j in range(i + 1, len(cluster_ids)):
                sim = _cosine_similarity(centers[cluster_ids[i]], centers[cluster_ids[j]])
                if sim > best_sim:
                    best_sim = sim
                    best_pair = (cluster_ids[i], cluster_ids[j])

        if best_pair is None:
            break

        # 合并：把 j 簇的所有样本归入 i 簇（保留较小的 label）
        keep_label, merge_label = sorted(best_pair)
        labels[labels == merge_label] = keep_label
        print(f"[cluster] 合并簇 {merge_label} → {keep_label} (cosine={best_sim:.3f})", file=sys.stdout)

    return labels


def _assign_noise_points(embeddings: "np.ndarray", labels: "np.ndarray", threshold: float) -> "np.ndarray":
    """将噪声点（label=-1）分配到最近的簇（若余弦相似度 > threshold）
    @param embeddings [N, D] 所有人脸 embedding
    @param labels [N] 簇标签，-1 为噪声
    @param threshold 余弦相似度阈值，相似度 > threshold 时分配
    @return 分配后的 labels
    """
    if threshold <= 0 or threshold >= 1:
        return labels

    centers = _compute_cluster_centers(embeddings, labels)
    if not centers:
        # 没有任何有效簇（全是噪声），无法分配
        return labels

    labels = labels.copy()
    noise_indices = np.where(labels == -1)[0]
    if len(noise_indices) == 0:
        return labels

    cluster_ids = list(centers.keys())
    center_matrix = np.array([centers[cid] for cid in cluster_ids])  # [K, D]

    assigned_count = 0
    for idx in noise_indices:
        # 计算该噪声点到所有簇心的余弦相似度
        sims = center_matrix @ embeddings[idx]  # [K]
        best_k = int(np.argmax(sims))
        best_sim = float(sims[best_k])
        if best_sim > threshold:
            labels[idx] = cluster_ids[best_k]
            assigned_count += 1

    if assigned_count > 0:
        print(f"[cluster] 噪声点分配: {assigned_count}/{len(noise_indices)} 个噪声点就近分配到簇 (threshold={threshold})", file=sys.stdout)

    return labels


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
