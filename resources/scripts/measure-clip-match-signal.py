# -*- coding: utf-8 -*-
"""
measure-clip-match-signal.py
P1 量化：真闭环 KM 命中率（final_km_hit_rate）
Baseline A/B/C/D 四组对比，验证 P0 时长惩罚改造是否真正翻盘。

用法:
  python measure-clip-match-signal.py --payload <km_payload.json> --labels <match_labels.json>

Baseline 定义（对齐 ADR 剖析文档）:
  A: 纯正文(无 visualIntent) + 原时长公式 + 原权重
  B: 正文 + LLM 生成 visualIntent(payload 自带) + 原时长公式 + 原权重
  C: 正文 + LLM 真值 visualIntent(labels 人工标注) + 原时长公式 + 原权重
  D: 正文 + LLM 真值 visualIntent(labels 人工标注) + 新时长函数 + 新权重

final_km_hit_rate:
  跑完整 KM（含时长/情绪/角色/锚定），提取每个 shot 的 matched_chunk_id，
  判断其 [startMs,endMs] 是否与人工标注合理区间 AcceptableRange 有重叠。
  hit_rate = 命中 shot 数 / 总 shot 数。

判定准则:
  D vs C 的 final_km_hit_rate 是否产生质的飞跃（如 35% -> 85%+），
  一锤定音验证 P0 有效性。
"""
import os
import sys
import json
import argparse
import math

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

sys.path.insert(0, r"F:\Tools\Zentect\resources\scripts")
os.chdir(r"F:\Tools\Zentect\resources\scripts")

from ai_config import AIModels
from timeline_solver import _extract_pooler, _emotion_compatibility, _compute_role_score, _compute_duration_score, _extract_frames_at_times

# ---------------- 时长公式 ----------------

def _legacy_duration_score(t_audio_ms: float, t_chunk_ms: float) -> float:
    """原时长公式：非对称指数惩罚（长素材 exp(-delta*0.5)，短素材 exp(-delta*2)），无下限保底。"""
    if t_audio_ms <= 0 or t_chunk_ms <= 0:
        return 1.0
    delta = abs(t_chunk_ms - t_audio_ms) / max(t_audio_ms, 1)
    if t_chunk_ms < t_audio_ms:
        return float(np.exp(-delta * 2))
    return float(np.exp(-delta * 0.5))


# ---------------- 权重 ----------------

LEGACY_WEIGHTS = {'sem': 0.4, 'emotion': 0.15, 'duration': 0.3, 'role': 0.15}
NEW_WEIGHTS = {'sem': 0.55, 'emotion': 0.15, 'duration': 0.2, 'role': 0.1}


def _combined(sem, dur, emo, role, weights):
    w = weights
    total = sum(w.values())
    w = {k: v / total for k, v in w.items()}
    return w['sem'] * sem + w['emotion'] * emo + w['duration'] * dur + w['role'] * role


# ---------------- 数据加载 ----------------

def load_payload(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def load_labels(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


# ---------------- 语义矩阵 ----------------

def encode_texts(zh_model, zh_processor, texts):
    """批量编码文本，返回 L2 归一化特征 (n, d)。"""
    with torch.no_grad():
        inputs = zh_processor(text=texts, return_tensors="pt", padding=True,
                              truncation=True, max_length=512).to(AIModels.device)
        feats = _extract_pooler(zh_model.get_text_features(
            input_ids=inputs["input_ids"], attention_mask=inputs["attention_mask"]))
        feats = F.normalize(feats, p=2, dim=-1).cpu().numpy()
    return feats


def split_chunks_for_phase5(chunks, max_dur_ms=3000):
    """阶段五模拟：把 >max_dur_ms 的切片按 max_dur_ms 均匀细分。
    子切片继承 description/emotion/characters 等文本字段，coverPath 置空（由抽帧兜底），
    id 追加 _sN 后缀，startMs/endMs 按细分边界更新。"""
    out = []
    for c in chunks:
        start = float(c.get("startMs") or 0)
        end = float(c.get("endMs") or start)
        dur = end - start
        if dur <= max_dur_ms:
            out.append(c)
            continue
        n = int(math.ceil(dur / max_dur_ms))
        for k in range(n):
            sub_start = start + dur * k / n
            sub_end = start + dur * (k + 1) / n
            sub = dict(c)
            sub["id"] = f"{c.get('id', 'chunk')}_s{k}"
            sub["startMs"] = round(sub_start, 1)
            sub["endMs"] = round(sub_end, 1)
            sub["durationMs"] = round(sub_end - sub_start, 1)
            sub["coverPath"] = ""  # 无封面，由抽帧兜底
            out.append(sub)
    return out


def precompute_image_features(zh_model, zh_processor, chunks, valid_idx, multi_frame=False):
    """
    预计算所有 chunk 的图像特征（单封面 或 >6s 头/中/尾 3 点平均池化），返回 (n_chunk, d)。
    供多组 baseline 复用，避免重复 ViT 编码。
    """
    IMAGE_ENCODE_BATCH = 64
    all_image_features = []
    for bs in range(0, len(valid_idx), IMAGE_ENCODE_BATCH):
        batch_imgs = []
        batch_frame_counts = []
        for ci in valid_idx[bs:bs + IMAGE_ENCODE_BATCH]:
            chunk = chunks[ci]
            dur_ms = float(chunk.get("durationMs") or 0)
            video_path = chunk.get("filePath", "")
            cover = chunk.get("coverPath", "")
            if multi_frame and dur_ms > 6000 and video_path and os.path.exists(video_path):
                start_ms = float(chunk.get("startMs") or 0)
                end_ms = float(chunk.get("endMs") or (start_ms + dur_ms))
                mid_ms = (start_ms + end_ms) / 2.0
                tail_ms = max(start_ms, end_ms - 200.0)
                frames = _extract_frames_at_times(video_path, [start_ms, mid_ms, tail_ms])
                valid_frames = [f for f in frames if f is not None]
                if len(valid_frames) >= 2:
                    batch_imgs.extend(valid_frames)
                    batch_frame_counts.append(len(valid_frames))
                    continue
            if cover and os.path.exists(cover):
                try:
                    with Image.open(cover) as img:
                        batch_imgs.append(img.convert("RGB"))
                except Exception:
                    batch_imgs.append(Image.new('RGB', (224, 224), color=(128, 128, 128)))
            elif video_path and os.path.exists(video_path):
                # 无封面（细分后的子切片）：从视频抽中点帧模拟 daemon 封面提取
                start_ms = float(chunk.get("startMs") or 0)
                end_ms = float(chunk.get("endMs") or (start_ms + dur_ms))
                mid_ms = (start_ms + end_ms) / 2.0
                frames = _extract_frames_at_times(video_path, [mid_ms])
                if frames and frames[0] is not None:
                    batch_imgs.append(frames[0])
                else:
                    batch_imgs.append(Image.new('RGB', (224, 224), color=(128, 128, 128)))
            else:
                batch_imgs.append(Image.new('RGB', (224, 224), color=(128, 128, 128)))
            batch_frame_counts.append(1)
        image_inputs = zh_processor(images=batch_imgs, return_tensors="pt", padding=True).to(AIModels.device)
        with torch.no_grad():
            bf = _extract_pooler(zh_model.get_image_features(pixel_values=image_inputs["pixel_values"]))
        bf = F.normalize(bf, p=2, dim=-1).cpu().numpy()
        feat_idx = 0
        for n_frames in batch_frame_counts:
            pooled = bf[feat_idx:feat_idx + n_frames].mean(axis=0)
            pooled = pooled / (np.linalg.norm(pooled) + 1e-9)
            all_image_features.append(pooled)
            feat_idx += n_frames
    return np.stack(all_image_features, axis=0)


def precompute_desc_features(zh_model, zh_processor, chunks, valid_idx):
    """预计算所有 chunk 的 description 文本特征（所有 baseline 共享，只算一次）。"""
    desc_texts = [(chunks[ci].get("description") or "").strip() for ci in valid_idx]
    has_desc = np.array([1.0 if t else 0.0 for t in desc_texts])
    if has_desc.sum() == 0:
        return None, has_desc
    desc_feats = encode_texts(zh_model, zh_processor, desc_texts)
    return desc_feats, has_desc


def build_semantic_matrix(zh_model, zh_processor, query_texts, chunks, valid_idx, image_features=None, desc_feats=None, has_desc=None):
    """
    计算 query 文本 与 每个 chunk 的语义相似度矩阵 (n_query, n_chunk)。
    图像通道用预计算的 image_features（单封面或多点采样，见 precompute_image_features）；
    文本通道用预计算的 desc_feats（见 precompute_desc_features），有描述才参与，0.5 图文 + 0.5 文本。
    """
    q_feats = encode_texts(zh_model, zh_processor, query_texts)
    image_sim = q_feats @ image_features.T

    if desc_feats is not None:
        text_sim = q_feats @ desc_feats.T
        text_sim *= has_desc[None, :]
        semantic_sim = np.where(has_desc[None, :] > 0, 0.5 * image_sim + 0.5 * text_sim, image_sim)
    else:
        semantic_sim = image_sim
    return semantic_sim


def apply_anchor(semantic_sim, queries, chunks, valid_idx, bonus=0.15):
    """时间轴锚定：query 起点落在某 chunk 区间内，给该 chunk 语义加成。"""
    for qi, q in enumerate(queries):
        q_start = float(q.get("startMs") or 0)
        if q_start <= 0:
            continue
        for ci_idx, ci in enumerate(valid_idx):
            c = chunks[ci]
            c_start = float(c.get("startMs") or 0)
            c_end = float(c.get("endMs") or c_start)
            if c_start <= q_start < c_end:
                semantic_sim[qi, ci_idx] = min(1.0, semantic_sim[qi, ci_idx] + bonus)
                break
    return semantic_sim


# ---------------- 完整 KM 打分与匹配 ----------------

def run_km(queries, chunks, valid_idx, semantic_sim, duration_fn, weights):
    """完整 KM 打分（语义/时长/情绪/角色）+ 匈牙利匹配，返回 (matched_chunk_ids, combined_matrix)。"""
    from scipy.optimize import linear_sum_assignment

    n_queries = len(queries)
    n_chunks = len(valid_idx)
    query_emotions = [(q.get("emotion") or '') for q in queries]
    chunk_emotions = [(chunks[ci].get("emotion") or '') for ci in valid_idx]
    query_roles = [[r for r in (q.get("characters") or []) if isinstance(r, str) and r.strip()] for q in queries]
    chunk_roles = [[r for r in (chunks[ci].get("characters") or []) if isinstance(r, str) and r.strip()] for ci in valid_idx]

    combined = np.zeros((n_queries, n_chunks))
    for qi in range(n_queries):
        audio_dur_ms = float(queries[qi].get("audioDurationMs") or 0)
        for ci_idx in range(n_chunks):
            chunk = chunks[valid_idx[ci_idx]]
            sem_score = max(0.0, min(1.0, (semantic_sim[qi, ci_idx] + 1.0) / 2.0))
            video_dur_ms = float(chunk.get("durationMs") or 0)
            duration_penalty = duration_fn(audio_dur_ms, video_dur_ms)
            emotion_score = _emotion_compatibility(query_emotions[qi], chunk_emotions[ci_idx])
            role_score = _compute_role_score(query_roles[qi], chunk_roles[ci_idx])
            combined[qi, ci_idx] = _combined(sem_score, duration_penalty, emotion_score, role_score, weights)

    cost = -combined
    row_ind, col_ind = linear_sum_assignment(cost)
    matched = [None] * n_queries
    for qi, ci_idx in zip(row_ind, col_ind):
        matched[qi] = chunks[valid_idx[ci_idx]]["id"]
    return matched, combined


def compute_hit_rate(matched_ids, queries, chunks, labels_queries):
    """final_km_hit_rate：matched_chunk 的 [startMs,endMs] 与 AcceptableRange 有重叠即命中。"""
    hits = 0
    total = 0
    details = []
    for qi, q in enumerate(queries):
        shot_id = q.get("shotId")
        label = (labels_queries or {}).get(shot_id)
        if not label or not label.get("acceptable_ranges"):
            continue
        total += 1
        matched_id = matched_ids[qi]
        # 找 matched chunk 的时间区间
        m_start = m_end = None
        for c in chunks:
            if c.get("id") == matched_id:
                m_start = float(c.get("startMs") or 0)
                m_end = float(c.get("endMs") or m_start)
                break
        hit = False
        if m_start is not None:
            for lo, hi in label["acceptable_ranges"]:
                if m_start < hi and m_end > lo:  # 区间重叠
                    hit = True
                    break
        hits += int(hit)
        details.append((shot_id, matched_id, m_start, m_end, hit))
    rate = hits / total if total > 0 else 0.0
    return rate, hits, total, details


# ---------------- 主流程 ----------------

def main():
    parser = argparse.ArgumentParser(description="P1 量化：真闭环 KM 命中率")
    parser.add_argument("--payload", required=True, help="km_payload.json 路径")
    parser.add_argument("--labels", required=True, help="match_labels.json 路径")
    args = parser.parse_args()

    payload = load_payload(args.payload)
    labels = load_labels(args.labels)
    chunks = payload["videoChunks"]
    queries = payload["queries"]

    # 项目名（从 payload 或 labels 推断）
    proj_name = None
    for pn in labels.get("projects", {}):
        proj_name = pn
    labels_queries = labels.get("projects", {}).get(proj_name, {}).get("queries", {}) if proj_name else {}

    valid_idx = [i for i, c in enumerate(chunks) if c.get("startMs") is not None]
    print(f"项目: {proj_name} | queries={len(queries)} chunks={len(chunks)} valid={len(valid_idx)}")

    # 加载 CLIP
    zh_model, zh_processor = AIModels.get_chinese_clip()

    # 四组 baseline 的 query 文本（与生产一致：visualIntent 优先，缺失回退正文）
    def q_text(q, mode):
        text = q.get("text") or ""
        if mode == "A":
            return text
        if mode == "B":
            return (q.get("visualIntent") or "").strip() or text
        if mode == "C" or mode == "D":
            vi = (labels_queries.get(q.get("shotId")) or {}).get("visualIntent_truth") or ""
            return vi.strip() or text
        return text

    baselines = [
        ("A", "纯正文 + 原时长 + 原权重", "A", _legacy_duration_score, LEGACY_WEIGHTS, False),
        ("B", "LLM生成visualIntent + 原时长 + 原权重", "B", _legacy_duration_score, LEGACY_WEIGHTS, False),
        ("C", "LLM真值visualIntent + 原时长 + 原权重", "C", _legacy_duration_score, LEGACY_WEIGHTS, False),
        ("D", "LLM真值visualIntent + 新时长 + 新权重", "D", _compute_duration_score, NEW_WEIGHTS, False),
        ("E", "D + 封面头中尾3点采样", "D", _compute_duration_score, NEW_WEIGHTS, True),
    ]

    print("\n=== Baseline 对比（final_km_hit_rate）===")
    print(f"{'组':<4}{'描述':<34}{'hit_rate':<10}{'命中':<8}{'总数'}")
    results = {}
    # 预计算图像特征（单封面 + 多点采样各一次，供 5 组复用）+ desc 文本特征（一次）
    single_img = precompute_image_features(zh_model, zh_processor, chunks, valid_idx, multi_frame=False)
    multi_img = precompute_image_features(zh_model, zh_processor, chunks, valid_idx, multi_frame=True)
    desc_feats, has_desc = precompute_desc_features(zh_model, zh_processor, chunks, valid_idx)
    for tag, desc, mode, dur_fn, weights, multi_frame in baselines:
        query_texts = [q_text(q, mode) for q in queries]
        img_feats = multi_img if multi_frame else single_img
        sem = build_semantic_matrix(zh_model, zh_processor, query_texts, chunks, valid_idx,
                                    image_features=img_feats, desc_feats=desc_feats, has_desc=has_desc)
        sem = apply_anchor(sem, queries, chunks, valid_idx)
        matched, combined = run_km(queries, chunks, valid_idx, sem, dur_fn, weights)
        rate, hits, total, details = compute_hit_rate(matched, queries, chunks, labels_queries)
        results[tag] = {"rate": rate, "hits": hits, "total": total, "matched": matched, "details": details}
        print(f"{tag:<4}{desc:<34}{rate*100:>6.1f}%   {hits}/{total}")

    # ============ F 组：阶段五 切片粒度下沉（>3s 均匀细分，封面按子切片中点抽帧） ============
    print("\n=== F 组：阶段五 切片粒度下沉（max_chunk_duration_sec=3.0）===")
    split_chunks = split_chunks_for_phase5(chunks, max_dur_ms=3000)
    split_valid = [i for i, c in enumerate(split_chunks) if c.get("startMs") is not None]
    print(f"细分后: chunks={len(split_chunks)} valid={len(split_valid)}")
    split_single = precompute_image_features(zh_model, zh_processor, split_chunks, split_valid, multi_frame=False)
    split_desc, split_has_desc = precompute_desc_features(zh_model, zh_processor, split_chunks, split_valid)
    f_query_texts = [q_text(q, "D") for q in queries]
    f_sem = build_semantic_matrix(zh_model, zh_processor, f_query_texts, split_chunks, split_valid,
                                  image_features=split_single, desc_feats=split_desc, has_desc=split_has_desc)
    f_sem = apply_anchor(f_sem, queries, split_chunks, split_valid)
    f_matched, f_combined = run_km(queries, split_chunks, split_valid, f_sem, _compute_duration_score, NEW_WEIGHTS)
    f_rate, f_hits, f_total, f_details = compute_hit_rate(f_matched, queries, split_chunks, labels_queries)
    results["F"] = {"rate": f_rate, "hits": f_hits, "total": f_total, "matched": f_matched, "details": f_details}
    print(f"F   细分切片 + 新时长 + 新权重      {f_rate*100:>6.1f}%   {f_hits}/{f_total}")

    # 判定准则
    if results["D"]["total"] > 0 and results["C"]["total"] > 0:
        d_rate = results["D"]["rate"]
        c_rate = results["C"]["rate"]
        delta = d_rate - c_rate
        verdict = "翻盘（P0 有效）" if delta >= 0.3 else ("持平/微升" if delta > 0 else "未翻盘")
        print(f"\n判定: D({d_rate*100:.1f}%) vs C({c_rate*100:.1f}%)  Δ={delta*100:+.1f}pp → {verdict}")

    # 明细
    print("\n=== 各 shot 匹配明细 ===")
    for tag in ["A", "B", "C", "D", "E", "F"]:
        print(f"\n[{tag}]")
        for shot_id, matched_id, m_start, m_end, hit in results[tag]["details"]:
            mark = "✓" if hit else "✗"
            print(f"  {shot_id} -> {matched_id} ({m_start}-{m_end}ms) {mark}")


if __name__ == "__main__":
    main()
