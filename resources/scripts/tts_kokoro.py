"""
tts_kokoro.py — Kokoro-82M 本地 TTS 合成端点模块

  POST /api/tts/kokoro/synthesize — 文本 → 24kHz WAV 语音合成
  GET  /api/tts/kokoro/voices     — 内置中文音色表

设计要点：
  1. KPipeline 懒加载单例：首次合成时创建（CPU 推理），模型从 HF 缓存加载
     （HF_HOME 已由 ai_config.py 指向 resources/models/huggingface）
  2. 音色文件本地优先：resources/models/kokoro/voices/*.pt 存在则直接加载本地文件，
     否则回退 HF 下载（kokoro 支持 voice 传 .pt 路径或音色名）
  3. 所有推理在 INFERENCE_LOCK 内串行执行，避免与 ASR/音频分离并发崩溃
  4. 依赖：pip install kokoro misaki[zh] soundfile（健康检查页可一键安装）
  5. 合成后走 FFmpeg loudnorm 二阶归一化（EBU R128：I=-16 LUFS, TP=-1.5 dB, LRA=11）
     — 替代之前的 torch.tanh 手搓版（手搓版在峰值 < 0.5 时会反向压缩 5~6 dB，
       导致实测 RMS 只有 -27 dBFS）。loudnorm 是广播级标准实现，结果稳健。
"""
import os
import sys
import tempfile
import subprocess
import shutil
import torch

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ai_config import MODELS_DIR, INFERENCE_LOCK, FFMPEG_PATH

router = APIRouter()

# ============================================================
# 内置中文音色表（Kokoro v1.0-zh，官方仅 8 个音色，与 HF voices/*.pt 一一对应）
# 注意：勿添加不存在的音色 id（如 zf_xiaomo/zm_yunye），HF 无此文件会导致合成 404 失败
# id 与 HuggingFace voices/*.pt 文件名一致，可手动放置到 resources/models/kokoro/voices/
# ============================================================
KOKORO_VOICES = [
    {'id': 'zf_xiaobei', 'name': '小北', 'lang': '中文·女'},
    {'id': 'zf_xiaoni', 'name': '小妮', 'lang': '中文·女'},
    {'id': 'zf_xiaoxiao', 'name': '小小', 'lang': '中文·女'},
    {'id': 'zf_xiaoyi', 'name': '小一', 'lang': '中文·女'},
    {'id': 'zm_yunjian', 'name': '云健', 'lang': '中文·男'},
    {'id': 'zm_yunxi', 'name': '云希', 'lang': '中文·男'},
    {'id': 'zm_yunxia', 'name': '云霞', 'lang': '中文·男'},
    {'id': 'zm_yunyang', 'name': '云扬', 'lang': '中文·男'},
]

# 本地音色文件目录（ModelTab 模型管理：一键下载或手动放置）
KOKORO_VOICES_DIR = os.path.join(MODELS_DIR, 'kokoro', 'voices')

# loudnorm 目标参数（EBU R128 语音流媒体规格）
# I: 集成响度 LUFS，TP: 真实峰值 dB，LRA: 响度范围
LOUDNORM_TARGET = {'I': -16.0, 'TP': -1.5, 'LRA': 11.0}


def _resolve_ffmpeg() -> str:
    """解析 FFmpeg 可执行路径，不存在则直接抛错（fail-fast，不降级）。

    优先级：ai_config 注入的 FFMPEG_PATH > PATH 中的 ffmpeg；无法调用时明确提示
    健康检查中安装 FFmpeg。
    """
    ffmpeg = FFMPEG_PATH
    if ffmpeg and ffmpeg != 'ffmpeg':
        if not os.path.isfile(ffmpeg):
            raise RuntimeError(f'FFmpeg 路径无效: {ffmpeg}；请到 设置 → 健康检查 确认 FFmpeg 已安装')
        return ffmpeg
    # PATH 中的 ffmpeg，用 which/shutil 确认
    resolved = shutil.which(ffmpeg or 'ffmpeg')
    if not resolved:
        raise RuntimeError('找不到 FFmpeg 可执行文件；请到 设置 → 健康检查 确认 FFmpeg 已安装')
    return resolved


def _ffmpeg_loudnorm_two_pass(src_path: str, dst_path: str) -> None:
    """对 src_path 执行 loudnorm 二阶归一化，输出到 dst_path。

    一阶：用 print_format=json 跑 dry_run，获取目标 measured_* 参数；
    二阶：把一阶的测量值回写到 filter 中获得线性归一化结果，不引入额外失真。
    任一阶失败都抛 RuntimeError（含 stderr 摘要），由上层返回 500。
    """
    ffmpeg = _resolve_ffmpeg()
    i_val, tp_val, lra_val = LOUDNORM_TARGET['I'], LOUDNORM_TARGET['TP'], LOUDNORM_TARGET['LRA']

    # ---------- 一阶：测量 ----------
    measure_cmd = [
        ffmpeg, '-hide_banner', '-nostats', '-i', src_path,
        '-af', (
            f'loudnorm=I={i_val}:TP={tp_val}:LRA={lra_val}:'
            'print_format=json'
        ),
        '-f', 'null', '-',
    ]
    try:
        proc = subprocess.run(measure_cmd, capture_output=True, text=True, check=False)
    except FileNotFoundError as e:
        raise RuntimeError(f'FFmpeg 执行失败: {e}') from e
    if proc.returncode != 0:
        tail = (proc.stderr or '').strip().splitlines()[-8:]
        raise RuntimeError(f'loudnorm 测量失败: {" | ".join(tail) or proc.returncode}')

    # 从 stderr 里抠 JSON 段（loudnorm 把 JSON 打到 stderr）
    measured = _extract_loudnorm_json(proc.stderr)
    if any(k not in measured for k in ('input_i', 'input_tp', 'input_lra', 'input_thresh')):
        raise RuntimeError(f'loudnorm 测量结果缺失关键字段: {measured}')

    # ---------- 二阶：线性归一化 ----------
    linear_filter = (
        f"loudnorm=I={i_val}:TP={tp_val}:LRA={lra_val}:"
        f"measured_I={measured['input_i']}:"
        f"measured_TP={measured['input_tp']}:"
        f"measured_LRA={measured['input_lra']}:"
        f"measured_thresh={measured['input_thresh']}:"
        "linear=true:print_format=summary"
    )
    apply_cmd = [
        ffmpeg, '-y', '-hide_banner', '-nostats', '-i', src_path,
        '-af', linear_filter,
        '-ar', '24000', '-sample_fmt', 's16',
        dst_path,
    ]
    proc2 = subprocess.run(apply_cmd, capture_output=True, text=True, check=False)
    if proc2.returncode != 0 or not os.path.isfile(dst_path):
        tail = (proc2.stderr or '').strip().splitlines()[-8:]
        raise RuntimeError(f'loudnorm 归一化失败: {" | ".join(tail) or proc2.returncode}')


def _extract_loudnorm_json(stderr: str) -> dict:
    """从 loudnorm print_format=json 的 stderr 里提取 JSON 字典。

    loudnorm 输出形如：
        [Parsed_loudnorm_0 @ 0x...]
        {
          "input_i" : "-27.13",
          ...
        }
    找最后一对花括号，尽量宽松匹配。
    """
    if not stderr:
        return {}
    # 找最后一个 '{' 和最后一个 '}'
    start = stderr.rfind('{')
    end = stderr.rfind('}')
    if start == -1 or end == -1 or end <= start:
        return {}
    import json
    try:
        raw = json.loads(stderr[start:end + 1])
    except json.JSONDecodeError:
        return {}
    # 把 JSON 中形如 "-27.13" 的字符串数字统一转 float；非数值字符串（如 "linear" / summary 标题）保持原样
    normalized = {}
    for k, v in raw.items():
        if isinstance(v, str):
            try:
                normalized[k] = float(v)
            except ValueError:
                normalized[k] = v
        else:
            normalized[k] = v
    return normalized


class KokoroTTS:
    """Kokoro-82M 合成封装：KPipeline 懒加载单例 + 本地音色优先"""

    _pipeline = None

    @classmethod
    def get_pipeline(cls):
        """懒加载 KPipeline（中文 lang_code='z'，CPU 推理），失败时暴露原始错误"""
        if cls._pipeline is None:
            # 依赖缺失时抛 ImportError，由调用方返回 500 提示安装
            from kokoro import KPipeline
            cls._pipeline = KPipeline(lang_code='z', device='cpu')
        return cls._pipeline

    @classmethod
    def _resolve_voice(cls, voice_id: str) -> str:
        """音色解析：本地 voices/*.pt 存在则返回完整路径（离线优先），否则返回音色名走 HF 下载"""
        local_pt = os.path.join(KOKORO_VOICES_DIR, f'{voice_id}.pt')
        if os.path.exists(local_pt):
            return local_pt
        return voice_id

    @classmethod
    def synthesize(cls, text: str, voice_id: str, speed: float, out_path: str) -> str:
        """合成文本为 24kHz WAV 写入 out_path；任一步骤失败都抛错，不做静默降级

        合成流程：
        1. Kokoro KPipeline 推理（中文，CPU 推理，全局 INFERENCE_LOCK 串行）
        2. soundfile 写临时 WAV
        3. FFmpeg loudnorm 二阶归一化（EBU R128 I=-16 LUFS）
        4. 原子替换到 out_path

        注意：
        - 之前的 torch tanh 归一化（目标 RMS -20 dBFS）在峰值振幅较小时
          会反向压缩 5~6 dB，导致实测 RMS -27 dBFS，已移除。
        - loudnorm 找不到 FFmpeg 会抛 RuntimeError，由 API 层返回 500 提示健康检查安装。
        """
        import soundfile as sf

        with INFERENCE_LOCK:
            pipeline = cls.get_pipeline()
            voice = cls._resolve_voice(voice_id)
            audio_chunks = []
            # split_pattern 按换行分段，逐段合成后拼接，避免超长文本截断
            for _gs, _ps, audio in pipeline(text, voice=voice, speed=speed, split_pattern=r'\n+'):
                if audio is not None:
                    audio_chunks.append(audio)
            if not audio_chunks:
                raise RuntimeError(f'Kokoro 合成结果为空: voice={voice_id}')
            full_audio = torch.cat(audio_chunks)

            os.makedirs(os.path.dirname(out_path) or '.', exist_ok=True)

            # 1) 写临时 RAW WAV（与 out_path 同目录，保证原子替换时 os.replace 同分区）
            suffix = '.kokoro_raw.wav'
            with tempfile.NamedTemporaryFile(
                dir=os.path.dirname(out_path) or '.',
                suffix=suffix,
                delete=False,
            ) as tmp_raw:
                raw_path = tmp_raw.name
            try:
                sf.write(raw_path, full_audio.numpy(), 24000)
                with tempfile.NamedTemporaryFile(
                    dir=os.path.dirname(out_path) or '.',
                    suffix='.loudnorm.wav',
                    delete=False,
                ) as tmp_norm:
                    norm_path = tmp_norm.name
                try:
                    _ffmpeg_loudnorm_two_pass(raw_path, norm_path)
                    # 原子替换：同分区 os.replace 要么成功要么失败，不会出现半写
                    os.replace(norm_path, out_path)
                    norm_path = None
                finally:
                    if norm_path and os.path.exists(norm_path):
                        try:
                            os.remove(norm_path)
                        except OSError:
                            pass
            finally:
                try:
                    os.remove(raw_path)
                except OSError:
                    pass

        return out_path


# ============================================================
# DTOs
# ============================================================
class KokoroSynthesizeReq(BaseModel):
    text: str
    voice: str = 'zf_xiaobei'       # 音色 id（zh 音色表）
    speed: float = 1.0              # 语速倍率（0.5 ~ 2.0）
    out_path: str                   # 输出 WAV 文件绝对路径（由 Node 端指定）


# ============================================================
# API 端点
# ============================================================
@router.post('/api/tts/kokoro/synthesize')
async def kokoro_synthesize(req: KokoroSynthesizeReq):
    """文本转语音：返回生成的 WAV 文件路径"""
    try:
        out = KokoroTTS.synthesize(req.text, req.voice, req.speed, req.out_path)
        return {'success': True, 'audioPath': out, 'sampleRate': 24000}
    except ImportError as e:
        # 依赖未安装 → 明确报错提示安装（错就错，不降级）
        raise HTTPException(status_code=500, detail={
            'success': False,
            'error': 'Kokoro TTS 依赖未安装：请到 设置 → 健康检查 → AI 运行时依赖 安装 kokoro / misaki[zh] / soundfile',
            'errorCode': 'AI_DEP_MISSING',
        })
    except Exception as e:
        raise HTTPException(status_code=500, detail={
            'success': False,
            'error': f'Kokoro 合成失败: {str(e)}',
            'errorCode': 'AI_PROCESS_FAILED',
        })


@router.get('/api/tts/kokoro/voices')
async def kokoro_voices():
    """返回内置中文音色表（前端展示）；本地已放置的音色文件自动并入列表"""
    local_voices = []
    try:
        if os.path.isdir(KOKORO_VOICES_DIR):
            for fname in os.listdir(KOKORO_VOICES_DIR):
                if fname.endswith('.pt'):
                    vid = fname[:-3]
                    if not any(v['id'] == vid for v in KOKORO_VOICES):
                        local_voices.append({'id': vid, 'name': vid, 'lang': '本地音色'})
    except OSError:
        pass
    return {'success': True, 'voices': KOKORO_VOICES + local_voices}
