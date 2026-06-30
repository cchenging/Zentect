"""
tts_worker.py — MOSS-TTS-Nano 语音合成工作进程
基于 OpenMOSS MOSS-TTS-Nano-100M-ONNX + MOSS-Audio-Tokenizer-Nano-ONNX

以 FastAPI/Uvicorn HTTP 服务形式运行，供 AIDaemon 以子进程方式启动。
启动方式: python tts_worker.py --port 9881 --model_dir <path>

API:
  GET  /health — 健康检查
  POST /tts    — 语音合成，请求体 {"text": "...", "voice": "Junhao", "speed": 1.0}
                响应 {"code": 0, "audio": "<hex-wav>"}

Python 3.10+ 兼容
"""

import sys
import os
import io
import argparse
import warnings
import traceback
import json
import time
import struct
import hashlib
from typing import List, Optional, Dict

warnings.filterwarnings('ignore', category=DeprecationWarning)
warnings.filterwarnings('ignore', message='.*pkg_resources.*')
warnings.filterwarnings('ignore', category=UserWarning)

import numpy as np
import sentencepiece as spm
import onnxruntime as ort

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import uvicorn

# ============================================================
# UTF-8 编码强制设置
# ============================================================
os.environ['PYTHONIOENCODING'] = 'utf-8'
os.environ['PYTHONUTF8'] = '1'

try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')
except Exception:
    pass

warnings.filterwarnings('ignore')

# ============================================================
# 命令行参数解析
# ============================================================
parser = argparse.ArgumentParser()
parser.add_argument('--port', type=int, default=9881)
parser.add_argument('--model_dir', type=str, default=None,
                    help='MOSS-TTS-Nano 模型目录 (包含 MOSS-TTS-Nano-100M-ONNX 和 MOSS-Audio-Tokenizer-Nano-ONNX)')
args, unknown = parser.parse_known_args()

port = args.port or int(os.environ.get('TTS_PORT', 9881))

if args.model_dir:
    MODEL_DIR = os.path.abspath(args.model_dir)
else:
    MODEL_DIR = os.path.abspath(os.path.join(
        os.path.dirname(os.path.abspath(__file__)), '..', 'models', 'moss-tts-nano'
    ))

TTS_ONNX_DIR = os.path.join(MODEL_DIR, 'MOSS-TTS-Nano-100M-ONNX')
CODEC_ONNX_DIR = os.path.join(MODEL_DIR, 'MOSS-Audio-Tokenizer-Nano-ONNX')
TOKENIZER_PATH = os.path.join(TTS_ONNX_DIR, 'tokenizer.model')
MANIFEST_PATH = os.path.join(TTS_ONNX_DIR, 'browser_poc_manifest.json')

# ============================================================
# Pydantic 请求/响应模型
# ============================================================

class TTSRequest(BaseModel):
    text: str
    voice: str = 'Junhao'
    speed: float = 1.0


class TTSResponse(BaseModel):
    code: int
    audio: Optional[str] = None
    message: Optional[str] = None


# ============================================================
# FastAPI 应用
# ============================================================
app = FastAPI()


# ============================================================
# 模型管理 — TTSModel 单例
# ============================================================

class TTSModel:
    """MOSS-TTS-Nano 模型管理器（懒加载单例）"""

    _instance = None
    _initialized = False

    # ONNX sessions
    prefill_session = None
    decode_session = None
    local_cached_session = None
    local_fixed_sampled_session = None
    codec_decode_session = None

    # Tokenizer
    sp = None

    # 配置
    manifest: Dict = {}
    voices: Dict = {}
    model_config: Dict = {}
    gen_defaults: Dict = {}
    prompt_templates: Dict = {}

    # ONNX I/O 名称映射
    prefill_output_names: List[str] = []
    decode_input_names: List[str] = []
    decode_output_names: List[str] = []
    local_cached_input_names: List[str] = []
    local_cached_output_names: List[str] = []
    local_fixed_input_names: List[str] = []
    local_fixed_output_names: List[str] = []

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    @classmethod
    def ensure_loaded(cls):
        """懒加载所有模型资源"""
        if cls._initialized:
            return

        print('[TTS Worker] 🧠 加载 MOSS-TTS-Nano 模型...', file=sys.stderr)
        t_start = time.time()

        # --- 加载配置 ---
        with open(MANIFEST_PATH, 'r', encoding='utf-8') as f:
            cls.manifest = json.load(f)

        cls.model_config = cls.manifest['tts_config']
        cls.gen_defaults = cls.manifest.get('generation_defaults', {})
        cls.prompt_templates = cls.manifest.get('prompt_templates', {})

        # 加载元数据文件获取 ONNX I/O 名称
        meta_path = os.path.join(TTS_ONNX_DIR, 'tts_browser_onnx_meta.json')
        if os.path.exists(meta_path):
            with open(meta_path, 'r', encoding='utf-8') as f:
                meta = json.load(f)
            onnx_meta = meta.get('onnx', {})
            cls.prefill_output_names = onnx_meta.get('prefill_output_names', [])
            cls.decode_input_names = onnx_meta.get('decode_input_names', [])
            cls.decode_output_names = onnx_meta.get('decode_output_names', [])
            cls.local_cached_input_names = onnx_meta.get('local_cached_input_names', [])
            cls.local_cached_output_names = onnx_meta.get('local_cached_output_names', [])
            cls.local_fixed_input_names = onnx_meta.get('local_fixed_sampled_frame_input_names', [])
            cls.local_fixed_output_names = onnx_meta.get('local_fixed_sampled_frame_output_names', [])

        # 索引音色
        for v in cls.manifest.get('builtin_voices', []):
            cls.voices[v['voice']] = v

        # --- 加载 Tokenizer ---
        cls.sp = spm.SentencePieceProcessor(model_file=TOKENIZER_PATH)

        # --- 加载 ONNX 会话 ---
        so = ort.SessionOptions()
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
        so.intra_op_num_threads = 4
        so.inter_op_num_threads = 2
        # 抑制 ONNX Runtime 警告
        so.log_severity_level = 3

        providers = ['CPUExecutionProvider']

        cls.prefill_session = ort.InferenceSession(
            os.path.join(TTS_ONNX_DIR, 'moss_tts_prefill.onnx'),
            so, providers=providers
        )
        cls.decode_session = ort.InferenceSession(
            os.path.join(TTS_ONNX_DIR, 'moss_tts_decode_step.onnx'),
            so, providers=providers
        )
        cls.local_cached_session = ort.InferenceSession(
            os.path.join(TTS_ONNX_DIR, 'moss_tts_local_cached_step.onnx'),
            so, providers=providers
        )
        cls.local_fixed_sampled_session = ort.InferenceSession(
            os.path.join(TTS_ONNX_DIR, 'moss_tts_local_fixed_sampled_frame.onnx'),
            so, providers=providers
        )
        cls.codec_decode_session = ort.InferenceSession(
            os.path.join(CODEC_ONNX_DIR, 'moss_audio_tokenizer_decode_full.onnx'),
            so, providers=providers
        )

        cls._initialized = True
        elapsed = time.time() - t_start
        print(f'[TTS Worker] ✅ 模型加载完成 ({elapsed:.1f}s)，'
              f'可用音色: {len(cls.voices)} 个', file=sys.stderr)

    @classmethod
    def get_voice(cls, voice_name: str) -> Dict:
        """获取指定音色的配置，不存在时回退到 Junhao"""
        cls.ensure_loaded()
        if voice_name in cls.voices:
            return cls.voices[voice_name]
        fallback = cls.voices.get('Junhao', next(iter(cls.voices.values())))
        print(f'[TTS Worker] ⚠️ 音色 "{voice_name}" 不存在，回退到 {fallback["voice"]}',
              file=sys.stderr)
        return fallback

    @classmethod
    def release(cls):
        """释放所有模型资源"""
        for attr in ['prefill_session', 'decode_session', 'local_cached_session',
                      'local_fixed_sampled_session', 'codec_decode_session']:
            session = getattr(cls, attr, None)
            if session is not None:
                del session
                setattr(cls, attr, None)
        cls.sp = None
        cls._initialized = False
        import gc
        gc.collect()
        print('[TTS Worker] 🧹 所有模型已释放', file=sys.stderr)


# ============================================================
# 语音合成核心逻辑
# ============================================================

def _build_input_ids(text_token_ids: List[int],
                     audio_codes: List[List[int]],
                     config: Dict) -> np.ndarray:
    """
    构建 prefill 输入张量 [1, seq_len, 17]

    每个位置是一个 17 维向量:
      - 文本位置: slot[0]=text_token_id, slot[1:17]=audio_pad_token_id
      - 音频位置: slot[0]=audio_user_slot_token_id (或 audio_assistant_slot_token_id),
                  slot[1:17]=对应的 audio codebook 值
    """
    n_vq = config['n_vq']  # 16
    row_width = n_vq + 1   # 17
    audio_pad = config['audio_pad_token_id']  # 1024
    audio_assistant_slot = config.get('audio_assistant_slot_token_id', 9)

    # 计算总长度 = 文本 token 数 + 音频帧数
    n_text = len(text_token_ids)
    n_audio_frames = len(audio_codes)
    total_len = n_text + n_audio_frames

    # 补齐到 row_width 的倍数
    remainder = total_len % row_width
    if remainder != 0:
        pad_len = row_width - remainder
        total_len += pad_len
    else:
        pad_len = 0

    input_ids = np.full((1, total_len, row_width), audio_pad, dtype=np.int32)

    # 填入文本 token
    for i, tid in enumerate(text_token_ids):
        input_ids[0, i, 0] = tid

    # 填入音频 codes（在文本之后）
    offset = n_text
    for frame_idx, frame_codes in enumerate(audio_codes):
        input_ids[0, offset + frame_idx, 0] = audio_assistant_slot
        for vq_idx in range(min(len(frame_codes), n_vq)):
            input_ids[0, offset + frame_idx, vq_idx + 1] = frame_codes[vq_idx]

    return input_ids


def _run_prefill(input_ids: np.ndarray, attention_mask: np.ndarray):
    """运行 prefill 获取 global_hidden 和 KV cache"""
    model = TTSModel

    # 构建输入字典
    ort_inputs = {
        'input_ids': input_ids,
        'attention_mask': attention_mask,
    }

    outputs = model.prefill_session.run(None, ort_inputs)

    # 解析输出
    global_hidden = outputs[0]  # [1, seq_len, 768]
    # KV cache: present_key_0..11, present_value_0..11 (共 24 个张量，不含 global_hidden)
    kv_cache = outputs[1:]  # 24 tensors

    return global_hidden, kv_cache


def _run_decode_step(input_ids_step: np.ndarray,
                     past_valid_lengths: np.ndarray,
                     kv_cache: List[np.ndarray]):
    """运行单步 decode，返回新的 global_hidden 和更新后的 KV cache"""
    model = TTSModel

    ort_inputs = {
        'input_ids': input_ids_step,
        'past_valid_lengths': past_valid_lengths,
    }

    # 填充 KV cache 输入 (past_key_0..11, past_value_0..11)
    for i in range(12):
        ort_inputs[f'past_key_{i}'] = kv_cache[i * 2]
        ort_inputs[f'past_value_{i}'] = kv_cache[i * 2 + 1]

    outputs = model.decode_session.run(None, ort_inputs)

    global_hidden = outputs[0]      # [1, 1, 768]
    new_kv_cache = outputs[1:]      # 24 tensors

    return global_hidden, new_kv_cache


def _run_local_fixed_sampled_frame(global_hidden: np.ndarray,
                                   repetition_seen_mask: np.ndarray,
                                   assistant_random_u: float,
                                   audio_random_u: np.ndarray):
    """运行 local_fixed_sampled_frame 采样一帧音频 token"""
    model = TTSModel

    batch_size = global_hidden.shape[0]
    gh = global_hidden.reshape(batch_size, -1)  # [1, 768]

    ort_inputs = {
        'global_hidden': gh.astype(np.float32),
        'repetition_seen_mask': repetition_seen_mask,
        'assistant_random_u': np.array([assistant_random_u], dtype=np.float32),
        'audio_random_u': audio_random_u.astype(np.float32),
    }

    outputs = model.local_fixed_sampled_session.run(None, ort_inputs)

    should_continue = bool(outputs[0][0, 0])
    frame_token_ids = outputs[1][0].tolist()  # [16]

    return should_continue, frame_token_ids


def _decode_audio(audio_codes: List[List[int]]) -> np.ndarray:
    """
    使用 Audio Tokenizer Decoder 将音频 token 序列解码为波形

    audio_codes: List of frames, each frame is 16 codebook values
    返回: stereo waveform numpy array [samples, 2], 48kHz, float32
    """
    model = TTSModel

    if not audio_codes:
        return np.zeros((1, 2), dtype=np.float32)

    codes_array = np.array(audio_codes, dtype=np.int32)  # [num_frames, 16]
    codes_array = codes_array.reshape(1, codes_array.shape[0], 16)  # [1, num_frames, 16]
    code_lengths = np.array([codes_array.shape[1]], dtype=np.int32)

    ort_inputs = {
        'audio_codes': codes_array,
        'audio_code_lengths': code_lengths,
    }

    outputs = model.codec_decode_session.run(None, ort_inputs)

    audio = outputs[0]   # [1, 2, audio_samples] — stereo
    audio = audio[0]     # [2, audio_samples]
    audio = audio.T      # [audio_samples, 2]

    return audio


def _wav_bytes_to_hex(audio: np.ndarray, sample_rate: int = 48000) -> str:
    """将 numpy 波形转为 WAV 字节，再 hex 编码"""
    # audio: [samples, channels], float32 in [-1, 1]
    audio_int16 = np.clip(audio * 32767, -32768, 32767).astype(np.int16)

    buf = io.BytesIO()
    n_channels = audio_int16.shape[1]
    n_samples = audio_int16.shape[0]
    byte_rate = sample_rate * n_channels * 2
    block_align = n_channels * 2
    data_size = n_samples * n_channels * 2

    # WAV header
    buf.write(b'RIFF')
    buf.write(struct.pack('<I', 36 + data_size))
    buf.write(b'WAVE')
    buf.write(b'fmt ')
    buf.write(struct.pack('<I', 16))        # fmt chunk size
    buf.write(struct.pack('<H', 1))          # PCM
    buf.write(struct.pack('<H', n_channels))
    buf.write(struct.pack('<I', sample_rate))
    buf.write(struct.pack('<I', byte_rate))
    buf.write(struct.pack('<H', block_align))
    buf.write(struct.pack('<H', 16))         # bits per sample
    buf.write(b'data')
    buf.write(struct.pack('<I', data_size))
    buf.write(audio_int16.tobytes())

    return buf.getvalue().hex()


def synthesize(text: str, voice: str = 'Junhao', speed: float = 1.0) -> str:
    """
    语音合成主流程

    返回: hex 编码的 WAV 音频数据
    """
    model = TTSModel
    model.ensure_loaded()

    config = model.model_config
    gen_defaults = model.gen_defaults
    voice_info = model.get_voice(voice)
    prompt_audio_codes = voice_info['prompt_audio_codes']

    # --- Step 1: 构建文本 prompt ---
    # 参考音频文字 — 用内置音色的 display_name 作为 reference text
    reference_text = voice_info.get('display_name', '')

    # 用户输入文本
    user_text = text.strip()
    if not user_text:
        raise ValueError('合成文本不能为空')

    # Tokenize
    prefix_ids = model.prompt_templates.get('user_prompt_prefix_token_ids', [])
    after_ref_ids = model.prompt_templates.get('user_prompt_after_reference_token_ids', [])
    assistant_prefix_ids = model.prompt_templates.get('assistant_prompt_prefix_token_ids', [])

    ref_token_ids = model.sp.encode(reference_text, out_type=int)
    user_token_ids = model.sp.encode(user_text, out_type=int)

    # 构建完整 token 序列（仅文本部分）
    text_token_ids = (
        prefix_ids +
        ref_token_ids +
        after_ref_ids +
        user_token_ids +
        assistant_prefix_ids
    )

    # --- Step 2: 构建 input_ids 并运行 prefill ---
    # audio_start_token_id (6) 已经在 assistant_prefix 中了
    # 但 prompt 格式还需要在 assistant 响应中插入 <|audio_start|> 和音频 codes
    # 将 reference audio codes 放在文本序列之后
    input_ids = _build_input_ids(text_token_ids, prompt_audio_codes, config)

    seq_len = input_ids.shape[1]
    attention_mask = np.ones((1, seq_len), dtype=np.int32)

    global_hidden, kv_cache = _run_prefill(input_ids, attention_mask)

    # --- Step 3: 自回归生成 ---
    max_new_frames = min(
        gen_defaults.get('max_new_frames', 375),
        int(375 * speed)  # speed 影响最大帧数
    )

    audio_pad = config['audio_pad_token_id']
    audio_assistant_slot = config.get('audio_assistant_slot_token_id', 9)
    n_vq = config['n_vq']
    pad_token_id = config['pad_token_id']

    generated_codes: List[List[int]] = []
    # repetition_seen_mask: [1, 16, 1024], 初始全 0
    repetition_seen_mask = np.zeros((1, n_vq, config['audio_codebook_sizes'][0]),
                                     dtype=np.int32)
    past_valid_lengths = np.array([seq_len], dtype=np.int32)

    # 生成循环
    for step in range(max_new_frames):
        # 构建 decode step 的 input_ids — 单步只需要 1 个位置
        step_input = np.full((1, 1, n_vq + 1), audio_pad, dtype=np.int32)
        step_input[0, 0, 0] = audio_assistant_slot

        global_hidden_step, kv_cache = _run_decode_step(
            step_input, past_valid_lengths, kv_cache
        )

        # 更新 past_valid_lengths
        past_valid_lengths = np.array([past_valid_lengths[0] + 1], dtype=np.int32)

        # 使用 local_fixed_sampled_frame 采样
        assistant_random_u = float(np.random.random())
        audio_random_u = np.random.random((1, n_vq)).astype(np.float32)

        should_continue, frame_tokens = _run_local_fixed_sampled_frame(
            global_hidden_step,
            repetition_seen_mask,
            assistant_random_u,
            audio_random_u
        )

        if not should_continue and len(generated_codes) > 0:
            break

        generated_codes.append(frame_tokens)

        # 更新 repetition mask: 对每个 VQ 层的每个 token，seen=1
        for vq_idx in range(n_vq):
            token_val = frame_tokens[vq_idx]
            if 0 <= token_val < repetition_seen_mask.shape[2]:
                repetition_seen_mask[0, vq_idx, token_val] = 1

    # --- Step 4: 合并 prompt audio codes + generated codes 并解码 ---
    all_audio_codes = prompt_audio_codes + generated_codes

    if not all_audio_codes:
        raise RuntimeError('未生成任何音频帧')

    audio_waveform = _decode_audio(all_audio_codes)

    # --- Step 5: 转换为 WAV hex ---
    return _wav_bytes_to_hex(audio_waveform)


# ============================================================
# API 端点
# ============================================================

@app.get('/health')
async def health_check():
    """健康检查端点"""
    return {'status': 'ok', 'port': port}


@app.get('/health/ready')
async def ready_check():
    """就绪检查（模型已加载）"""
    try:
        TTSModel.ensure_loaded()
        return {'status': 'ok', 'ready': True, 'voices': list(TTSModel.voices.keys())}
    except Exception as e:
        return {'status': 'error', 'ready': False, 'message': str(e)}


@app.post('/tts', response_model=TTSResponse)
async def tts_synthesize(req: TTSRequest):
    """
    语音合成端点

    请求: {"text": "你好世界", "voice": "Junhao", "speed": 1.0}
    响应: {"code": 0, "audio": "<hex-wav>"}
    """
    try:
        hex_audio = synthesize(
            text=req.text,
            voice=req.voice,
            speed=req.speed
        )
        return TTSResponse(code=0, audio=hex_audio)
    except ValueError as e:
        return TTSResponse(code=1, message=str(e))
    except Exception as e:
        print(f'[TTS Worker] ❌ 合成失败: {e}', file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return TTSResponse(code=1, message=str(e))


@app.post('/release_models')
async def release_models():
    """释放模型内存"""
    try:
        TTSModel.release()
        return {'status': 'ok', 'message': '所有模型已释放'}
    except Exception as e:
        return {'status': 'error', 'message': str(e)}


@app.get('/voices')
async def list_voices():
    """列出可用音色"""
    TTSModel.ensure_loaded()
    result = {}
    for name, info in TTSModel.voices.items():
        result[name] = {
            'display_name': info.get('display_name', ''),
            'group': info.get('group', ''),
        }
    return {'voices': result}


# ============================================================
# 入口
# ============================================================

if __name__ == '__main__':
    print(f'[TTS Worker] 模型目录: {MODEL_DIR}', file=sys.stderr)
    print(f'[TTS Worker] 启动端口: {port}', file=sys.stderr)
    uvicorn.run(app, host='127.0.0.1', port=port, log_level='warning')
