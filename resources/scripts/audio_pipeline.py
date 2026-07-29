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

from ai_config import AIModels, FFMPEG_PATH, INFERENCE_LOCK

router = APIRouter()


# ==========================================
# 辅助：统一错误响应格式（含 errorCode，便于 Node 端按错误类型分流处理）
# ==========================================
def _error(msg: str, code: str = "AI_PROCESS_FAILED") -> dict:
    return {"success": False, "error": msg, "errorCode": code}


# ==========================================
# 辅助：Demucs 模型内存强制释放（修复 SR 崩溃 exit code: 3221225477）
# ==========================================
def _cleanup_demucs_memory():
    """强制释放 Demucs 模型占用的 PyTorch 内存，防止后续 SenseVoice 加载时触发 ACCESS_VIOLATION
    
    🔧 修复 SR 崩溃根因：
    del + gc.collect() 只释放 Python 层引用，PyTorch C++ 内存分配器可能仍持有缓存。
    需要：
    1. 多次 gc.collect() 回收 Python 对象
    2. torch.cuda.empty_cache() 清理 PyTorch 内存分配器缓存
    3. 短暂 sleep 让 OS 回收物理内存页
    注意：调用方需要在 finally 块中将外部变量显式置 None，确保引用断开。
    """
    import gc
    import time
    
    # 步骤1：第一次 gc 回收 Python 对象
    gc.collect()
    
    # 步骤2：清理 PyTorch C++ 内存分配器缓存
    # 即使 CPU 模式也调用 empty_cache()，它会释放 PyTorch 内部缓存的 tensor 存储
    try:
        import torch
        if hasattr(torch, 'cuda') and torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.synchronize()
        # CPU 模式：PyTorch 1.x+ 有 cpu_allocator 但无公开 API 清理
        # 通过 gc.collect() + sleep 组合让 OS 自然回收
    except ImportError:
        pass
    
    # 步骤3：第二次 gc 回收（torch 清理后可能释放新的 Python 对象）
    gc.collect()
    
    # 步骤4：等待 OS 回收物理内存页（500ms）
    # 避免 SenseVoice 紧接着加载时访问尚未完全回收的内存区域
    time.sleep(0.5)
    
    print("[AI Daemon] 🧹 Demucs 模型内存已强制释放", file=sys.stderr)


# ==========================================
# DTOs
# ==========================================
class EmotionReq(BaseModel):
    audio_path: str

class TranscribeReq(BaseModel):
    audio_path: str
    output_json_path: str
    language: str = "auto"
    # ASR 引擎选择：'sensevoice'(默认,中日韩) | 'faster-whisper'(英文/欧洲语言)
    # 不传或 'auto' 时根据 language 自动选择：CJK → sensevoice，其他 → faster-whisper
    engine: str = "auto"
    # 任务 ID：由 Node 端生成，用于隔离并发 ASR 任务的进度状态（SSE 推流时按 task_id 查询）
    task_id: str | None = None

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

        # 2) 时间重叠 >= 80% 时合并（方案5: 0.6→0.8，避免短句误合并）
        if overlap_ratio >= 0.8:
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


def _split_segment_by_words(words, detected_lang="en"):
    """基于 word 级时间戳的句子级断句算法（确定参数版）

    faster-whisper 的 segment 是 VAD 段（基于静音切分），可能包含多个句子。
    本函数利用 word_timestamps=True 返回的每个 word 的精确时间戳，按以下规则重新断句：

    断句触发条件（任一满足即断）：
    1) 标点触发：word 末尾包含句末标点（. ! ? 。 ！ ？ ；）→ 立即断句
    2) 停顿触发：相邻 word 间停顿 > 500ms → 断句
    3) 长度触发：当前句达 CJK 20 字 / 西文 12 词 → 强制断句

    参数确定依据（行业标准硬阈值）：
    - PAUSE_THRESHOLD_SEC = 0.500s
      依据：英语连续发音词间隔 < 300ms（参考：语速 150 词/分钟 = 400ms/词），
            句间换气停顿 ≥ 500ms（参考：VAD 默认 min_silence_duration_ms=500），
            500ms 是连续发音与换气停顿的明确分界。
    - MAX_CHARS = 20（CJK）
      依据：GB/T 28039-2011《中文字幕通用技术规范》单行字幕 ≤ 21 字，取 20 字为安全上限。
    - MAX_WORDS = 12（西文）
      依据：BBC Subtitle Guidelines 第 14 节规定单行字幕 ≤ 12 词。

    Args:
        words: faster-whisper segment.words 列表，每个元素含 .word/.start/.end
        detected_lang: 检测到的语言代码（zh/ja/ko 等 CJK 或 en 等西文）

    Returns:
        list[dict]: 每个元素 {start, end, text}，代表一个句子
    """
    if not words:
        return []

    lang_lower = (detected_lang or 'en').lower()
    is_cjk = any(k in lang_lower for k in ["zh", "ja", "ko", "cjk", "yue"])

    # 断句参数（确定值，无模糊区间）
    PAUSE_THRESHOLD_SEC = 0.500  # 停顿 ≥ 500ms 断句（连续发音 < 300ms，换气 ≥ 500ms）
    MAX_CHARS = 20 if is_cjk else 999   # CJK 单句 ≤ 20 字（GB/T 28039-2011）
    MAX_WORDS = 999 if is_cjk else 12   # 西文单句 ≤ 12 词（BBC Subtitle Guidelines）

    # 句末标点（触发断句）
    SENTENCE_END_PUNCT = set('.!?。！？;；')

    sentences = []
    current_words = []
    current_start = None
    word_count = 0

    for idx, w in enumerate(words):
        word_text = getattr(w, 'word', '') or ''
        word_start = getattr(w, 'start', 0) or 0
        word_end = getattr(w, 'end', 0) or 0

        if not word_text.strip() and not current_words:
            # 跳过前导空白
            continue

        if current_start is None:
            current_start = word_start

        current_words.append(word_text)
        if not is_cjk:
            word_count += 1

        # 判断是否需要断句
        should_break = False

        # 规则1：标点触发（word 末尾有句末标点）
        if word_text and word_text.strip()[-1] in SENTENCE_END_PUNCT:
            should_break = True

        # 规则2：停顿触发（与下一个 word 间停顿 > 500ms）
        if not should_break and idx < len(words) - 1:
            next_start = getattr(words[idx + 1], 'start', word_end) or word_end
            pause = next_start - word_end
            if pause > PAUSE_THRESHOLD_SEC:
                should_break = True

        # 规则3：长度触发（CJK ≥ 20 字 / 西文 ≥ 12 词）
        if not should_break:
            if is_cjk:
                joined = ''.join(current_words)
                if len(joined) >= MAX_CHARS:
                    should_break = True
            else:
                if word_count >= MAX_WORDS:
                    should_break = True

        # 最后一个 word 强制断句
        if idx == len(words) - 1:
            should_break = True

        if should_break and current_words:
            sentence_text = ' '.join(current_words) if not is_cjk else ''.join(current_words)
            sentence_text = sentence_text.strip()
            # 清理多余空格
            while '  ' in sentence_text:
                sentence_text = sentence_text.replace('  ', ' ')

            if sentence_text:
                sentences.append({
                    'start': round(current_start, 3),
                    'end': round(word_end, 3),
                    'text': sentence_text,
                })

            current_words = []
            current_start = None
            word_count = 0

    return sentences


def _levenshtein_dedup(segments, threshold=0.92):
    """基于文本重合度的滑动窗口去重：
    比对相邻句子的文本相似度，如果 > threshold（默认 92%），
    则延长上一句的时间轴，丢弃重复文本。
    解决音频分离不纯净时 SenseVoice 产生的幻觉重复。

    方案5: threshold 从 0.85 调到 0.92，避免误删相似但不同的短句
           （如 "I am" / "I'm not" / "I am here" 等英文短语）
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

        # 文本相似度超过阈值，且时间紧密相邻（gap < 0.5 秒，含重叠），判定为幻觉重复
        # 方案5: gap 阈值从 1.5s 收紧到 0.5s，避免误删正常对话节奏的相似短句
        gap = seg["start"] - prev["end"]
        if sim > threshold and gap < 0.5:
            # 延长上一句的时间轴，丢弃重复文本
            prev["end"] = max(prev["end"], seg["end"])
        else:
            final.append(dict(seg))

    return final


def _asr_extract_lang(raw_text):
    """基于纯文本特征的强类型语言推断
    🚀 修复：SenseVoice 在 language='auto' 或高噪声场景下会产生中文幻觉，
    旧版仅靠中文字符占比 < 20% 判断，无法纠正带中文幻觉的英文音频。
    改为同时统计中文字符数与英文单词数，英文单词明显占优时强制修正为 en。
    """
    import re
    # 提取 SenseVoice 原始语言标签（<|zh|> / <|en|> / <|ja|> 等）
    m = re.match(r'<\|(\w+)\|>', raw_text)
    sensevoice_lang = m.group(1) if m else "zh"

    # 清理标签后获取纯文本
    cleaned = re.sub(r'<\|.*?\|>', '', raw_text).strip()
    if not cleaned:
        return sensevoice_lang

    # 统计中文汉字数与英文单词数（≥2 字母的连续字母序列视为单词）
    chinese_chars = len(re.findall(r'[\u4e00-\u9fff]', cleaned))
    english_words = len(re.findall(r'\b[a-zA-Z]{2,}\b', cleaned))

    # 英文单词数明显多于中文字符（≥3 个英文单词），强制修正为 en
    if english_words > chinese_chars and english_words >= 3:
        return "en"

    # 有中文字符且英文不占优，判定为中文
    if chinese_chars > 0:
        return "zh"

    # 既无中文也无英文单词，回退到 SenseVoice 标签
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
    """音频情绪检测（带全局推理锁保护，防止并发原生库崩溃）"""
    import librosa
    import numpy as np
    try:
        with INFERENCE_LOCK:
            if not os.path.exists(req.audio_path):
                return _error("Audio file not found", "FS_PATH_INVALID")

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
# /api/transcribe — ASR 语音转写（fire-and-forget + SSE 流式进度）
# SenseVoice funasr AutoModel（内置 fsmn-vad 深度学习 VAD）
# 💥 改为 fire-and-forget：POST 立即返回 task_id，进度通过 SSE 推送
#    与 /api/separate 模式对齐，支持流式进度和并发任务隔离
# ==========================================
@router.post("/api/transcribe")
async def api_transcribe(req: TranscribeReq):
    """异步 ASR 转写：立即返回 task_id，后台线程池执行推理，进度通过 SSE 推送

    🔧 task_id 去重：相同 task_id 进行中时拒绝重复执行，避免重复加载 ASR 模型
       （SenseVoice + fsmn-vad 约 1.5GB，重复加载会触发 OOM）
    """
    import asyncio
    import uuid

    task_id = req.task_id or str(uuid.uuid4())

    # 🔧 去重防御：如果该 task_id 已在进行中，直接返回（不重复启动 ASR）
    # 🔧 修复竞态：必须检查 started=True 才算真正启动，
    #   SSE 流先连接时 _get_progress 会创建 started=False 的占位条目，不能误判为已在执行
    existing = _task_progress.get(task_id)
    if existing and existing.get("started") and not existing.get("done") and not existing.get("error"):
        print(f"[AI Daemon] ⚠️ task_id={task_id} ASR 已在进行中，拒绝重复触发", file=sys.stderr)
        return {"success": True, "task_id": task_id, "deduplicated": True}

    # 重置该任务的进度状态（started=True 表示任务真正启动）
    _task_progress[task_id] = {
        "pct": 0,
        "msg": "正在启动 ASR 引擎...",
        "done": False,
        "result": None,
        "error": None,
        "started": True,
    }

    loop = asyncio.get_running_loop()
    # fire-and-forget：后台线程池执行，不等待结果
    loop.run_in_executor(None, _transcribe_sync_safe, req, task_id)
    # 立即返回 task_id，Node 端通过 SSE 订阅进度和最终结果
    return {"success": True, "task_id": task_id}


@router.get("/api/transcribe/stream/{task_id}")
async def api_transcribe_stream(task_id: str):
    """SSE 推流接口：ASR 进度变化时主动 push，Node 端无需轮询"""
    import asyncio

    async def event_generator():
        while True:
            progress = _get_progress(task_id)
            yield f"data: {json.dumps(progress, ensure_ascii=False)}\n\n"
            if progress.get("done"):
                break
            await asyncio.sleep(0.1)  # 100ms 推送间隔
    return StreamingResponse(event_generator(), media_type="text/event-stream")


def _transcribe_sync_safe(req: TranscribeReq, task_id: str):
    """_transcribe_sync 的安全包装：捕获异常并写入进度，确保 SSE 流一定能终止

    🔧 修复：在全局 INFERENCE_LOCK 内执行推理，防止与 Vision/InsightFace 等其他
       原生推理任务并发执行导致 0xC0000005 ACCESS_VIOLATION 崩溃
    """
    try:
        with INFERENCE_LOCK:
            result = _transcribe_sync(req, task_id)
        _set_progress(task_id, done=True, pct=100, msg="ASR 完成", result=result)
        if isinstance(result, dict):
            result["task_id"] = task_id
    except Exception as e:
        print(f"[AI Daemon] ASR 崩溃: {e}", file=sys.stderr)
        traceback.print_exc()
        _set_progress(task_id, done=True, error=str(e), msg=f"ASR 失败: {e}")


def _transcribe_via_faster_whisper(req: TranscribeReq, task_id: str = ""):
    """使用 faster-whisper（CTranslate2）进行 ASR 推理

    英文/欧洲语言识别率优于 whisper.cpp 的 ggml-base.bin（WER 约 5% vs 17-30%），
    速度比 whisper.cpp 快 4-8 倍。模型首次使用时自动从 HuggingFace 下载。

    参数：
        req: TranscribeReq 请求对象（audio_path/output_json_path/language）
        task_id: SSE 任务 ID，用于推送进度
    返回：
        dict: {"success": True, "data": result_data} 或 {"success": False, "error": ...}
    """
    try:
        if task_id:
            _set_progress(task_id, pct=5, msg="正在加载 Faster-Whisper 模型...")

        model = AIModels.get_faster_whisper('large-v3')
        print(f"[ASR] 使用 faster-whisper large-v3，language={req.language}", file=sys.stderr)

        if task_id:
            _set_progress(task_id, pct=15, msg="模型已就绪，开始语音推理...")

        # faster-whisper 语言代码映射：'auto' → None（自动检测）
        fw_lang = None if req.language == 'auto' else req.language

        # 调用 faster-whisper 转写（方案1: 推理参数调优，提升英文/小语种识别率）
        # beam_size=10: 搜索空间翻倍，专有名词/长句识别显著改善（默认5）
        # best_of=5: 对每段音频采样多次取最优，对抗噪声/口音
        # temperature 退火: 低温度失败时自动回退到高温度，处理噪声场景
        # no_speech_threshold=0.4: 调低阈值避免漏识别安静台词（默认0.6会跳过低音量句）
        # log_prob_threshold=-1.5: 放宽置信度门槛，减少漏识别（默认-1.0会丢弃低置信段）
        # condition_on_previous_text=False: 关闭上下文条件，避免长视频幻觉扩散
        segments_iter, info = model.transcribe(
            req.audio_path,
            language=fw_lang,
            beam_size=10,
            best_of=5,
            temperature=[0.0, 0.2, 0.4, 0.6, 0.8, 1.0],
            vad_filter=True,
            vad_parameters={'min_silence_duration_ms': 500},
            word_timestamps=True,
            no_speech_threshold=0.4,
            log_prob_threshold=-1.5,
            condition_on_previous_text=False,
        )

        # 语言检测信息
        detected_lang = info.language if info else (req.language or 'en')
        print(f"[ASR] faster-whisper 检测语言: {detected_lang}, 概率: {getattr(info, 'language_probability', 'N/A')}", file=sys.stderr)

        # 收集 segments
        all_segments = []
        all_text_parts = []
        total_segments_est = max(1, int(getattr(info, 'duration', 120)) // 5) if info else 20
        seg_idx = 0

        for seg in segments_iter:
            seg_idx += 1
            text = (seg.text or '').strip()
            # 🔧 修复断句：faster-whisper 的 segment 是 VAD 段（可能含多句），
            #   利用 word_timestamps=True 返回的 word 级时间戳做真正的句子级断句
            words = getattr(seg, 'words', None)
            if words:
                word_segments = _split_segment_by_words(words, detected_lang)
                for ws in word_segments:
                    all_segments.append(ws)
                    all_text_parts.append(ws['text'])
            else:
                # 无 word 时间戳时回退到 segment 级
                all_segments.append({
                    'start': round(seg.start, 3),
                    'end': round(seg.end, 3),
                    'text': text,
                })
                all_text_parts.append(text)

            # 推送进度（15-90 区间）
            if task_id and seg_idx % 5 == 0:
                pct = min(90, 15 + int(seg_idx / total_segments_est * 75))
                _set_progress(task_id, pct=pct, msg=f"已识别 {seg_idx} 段...")

        # 后处理：faster-whisper 已自带 segment 级断句和标点，无需再走 word 级断句器
        # 🔧 修复：旧版把 faster-whisper 的 segment（完整句子）当作 word 传入 clean_and_merge_to_sentences，
        #   导致多个句子被错误合并、标点被清除、时间戳被重算，与字幕完全不一致
        #   现在只做 _asr_postprocess_segments（去重 + 重叠合并），保留 faster-whisper 原生断句和标点
        if task_id:
            _set_progress(task_id, pct=90, msg="后处理：去重与重叠合并...")

        merged_segments = _asr_postprocess_segments(all_segments)

        formatted_segments = []
        for s in merged_segments:
            formatted_segments.append({
                'start': round(s['start'], 3),
                'end': round(s['end'], 3),
                'text': s['text'],
                'originalText': s['text'],
            })

        result_data = {
            'text': ' '.join(all_text_parts),
            'language': detected_lang,
            'segments': formatted_segments,
            'emotion': 'neutral',
        }

        with open(req.output_json_path, 'w', encoding='utf-8') as f:
            json.dump(result_data, f, ensure_ascii=False, indent=2)

        if task_id:
            _set_progress(task_id, pct=95, msg=f"写入完成，{len(formatted_segments)} 段台词")

        print(f"[ASR SUCCESS] faster-whisper: {len(formatted_segments)} 句台词, lang={detected_lang}", file=sys.stderr)
        return {"success": True, "data": result_data}

    except Exception as e:
        print(f"[ASR] faster-whisper 失败: {e}", file=sys.stderr)
        traceback.print_exc()
        # 🔧 内存释放：异常时释放 faster-whisper 模型，避免 CTranslate2 session 残留导致 OOM
        AIModels.release_faster_whisper()
        return _error(f"{type(e).__name__}: {str(e)}")


def _transcribe_sync(req: TranscribeReq, task_id: str = ""):
    """同步 ASR 推理逻辑：在线程池中执行，不阻塞 uvicorn 事件循环

    引擎分发：
    - 'sensevoice' 或 'auto'+CJK语言 → 调用 SenseVoice funasr AutoModel
    - 'faster-whisper' 或 'auto'+非CJK语言 → 调用 faster-whisper（CTranslate2）
    """
    try:
        if not os.path.exists(req.audio_path):
            return _error("Audio file not found", "FS_PATH_INVALID")

        # ── 引擎自动选择：CJK 语言用 sensevoice，其他用 faster-whisper ──
        CJK_LANGS = ['zh', 'ja', 'ko', 'yue']
        selected_engine = req.engine
        if selected_engine == 'auto':
            lang_lower = (req.language or 'auto').lower()
            if lang_lower in CJK_LANGS:
                selected_engine = 'sensevoice'
            else:
                selected_engine = 'faster-whisper'

        # ── 分支 1：faster-whisper（英文/欧洲语言） ──
        if selected_engine == 'faster-whisper':
            return _transcribe_via_faster_whisper(req, task_id)

        # ── 分支 2：funasr AutoModel（内置 fsmn-vad） ──
        try:
            from funasr import AutoModel
            from funasr.utils.postprocess_utils import rich_transcription_postprocess

            if task_id:
                _set_progress(task_id, pct=5, msg="正在加载 SenseVoice 模型...")
            model = AIModels.get_funasr_sensevoice()
            print(f"[ASR] 使用 funasr AutoModel + fsmn-vad，language={req.language}", file=sys.stderr)

            if task_id:
                _set_progress(task_id, pct=15, msg="模型已就绪，开始语音推理...")

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

            if task_id:
                _set_progress(task_id, pct=80, msg=f"推理完成，{len(all_segments)} 段，正在格式化...")

            # ── funasr 返回空结果直接报错，不降级 ──
            if not all_segments:
                print("[ASR] funasr AutoModel 返回空结果", file=sys.stderr)
                # 🔧 内存释放：失败时调用 release 而非仅置 None，触发 gc_collect 回收内存
                AIModels.release_funasr_sensevoice()
                return _error("ASR returned empty result")

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

            if task_id:
                _set_progress(task_id, pct=95, msg=f"写入完成，{len(formatted_segments)} 段台词")

            print(f"[ASR SUCCESS] funasr AutoModel: {len(formatted_segments)} 句台词, lang={dominant_lang}", file=sys.stderr)
            return {"success": True, "data": result_data}

        except Exception as e:
            print(f"[ASR] funasr AutoModel 失败: {e}", file=sys.stderr)
            traceback.print_exc()
            # 🔧 内存释放：异常时释放 funasr 模型，避免损坏的模型实例残留导致后续 OOM
            AIModels.release_funasr_sensevoice()
            return _error(f"{type(e).__name__}: {str(e)}")

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
    """获取指定任务的进度状态，不存在则初始化（SSE 流初始化，不代表任务已启动）"""
    if task_id not in _task_progress:
        _task_progress[task_id] = {
            "pct": 0,
            "msg": "等待中",
            "done": False,
            "result": None,
            "error": None,
            "started": False,  # 🔧 修复竞态：SSE 流初始化时 started=False，POST 真正启动任务时设为 True
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
    """异步人声分离：立即返回 task_id，后台线程池执行分离，进度通过 SSE 推送

    🔧 修复 P0 崩溃：原 `await loop.run_in_executor(...)` 会等待分离完成（Demucs 约 4 分钟），
       而 Node 端 HttpClient 默认 90s 超时 → 重试 2 次 → 重复 POST 相同 task_id →
       daemon 收到 3 次请求，每次都启动 Demucs 模型加载（~2GB/次）→ 内存爆炸崩溃
       (Windows code 3221225477 = ACCESS_VIOLATION)。
       修复：改为 fire-and-forget（与 /api/transcribe 一致），POST 只负责触发，
       结果通过 SSE 流回传（Node 端 PythonProgressSubscriber.subscribe 读取）。
    🔧 task_id 去重：相同 task_id 进行中时拒绝重复执行，避免重复加载模型。
    """
    import asyncio
    import uuid

    task_id = req.task_id or str(uuid.uuid4())

    # 🔧 去重防御：如果该 task_id 已在进行中，直接返回（不重复启动分离）
    #   避免 Node 端 HttpClient 重试或前端重复点击导致 daemon 同时加载多个 Demucs 模型
    # 🔧 修复竞态：必须检查 started=True 才算真正启动，
    #   SSE 流先连接时 _get_progress 会创建 started=False 的占位条目，不能误判为已在执行
    existing = _task_progress.get(task_id)
    if existing and existing.get("started") and not existing.get("done") and not existing.get("error"):
        print(f"[AI Daemon] ⚠️ task_id={task_id} 已在进行中，拒绝重复触发", file=sys.stderr)
        return {"success": True, "task_id": task_id, "deduplicated": True}

    # 重置该任务的进度状态（started=True 表示任务真正启动）
    _task_progress[task_id] = {
        "pct": 0,
        "msg": "正在启动分离引擎...",
        "done": False,
        "result": None,
        "error": None,
        "started": True,
    }

    loop = asyncio.get_running_loop()
    # 🔧 fire-and-forget：后台线程池执行，不等待结果（与 /api/transcribe 一致）
    #   结果通过 SSE /api/separate/stream/{task_id} 推送，彻底规避 HttpClient 超时重试
    loop.run_in_executor(None, _separate_sync_safe, req, task_id)
    # 立即返回 task_id，Node 端通过 SSE 订阅进度和最终结果
    return {"success": True, "task_id": task_id}


def _separate_sync_safe(req, task_id: str):
    """分离任务安全包装：捕获所有异常写入 task_progress，避免线程池静默崩溃

    🔧 修复：原 api_separate 的 try/except 在 await 层，线程池异常会被吞掉。
       现在线程池内部捕获，确保 _set_progress(done=True, error=...) 被调用，
       Node 端 SSE 能收到错误信号而非无限等待。
    🔧 修复：在全局 INFERENCE_LOCK 内执行推理，防止与 ASR/Vision 等其他
       原生推理任务并发执行导致 0xC0000005 ACCESS_VIOLATION 崩溃
    """
    try:
        with INFERENCE_LOCK:
            result = _separate_sync(req, task_id)
        _set_progress(task_id, done=True, pct=100, msg="分离完成", result=result)
        # 补充 task_id 便于 Node 端关联
        if isinstance(result, dict):
            result["task_id"] = task_id
    except Exception as e:
        _set_progress(task_id, done=True, error=str(e), msg=f"分离失败: {e}")
        print(f"[AI Daemon] 分离崩溃: {e}", file=sys.stderr)
        traceback.print_exc()


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
            return _error("Audio file not found", "FS_PATH_INVALID")

        if not os.path.exists(req.output_dir):
            os.makedirs(req.output_dir, exist_ok=True)

        engine = (req.engine or "auto").lower()
        run_demucs = engine in ("demucs", "auto")
        run_mdx = engine in ("mdx", "auto")

        # --- Phase 0: Demucs (highest quality, 4-stem hybrid) ---
        # demucs 4.1.0+ 官方 API：demucs.api.Separator
        if run_demucs:
            # 🔧 修复 SR 崩溃 (exit code: 3221225477 = ACCESS_VIOLATION)：
            # Demucs 加载 ~2GB 模型后，SenseVoice 紧接着加载 ~1.5GB 模型，
            # 仅靠 del + gc.collect() 无法确保 PyTorch C++ 内存分配器释放干净，
            # 导致后续模型加载时访问已释放/碎片化的内存区域 → 进程崩溃。
            # 修复策略：
            #   1. try-finally 确保 Demucs 清理一定执行（即使 FFmpeg 合并失败）
            #   2. del 大型对象 + gc.collect() + torch 缓存清理 + 再次 gc.collect()
            #   3. 500ms 延迟让 OS 回收内存页，稳定后再释放 INFERENCE_LOCK
            demucs_sep = None
            origin = None
            separated = None
            try:
                import demucs
                from demucs.api import Separator as DemucsSeparator
                import subprocess
                import numpy as np

                print("[AI Daemon] 🎵 [Demucs] 正在加载 htdemucs 模型...", file=sys.stderr)
                _set_progress(task_id, pct=5, msg="正在加载 Demucs htdemucs 模型...")

                def _demucs_progress_callback(info):
                    try:
                        seg_offset = info.get('segment_offset') or info.get('offset') or 0
                        audio_len = info.get('audio_length') or info.get('total') or 0
                        progress_ratio = info.get('progress')
                        if audio_len > 0:
                            ratio = min(1.0, seg_offset / audio_len)
                        elif progress_ratio is not None:
                            ratio = min(1.0, max(0.0, float(progress_ratio)))
                        else:
                            return
                        _set_progress(task_id, pct=5 + int(ratio * 80),
                                      msg=f"Demucs 正在分离... {int(ratio * 100)}%")
                    except Exception:
                        pass

                demucs_sep = DemucsSeparator('htdemucs', callback=_demucs_progress_callback)
                origin, separated = demucs_sep.separate_audio_file(req.audio_path)

                _set_progress(task_id, pct=85, msg="Demucs 分离完成，正在保存音轨...")

                sr = demucs_sep.samplerate
                stem_paths = {}

                for stem_name, stem_tensor in separated.items():
                    audio_np = stem_tensor.cpu().numpy()
                    if audio_np.ndim == 2:
                        audio_np = audio_np.T
                    stem_path = os.path.join(req.output_dir, f"{stem_name}_demucs.wav")

                    try:
                        import soundfile as sf
                        sf.write(stem_path, audio_np, sr)
                    except ImportError:
                        # 🔧 兜底：soundfile 不可用时用 scipy.io.wavfile 写文件
                        import scipy.io.wavfile as wavfile
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

            except ImportError as ie:
                # 🔧 增强诊断：打印 Python 解释器路径和 ImportError 详情，帮助定位环境不一致问题
                print(f"[AI Daemon] Demucs 未安装 (ImportError: {ie}), "
                      f"sys.executable={sys.executable}, "
                      f"sys.path[:3]={sys.path[:3]}", file=sys.stderr)
                _set_progress(task_id, pct=5, msg="Demucs 未安装，降级到 MDX-Net...")
            except Exception as demucs_err:
                print(f"[AI Daemon] Demucs 分离失败，降级到 MDX-Net: {demucs_err}", file=sys.stderr)
                _set_progress(task_id, pct=5, msg="Demucs 失败，降级到 MDX-Net...")
            finally:
                # 🔧 修复 SR 崩溃：finally 确保 Demucs 模型资源一定被释放
                # 即使 FFmpeg 合并失败或中途异常，也要清理 PyTorch 内存
                # 关键顺序：先断开引用，再 gc.collect()，否则 GC 无法回收仍被引用的 tensor
                origin = None
                separated = None
                demucs_sep = None
                _cleanup_demucs_memory()

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

                # 🔧 内存释放：MDX-Net 分离完成后立即释放 separator 对象
                # 避免 ONNX 模型缓存累积导致内存溢出
                del separator
                AIModels._gc_collect()

                if target_vocals and target_bgm:
                    print("[AI Daemon] ✅ [MDX-Net] 分离完成", file=sys.stderr)
                    _set_progress(task_id, pct=92, msg="正在清理中间文件...")
                    final_vocals, final_bgm = _finalize_output(req.output_dir, target_vocals, target_bgm)
                    _set_progress(task_id, pct=98, msg="分离完成，即将返回结果")
                    return {"success": True, "vocals": final_vocals, "bgm": final_bgm}
            except Exception as mdx_err:
                # 🔧 增强诊断：打印完整 traceback 和 flush，避免 stderr 缓冲吞掉错误
                print(f"[AI Daemon] ❌ [MDX-Net] 分离失败: {type(mdx_err).__name__}: {mdx_err}", file=sys.stderr, flush=True)
                print(f"[AI Daemon] ❌ [MDX-Net] traceback:", file=sys.stderr, flush=True)
                traceback.print_exc(file=sys.stderr)
                sys.stderr.flush()
                _set_progress(task_id, error=f"MDX-Net: {mdx_err}", done=True)

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
    loop = asyncio.get_running_loop()
    try:
        result = await loop.run_in_executor(None, _detect_beats_sync, req)
        return result
    except Exception as e:
        print(f"ERROR: 节拍检测崩溃 - {str(e)}", file=sys.stderr)
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


def _detect_beats_sync(req: BeatDetectReq) -> dict:
    """节拍检测同步逻辑（带全局推理锁保护，防止并发原生库崩溃）"""
    import numpy as np
    import librosa
    try:
        with INFERENCE_LOCK:
            if not os.path.exists(req.file_path):
                return _error("Audio file not found", "FS_PATH_INVALID")

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
            with INFERENCE_LOCK:
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
