"""
ai_daemon.py — AI 运行时守护进程
从 resources/scripts/__pycache__/ai_daemon.cpython-310.pyc 完整反编译重建

原始编译时间: 2026-06-25 10:01 (由 Python 3.10 编译)
恢复时间: 2026-06-29
"""

import sys
import os
import io
import argparse
import warnings

warnings.filterwarnings('ignore', category=DeprecationWarning)
warnings.filterwarnings('ignore', message='.*pkg_resources.*')
warnings.filterwarnings('ignore', category=UserWarning, module='requests')

import traceback
import json

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Optional
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
parser.add_argument('--port', type=int, default=None)
parser.add_argument('--device', type=str, default='cpu')
parser.add_argument('--models_dir', type=str, default=None)
parser.add_argument('--ffmpeg_path', type=str, default=None,
                    help='FFmpeg 可执行文件路径（由 Electron 主进程注入）')
args, unknown = parser.parse_known_args()

port = args.port or int(os.environ.get('PORT', 34567))
device = args.device or 'cpu'
models_dir = args.models_dir or os.environ.get('MAGIC_MODELS_DIR',
    os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'models'))

MODELS_DIR = os.path.abspath(models_dir)
FFMPEG_PATH = args.ffmpeg_path or os.environ.get('FFMPEG_PATH', 'ffmpeg')
PROJECT_MATERIAL_POOL = {}

# 🔧 修复 P0：重定向所有 AI 框架的模型缓存到 resources/models/，避免散落到 C 盘
#   旧版 bug：demucs/torch/funasr/transformers 默认下载到 ~/.cache/，用户难管理
#   修复后：所有模型统一落到 resources/models/<子目录>/，与项目预装模型集中管理
#   说明：必须在 import torch/funasr/transformers 之前设置（这些模块在 import 时读取环境变量）
os.environ['TORCH_HOME'] = os.path.join(MODELS_DIR, 'demucs')        # demucs/torch.hub 系
os.environ['HF_HOME'] = os.path.join(MODELS_DIR, 'huggingface')      # funasr/transformers 系
os.environ['XDG_CACHE_HOME'] = os.path.join(MODELS_DIR, '.cache')    # 通用兜底
os.environ['INSIGHTFACE_HOME'] = os.path.join(MODELS_DIR, 'insightface')  # insightface 模型目录

# ============================================================
# FastAPI 应用
# ============================================================
app = FastAPI()

# ============================================================
# 业务路由动态注册
# ============================================================
# (module_name, router_var_name) — 模块内必须暴露 APIRouter() 实例 `router`
# 旧版 bug：列表为空 → 6 个业务模块的 17 条路由全是孤儿，运行时全部 404
_business_routers = [
    ('audio_pipeline', 'router'),     # /api/separate, /api/separate/stream/{task_id}, /api/transcribe, /api/emotion, /api/audio/detect_beats, /api/separate/progress/{task_id}
    ('face_analysis', 'router'),      # /api/vision, /api/cluster_faces, /api/load_clusters
    ('semantic_engine', 'router'),    # /api/match, /api/extract_semantics, /api/search_semantics
    ('timeline_solver', 'router'),    # /api/solver/kuhn_munkres_match
    ('video_analyzer', 'router'),     # /api/video/detect_scene_chunks
    ('jianying_export', 'router'),    # /api/jianying/export
]


def _register_business_routers():
    """动态加载并注册业务子路由"""
    for module_name, _var_name in _business_routers:
        try:
            mod = __import__(module_name, fromlist=['router'])
            app.include_router(mod.router)
            print(f'[AI Daemon] ✅ 已注册路由模块: {module_name}', file=sys.stderr)
        except Exception as e:
            print(f'[AI Daemon] ⚠️ 模块 {module_name} 加载失败: {e}',
                  file=sys.stderr)
            traceback.print_exc(file=sys.stderr)


# ============================================================
# AIModels — AI 模型管理类
# ============================================================
class AIModels:
    """全局 AI 模型管理器（类级别单例）"""

    device = 'cpu'
    MODELS_DIR = MODELS_DIR

    face_app = None
    clip_model = None
    clip_processor = None
    sensevoice_model = None
    _funasr_model = None

    @classmethod
    def _ensure_device(cls):
        """延迟检测 CUDA 可用性，避免启动时加载 torch"""
        if cls.device == 'cpu':
            try:
                import torch
                cls.device = args.device if torch.cuda.is_available() else 'cpu'
            except ImportError:
                cls.device = 'cpu'
        return cls.device

    @classmethod
    def release_face_app(cls):
        """释放 InsightFace 模型内存"""
        if cls.face_app is not None:
            del cls.face_app
            cls.face_app = None
            cls._gc_collect()

    @classmethod
    def release_clip(cls):
        """释放 CLIP 模型内存"""
        if cls.clip_model is not None and cls.clip_model is not False:
            import torch
            del cls.clip_model
            del cls.clip_processor
            cls.clip_model = None
            cls.clip_processor = None
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            cls._gc_collect()

    @classmethod
    def release_sensevoice(cls):
        """释放 SenseVoice ONNX 模型内存"""
        if cls.sensevoice_model is not None:
            del cls.sensevoice_model
            cls.sensevoice_model = None
            cls._gc_collect()

    @classmethod
    def release_funasr_sensevoice(cls):
        """释放 FunASR SenseVoice + VAD 模型内存"""
        if cls._funasr_model is not None:
            del cls._funasr_model
            cls._funasr_model = None
            cls._gc_collect()

    @classmethod
    def release_all_models(cls):
        """释放所有已加载模型，回收内存"""
        cls.release_face_app()
        cls.release_clip()
        cls.release_sensevoice()
        cls.release_funasr_sensevoice()
        print('[AI Daemon] 🧹 所有模型已释放，内存已回收', file=sys.stderr)

    @staticmethod
    def _gc_collect():
        """强制垃圾回收"""
        import gc
        gc.collect()
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except ImportError:
            pass

    @classmethod
    def get_face_app(cls):
        """获取 InsightFace 人脸检测模型（懒加载）"""
        if cls.face_app is None:
            import cv2
            import numpy as np
            from insightface.app import FaceAnalysis
            print('[AI Daemon] 🧠 首次按需加载: InsightFace 视觉雷达...',
                  file=sys.stderr)
            insightface_root = os.path.dirname(MODELS_DIR)
            cls.face_app = FaceAnalysis(
                name='buffalo_l',
                root=insightface_root,
                providers=['CPUExecutionProvider']
            )
            cls.face_app.prepare(ctx_id=0, det_size=(640, 640))
        return cls.face_app

    @classmethod
    def get_clip(cls):
        """获取 CLIP 模型和处理器，失败时返回 (None, None) 降级为直方图匹配"""
        if cls.clip_model is None:
            try:
                import torch
                from transformers import CLIPProcessor, CLIPModel
                print('[AI Daemon] 🧠 首次按需加载: CLIP 多模态匹配雷达...',
                      file=sys.stderr)
                clip_dir = os.path.join(MODELS_DIR, 'clip')
                cls.clip_model = CLIPModel.from_pretrained(
                    clip_dir, local_files_only=True
                ).to(cls._ensure_device())
                cls.clip_processor = CLIPProcessor.from_pretrained(
                    clip_dir, local_files_only=True
                )
            except Exception as e:
                print(f'[AI Daemon] ⚠️ CLIP 加载失败，将降级为直方图匹配: {e}',
                      file=sys.stderr)
                cls.clip_model = False
                cls.clip_processor = False
        if cls.clip_model is False:
            return (None, None)
        return (cls.clip_model, cls.clip_processor)

    @classmethod
    def get_sensevoice(cls):
        """获取 SenseVoice ONNX 模型（懒加载）"""
        if cls.sensevoice_model is None:
            from funasr_onnx import SenseVoiceSmall
            print('[AI Daemon] 🧠 首次按需加载：SenseVoice (ONNX)...',
                  file=sys.stderr)
            model_dir = os.path.join(MODELS_DIR, 'sensevoice_onnx')
            cls.sensevoice_model = SenseVoiceSmall(
                model_dir, batch_size=1, quantize=True
            )
        return cls.sensevoice_model

    @classmethod
    def get_funasr_sensevoice(cls):
        """获取 funasr AutoModel（SenseVoiceSmall + fsmn-vad，本地目录加载）

        参考：https://github.com/FunAudioLLM/SenseVoice
        用法：AutoModel(model=本地目录, trust_remote_code=True,
                       vad_model=fsmn_vad目录)
        注意：不传 remote_code 参数，让 funasr 自动从模型目录发现 model.py，
              传绝对路径会导致 importlib 导入失败（No module named 错误）
        """
        if cls._funasr_model is None:
            from funasr import AutoModel
            sv_dir = os.path.join(MODELS_DIR, 'sensevoice_small')
            vad_dir = os.path.join(MODELS_DIR, 'fsmn_vad')
            print('[AI Daemon] 🧠 SenseVoiceSmall + fsmn-vad 启动…',
                  file=sys.stderr)
            print(f'[AI Daemon]    SenseVoiceSmall: {sv_dir}',
                  file=sys.stderr)
            print(f'[AI Daemon]    FSMN-VAD:       {vad_dir}',
                  file=sys.stderr)

            if sv_dir not in sys.path:
                sys.path.insert(0, sv_dir)

            cls._funasr_model = AutoModel(
                model=sv_dir,
                trust_remote_code=True,
                vad_model=vad_dir,
                vad_kwargs={'max_single_segment_time': 30000},
                device=cls._ensure_device(),
                disable_update=True,
            )
        return cls._funasr_model

    @staticmethod
    def get_batches(items, batch_size):
        """💥 批处理生成器：将大数据集切分为小批次，保护内存并提升 GPU 利用率

        :param items: 待处理的项目列表
        :param batch_size: 每个批次的大小
        :yield: 分批次的子列表
        """
        for i in range(0, len(items), batch_size):
            yield items[i:i + batch_size]


# ============================================================
# Pydantic 请求/响应模型
# ============================================================

class SceneChunkReq(BaseModel):
    """场景切割请求"""
    file_path: str
    output_dir: str
    threshold: float = 0.3
    min_chunk_duration_sec: float = 1.0
    mediaId: str = 'default'


class KMMatchQuery(BaseModel):
    """卡点匹配查询"""
    shotId: str
    text: str
    audioDurationMs: float = 0


class KMMatchReq(BaseModel):
    """卡点匹配请求"""
    queries: List[KMMatchQuery]
    videoChunks: List[dict]
    bgmBeats: List[float] = []
    mediaId: str = 'default'
    translateToEnglish: bool = False
    llmApiKey: str = ''
    llmApiBase: str = ''
    llmApiModel: str = ''
    vlmApiKey: str = ''
    vlmApiBase: str = ''
    vlmApiModel: str = ''


# ============================================================
# FastAPI 生命周期事件
# ============================================================

@app.on_event('startup')
async def on_startup():
    """启动时注册业务路由"""
    _register_business_routers()


# ============================================================
# API 端点
# ============================================================

@app.get('/health')
async def health_check():
    """健康检查端点：供 AiRuntimeManager 轮询确认服务就绪"""
    return {'status': 'ok', 'port': port}


@app.get('/api/check_deps')
async def check_deps():
    """检查 Python 依赖安装状态：供前端健康检查 + 模型管理页展示
    返回结构：
      {
        deps: { demucs: {installed, version, display_name}, ... },  # 扁平依赖状态（兼容旧版）
        modules: {                                                     # 模块化分组（新版）
          torch: { ready, missing, size },
          demucs: { ready, missing, size, deps: [torch, torchaudio] },
          ...
        },
        python_executable
      }
    """
    import importlib
    # 关键依赖清单：key=导入名, value=显示名
    targets = {
        'demucs': 'Demucs (音频分离)',
        'audio_separator': 'MDX-Net (音频分离)',
        'funasr': 'SenseVoice (ASR)',
        'insightface': 'InsightFace (人脸识别)',
        'hdbscan': 'HDBSCAN (人脸聚类)',
        'torch': 'PyTorch',
        'torchaudio': 'Torchaudio',
        'transformers': 'Transformers',
        'fastapi': 'FastAPI',
        'uvicorn': 'Uvicorn',
        'cv2': 'OpenCV',
        'librosa': 'Librosa',
        'soundfile': 'SoundFile',
        'scipy': 'SciPy',
    }
    deps = {}
    for mod_name, display_name in targets.items():
        try:
            mod = importlib.import_module(mod_name)
            version = getattr(mod, '__version__', None) or 'unknown'
            deps[mod_name] = {'installed': True, 'version': version, 'display_name': display_name}
        except ImportError:
            deps[mod_name] = {'installed': False, 'version': None, 'display_name': display_name}

    # 🔧 新增 P0：模块化分组，便于前端模型管理页按功能模块展示运行时状态
    #   每个功能模块 = 一组依赖包，所有依赖都 installed 时 ready=true
    def _module_ready(pkg_list):
        """检查一组包是否全部已安装"""
        missing = [p for p in pkg_list if not deps.get(p, {}).get('installed', False)]
        return {'ready': len(missing) == 0, 'missing': missing}

    modules = {
        # 共用引擎
        'torch': {**_module_ready(['torch', 'torchaudio']),
                  'display_name': 'PyTorch 推理引擎', 'size': '~2.1 GB',
                  'shared_by': ['demucs', 'sensevoice', 'clip']},
        # 音频分离引擎
        'demucs': {**_module_ready(['demucs']),
                   'display_name': 'Demucs 音频分离引擎', 'size': '~2.2 GB (含 torch)',
                   'needs': ['torch', 'torchaudio']},
        'mdx_net': {**_module_ready(['audio_separator']),
                    'display_name': 'MDX-Net 音频分离引擎', 'size': '~60 MB',
                    'needs': []},
        # ASR 引擎
        'whisper': {**_module_ready([]),  # Whisper.cpp 是 C++ 可执行文件，无 Python 依赖
                    'display_name': 'Whisper.cpp ASR 引擎', 'size': '0 (已内置)',
                    'needs': []},
        'sensevoice': {**_module_ready(['funasr']),
                       'display_name': 'SenseVoice ASR 引擎', 'size': '~600 MB (含 torch)',
                       'needs': ['torch']},
        # 视觉引擎
        'insightface': {**_module_ready(['insightface']),
                        'display_name': 'InsightFace 人脸识别引擎', 'size': '~200 MB',
                        'needs': []},
        'clip': {**_module_ready(['transformers']),
                 'display_name': 'Transformers (CLIP 引擎)', 'size': '~100 MB (含 torch)',
                 'needs': ['torch']},
    }

    return {'deps': deps, 'modules': modules, 'python_executable': sys.executable}


@app.post('/release_models')
async def release_models():
    """释放所有已加载模型，回收内存（空闲时调用）"""
    try:
        AIModels.release_all_models()
        return {'status': 'ok', 'message': '所有模型已释放'}
    except Exception as e:
        return {'status': 'error', 'message': str(e)}


# ============================================================
# 工具函数
# ============================================================

def process_llm_json_response(raw_response_content, chinese_script_text):
    """
    处理大模型返回的 JSON 响应，提取五维电影级描述字段
    使用双语解耦拼接公式：EN(shotSize, cameraMovement) + ZH(subjects, lighting, mood)
    """
    try:
        parsed_payload = json.loads(raw_response_content)

        shot_size = parsed_payload.get('shotSize', 'Medium-shot')
        camera_movement = parsed_payload.get('cameraMovement', 'Static')
        subjects = parsed_payload.get('subjectsAndActions', '')
        lighting = parsed_payload.get('lightingAndColor', '')
        mood = parsed_payload.get('environmentMood', '')

        composed_description = (
            f'{shot_size}, {camera_movement}. '
            f'{subjects} {lighting}, {mood}'
        )

        return {
            'success': True,
            'data': {
                'shotSize': shot_size,
                'cameraMovement': camera_movement,
                'description': composed_description,
                'rawFields': parsed_payload,
            }
        }
    except Exception as e:
        fallback_text = chinese_script_text or '电影级场景'
        return {
            'success': True,
            'data': {
                'shotSize': 'Wide-shot',
                'cameraMovement': 'Slow push-in',
                'description': (
                    f'Cinematic movie scene, photorealistic, 8k resolution, '
                    f'related to: {fallback_text}'
                ),
                'rawFields': None,
            }
        }


# ============================================================
# 入口
# ============================================================

if __name__ == '__main__':
    uvicorn.run(app, host='127.0.0.1', port=port, log_level='warning')
