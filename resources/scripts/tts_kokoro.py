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
"""
import os
import sys
import torch

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ai_config import MODELS_DIR, INFERENCE_LOCK

router = APIRouter()

# ============================================================
# 内置中文音色表（Kokoro v1.0-zh，12 个音色）
# id 与 HuggingFace voices/*.pt 文件名一致，可手动放置到 resources/models/kokoro/voices/
# ============================================================
KOKORO_VOICES = [
    {'id': 'zf_xiaobei', 'name': '小北', 'lang': '中文·女'},
    {'id': 'zf_xiaoni', 'name': '小妮', 'lang': '中文·女'},
    {'id': 'zf_xiaoxiao', 'name': '小小', 'lang': '中文·女'},
    {'id': 'zf_xiaoyi', 'name': '小一', 'lang': '中文·女'},
    {'id': 'zf_xiaomo', 'name': '小莫', 'lang': '中文·女'},
    {'id': 'zf_xiaoyou', 'name': '小悠', 'lang': '中文·女'},
    {'id': 'zm_yunjian', 'name': '云健', 'lang': '中文·男'},
    {'id': 'zm_yunxi', 'name': '云希', 'lang': '中文·男'},
    {'id': 'zm_yunyang', 'name': '云扬', 'lang': '中文·男'},
    {'id': 'zm_yunye', 'name': '云野', 'lang': '中文·男'},
    {'id': 'zm_yunhao', 'name': '云皓', 'lang': '中文·男'},
    {'id': 'zm_yunze', 'name': '云泽', 'lang': '中文·男'},
]

# 本地音色文件目录（ModelTab 模型管理：一键下载或手动放置）
KOKORO_VOICES_DIR = os.path.join(MODELS_DIR, 'kokoro', 'voices')


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
        """合成文本为 24kHz WAV 写入 out_path；任一步骤失败都抛错，不做静默降级"""
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
            sf.write(out_path, full_audio.numpy(), 24000)
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
