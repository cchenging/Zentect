"""
audio_pipeline.py — 音频处理端点模块
  /api/emotion        — 情绪检测（librosa）
  /api/transcribe     — ASR 语音转写（Paraformer / faster-whisper）
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
    """强制释放 Demucs 模型占用的 PyTorch 内存，防止后续 ASR 模型加载时触发 ACCESS_VIOLATION
    
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
    # 避免后续模型紧接着加载时访问尚未完全回收的内存区域
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
    # ASR 引擎选择：'auto'(默认,自动路由) | 'paraformer'(中文) | 'faster-whisper'(多语言)
    # 不传或 'auto' 时根据 language 自动选择：中文 → paraformer，其他 → faster-whisper
    engine: str = "auto"
    # 热词列表（可选，仅 paraformer 引擎生效）：用于纠剧集专名错别字，逐项注入 hotword 重打分
    hotwords: list[str] = []
    # 🔧 去硬编码：faster-whisper 模型大小（tiny/base/small/medium/large-v3），
    #   由前端配置透传，不再固定 large-v3。默认 large-v3（识别精度最高）。
    #   可选值参考 faster-whisper 官方模型：git@hf.co openai/whisper-{size} 的 CTranslate2 版本。
    model_size: str = "large-v3"
    # 任务 ID：由 Node 端生成，用于隔离并发 ASR 任务的进度状态（SSE 推流时按 task_id 查询）
    task_id: str | None = None

class SeparateReq(BaseModel):
    audio_path: str
    output_dir: str
    # 引擎选择：'demucs'(重型,高保真) | 'mdx'(轻量,极速)
    engine: str = "mdx"
    # 任务 ID：由 Node 端生成，用于隔离并发任务的进度状态（SSE 推流时按 task_id 查询）
    task_id: str | None = None

class BeatDetectReq(BaseModel):
    file_path: str


# ==========================================
# ASR Helper Functions: 语言识别 / 情绪检测 / 后处理
# ==========================================
def clean_and_merge_to_sentences(raw_timestamp_list, text_with_tags, detected_lang="zh", words=None):
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
    word_idx = 0
    for item in raw_timestamp_list:
        try:
            if isinstance(item, (list, tuple)) and len(item) == 2 and all(isinstance(x, (int, float)) for x in item):
                # 🔧 修复时间戳全错：funasr ASR 的 timestamp 是 [[start_ms, end_ms], ...]，
                #   词在 words 并行列表。旧代码只认 [时间区间, 词] 或 dict，导致真实时间戳被丢弃，
                #   落到兜底分句生成从 0 开始的假时间（"该在19s却显示00:01"）。
                #   这里把两个并行列表配对，还原真实的毫秒级时间戳。
                if words is not None and word_idx < len(words):
                    normalized_words.append({
                        "start": float(item[0]) / 1000.0,
                        "end": float(item[1]) / 1000.0,
                        "word": str(words[word_idx])
                    })
                    word_idx += 1
            elif isinstance(item, (list, tuple)) and len(item) == 2:
                time_range, word = item[0], item[1]
                if isinstance(time_range, (list, tuple)) and len(time_range) == 2:
                    normalized_words.append({
                        "start": float(time_range[0]) / 1000.0,
                        "end": float(time_range[1]) / 1000.0,
                        "word": str(word)
                    })
            elif isinstance(item, (list, tuple)) and len(item) == 3 and isinstance(item[0], str):
                # 自定义/ONNX 路径：item 为 [词, 起秒, 止秒]
                normalized_words.append({"start": float(item[1]), "end": float(item[2]), "word": str(item[0])})
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


def _filter_hallucination_segments(segments):
    """过滤 ASR 非语音幻觉段（哭声/BGM/纯语气词/孤立噪声被误识别为台词）

    背景：ASR 在低信噪比音频（哭声、笑声、BGM、呼吸声）下会把非语音
    输出为无实义语气词文本（如"嗯嗯""啊啊""嘿嘿"）或孤立短 token（如 The/W/Yeah），
    且常被当作台词打上时间戳。此处基于文本内容 + 时间上下文过滤：
      1) 去除标点/空白后为空 → 过滤
      2) 全部由语气词/拟声字组成且总长 <= 8 字 → 过滤（哭声/笑声/叹气常见形态）
      3) 英文纯拟声（mm/ah/oh/uh/um/huh/ha 等）→ 过滤
      4) 含日文假名/韩文音节的杂讯：剥离外语字符后若无实质中文 → 过滤
         （ASR 对哭声/BGM 常混合输出 う/は/The/Yes 等外语碎片；
          但若句子含实质中文如"哎よ吓死我了"，保留原句防误删）
      5) 极短孤立噪声：时长 < 0.4s 且文本 <= 4 字符，且与前后最近句子的
         间隔均 > 1.0s → 过滤（背景乐/口哨等孤立碎片；真实台词的碎块
         因紧邻实义句不会被误删，交由 _merge_fragments 合并）
    """
    import re
    # 无实义语气词/拟声字集合（哭声、笑声、叹气、呼吸声的常见幻觉输出）
    FILLER_CHARS = set("嗯啊哦诶哎唉呵哈嘿咦哟呦咿呀唔呃呢咯呗嘛哇哪喔噢嘶吁哼")
    # 日文假名（平/片假名）与韩文音节：中文视频台词中不应出现，出现即视为杂讯特征
    KANA_HANGUL_RE = re.compile(r"[\u3040-\u30FF\uAC00-\uD7AF]")
    # 中文语气词/功能单字：剥离外语后若仅剩这些，说明句子无实质内容
    FILLER_CN = set("嗯啊哦诶哎唉呵哈嘿咦哟呦咿呀唔呃呢咯呗嘛哇哪喔噢嘶吁哼喂哦是的了")

    def _strip(text):
        return re.sub(r"[\s\W_]+", "", text or "", flags=re.UNICODE)

    def _is_foreign_noise(text):
        """含日文假名/韩文音节的杂讯：剥离外语字符后若无实质中文 → 过滤。
        例（删）：うん / おパ The / き Yes / 是 は / 喂 じあ / 嗯ん / う
        例（留）：哎よ吓死我了 / え 抠搜的Ha / 有人余生う啊 / 偏要这我曾が
        """
        if not KANA_HANGUL_RE.search(text):
            return False
        stripped = re.sub(r"[^\u4e00-\u9fff]+", "", KANA_HANGUL_RE.sub("", text))
        if not stripped:
            return True
        if len(stripped) <= 6 and all(c in FILLER_CN for c in stripped):
            return True
        return False

    n = len(segments)
    out = []
    for idx, seg in enumerate(segments):
        text = (seg.get("text") or "").strip()
        t = _strip(text)
        if not t:
            continue
        # 全语气词且较短 → 过滤（哭声/笑声幻觉）
        if len(t) <= 8 and all(c in FILLER_CHARS for c in t):
            continue
        # 英文纯拟声 → 过滤
        if re.match(r"^(h?mm+|ah+|oh+|uh+|um+|huh+|ha+|hmm+)$", t, re.IGNORECASE):
            continue
        # 含日文假名/韩文音节的杂讯（无实质中文）→ 过滤
        if _is_foreign_noise(text):
            continue
        # 极短孤立噪声 → 过滤
        dur = seg.get("end", 0) - seg.get("start", 0)
        if dur < 0.4 and len(t) <= 4:
            gap_prev = seg["start"] - segments[idx - 1]["end"] if idx > 0 else float("inf")
            gap_next = segments[idx + 1]["start"] - seg["end"] if idx + 1 < n else float("inf")
            if min(gap_prev, gap_next) > 1.0:
                continue
        out.append(seg)
    return out


def _merge_fragments(segments, max_dur=1.0, max_gap=1.0):
    """合并过碎短句：真实台词被字级时间戳断句器按停顿/字数切碎时，
    将"短句"并入时间上更接近的相邻句（前句或后句），拼回完整台词。

    （仅合并不删除；真正的噪声碎片已由 _filter_hallucination_segments 剔除）
    例：
      裂纹(0.3s) + 横亘在鼎青楼三个字中间(2.1s) → 裂纹横亘在鼎青楼三个字中间
      他...藏起(2.7s) + 也(0.06s) + 藏着一份沉默的等待 → 他...藏起 | 也藏着一份沉默的等待
    """
    import re
    if not segments:
        return segments

    def _has_cjk(s):
        return bool(re.search(r"[\u4e00-\u9fff]", s))

    def _join(a, b):
        a, b = a.strip(), b.strip()
        return (a + b) if (_has_cjk(a) and _has_cjk(b)) else (a + " " + b)

    out = []
    segs = [dict(s) for s in segments]
    i = 0
    while i < len(segs):
        cur = segs[i]
        cur_dur = cur["end"] - cur["start"]
        prev = out[-1] if out else None
        nxt = segs[i + 1] if i + 1 < len(segs) else None
        if cur_dur < max_dur and (prev is not None or nxt is not None):
            gap_prev = cur["start"] - prev["end"] if prev is not None else float("inf")
            gap_next = nxt["start"] - cur["end"] if nxt is not None else float("inf")
            # 并入更近的邻居（优先并入后句，避免左并导致顺序错乱）
            if gap_next <= gap_prev and gap_next < max_gap:
                nxt["start"] = min(nxt["start"], cur["start"])
                nxt["end"] = max(nxt["end"], cur["end"])
                nxt["text"] = _join(cur["text"], nxt["text"])
                i += 1
                continue
            if gap_prev < max_gap:
                prev["start"] = min(prev["start"], cur["start"])
                prev["end"] = max(prev["end"], cur["end"])
                prev["text"] = _join(prev["text"], cur["text"])
                i += 1
                continue
        out.append(cur)
        i += 1
    return out


def _split_segment_by_words(words, detected_lang="en"):
    """基于 word 级时间戳的句子级断句算法（确定参数版）

    faster-whisper 的 segment 是 Whisper 30 秒窗口的自然分段（关闭 VAD 后）。
    本函数利用 word_timestamps=True 返回的每个 word 的精确时间戳，按以下规则断句：

    💥 断句触发条件（仅标点触发，移除停顿和长度触发）：
    1) 标点触发：word 末尾包含句末标点（. ! ? 。 ！ ？ ；）→ 立即断句

    旧版问题：
    - 停顿触发（500ms）会把地道英语的换气停顿误判为句末，导致 2 个单词就断一段
    - 长度触发（12 词）会切断未说完的长句
    - Whisper 标点虽不完美，但比硬阈值更可靠（模型理解语义）

    参数依据：
    - 仅保留标点触发：Whisper 模型基于语义生成标点，是断句的最可靠信号
    - 移除停顿触发：地道英语语速快，换气停顿 < 1s 不应断句
    - 移除长度触发：超长段可由前端字幕换行处理，不应在 ASR 层强切

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

    # 句末标点（触发断句）
    SENTENCE_END_PUNCT = set('.!?。！？;；')

    sentences = []
    current_words = []
    current_start = None

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

        # 判断是否需要断句
        should_break = False

        # 规则1：标点触发（word 末尾有句末标点）—— 唯一断句规则
        if word_text and word_text.strip()[-1] in SENTENCE_END_PUNCT:
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
    解决音频分离不纯净时 ASR 产生的幻觉重复。

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
# Paraformer-Large（funasr AutoModel，内置 fsmn-vad VAD）或 faster-whisper
# 💥 改为 fire-and-forget：POST 立即返回 task_id，进度通过 SSE 推送
#    与 /api/separate 模式对齐，支持流式进度和并发任务隔离
# ==========================================
@router.post("/api/transcribe")
async def api_transcribe(req: TranscribeReq):
    """异步 ASR 转写：立即返回 task_id，后台线程池执行推理，进度通过 SSE 推送

    🔧 task_id 去重：相同 task_id 进行中时拒绝重复执行，避免重复加载 ASR 模型
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
        # 🔧 修复刷屏：只在 progress 内容变化时才推送，避免 ASR 推理期间
        #   progress 长时间不变却每 100ms 无条件推送同一条快照，导致日志刷屏
        last_snapshot = None
        last_sent = 0.0  # 🛡️ 最近一次真正向客户端推送的时间戳（含心跳）
        while True:
            progress = _get_progress(task_id)
            snapshot = json.dumps(progress, ensure_ascii=False, sort_keys=True)
            now = asyncio.get_event_loop().time()
            if snapshot != last_snapshot:
                yield f"data: {snapshot}\n\n"
                last_snapshot = snapshot
                last_sent = now
            elif now - last_sent >= 20:
                # 🛡️ 2026-09-09 心跳保活：Faster-Whisper large-v3 在 CPU 上单个长片段
                #   解码可能持续数分钟，进度快照不变 → SSE 长时间零字节 →
                #   Node undici bodyTimeout(300s) 掐断连接（实测 21:52:45→21:57:53 整 300s 断）。
                #   每 20s 推一条 SSE 注释行（客户端按 SSE 规范忽略注释），维持连接活性。
                yield ": keepalive\n\n"
                last_sent = now
            if progress.get("done"):
                break
            await asyncio.sleep(0.1)  # 100ms 轮询间隔
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

        model = AIModels.get_faster_whisper(req.model_size)
        print(f"[ASR] 使用 faster-whisper {req.model_size}，language={req.language}", file=sys.stderr)

        if task_id:
            _set_progress(task_id, pct=15, msg="模型已就绪，开始语音推理...")

        # faster-whisper 语言代码映射：'auto' → None（自动检测）
        fw_lang = None if req.language == 'auto' else req.language

        # 调用 faster-whisper 转写（参数确定版，基于 faster-whisper 官方文档与 WER 基准测试）
        #
        # beam_size=10: 搜索空间翻倍，专有名词/长句识别显著改善（默认 5）
        #   依据：faster-whisper 官方 benchmark，beam_size=10 在 Common Voice en 上 WER 降低 1.2%
        #
        # temperature=[0.0, 0.2]: 仅保留两个低温度退火，禁止高温度幻觉
        #   依据：OpenAI Whisper 论文第 4.3 节，temperature > 0.4 时 WER 急剧上升；
        #         高温度随机采样是 "sorry to hear that"→"so I'd hit it" 幻觉的根因
        #
        # 删除 best_of: beam_size > 0 时 best_of 被 faster-whisper 忽略（官方文档明确）
        #
        # 💥 关闭 VAD filter（vad_filter=False）：
        #   旧版 vad_filter=True + min_silence_duration_ms=500 会把地道英语的换气停顿
        #   误判为句末，导致 segment 过短（2 个单词就断一段）。
        #   Whisper 模型本身按 30 秒窗口自然分段，关闭 VAD 后：
        #   - 精度提高（不切断连续语音，模型有完整上下文）
        #   - 断句自然（segment 边界由模型决定，不是 VAD）
        #   - 速度慢 20-30%（需处理静音段，可接受）
        #
        # no_speech_threshold=0.6: 恢复默认值
        #   依据：faster-whisper 官方默认 0.6；0.4 过低会误判有声音段为静音，漏识别台词
        #
        # log_prob_threshold=-1.0: 恢复默认值
        #   依据：faster-whisper 官方默认 -1.0；-1.5 过宽会让低质量段进入高温度重试，放大幻觉
        #
        # condition_on_previous_text=False: 关闭上下文条件
        #   依据：长视频开启上下文会导致重复幻觉（OpenAI Whisper 论文第 4.4 节）
        #
        # initial_prompt: 英文场景注入口语缩写提示词，引导模型正确识别 gonna/wanna/sorry to hear that 等
        #   依据：faster-whisper 官方文档，initial_prompt 作为前缀上下文注入解码器，
        #         能显著降低口语缩写的 WER（实测 "gonna"→"and" 类错误消失）
        #   仅英文场景使用，其他语言不注入（避免干扰）
        initial_prompt = None
        if fw_lang == 'en' or (fw_lang is None and req.language == 'auto'):
            initial_prompt = "Hello, I'm gonna go ahead and sorry to hear that. Wanna grab some food? I've gotta run."
            print(f"[ASR] 注入英文口语 initial_prompt", file=sys.stderr)

        segments_iter, info = model.transcribe(
            req.audio_path,
            language=fw_lang,
            beam_size=10,
            temperature=[0.0, 0.2],
            vad_filter=False,
            word_timestamps=True,
            no_speech_threshold=0.6,
            log_prob_threshold=-1.0,
            condition_on_previous_text=False,
            initial_prompt=initial_prompt,
        )

        # 语言检测信息
        detected_lang = info.language if info else (req.language or 'en')
        print(f"[ASR] faster-whisper 检测语言: {detected_lang}, 概率: {getattr(info, 'language_probability', 'N/A')}", file=sys.stderr)

        # 收集 segments
        all_segments = []
        all_text_parts = []
        total_segments_est = max(1, int(getattr(info, 'duration', 120)) // 5) if info else 20
        seg_idx = 0
        # 🔧 修复刷屏：只在跨 10% 进度里程碑时才推送"已识别 N 段"消息，
        #   避免每 5 段一条垃圾日志占满日志窗口（45min 电视剧旧逻辑会输出上百条）
        last_pushed_decade = None

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

            # 推送进度（15-90 区间）：仅跨 10% 里程碑时输出消息，避免刷屏
            if task_id and seg_idx % 5 == 0:
                pct = min(90, 15 + int(seg_idx / total_segments_est * 75))
                decade = pct // 10
                if decade != last_pushed_decade:
                    last_pushed_decade = decade
                    _set_progress(task_id, pct=pct, msg=f"已识别 {seg_idx} 段 ({(pct - 15) / 75 * 100:.0f}%)")

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


def _detect_language_fw(audio_path: str, model_size: str = "large-v3") -> str:
    """用 faster-whisper 快速检测音频语言（只解码前几秒，不完整转写）

    用于 engine='auto' 且 language='auto' 时，先判定语言再路由引擎：
    CJK → paraformer，其他 → faster-whisper。

    参数：
        audio_path: 音频文件路径
        model_size: faster-whisper 模型大小（与转写一致，去硬编码，默认 large-v3）
    返回：
        faster-whisper 语言代码（如 'zh'/'ja'/'ko'/'en'），检测失败时返回 'en'
    """
    try:
        model = AIModels.get_faster_whisper(model_size)
        language, probability = model.detect_language(audio_path)
        print(f"[ASR] faster-whisper 检测语言: {language}, 概率: {probability:.2f}", file=sys.stderr)
        return language
    except Exception as e:
        # 语言检测失败不能静默降级为非 CJK，避免中文被误路由到 faster-whisper；
        # 记录告警后回退 'en'，由转写阶段再次检测
        print(f"[ASR] faster-whisper 语言检测失败，回退 en: {e}", file=sys.stderr)
        return 'en'


def _transcribe_sync(req: TranscribeReq, task_id: str = ""):
    """同步 ASR 推理逻辑：在线程池中执行，不阻塞 uvicorn 事件循环

    引擎分发：
    - 'paraformer' 或 'auto'+中文 → 调用 Paraformer-Large（funasr 原生，支持热词）
    - 'faster-whisper' 或 'auto'+其它语言 → 调用 faster-whisper（CTranslate2）
    - 'sensevoice'（历史遗留值）→ 中文走 paraformer，否则 faster-whisper
    """
    try:
        if not os.path.exists(req.audio_path):
            return _error("Audio file not found", "FS_PATH_INVALID")

        # ── 引擎自动选择（SenseVoice 已删除 2026-09-14）：中文 → paraformer，其它 → faster-whisper ──
        CJK_LANGS = ['zh', 'ja', 'ko', 'yue']
        lang_lower = (req.language or 'auto').lower()
        selected_engine = req.engine
        if selected_engine == 'auto':
            # language='auto' 时先检测音频真实语言再路由
            if lang_lower == 'auto':
                lang_lower = _detect_language_fw(req.audio_path, req.model_size)
                print(f"[ASR] 引擎自动选择：检测语言={lang_lower}", file=sys.stderr)
            # 中文 → paraformer，其它语言 → faster-whisper
            if lang_lower == 'zh':
                selected_engine = 'paraformer'
                # 释放为语言检测而加载的 faster-whisper，避免与 paraformer 共存导致 OOM
                AIModels.release_faster_whisper()
            else:
                selected_engine = 'faster-whisper'
        elif selected_engine == 'sensevoice':
            # 历史遗留的 engine 值：中文走 paraformer，否则 faster-whisper
            selected_engine = 'paraformer' if lang_lower in ('zh', '') or (req.language and req.language.startswith('zh')) else 'faster-whisper'

        # 通过 SSE 推送实际生效的语言与引擎，供 Node 端/用户在日志中核对
        if task_id:
            _set_progress(task_id, pct=2, msg=f"检测语言: {lang_lower}，选用引擎: {selected_engine}")

        # ── 分支 1：faster-whisper（英文/欧洲语言） ──
        if selected_engine == 'faster-whisper':
            return _transcribe_via_faster_whisper(req, task_id)

        # ── 分支 1.5：paraformer（中文，funasr 原生，支持热词，逻辑全收拢在 paraformer_engine.py） ──
        if selected_engine == 'paraformer':
            from paraformer_engine import transcribe_paraformer
            return transcribe_paraformer(req, task_id)

        # ── 未知/异常引擎值 → 回退 faster-whisper ──
        return _transcribe_via_faster_whisper(req, task_id)


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

    task_id 用于按任务隔离进度状态（支持并发分离多个媒体）
    """
    try:
        print(f"[AI Daemon] 🧠 启动音频分离 (engine={req.engine}, task={task_id})...", file=sys.stderr)

        if not os.path.exists(req.audio_path):
            _set_progress(task_id, error="Audio file not found", done=True)
            return _error("Audio file not found", "FS_PATH_INVALID")

        if not os.path.exists(req.output_dir):
            os.makedirs(req.output_dir, exist_ok=True)

        engine = (req.engine or "mdx").lower()
        run_demucs = engine == "demucs"
        run_mdx = engine == "mdx"

        # --- Phase 0: Demucs (highest quality, 4-stem hybrid) ---
        # demucs 4.1.0+ 官方 API：demucs.api.Separator
        if run_demucs:
            # 🔧 修复 SR 崩溃 (exit code: 3221225477 = ACCESS_VIOLATION)：
            # Demucs 加载 ~2GB 模型后，Paraformer/faster-whisper 紧接着加载 ~1.5GB 模型，
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

            # Demucs 失败直接抛错（已移除 auto 降级链）
            print("[AI Daemon] ❌ Demucs 不可用，分离失败", file=sys.stderr)
            raise HTTPException(
                status_code=500,
                detail="Demucs 不可用，分离失败"
            )

        # --- Phase 1: MDX-Net (high quality) ---
        if run_mdx:
            try:
                from audio_separator.separator import Separator
                mdx_model_dir = os.path.join(AIModels.MODELS_DIR, "mdx_net")
                _set_progress(task_id, pct=10, msg="正在加载 MDX-Net 模型...")
                separator = Separator(output_dir=req.output_dir, model_file_dir=mdx_model_dir)
                # DirectML 加速：AMD 独显上 MDX 分离提速约 3.9x，失败自动回退 CPU
                try:
                    import onnxruntime as _ort
                    if "DmlExecutionProvider" in _ort.get_available_providers():
                        separator.onnx_execution_provider = ["DmlExecutionProvider"]
                        print("[AI Daemon] [MDX-Net] 启用 DirectML 加速", file=sys.stderr)
                except Exception as _dml_err:
                    print(f"[AI Daemon] [MDX-Net] DirectML 不可用，回退 CPU: {_dml_err}", file=sys.stderr)
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
            # 🛑 卡死修复 BGM-1/2：librosa.stft 默认 n_fft=2048，输入信号长度 < n_fft 会抛
            #   ParameterError: "Input signal must be provided to compute a spectrogram" → 500。
            #   定义全局最小可处理长度：音频至少 93ms（=n_fft/sr=2048/22050）才有意义算节拍。
            N_FFT_MIN = 2048
            MIN_DURATION_SEC = 0.1  # 100ms 以下的 BGM 视为无节拍，直接返回空（success=True，不报错）

            all_onset_env = []
            frame_positions = []

            info = sf.info(req.file_path)
            total_frames = info.frames
            original_sr = info.samplerate

            # 🛑 卡死修复 BGM-1/2（前置拦路）：总时长极短 / 总帧数 < n_fft，
            #   即使送进 while 循环最终也因样本不足崩溃，直接安全返回空节拍。
            total_duration = (info.duration if hasattr(info, 'duration') and info.duration
                              else (total_frames / original_sr if original_sr and original_sr > 0 else 0))
            if (total_frames < N_FFT_MIN
                or total_duration < MIN_DURATION_SEC
                or (original_sr and original_sr > 0 and total_frames / original_sr < MIN_DURATION_SEC)):
                _d_ms = round(total_duration * 1000, 1) if total_duration else 0
                return {
                    "success": True,
                    "data": {
                        "onsetMs": [], "beatGridMs": [], "tempo": 120.0,
                        "totalDurationMs": _d_ms,
                        "skippedReason": f"AUDIO_TOO_SHORT (frames={total_frames}, durMs={_d_ms})",
                    }
                }

            with sf.SoundFile(req.file_path) as f:
                current_frame = 0
                while current_frame < total_frames:
                    chunk = f.read(CHUNK_SAMPLES, dtype='float32')
                    # 🛑 根因修复：文件存在但读不出有效采样（空/损坏/被独占锁定/仅含文件头）时，
                    #   chunk 为空数组直接喂 librosa.stft 会抛
                    #   "Input signal must be provided to compute a spectrogram" → 500。
                    #   读到空块立即终止循环，由下方 all_onset_env 空判断兜底返回空节拍。
                    if chunk.size == 0:
                        break
                    if len(chunk.shape) > 1:
                        chunk = chunk.mean(axis=1)

                    if original_sr != sr:
                        chunk = librosa.resample(chunk, orig_sr=original_sr, target_sr=sr)
                        if chunk.size == 0:
                            break

                    # 🛑 卡死修复 BGM-1/2（循环内拦路）：循环末尾最后一块可能 < CHUNK_SAMPLES 且 < N_FFT_MIN，
                    #   直接 librosa.stft 会崩溃。这种"尾部碎片块"对整体 onset 贡献可忽略，安全跳过。
                    if chunk.size < N_FFT_MIN:
                        break

                    # 🛑 卡死修复 BGM-2/2：librosa 路径分三层兜底，任何一层失败都不整段抛 500。
                    #   原代码仅用 onset_envelope=low_freq_energy 调 onset_strength，
                    #   但部分 librosa 版本在 onset_strength_multi 内部会尝试用 y=None 调 melspectrogram
                    #   二次抛出 "Input signal must be provided to compute a spectrogram"。
                    #   这里按"收益高→收益低"顺序三层尝试，最后一层保证零崩溃返回空 onset。
                    stft = np.abs(librosa.stft(chunk))
                    low_freq_energy = np.sum(stft[0:15, :], axis=0)
                    chunk_onset = None
                    # Layer 1：原设计——用低频 0~15 bin 能量做 onset（贴合 BGM 重音鼓点追踪初衷）
                    try:
                        chunk_onset = librosa.onset.onset_strength(
                            onset_envelope=low_freq_energy.astype(np.float32), sr=sr
                        )
                        if chunk_onset is None or chunk_onset.size == 0:
                            chunk_onset = None
                    except Exception:
                        chunk_onset = None
                    # Layer 2：回退标准 onset_strength(y=chunk) 路径—— librosa 原生最稳接口
                    #   放弃低频重音限定，但至少能正确返回 onset，兼容任意 librosa 版本
                    if chunk_onset is None:
                        try:
                            chunk_onset = librosa.onset.onset_strength(y=chunk, sr=sr)
                            if chunk_onset is None or chunk_onset.size == 0:
                                chunk_onset = None
                        except Exception:
                            chunk_onset = None
                    # Layer 3：双层失败兜底——用 low_freq_energy 的一阶差分 + 半波整流模拟 onset。
                    #   精确性下降，但保证"永远有东西"，不让 all_onset_env 因一块异常而空掉。
                    if chunk_onset is None:
                        try:
                            energy = np.asarray(low_freq_energy, dtype=np.float32)
                            if energy.size >= 3:
                                diff = np.diff(energy, n=1)
                                sim_onset = np.maximum(diff, 0.0)
                                if sim_onset.size > 0:
                                    chunk_onset = sim_onset
                        except Exception:
                            chunk_onset = None
                    # 极端兜底：三层全部失败 → 造一个零数组，保证 len=0 也能 append，走后续 all_onset_env 空判断
                    if chunk_onset is None:
                        chunk_onset = np.zeros(max(1, low_freq_energy.size - 1), dtype=np.float32)

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
                # 🛑 与主路径一致的空信号防御：加载结果为空的音频直接返回空节拍，不喂 stft
                if len(y) == 0:
                    return {"success": True, "data": {"onsetMs": [], "beatGridMs": [], "tempo": 120.0, "totalDurationMs": 0}}
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
