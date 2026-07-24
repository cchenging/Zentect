"""
audio_pipeline.py — 音频处理端点模块
  /api/emotion        — 情绪检测（librosa）
  /api/transcribe     — ASR 语音转写（SenseVoice）
  /api/separate       — 人声分离（Demucs → MDX-Net 双引擎，均失败时抛 500）
  /api/audio/detect_beats — 鼓点检测（librosa + soundfile）
"""
import os
import sys
import traceback
import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ai_daemon import AIModels, FFMPEG_PATH

router = APIRouter()


# ==========================================
# DTOs
# ==========================================
class EmotionReq(BaseModel):
    audio_path: str

class TranscribeReq(BaseModel):
    audio_path: str
    output_json_path: str
    language: str = "auto"

class SeparateReq(BaseModel):
    audio_path: str
    output_dir: str
    # 引擎选择：'demucs'(重型,高保真) | 'mdx'(轻量,极速) | 'auto'(默认 Demucs→MDX 降级链)
    engine: str = "auto"
    # 任务 ID：由 Node 端生成，用于隔离并发任务的进度状态（SSE 推流时按 task_id 查询）
    task_id: str | None = None

class BeatDetectReq(BaseModel):
    file_path: str


# ==========================================
# ASR Helper Functions: 语言识别 / 情绪检测 / 后处理
# ==========================================
def clean_and_merge_to_sentences(raw_timestamp_list, text_with_tags, detected_lang="zh"):
    """终极多语言空格自适应断句算法（彻底终结"一段台词"魔咒）：
    核心依据:
      1) 字幕去标点契约: 封装前强制将一切残留标点擦除，确保字幕只含有纯文字和合法词距
      2) 字符级空格感知:
         - CJK(中日韩): 只要遇到任何空格/切词边界，立刻判定换句分行
         - 西文(EN/FR/ES): 单空格判定为单词间隔不换行。当捕获到连续双空格 "  " 或模型吐出的独立空Token时，判定为句子完结
      3) 毫秒级发音气口红线:
         - 西文连续朗读单词间隙一般为 30ms-80ms
         - 当相邻两个单词的静音期(gap)突然大于 260ms，说明是极其微弱的换气口，立刻强制截断换句
      4) 视觉排版兜底: 限制单行最大中文字数(15字)或英文单词数(9个词)，超长则强切
    """
    if not raw_timestamp_list:
        return []

    # 动态分析真实语种属性
    lang_lower = detected_lang.lower()
    is_cjk = any(k in lang_lower for k in ["zh", "ja", "ko", "cjk", "yue"])  # 顺便收纳粤语误判

    # 影视级高敏感时间门限
    PAUSE_THRESH_SEC = 0.26 if is_cjk else 0.28
    MAX_WORDS_LIMIT = 9     # 英文单句最大单词数限制
    MAX_CHARS_LIMIT = 15    # 中文单句最大汉字数限制

    sentences = []
    current_sentence_text = ""
    current_start = None
    word_counter = 0

    normalized_words = []
    for item in raw_timestamp_list:
        try:
            if isinstance(item, (list, tuple)) and len(item) == 2:
                time_range, word = item[0], item[1]
                if isinstance(time_range, (list, tuple)) and len(time_range) == 2:
                    normalized_words.append({
                        "start": float(time_range[0]) / 1000.0,
                        "end": float(time_range[1]) / 1000.0,
                        "word": str(word)
                    })
            elif isinstance(item, dict):
                w = item.get("word", item.get("text", ""))
                s = item.get("start", 0)
                e = item.get("end", 0)
                s_sec = s / 1000.0 if s > 500 else s
                e_sec = e / 1000.0 if e > 500 else e
                normalized_words.append({"start": s_sec, "end": e_sec, "word": str(w)})
        except Exception:
            pass

    if not normalized_words:
        return []

    for idx, curr_w in enumerate(normalized_words):
        word_raw = curr_w["word"]

        # 判定是否包含空格或本身是空格
        is_space_token = (word_raw == " " or word_raw.strip() == "")

        # 清洗层：彻底抹除所有残留标点符号，维护纯文字的外观契约
        clean_word = word_raw
        for punc in ["。", "？", "！", "，", "；", "、", ",", "?", "!", ".", ";", ":", "："]:
            clean_word = clean_word.replace(punc, "")

        if clean_word.strip() and current_start is None:
            current_start = curr_w["start"]

        # ── 自适应多语言文本高阶蓄水池 ──
        if is_cjk:
            if clean_word.strip():
                current_sentence_text += clean_word.strip()
        else:
            if is_space_token:
                # 规范化单空格，防止西文粘连
                if current_sentence_text and not current_sentence_text.endswith(" "):
                    current_sentence_text += " "
            else:
                if current_sentence_text and not current_sentence_text.endswith(" "):
                    current_sentence_text += " " + clean_word.strip()
                else:
                    current_sentence_text += clean_word.strip()
                word_counter += 1

        # ── 交叉红线智能断句判定 ──
        is_tail = (idx == len(normalized_words) - 1)
        is_acoustic_pause = False
        is_punc_space_trigger = False
        is_排版溢出 = False

        # 依据 1：超长硬强切控制
        if is_cjk and len(current_sentence_text) >= MAX_CHARS_LIMIT:
            is_排版溢出 = True
        elif not is_cjk and word_counter >= MAX_WORDS_LIMIT:
            is_排版溢出 = True

        # 依据 2：空格触发断句
        if is_space_token:
            if is_cjk:
                is_punc_space_trigger = True  # 中文遇到空格无脑切
            else:
                # 英文核心：如果识别到原始 Token 包含连续的多重空格，说明大模型在强行提示停顿断句
                if "  " in word_raw or (idx > 0 and normalized_words[idx-1]["word"] == " "):
                    is_punc_space_trigger = True

        # 依据 3：微观字间距时间断层
        if not is_tail:
            next_w = normalized_words[idx + 1]
            gap = next_w["start"] - curr_w["end"]
            if gap > PAUSE_THRESH_SEC:
                is_acoustic_pause = True  # 判定发音物理悬空，换气切句

        # 只要有一条红线拦截成功，立即生成一行清爽独立的台词
        if is_punc_space_trigger or is_acoustic_pause or is_排版溢出 or is_tail:
            final_text = current_sentence_text.strip()

            # 清理长连续空格垃圾
            while "  " in final_text:
                final_text = final_text.replace("  ", " ")

            if final_text and current_start is not None:
                sentences.append({
                    "start": round(current_start, 2),
                    "end": round(curr_w["end"], 2),
                    "text": final_text
                })

            # 优雅重置，迎接下一完整语义句
            current_start = None
            current_sentence_text = ""
            word_counter = 0

    print(f"[Zentect ASR SUCC] 语种: {detected_lang} | 音频已成功切分为 {len(sentences)} 句纯净字幕", file=sys.stderr)
    return sentences


def _fallback_split_by_punctuation(text, lang="zh", estimated_start=0.0):
    """💥 V1.2 兜底分句算法：无时间戳时，按标点+字数硬切分段
    策略：
    1. 先按中文标点（。！？；）和英文标点(.!?)断句
    2. 残余文本按字数硬切（中文20字/行，英文12词/行）
    3. 每段估算3-5秒时长，按顺序递增时间戳
    """
    if not text or not text.strip():
        return []

    lang_lower = (lang or "zh").lower()
    is_cjk = any(k in lang_lower for k in ["zh", "ja", "ko", "cjk", "yue"])

    # 先按强标点断句
    import re
    raw_chunks = re.split(r'[。！？；\n.!?;]+', text)
    raw_chunks = [c.strip() for c in raw_chunks if c.strip()]

    # 如果标点断句后只有1段且很长，按弱标点再切
    if len(raw_chunks) == 1 and len(raw_chunks[0]) > (20 if is_cjk else 60):
        raw_chunks = re.split(r'[，、,：:]+', raw_chunks[0])
        raw_chunks = [c.strip() for c in raw_chunks if c.strip()]

    # 对每个 chunk 按字数硬切
    MAX_CHARS = 20 if is_cjk else 999
    MAX_WORDS = 12 if not is_cjk else 999
    final_chunks = []

    for chunk in raw_chunks:
        if is_cjk:
            for i in range(0, len(chunk), MAX_CHARS):
                final_chunks.append(chunk[i:i + MAX_CHARS])
        else:
            words = chunk.split()
            for i in range(0, len(words), MAX_WORDS):
                final_chunks.append(" ".join(words[i:i + MAX_WORDS]))

    # 构建带时间戳的 segments
    segments = []
    current_time = estimated_start
    for chunk in final_chunks:
        # 估算时长：中文4字/秒，英文2.5词/秒
        if is_cjk:
            duration = max(1.5, len(chunk) / 4.0)
        else:
            word_count = len(chunk.split())
            duration = max(1.5, word_count / 2.5)

        segments.append({
            "start": round(current_time, 2),
            "end": round(current_time + duration, 2),
            "text": chunk
        })
        current_time += duration

    return segments


def _asr_postprocess_segments(segments):
    """ASR 片段后处理：
    1) 按开始时间排序
    2) 合并时间高度重叠的片段（合并文本，取更宽时间范围）
    3) 删除与前一段文本/时间完全一致的重复
    4) 对时间上紧邻的相同短句进行合并（避免一句话被切成多个短片段）
    5) Levenshtein 文本重合度去重：相邻句子文本相似度 > 85% 时裁剪去重
    """
    if not segments:
        return segments

    # 1) 排序
    segments = sorted(segments, key=lambda x: x["start"])

    merged = []
    for seg in segments:
        if not merged:
            merged.append(dict(seg))
            continue

        prev = merged[-1]
        overlap = min(prev["end"], seg["end"]) - max(prev["start"], seg["start"])
        total_span = max(prev["end"], seg["end"]) - min(prev["start"], seg["start"])
        overlap_ratio = overlap / total_span if total_span > 0 else 0.0

        # 2) 时间重叠 >= 60% 时合并
        if overlap_ratio >= 0.6:
            prev["start"] = min(prev["start"], seg["start"])
            prev["end"] = max(prev["end"], seg["end"])
            if seg["text"] not in prev["text"]:
                prev["text"] = (prev["text"] + " " + seg["text"]).strip()
            continue

        # 3) 时间完全一致或文本完全相同 → 去重
        if (abs(prev["start"] - seg["start"]) < 0.2 and abs(prev["end"] - seg["end"]) < 0.2) \
                or prev["text"].strip() == seg["text"].strip():
            continue

        # 4) 紧邻（间隔 < 0.2 秒）且文本较短（< 15 字）的片段合并，
        #    主要是避免"他说/她说"这种短对话被切碎
        gap = seg["start"] - prev["end"]
        if 0 <= gap < 0.2 and len(prev["text"]) < 15 and len(seg["text"]) < 15:
            prev["end"] = seg["end"]
            prev["text"] = (prev["text"] + " " + seg["text"]).strip()
            continue

        merged.append(dict(seg))

    # 5) Levenshtein 文本重合度去重：消除环境白噪引起的相邻重复幻觉
    merged = _levenshtein_dedup(merged)

    return merged


def _levenshtein_dedup(segments, threshold=0.85):
    """基于文本重合度的滑动窗口去重：
    比对相邻句子的文本相似度，如果 > threshold（默认 85%），
    则延长上一句的时间轴，丢弃重复文本。
    解决音频分离不纯净时 SenseVoice 产生的幻觉重复。
    """
    if not segments or len(segments) <= 1:
        return segments

    def _similarity(a, b):
        """计算两个字符串的相似度（0~1），基于最长公共子序列比率"""
        if not a or not b:
            return 0.0
        la, lb = len(a), len(b)
        # 短字符串优化：直接用编辑距离
        if la * lb > 10000:
            # 长文本用字符级 Jaccard 近似，避免 O(n^2) 爆炸
            set_a = set(a)
            set_b = set(b)
            intersection = len(set_a & set_b)
            union = len(set_a | set_b)
            return intersection / union if union > 0 else 0.0

        # 标准 Levenshtein 编辑距离
        dp = list(range(lb + 1))
        for i in range(1, la + 1):
            prev = dp[0]
            dp[0] = i
            for j in range(1, lb + 1):
                temp = dp[j]
                if a[i-1] == b[j-1]:
                    dp[j] = prev
                else:
                    dp[j] = 1 + min(prev, dp[j], dp[j-1])
                prev = temp

        edit_dist = dp[lb]
        max_len = max(la, lb)
        return 1.0 - (edit_dist / max_len) if max_len > 0 else 0.0

    final = []
    for seg in segments:
        if not final:
            final.append(dict(seg))
            continue

        prev = final[-1]
        sim = _similarity(prev["text"].strip(), seg["text"].strip())

        # 文本相似度超过阈值，且时间间隔极短（< 1.5 秒），判定为幻觉重复
        gap = seg["start"] - prev["end"]
        if sim > threshold and gap < 1.5:
            # 延长上一句的时间轴，丢弃重复文本
            prev["end"] = max(prev["end"], seg["end"])
        else:
            final.append(dict(seg))

    return final


def _asr_extract_lang(raw_text):
    """Extract language tag from raw SenseVoice text
    🚀 修复：SenseVoice 在 language='zh' 模式下会错误返回 zh 标签
    改为根据实际文本内容判断语言
    """
    import re
    m = re.match(r'<\|(\w+)\|>', raw_text)
    sensevoice_lang = m.group(1) if m else "zh"

    # 🚀 基于文本内容的语言二次校验：统计中文字符占比
    cleaned = re.sub(r'<\|.*?\|>', '', raw_text).strip()
    if cleaned:
        chinese_chars = len(re.findall(r'[\u4e00-\u9fff]', cleaned))
        total_chars = len(re.sub(r'\s+', '', cleaned))
        if total_chars > 0:
            chinese_ratio = chinese_chars / total_chars
            # 中文字符占比低于 20%，且 SenseVoice 报告为 zh，则修正为 en
            if chinese_ratio < 0.2 and sensevoice_lang == 'zh':
                return "en"
    return sensevoice_lang


def _asr_extract_emotion(raw_text):
    """Extract emotion tag from raw SenseVoice text"""
    import re
    emotion_tags = ['HAPPY', 'SAD', 'ANGRY', 'NEUTRAL', 'SURPRISE', 'FEAR', 'DISGUST']
    for tag in emotion_tags:
        if f'<|{tag}|>' in raw_text:
            return tag.lower()
    return "neutral"


# ==========================================
# /api/emotion — 音频情绪检测
# ==========================================
@router.post("/api/emotion")
def api_emotion(req: EmotionReq):
    import librosa
    import numpy as np
    try:
        if not os.path.exists(req.audio_path):
            return {"success": False, "error": "Audio file not found"}

        y, sr = librosa.load(req.audio_path, sr=16000)
        rms = librosa.feature.rms(y=y)[0]
        mean_rms = float(np.mean(rms))
        pitches, magnitudes = librosa.piptrack(y=y, sr=sr)
        mean_pitch = float(np.mean(pitches[magnitudes > np.median(magnitudes)]))

        emotion = "neutral"
        if mean_rms > 0.05 and mean_pitch > 200:
            emotion = "excited"
        elif mean_rms < 0.01:
            emotion = "calm"

        return {"success": True, "data": {"emotion": emotion, "rms": mean_rms, "pitch": mean_pitch}}
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


# ==========================================
# /api/transcribe — ASR 语音转写
# SenseVoice funasr AutoModel（内置 fsmn-vad 深度学习 VAD）
# 💥 改为 async + run_in_executor，避免 CPU 密集型推理阻塞 uvicorn 事件循环
# ==========================================
@router.post("/api/transcribe")
async def api_transcribe(req: TranscribeReq):
    """异步 ASR 转写：将 CPU 密集型的推理计算放入线程池，不阻塞事件循环"""
    import asyncio
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(None, _transcribe_sync, req)
        return result
    except Exception as e:
        print(f"[AI Daemon] ASR 崩溃: {e}", file=sys.stderr)
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


def _transcribe_sync(req: TranscribeReq):
    """同步 ASR 推理逻辑：在线程池中执行，不阻塞 uvicorn 事件循环"""
    try:
        if not os.path.exists(req.audio_path):
            return {"success": False, "error": "Audio file not found"}

        # ── funasr AutoModel（内置 fsmn-vad） ──
        try:
            from funasr import AutoModel
            from funasr.utils.postprocess_utils import rich_transcription_postprocess

            model = AIModels.get_funasr_sensevoice()
            print(f"[ASR] 使用 funasr AutoModel + fsmn-vad，language={req.language}", file=sys.stderr)

            # ✅ 关键修复：启用 funasr 内置 VAD，并做细粒度切分
            #   - vad_model="fsmn-vad"：让模型内部 VAD 负责切分（比外部的任何 VAD 都准）
            #   - max_single_segment_time=30000：单段不超过 30 秒
            #   - batch_size_s=60：批处理
            res = model.generate(
                input=req.audio_path,
                language=req.language if req.language != "auto" else "auto",
                use_itn=True,
                batch_size_s=60,
                vad_model="fsmn-vad",
                vad_kwargs={"max_single_segment_time": 30000},
                word_timestamp=True,         # 必须开启：向模型索要底层每个 Token 的毫秒级坐标
                return_spk_res=False
            )

            # 解析 funasr 返回结果
            all_segments = []
            all_text_parts = []
            emotions = []
            languages = []

            for item in res:
                raw_text = item.get("text", "")
                clean_text = rich_transcription_postprocess(raw_text).strip()

                # 提取情绪和语言标签
                emotion = _asr_extract_emotion(raw_text)
                lang = _asr_extract_lang(raw_text)

                # ✅ 核心算法改进：FunASR 在字级时间戳字段上有时名为 "timestamp"、有时名为 "word_timestamp"
                raw_timestamps = item.get("timestamp", item.get("word_timestamp", None))

                if raw_timestamps:
                    # 激活多语言自适应断句器，将 detected_lang 传入打通语种双轨制
                    processed_sentences = clean_and_merge_to_sentences(
                        raw_timestamp_list=raw_timestamps,
                        text_with_tags=raw_text,
                        detected_lang=lang  # 动态匹配实际检测出的语种(如 zh/en/ja)
                    )

                    # 💥 V1.2 关键修复：如果断句结果只有1段且文本很长，
                    # 说明 timestamp 数据本身就是一个大段（如低信噪比音频），
                    # 必须强制走兜底分句，绝不能输出一大段
                    is_cjk_lang = any(k in lang.lower() for k in ["zh", "ja", "ko", "cjk", "yue"])
                    MAX_SINGLE_SEG_CHARS = 25 if is_cjk_lang else 60
                    if processed_sentences and len(processed_sentences) == 1 and len(processed_sentences[0].get("text", "")) > MAX_SINGLE_SEG_CHARS:
                        print(f"[Zentect ASR] 断句结果仅1段({len(processed_sentences[0]['text'])}字)，强制走兜底分句", file=sys.stderr)
                        processed_sentences = None  # 清空，让下方兜底分支接管

                    if processed_sentences:
                        for sentence in processed_sentences:
                            all_segments.append(sentence)
                            all_text_parts.append(sentence["text"])
                            emotions.append(emotion)
                            languages.append(lang)
                        continue  # 成功处理，跳过下方的大一刀切兜底分支

                # 💥 V1.2 兜底分句：无时间戳时，按标点+字数硬切分段，绝不输出一大段
                if clean_text:
                    print("[Zentect ASR] 无字级时间戳，执行标点+字数兜底分句", file=sys.stderr)
                    fallback_segments = _fallback_split_by_punctuation(clean_text, lang, estimated_start=0.0)
                    for seg in fallback_segments:
                        all_segments.append(seg)
                        all_text_parts.append(seg["text"])
                        emotions.append(emotion)
                        languages.append(lang)

            # ✅ 后处理：相邻去重 + 重叠合并（彻底消除"台词重复"）
            all_segments = _asr_postprocess_segments(all_segments)

            # ── funasr 返回空结果直接报错，不降级 ──
            if not all_segments:
                print("[ASR] funasr AutoModel 返回空结果", file=sys.stderr)
                AIModels._funasr_model = None
                return {"success": False, "error": "ASR returned empty result"}

            from collections import Counter
            dominant_emotion = Counter(emotions).most_common(1)[0][0] if emotions else "neutral"
            dominant_lang = Counter(languages).most_common(1)[0][0] if languages else (req.language if req.language != "auto" else "zh")

            # 输出 segments，start/end 为数字秒数（TS 端 formatSrtTime 期望数字）
            formatted_segments = []
            for seg in all_segments:
                formatted_segments.append({
                    "start": round(seg["start"], 3),
                    "end": round(seg["end"], 3),
                    "text": seg["text"],
                    "originalText": seg["text"]
                })

            result_data = {
                "text": " ".join(all_text_parts),
                "language": dominant_lang,
                "segments": formatted_segments,
                "emotion": dominant_emotion
            }

            with open(req.output_json_path, 'w', encoding='utf-8') as f:
                json.dump(result_data, f, ensure_ascii=False, indent=2)

            print(f"[ASR SUCCESS] funasr AutoModel: {len(formatted_segments)} 句台词, lang={dominant_lang}", file=sys.stderr)
            return {"success": True, "data": result_data}

        except Exception as e:
            print(f"[ASR] funasr AutoModel 失败: {e}", file=sys.stderr)
            traceback.print_exc()
            return {"success": False, "error": f"{type(e).__name__}: {str(e)}"}

    except Exception as e:
        print(f"[ASR FATAL] Error Type: {type(e).__name__}, Detail: {str(e)}", file=sys.stderr)
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {str(e)}")


# ==========================================
# /api/separate — 人声伴奏分离（MDX-Net / HPSS 降级）
# 💥 改为 async + run_in_executor，避免 CPU 密集型计算阻塞 uvicorn 事件循环
# ==========================================

# 分离进度状态：按 task_id 隔离（支持并发，替代旧的全局单例）
_task_progress: dict[str, dict] = {}


def _get_progress(task_id: str) -> dict:
    """获取指定任务的进度状态，不存在则初始化"""
    if task_id not in _task_progress:
        _task_progress[task_id] = {
            "pct": 0,
            "msg": "等待中",
            "done": False,
            "result": None,
            "error": None,
        }
    return _task_progress[task_id]


def _set_progress(task_id: str, **kwargs) -> None:
    """更新指定任务的进度字段（增量更新）"""
    p = _get_progress(task_id)
    p.update(kwargs)


@router.get("/api/separate/progress/{task_id}")
async def api_separate_progress(task_id: str):
    """轮询接口（兼容旧版）：按 task_id 获取分离进度快照"""
    return _get_progress(task_id)


@router.get("/api/separate/stream/{task_id}")
async def api_separate_stream(task_id: str):
    """SSE 推流接口：进度变化时主动 push，Node 端无需轮询"""
    import asyncio

    async def event_generator():
        while True:
            progress = _get_progress(task_id)
            yield f"data: {json.dumps(progress, ensure_ascii=False)}\n\n"
            if progress.get("done"):
                break
            await asyncio.sleep(0.1)  # 100ms 推送间隔
    return StreamingResponse(event_generator(), media_type="text/event-stream")


@router.post("/api/separate")
async def api_separate(req: SeparateReq):
    """异步人声分离：将 CPU 密集型的分离计算放入线程池，不阻塞事件循环"""
    import asyncio
    import uuid

    # 生成或复用 task_id，按任务隔离进度状态
    task_id = req.task_id or str(uuid.uuid4())
    # 重置该任务的进度状态
    _task_progress[task_id] = {
        "pct": 0,
        "msg": "正在启动分离引擎...",
        "done": False,
        "result": None,
        "error": None,
    }

    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(None, _separate_sync, req, task_id)
        _set_progress(task_id, done=True, pct=100, msg="分离完成", result=result)
        # 补充 task_id 便于 Node 端关联
        if isinstance(result, dict):
            result["task_id"] = task_id
        return result
    except Exception as e:
        _set_progress(task_id, done=True, error=str(e), msg=f"分离失败: {e}")
        print(f"[AI Daemon] 分离崩溃: {e}", file=sys.stderr)
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


def _finalize_output(output_dir, vocals_path, bgm_path):
    """标准化输出文件名并删除中间产物，仅保留 vocals.wav 和 bgm.wav"""
    import glob
    import shutil

    final_vocals = os.path.join(output_dir, "vocals.wav")
    final_bgm = os.path.join(output_dir, "bgm.wav")

    # 复制到标准化名称
    if vocals_path:
        shutil.copy2(vocals_path, final_vocals)
    if bgm_path:
        shutil.copy2(bgm_path, final_bgm)

    # 删除所有中间 .wav 文件，仅保留标准化输出
    keep = {final_vocals, final_bgm}
    for wav_file in glob.glob(os.path.join(output_dir, "*.wav")):
        if wav_file not in keep:
            try:
                os.remove(wav_file)
            except OSError:
                pass

    return final_vocals, final_bgm


def _separate_sync(req: SeparateReq, task_id: str):
    """同步分离逻辑：在线程池中执行，不阻塞 uvicorn 事件循环

    engine 参数控制引擎选择：
      - 'demucs': 仅使用 Demucs（重型，高保真），失败则抛 500
      - 'mdx':    仅使用 MDX-Net（轻量，极速），失败则抛 500
      - 'auto':  默认顺序 Demucs → MDX-Net 降级链

    task_id 用于按任务隔离进度状态（支持并发分离多个媒体）
    """
    try:
        print(f"[AI Daemon] 🧠 启动音频分离 (engine={req.engine}, task={task_id})...", file=sys.stderr)

        if not os.path.exists(req.audio_path):
            _set_progress(task_id, error="Audio file not found", done=True)
            return {"success": False, "error": "Audio file not found"}

        if not os.path.exists(req.output_dir):
            os.makedirs(req.output_dir, exist_ok=True)

        engine = (req.engine or "auto").lower()
        run_demucs = engine in ("demucs", "auto")
        run_mdx = engine in ("mdx", "auto")

        # --- Phase 0: Demucs (highest quality, 4-stem hybrid) ---
        if run_demucs:
            try:
                import demucs
                from demucs.api import Separator as DemucsSeparator
                import subprocess
                import numpy as np

                print("[AI Daemon] 🎵 [Demucs] 正在加载 htdemucs 模型...", file=sys.stderr)
                _set_progress(task_id, pct=5, msg="正在加载 Demucs htdemucs 模型...")

                # P2: Demucs 真实进度回调
                # callback 接收 info dict，包含 segment_offset 和 audio_length
                # 将进度映射到 5-85 区间（85=Demucs 分离完成），替代旧版 5-15 的极粗粒度
                def _demucs_progress_callback(info):
                    try:
                        seg_offset = info.get('segment_offset', 0) or 0
                        audio_len = info.get('audio_length', 0) or 0
                        if audio_len > 0:
                            ratio = min(1.0, seg_offset / audio_len)
                            # Demucs 分离阶段占总进度 5-85，共 80 个百分点（旧版仅 10）
                            _set_progress(task_id, pct=5 + int(ratio * 80),
                                          msg=f"Demucs 正在分离... {int(ratio * 100)}%")
                    except Exception:
                        pass  # 进度回调不应影响主流程

                demucs_sep = DemucsSeparator('htdemucs', callback=_demucs_progress_callback)
                origin, separated = demucs_sep.separate_audio_file(req.audio_path)

                _set_progress(task_id, pct=85, msg="Demucs 分离完成，正在保存音轨...")

                sr = demucs_sep.samplerate
                stem_paths = {}

                # Save each stem to output_dir
                for stem_name, stem_tensor in separated.items():
                    audio_np = stem_tensor.cpu().numpy()
                    if audio_np.ndim == 2:
                        audio_np = audio_np.T
                    stem_path = os.path.join(req.output_dir, f"{stem_name}_demucs.wav")

                    try:
                        import soundfile as sf
                        sf.write(stem_path, audio_np, sr)
                    except ImportError:
                        from scipy.io import wavfile
                        audio_int16 = (audio_np * 32767).astype(np.int16)
                        wavfile.write(stem_path, sr, audio_int16)

                    stem_paths[stem_name.lower()] = stem_path

                demucs_vocals = stem_paths.get("vocals", "")
                demucs_drums = stem_paths.get("drums", "")
                demucs_bass = stem_paths.get("bass", "")
                demucs_other = stem_paths.get("other", "")

                if demucs_vocals:
                    _set_progress(task_id, pct=88, msg="正在合并背景音轨 (Demucs)...")

                    bgm_stems = [s for s in [demucs_drums, demucs_bass, demucs_other] if s]
                    dest_bgm = os.path.join(req.output_dir, "bgm_demucs.wav")

                    if len(bgm_stems) >= 2:
                        ffmpeg_cmd = [FFMPEG_PATH, "-y"]
                        for stem in bgm_stems:
                            ffmpeg_cmd.extend(["-i", stem])
                        filter_parts = [f"[{i}:0]" for i in range(len(bgm_stems))]
                        filter_expr = "".join(filter_parts) + f"amix=inputs={len(bgm_stems)}:duration=longest"
                        ffmpeg_cmd.extend(["-filter_complex", filter_expr, dest_bgm])
                    elif len(bgm_stems) == 1:
                        import shutil
                        shutil.copy2(bgm_stems[0], dest_bgm)
                    else:
                        dest_bgm = ""

                    try:
                        if len(bgm_stems) >= 2:
                            subprocess.run(ffmpeg_cmd, check=True, capture_output=True, text=True)
                        print(f"[AI Daemon] ✅ [Demucs] 分离完成", file=sys.stderr)
                        _set_progress(task_id, pct=92, msg="正在清理中间文件...")
                        final_vocals, final_bgm = _finalize_output(req.output_dir, demucs_vocals, dest_bgm)
                        _set_progress(task_id, pct=98, msg="分离完成，即将返回结果")
                        return {"success": True, "vocals": final_vocals, "bgm": final_bgm}
                    except Exception as ffmpeg_err:
                        print(f"[AI Daemon] [Demucs] FFmpeg 合并失败，使用 other 轨作为 BGM: {ffmpeg_err}", file=sys.stderr)
                        if demucs_other:
                            import shutil
                            shutil.copy2(demucs_other, dest_bgm)
                        elif demucs_drums:
                            import shutil
                            shutil.copy2(demucs_drums, dest_bgm)
                        elif demucs_bass:
                            import shutil
                            shutil.copy2(demucs_bass, dest_bgm)
                        print(f"[AI Daemon] ✅ [Demucs] 分离完成（FFmpeg 降级）", file=sys.stderr)
                        _set_progress(task_id, pct=92, msg="正在清理中间文件...")
                        final_vocals, final_bgm = _finalize_output(req.output_dir, demucs_vocals, dest_bgm)
                        _set_progress(task_id, pct=98, msg="分离完成，即将返回结果")
                        return {"success": True, "vocals": final_vocals, "bgm": final_bgm}

            except ImportError:
                print("[AI Daemon] Demucs 未安装，降级到 MDX-Net", file=sys.stderr)
                _set_progress(task_id, pct=5, msg="Demucs 未安装，降级到 MDX-Net...")
            except Exception as demucs_err:
                print(f"[AI Daemon] Demucs 分离失败，降级到 MDX-Net: {demucs_err}", file=sys.stderr)
                _set_progress(task_id, pct=5, msg="Demucs 失败，降级到 MDX-Net...")

            # engine='demucs' 时不降级到 MDX-Net，直接抛失败
            if engine == "demucs":
                print("[AI Daemon] ❌ Demucs 不可用且 engine=demucs，不降级", file=sys.stderr)
                raise HTTPException(
                    status_code=500,
                    detail="Demucs 不可用且 engine=demucs，不降级到 MDX-Net"
                )

        # --- Phase 1: MDX-Net (high quality) ---
        if run_mdx:
            try:
                from audio_separator.separator import Separator
                mdx_model_dir = os.path.join(AIModels.MODELS_DIR, "mdx_net")
                _set_progress(task_id, pct=10, msg="正在加载 MDX-Net 模型...")
                separator = Separator(output_dir=req.output_dir, model_file_dir=mdx_model_dir)
                separator.load_model('UVR-MDX-NET-Inst_HQ_4.onnx')
                _set_progress(task_id, pct=30, msg="MDX-Net 正在分离音轨...")
                output_files = separator.separate(req.audio_path)

                target_bgm = ""
                target_vocals = ""
                for file_name in output_files:
                    if "(Instrumental)" in file_name:
                        target_bgm = os.path.join(req.output_dir, file_name)
                    elif "(Vocals)" in file_name:
                        target_vocals = os.path.join(req.output_dir, file_name)

                if target_vocals and target_bgm:
                    print("[AI Daemon] ✅ [MDX-Net] 分离完成", file=sys.stderr)
                    _set_progress(task_id, pct=92, msg="正在清理中间文件...")
                    final_vocals, final_bgm = _finalize_output(req.output_dir, target_vocals, target_bgm)
                    _set_progress(task_id, pct=98, msg="分离完成，即将返回结果")
                    return {"success": True, "vocals": final_vocals, "bgm": final_bgm}
            except Exception as mdx_err:
                print(f"[AI Daemon] MDX-Net 分离失败: {mdx_err}", file=sys.stderr)

        # Demucs + MDX-Net 均失败：抛出异常，由 Node 端 separateVocalsBgm 走 fallback
        # （Node 端会标记 vocalsIsFallback=true，ASR 自动使用原始 16kHz 音轨）
        print("[AI Daemon] ❌ 所选引擎均不可用，音频分离失败", file=sys.stderr)
        raise HTTPException(
            status_code=500,
            detail=f"所选引擎 (engine={engine}) 均不可用，音频分离失败"
        )

    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))



# ==========================================
# /api/audio/detect_beats — BGM 鼓点节拍检测
# ==========================================
@router.post("/api/audio/detect_beats")
async def detect_beats(req: BeatDetectReq):
    """流式窗口 STFT 节拍检测，ThreadPool 中运行避免阻塞事件循环"""
    import asyncio
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(None, _detect_beats_sync, req)
        return result
    except Exception as e:
        print(f"ERROR: 节拍检测崩溃 - {str(e)}", file=sys.stderr)
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


def _detect_beats_sync(req: BeatDetectReq) -> dict:
    import numpy as np
    import librosa
    try:
        if not os.path.exists(req.file_path):
            return {"success": False, "error": "Audio file not found"}

        import soundfile as sf

        CHUNK_SAMPLES = 22050 * 30
        sr = 22050
        all_onset_env = []
        frame_positions = []

        info = sf.info(req.file_path)
        total_frames = info.frames
        original_sr = info.samplerate

        with sf.SoundFile(req.file_path) as f:
            current_frame = 0
            while current_frame < total_frames:
                chunk = f.read(CHUNK_SAMPLES, dtype='float32')
                if len(chunk.shape) > 1:
                    chunk = chunk.mean(axis=1)

                if original_sr != sr:
                    chunk = librosa.resample(chunk, orig_sr=original_sr, target_sr=sr)

                stft = np.abs(librosa.stft(chunk))
                low_freq_energy = np.sum(stft[0:15, :], axis=0)
                chunk_onset = librosa.onset.onset_strength(onset_envelope=low_freq_energy, sr=sr)

                frame_positions.append(len(all_onset_env))
                all_onset_env.append(chunk_onset)

                current_frame += CHUNK_SAMPLES
                del chunk, stft, low_freq_energy, chunk_onset

        if not all_onset_env:
            return {"success": True, "data": {"onsetMs": [], "beatGridMs": [], "tempo": 120.0, "totalDurationMs": 0}}

        full_onset_env = np.concatenate(all_onset_env)
        del all_onset_env

        onset_frames = librosa.onset.onset_detect(
            onset_envelope=full_onset_env, sr=sr,
            wait=10, pre_avg=1, post_avg=1, pre_max=1, post_max=1
        )
        onset_times_sec = librosa.frames_to_time(onset_frames, sr=sr)
        beat_ms = [round(t * 1000, 1) for t in onset_times_sec]

        tempo, beat_frames = librosa.beat.beat_track(onset_envelope=full_onset_env, sr=sr)
        if isinstance(tempo, np.ndarray):
            tempo = float(tempo[0]) if len(tempo) > 0 else 120.0
        else:
            tempo = float(tempo)
        beat_times_sec = librosa.frames_to_time(beat_frames, sr=sr)
        beat_grid_ms = [round(t * 1000, 1) for t in beat_times_sec]

        del full_onset_env

        return {
            "success": True,
            "data": {
                "onsetMs": beat_ms,
                "beatGridMs": beat_grid_ms,
                "tempo": round(tempo, 1),
                "totalDurationMs": round(total_frames / original_sr * 1000, 1)
            }
        }
    except ImportError:
        try:
            y, sr = librosa.load(req.file_path, sr=22050)
            stft = np.abs(librosa.stft(y))
            low_freq_energy = np.sum(stft[0:15, :], axis=0)
            onset_env = librosa.onset.onset_strength(onset_envelope=low_freq_energy, sr=sr)
            onset_frames = librosa.onset.onset_detect(onset_envelope=onset_env, sr=sr, wait=10, pre_avg=1, post_avg=1, pre_max=1, post_max=1)
            onset_times_sec = librosa.frames_to_time(onset_frames, sr=sr)
            beat_ms = [round(t * 1000, 1) for t in onset_times_sec]
            tempo, beat_frames = librosa.beat.beat_track(onset_envelope=onset_env, sr=sr)
            if isinstance(tempo, np.ndarray): tempo = float(tempo[0]) if len(tempo) > 0 else 120.0
            else: tempo = float(tempo)
            beat_times_sec = librosa.frames_to_time(beat_frames, sr=sr)
            beat_grid_ms = [round(t * 1000, 1) for t in beat_times_sec]
            del y, stft, onset_env
            return {"success": True, "data": {"onsetMs": beat_ms, "beatGridMs": beat_grid_ms, "tempo": round(tempo, 1), "totalDurationMs": round(len(beat_ms) / sr * 1000, 1)}}
        except Exception as e2:
            raise HTTPException(status_code=500, detail=str(e2))
    except Exception as e:
        print(f"ERROR: 节拍检测崩溃 - {str(e)}", file=sys.stderr)
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))
