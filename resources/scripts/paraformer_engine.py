# -*- coding: utf-8 -*-
"""Paraformer-Large 中文 ASR 引擎门面（与 SenseVoice / faster-whisper 并列的第三个引擎）

设计原则：paraformer 全部逻辑收拢在本文件，audio_pipeline 只做 engine 分发（约 3 行）。
对外契约与现有引擎完全一致：

    transcribe_paraformer(req, task_id) -> {"success": True, "data": {...}} | _error 结构

复用现有后处理三段：_asr_postprocess_segments（去重合并）→ _filter_hallucination_segments
（幻觉过滤）→ _merge_fragments（碎句合并），保证与 SenseVoice 链路输出行为一致。

Paraformer（funasr 原生）特性：
- 零新增依赖（funasr AutoModel 本地目录加载，无需 trust_remote_code）
- 原生支持句子级时间戳与 hotword 热词重打分（纠剧集专名错别字）
"""
import json
import os
import re
import sys
import traceback

# 允许直接运行时找到同目录模块
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from ai_config import AIModels  # noqa: E402
from audio_pipeline import (  # noqa: E402
    _error,
    _set_progress,
    _asr_postprocess_segments,
    _filter_hallucination_segments,
    _merge_fragments,
    _fallback_split_by_punctuation,
)

# ── 模块级配置（集中管理，预留环境变量覆盖入口）──
PARAFORMER_CONFIG = {
    "model_dir": os.path.join(AIModels.MODELS_DIR, "paraformer_large"),
    "max_seg_sec": 30,                # VAD 单段上限（毫秒换算，对齐现有断句规范）
    "max_char_per_sub_sentence": 25,  # 子句细分上限（对齐现有规范）
}


def _clean_zh_spaces(text: str) -> str:
    """清理 Paraformer 输出中汉字之间的空格（其 text 常逐字/逐 token 加空格）。

    仅移除【汉字与汉字之间】的空格，保留英文单词间空格与数字、标点相邻的空格，
    使最终台词与 SenseVoice 契约一致（连贯无空格）。
    """
    if not text:
        return text
    return re.sub(r'(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])', '', text)


def _split_text_by_timestamp(text: str, timestamps) -> list | None:
    """将 Paraformer 整段 text 按标点切成子句，与句子级 timestamp 对齐。

    Paraformer 返回的 timestamp 是句子级 [[s_ms,e_ms],...]（毫秒），text 是整段文本。
    这里按常见中英文标点把 text 切成子句（保留标点），并校验数量与 timestamp 一致；
    数量不一致时不强行 zip（避免文本张冠李戴），返回 None 由上层走兜底分句。
    """
    if not text or not timestamps:
        return None
    text = text.strip()
    # 先按中英文强标点切（保留标点），再按弱标点/空格二次尝试
    parts = [p.strip() for p in re.split(r'(?<=[，。！？；、,.!?;])', text) if p.strip()]
    if len(parts) != len(timestamps):
        parts = [p.strip() for p in re.split(r'(?<=[，。！？；、,.!?;\s])', text) if p.strip()]
    if len(parts) != len(timestamps):
        return None
    segments = []
    for (s, e), t in zip(timestamps, parts):
        if t:
            # Paraformer timestamp 单位为毫秒，统一转秒对齐契约
            segments.append({"start": float(s) / 1000.0, "end": float(e) / 1000.0, "text": t})
    return segments or None


def transcribe_paraformer(req, task_id: str = ""):
    """Paraformer-Large 中文 ASR 主入口（返回契约与现有引擎完全一致）

    内部自管：模型懒加载、VAD 切段、热词注入、推理、时间戳处理、进度上报、
    后处理复用、异常时内存释放。
    """
    try:
        if task_id:
            _set_progress(task_id, pct=5, msg="正在加载 Paraformer 模型...")
        model = AIModels.get_paraformer()
        print(f"[ASR] 使用 Paraformer-Large + fsmn-vad，language={req.language}", file=sys.stderr)

        if task_id:
            _set_progress(task_id, pct=15, msg="使用 Paraformer 引擎 (funasr + fsmn-vad) 开始推理...")

        gen_kwargs = dict(
            input=req.audio_path,
            use_itn=True,
            batch_size_s=15,
            vad_model="fsmn-vad",
            vad_kwargs={"max_single_segment_time": PARAFORMER_CONFIG["max_seg_sec"] * 1000},
        )

        # 热词注入（可选）：Paraformer 独有能力，用于纠剧集专名错别字
        hotwords = getattr(req, "hotwords", None) or []
        if hotwords:
            gen_kwargs["hotword"] = "\n".join(hotwords)
            print(f"[ASR] Paraformer 注入热词 {len(hotwords)} 个: {hotwords[:10]}...", file=sys.stderr)

        res = model.generate(**gen_kwargs)

        all_segments = []
        for item in res:
            raw_text = (item.get("text") or "").strip()
            if not raw_text:
                continue
            raw_timestamps = item.get("timestamp", item.get("word_timestamp", None))
            if raw_timestamps:
                segments = _split_text_by_timestamp(raw_text, raw_timestamps)
                if segments:
                    all_segments.extend(segments)
                    continue
            # 兜底：无时间戳或文本/时间戳无法对齐时，按标点+字数硬切（时间轴按估算递增）
            print("[Zentect ASR] Paraformer 无可用句子级时间戳，执行兜底分句", file=sys.stderr)
            fallback = _fallback_split_by_punctuation(raw_text, "zh", estimated_start=0.0)
            all_segments.extend(fallback)

        # Paraformer text 逐字/逐 token 带空格，先清理为连贯文本，再进后处理
        # （否则"嗯 嗯"等带空格形式会逃过幻觉过滤）
        for seg in all_segments:
            seg["text"] = _clean_zh_spaces(seg["text"])

        # 复用现有后处理三段（去重/幻觉过滤/碎句合并），与 SenseVoice 链路一致
        all_segments = _asr_postprocess_segments(all_segments)
        all_segments = _filter_hallucination_segments(all_segments)
        all_segments = _merge_fragments(all_segments)

        if task_id:
            _set_progress(task_id, pct=80, msg=f"推理完成，{len(all_segments)} 段，正在格式化...")

        if not all_segments:
            print("[ASR] Paraformer 返回空结果", file=sys.stderr)
            AIModels.release_paraformer()
            return _error("ASR returned empty result")

        dominant_lang = req.language if req.language and req.language != "auto" else "zh"

        formatted_segments = []
        for seg in all_segments:
            clean_text = _clean_zh_spaces(seg["text"])
            formatted_segments.append({
                "start": round(seg["start"], 3),
                "end": round(seg["end"], 3),
                "text": clean_text,
                "originalText": clean_text,
            })

        result_data = {
            "text": " ".join(s["text"] for s in formatted_segments),
            "language": dominant_lang,
            "segments": formatted_segments,
            "emotion": "neutral",
        }

        with open(req.output_json_path, 'w', encoding='utf-8') as f:
            json.dump(result_data, f, ensure_ascii=False, indent=2)

        if task_id:
            _set_progress(task_id, pct=95, msg=f"写入完成，{len(formatted_segments)} 段台词")

        print(f"[ASR SUCCESS] Paraformer: {len(formatted_segments)} 句台词, lang={dominant_lang}", file=sys.stderr)
        return {"success": True, "data": result_data}

    except Exception as e:
        print(f"[ASR] Paraformer 失败: {e}", file=sys.stderr)
        traceback.print_exc()
        AIModels.release_paraformer()
        return _error(f"{type(e).__name__}: {str(e)}")
