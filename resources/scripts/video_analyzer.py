"""
video_analyzer.py — 视频场景切片检测模块
  /api/video/detect_scene_chunks — FFmpeg/OpenCV 并发场景检测 + CLIP 视觉特征预提取
"""
import os
import sys
import traceback
import asyncio
import re

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from ai_config import AIModels, PROJECT_MATERIAL_POOL, FFMPEG_PATH, INFERENCE_LOCK

router = APIRouter()


# ==========================================
# DTOs
# ==========================================
class SceneChunkReq(BaseModel):
    """场景切割请求"""
    file_path: str
    output_dir: str
    threshold: float = 0.3
    min_chunk_duration_sec: float = 1.0
    mediaId: str = 'default'


@router.post("/api/video/detect_scene_chunks")
async def detect_scene_chunks(req: SceneChunkReq):
    """
    🚀 视觉切片算子：探测电影天然转场并利用 CLIP 视觉双塔提前刷写 512 维高维视觉语义
    - 宏观：按10分钟分段，多 FFmpeg 进程并发检测
    - 微观：每段内 FFmpeg C 优化的 scene detect 滤镜
    - 回退：FFmpeg 不可用时 OpenCV 并发检测
    - 缓存：通过 PROJECT_MATERIAL_POOL 避免重复计算
    """
    try:
        if not os.path.exists(req.file_path):
            return {"success": False, "error": f"Video file not found: {req.file_path}"}

        # 🚀 缓存命中：如果该 media_id 已切片，直接返回缓存结果，秒级响应
        media_id = req.mediaId or "default"
        if media_id in PROJECT_MATERIAL_POOL:
            return {"success": True, "data": PROJECT_MATERIAL_POOL[media_id], "fromCache": True}

        os.makedirs(req.output_dir, exist_ok=True)

        # 第一步：获取视频总时长
        loop = asyncio.get_running_loop()
        video_info = await loop.run_in_executor(None, _get_video_info, req.file_path)
        if not video_info:
            return {"success": False, "error": "无法读取视频文件信息"}
        duration_ms = video_info['duration_ms']
        fps = video_info['fps']

        # 第二步：宏观物理划区，按10分钟分段
        BLOCK_DURATION_MS = 600000  # 10分钟
        blocks = []
        current_start = 0
        block_idx = 0
        while current_start < duration_ms:
            current_end = min(current_start + BLOCK_DURATION_MS, duration_ms)
            blocks.append((current_start, current_end, block_idx))
            current_start = current_end
            block_idx += 1

        # 第三步：并发 FFmpeg 场景检测
        scene_changes_sec = []
        try:
            scene_changes_sec = await _detect_scenes_ffmpeg_concurrent(
                req.file_path, blocks, req.threshold, fps
            )
        except Exception:
            pass

        # FFmpeg 检测失败时回退到 OpenCV 并发检测
        if not scene_changes_sec:
            scene_changes_sec = await loop.run_in_executor(
                None, _detect_scenes_opencv_concurrent,
                req.file_path, blocks, req.threshold, req.min_chunk_duration_sec
            )

        # 第四步：构建切片并提取封面 + CLIP 512维视觉特征（CPU密集型，放入线程池）
        result = await loop.run_in_executor(
            None, _build_chunks_with_covers,
            req.file_path, req.output_dir, scene_changes_sec,
            req.min_chunk_duration_sec, media_id
        )

        # 🚀 写入素材池缓存，下次相同 media_id 秒级返回
        if result.get("success") and result.get("data"):
            PROJECT_MATERIAL_POOL[media_id] = result["data"]

        return result
    except Exception as e:
        print(f"ERROR: 场景切片检测崩溃 - {str(e)}", file=sys.stderr)
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


def _get_video_info(file_path: str) -> dict:
    """
    获取视频基本信息（时长、帧率）
    带全局推理锁保护，防止并发原生库崩溃
    """
    import cv2
    try:
        with INFERENCE_LOCK:
            cap = cv2.VideoCapture(file_path)
            if not cap.isOpened():
                return None
            fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
            total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
            duration_ms = total_frames / fps * 1000 if fps > 0 else 0
            cap.release()
            return {'duration_ms': duration_ms, 'fps': fps}
    except Exception:
        return None


async def _detect_scenes_ffmpeg_concurrent(file_path: str, blocks: list, threshold: float, fps: float) -> list:
    """
    🚀 分段并发 FFmpeg 场景检测
    将长视频按时间段切分，多个 FFmpeg 进程并发检测场景切换点
    2小时电影12段并发，速度提升约6-10倍
    """
    async def _detect_block(start_ms: int, end_ms: int, block_idx: int) -> list:
        """检测单个时间段的场景切换点"""
        start_sec = start_ms / 1000.0
        try:
            proc = await asyncio.create_subprocess_exec(
                FFMPEG_PATH,
                '-ss', f'{start_sec:.3f}',
                '-i', file_path,
                '-to', f'{(end_ms - start_ms) / 1000.0:.3f}',
                '-filter:v', f"select='gt(scene,{threshold})',showinfo",
                '-f', 'null', '-',
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            try:
                stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=120)
                stderr_text = stderr.decode('utf-8', errors='replace')
            except asyncio.TimeoutError:
                proc.kill()
                return []

            changes = []
            for line in stderr_text.split('\n'):
                m = re.search(r'pts_time:(\d+\.?\d*)', line)
                if m:
                    abs_time = float(m.group(1)) + start_sec
                    changes.append(abs_time)
            return changes
        except Exception:
            return []

    tasks = [_detect_block(s, e, idx) for s, e, idx in blocks]
    results = await asyncio.gather(*tasks)

    all_changes = []
    for block_changes in results:
        all_changes.extend(block_changes)
    all_changes.sort()
    return all_changes


def _detect_scenes_opencv_concurrent(file_path: str, blocks: list, threshold: float, min_chunk_duration_sec: float) -> list:
    """
    🚀 OpenCV 并发回退检测：按时间段并发执行直方图对比
    仅在 FFmpeg 不可用时使用
    带全局推理锁保护，防止并发原生库崩溃
    """
    import cv2
    import numpy as np
    from concurrent.futures import ThreadPoolExecutor
    def _detect_block_opencv(start_ms: int, end_ms: int, block_idx: int) -> list:
        """检测单个时间段的场景切换点（OpenCV 实现），带全局推理锁保护"""
        scene_changes = []
        try:
            with INFERENCE_LOCK:
                cap = cv2.VideoCapture(file_path)
                if not cap.isOpened():
                    return []
                fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
                start_frame = int((start_ms / 1000.0) * fps)
                end_frame = int((end_ms / 1000.0) * fps)
                cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)

                prev_hist = None
                min_gap_frames = int(min_chunk_duration_sec * fps)
                last_change = start_frame - min_gap_frames
                frame_idx = start_frame

                while frame_idx < end_frame:
                    ret, frame = cap.read()
                    if not ret:
                        break
                    """ 🚀 每 5 帧做快速步长跳跃采样 """
                    if frame_idx % 5 == 0:
                        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
                        hist = cv2.calcHist([hsv], [0], None, [50], [0, 180])
                        cv2.normalize(hist, hist, 0, 1, cv2.NORM_MINMAX)
                        if prev_hist is not None:
                            diff = 1.0 - float(np.sum(np.minimum(prev_hist, hist)))
                            if diff > threshold and (frame_idx - last_change) >= min_gap_frames:
                                scene_changes.append(frame_idx / fps)
                                last_change = frame_idx
                        prev_hist = hist
                    frame_idx += 1
                cap.release()
        except Exception:
            pass
        return scene_changes

    max_workers = min(os.cpu_count() or 4, len(blocks))
    all_changes = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [
            executor.submit(_detect_block_opencv, s, e, idx)
            for s, e, idx in blocks
        ]
        for f in futures:
            all_changes.extend(f.result())

    all_changes.sort()
    return all_changes


def _compute_chunk_motion_scores(file_path: str, boundaries_sec: list, min_chunk_duration_sec: float) -> dict:
    """
    计算每个切片的运动显著性得分（motionScore）
    原理：切片内每 0.5 秒采样一帧，求相邻采样帧灰度绝对差的均值，归一化到 0~1
    - 值越高：画面运动越剧烈（动作戏 / 快速运镜）
    - 值越低：画面越静态（对话 / 空镜）
    归一化基准：灰度差 0~255，25 作为"显著运动"的经验分界，超出部分封顶到 1.0
    性能设计：流式读取（seek 到切片起点后顺序 grab 跳帧），每个切片最多解码 12 帧，
    不持有 INFERENCE_LOCK（纯 OpenCV 帧差，与模型推理无关，避免与 CLIP 串行卡顿）
    """
    import cv2
    import numpy as np

    motion_scores = {}
    try:
        cap = cv2.VideoCapture(file_path)
        if not cap.isOpened():
            print("[motion] 无法打开视频，跳过运动显著性计算", file=sys.stderr)
            return motion_scores
        fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
        if total_frames <= 0 or fps <= 0:
            cap.release()
            return motion_scores

        SAMPLE_INTERVAL = max(1, int(fps * 0.5))  # 每 0.5 秒采样一帧
        SAMPLE_MAX = 12  # 每个切片最多采样 12 帧，控制 CPU 开销
        for i in range(len(boundaries_sec) - 1):
            start_sec = boundaries_sec[i]
            end_sec = boundaries_sec[i + 1]
            dur_sec = end_sec - start_sec
            if dur_sec < min_chunk_duration_sec:
                continue

            start_frame = int(start_sec * fps)
            end_frame = int(end_sec * fps)
            cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)

            prev_gray = None
            diffs = []
            frame_idx = start_frame
            # 流式读取：只解码采样帧，中间帧用 grab 跳过（grab 不解码，远快于 read）
            while frame_idx < end_frame and len(diffs) < SAMPLE_MAX:
                ret, frame = cap.read()
                if not ret:
                    break
                if prev_gray is None:
                    prev_gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                else:
                    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                    diff = float(np.mean(np.abs(gray.astype(np.float32) - prev_gray.astype(np.float32))))
                    diffs.append(diff)
                    prev_gray = None
                for _ in range(SAMPLE_INTERVAL - 1):
                    if not cap.grab():
                        break
                frame_idx += SAMPLE_INTERVAL

            if diffs:
                mean_diff = sum(diffs) / len(diffs)
                # 灰度差均值 / 25 → 0~1 归一化（25 以上视为显著运动）
                motion_scores[i] = min(1.0, mean_diff / 25.0)
        cap.release()
    except Exception as e:
        print(f"[motion] 运动显著性计算失败: {e}", file=sys.stderr)
    return motion_scores


def _build_chunks_with_covers(file_path: str, output_dir: str, scene_changes_sec: list, min_chunk_duration_sec: float, media_id: str = "default") -> dict:
    """
    🚀 根据场景切换时间点构建视频切片列表，批量提取封面图 + CLIP 512维视觉语义特征
    带全局推理锁保护，防止并发原生库崩溃
    """
    import cv2
    with INFERENCE_LOCK:
        cap = cv2.VideoCapture(file_path)
        fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
        duration_ms = total_frames / fps * 1000 if fps > 0 else 0
        cap.release()

    filtered_changes = []
    last_time = -min_chunk_duration_sec
    for t in scene_changes_sec:
        if t - last_time >= min_chunk_duration_sec:
            filtered_changes.append(t)
            last_time = t

    boundaries_sec = [0.0] + filtered_changes + [duration_ms / 1000.0]
    chunks = []

    # 计算每个切片的运动显著性得分（帧差法），用于镜头匹配打分与高潮动作截取
    motion_scores = _compute_chunk_motion_scores(file_path, boundaries_sec, min_chunk_duration_sec)

    cover_times = []
    for i in range(len(boundaries_sec) - 1):
        start_ms = round(boundaries_sec[i] * 1000, 1)
        end_ms = round(boundaries_sec[i + 1] * 1000, 1)
        chunk_duration_ms = end_ms - start_ms
        if chunk_duration_ms < min_chunk_duration_sec * 1000:
            continue
        mid_sec = (boundaries_sec[i] + boundaries_sec[i + 1]) / 2.0
        cover_times.append((i, mid_sec))

    cover_times.sort(key=lambda x: x[1])

    cover_paths = {}
    cover_frames_for_clip = []
    color_histograms = {}
    if cover_times:
        try:
            with INFERENCE_LOCK:
                cap = cv2.VideoCapture(file_path)
                for chunk_i, mid_sec in cover_times:
                    try:
                        cap.set(cv2.CAP_PROP_POS_MSEC, mid_sec * 1000)
                        ret, frame = cap.read()
                        if ret:
                            cover_name = f"chunk_{chunk_i:03d}_cover.jpg"
                            cpath = os.path.join(output_dir, cover_name)
                            cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 85])[1].tofile(cpath)
                            cover_paths[chunk_i] = cpath
                            cover_frames_for_clip.append((chunk_i, frame[:, :, ::-1]))
                            # 🎨 P1 衔接维度：封面帧 HSV 色相直方图（16 桶归一化），
                            #   供镜头匹配的"相邻切片色调连续性"检查（字段已预留 colorHistogram）
                            try:
                                import numpy as np
                                hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
                                hist = cv2.calcHist([hsv], [0], None, [16], [0, 180]).flatten()
                                total = float(np.sum(hist)) or 1.0
                                color_histograms[chunk_i] = (hist / total).tolist()
                            except Exception:
                                pass
                    except Exception:
                        pass
                cap.release()
        except Exception:
            pass

    vision_embeddings = {}
    if cover_frames_for_clip:
        try:
            model, processor = AIModels.get_clip()
            if model is not None and processor is not None:
                import torch
                import torch.nn.functional as F
                import numpy as np
                from PIL import Image

                pil_images = []
                chunk_indices = []
                for chunk_i, frame_rgb in cover_frames_for_clip:
                    try:
                        pil_images.append(Image.fromarray(frame_rgb))
                        chunk_indices.append(chunk_i)
                    except Exception:
                        continue

                if pil_images:
                    IMAGE_BATCH = 32
                    all_features = []
                    with INFERENCE_LOCK:
                        for batch_start in range(0, len(pil_images), IMAGE_BATCH):
                            batch_imgs = pil_images[batch_start:batch_start + IMAGE_BATCH]
                            image_inputs = processor(images=batch_imgs, return_tensors="pt", padding=True).to(AIModels.device)
                            with torch.no_grad():
                                batch_features = model.get_image_features(**image_inputs)
                            # 兼容 transformers 新版：get_image_features 返回 BaseModelOutputWithPooling
                            if hasattr(batch_features, 'pooler_output'):
                                batch_features = batch_features.pooler_output
                            batch_features = F.normalize(batch_features, p=2, dim=-1)
                            all_features.append(batch_features.cpu().numpy())
                            del image_inputs, batch_features

                    image_features = np.vstack(all_features)

                    for idx, (chunk_i, _) in enumerate(cover_frames_for_clip):
                        if idx < len(image_features):
                            vision_embeddings[chunk_i] = image_features[idx].tolist()

                    del pil_images, all_features, image_features
                    print(f"[CLIP] 预提取 {len(vision_embeddings)} 个切片的 512维视觉特征完成", file=sys.stderr)
            else:
                print("[CLIP] 模型不可用，跳过视觉特征预提取", file=sys.stderr)
        except Exception as e:
            print(f"[CLIP] 预提取视觉特征失败: {e}", file=sys.stderr)

    chunk_idx = 0
    for i in range(len(boundaries_sec) - 1):
        start_ms = round(boundaries_sec[i] * 1000, 1)
        end_ms = round(boundaries_sec[i + 1] * 1000, 1)
        chunk_duration_ms = end_ms - start_ms

        if chunk_duration_ms < min_chunk_duration_sec * 1000:
            continue

        chunk_id = f"chunk_{i:03d}"
        chunks.append({
            "id": chunk_id,
            "filePath": file_path,
            "startMs": start_ms,
            "endMs": end_ms,
            "durationMs": chunk_duration_ms,
            "motionScore": motion_scores.get(i, 0.0),
            "colorHistogram": color_histograms.get(i, []),
            "coverPath": cover_paths.get(i, ""),
            "visionEmbedding": vision_embeddings.get(i, []),
            "name": f"场景切片 {chunk_idx + 1}"
        })
        chunk_idx += 1

    return {
        "success": True,
        "data": chunks,
        "totalDurationMs": round(duration_ms, 1),
        "sceneChangeCount": len(filtered_changes)
    }
