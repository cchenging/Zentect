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
        'tokenizers': 'Tokenizers',  # 🔧 V6 补全：CLIP 依赖 tokenizers（transformers 子依赖，可能未装）
        'fastapi': 'FastAPI',
        'uvicorn': 'Uvicorn',
        'cv2': 'OpenCV',
        'librosa': 'Librosa',
        'soundfile': 'SoundFile',
        'scipy': 'SciPy',
    }
    deps = {}
    for mod_name, display_name in targets.items():
        # 🔧 修复 importlib.import_module 缓存 ImportError bug：
        #   旧版用 import_module，进程启动时若某包未装，ImportError 会被缓存到 sys.modules，
        #   后续即使 pip install 了，仍然抛 ImportError，导致 check_deps 永远显示未装。
        #   改用 find_spec 仅做磁盘查找，不触发 import，无缓存副作用。
        try:
            spec = importlib.util.find_spec(mod_name)
            if spec is not None:
                # 找到 spec 后再 import 拿版本号（import 成功不会缓存失败）
                mod = importlib.import_module(mod_name)
                version = getattr(mod, '__version__', None) or 'unknown'
                deps[mod_name] = {'installed': True, 'version': version, 'display_name': display_name}
            else:
                deps[mod_name] = {'installed': False, 'version': None, 'display_name': display_name}
        except (ImportError, ModuleNotFoundError):
            deps[mod_name] = {'installed': False, 'version': None, 'display_name': display_name}

    # 🔧 V7 模块化分组：每个功能模块 = 一组依赖包，所有依赖都 installed 时 ready=true
    #   修复 P0-3：demucs/sensevoice/clip 等模块的 ready 判断必须包含 needs 中声明的共用引擎
    #   旧版 bug：demucs 仅检查 ['demucs'] 包，导致 demucs 装了但 torch 没装时仍显示 ready=true
    #   修复后：demucs ready = demucs + torch + torchaudio 全部已安装
    def _module_ready(pkg_list):
        """检查一组包是否全部已安装"""
        missing = [p for p in pkg_list if not deps.get(p, {}).get('installed', False)]
        return {'ready': len(missing) == 0, 'missing': missing}

    modules = {
        # 共用基础引擎（PyTorch 推理底座，被 demucs/sensevoice/clip 共用）
        'torch': {**_module_ready(['torch', 'torchaudio']),
                  'display_name': 'PyTorch 推理引擎', 'size': '~2.1 GB',
                  'shared_by': ['demucs', 'sensevoice', 'clip']},
        # 音频分离引擎
        # 🔧 修复 P0-3：demucs ready 包含 torch + torchaudio，与 needs 字段一致
        'demucs': {**_module_ready(['demucs', 'torch', 'torchaudio']),
                   'display_name': 'Demucs 音频分离引擎', 'size': '~2.2 GB (含 torch)',
                   'needs': ['torch', 'torchaudio']},
        'mdx_net': {**_module_ready(['audio_separator']),
                    'display_name': 'MDX-Net 音频分离引擎', 'size': '~60 MB',
                    'needs': []},
        # ASR 引擎
        'whisper': {**_module_ready([]),  # Whisper.cpp 是 C++ 可执行文件，无 Python 依赖
                    'display_name': 'Whisper.cpp ASR 引擎', 'size': '0 (已内置)',
                    'needs': []},
        # 🔧 修复 P0-3：sensevoice ready 包含 funasr + torch
        'sensevoice': {**_module_ready(['funasr', 'torch']),
                       'display_name': 'SenseVoice ASR 引擎', 'size': '~600 MB (含 torch)',
                       'needs': ['torch']},
        # 视觉引擎
        'insightface': {**_module_ready(['insightface']),
                        'display_name': 'InsightFace 人脸识别引擎', 'size': '~200 MB',
                        'needs': []},
        # 🔧 修复 P0-3：clip ready 包含 transformers + torch
        'clip': {**_module_ready(['transformers', 'torch']),
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
# 🚀 GPU 加速管理（阶段 3 新增）
# ============================================================
# 端点：
#   GET  /api/gpu/status      — 查询 GPU/CUDA 状态（显卡型号、CUDA 可用性、torch 版本）
#   POST /api/gpu/install_cuda — 触发 CUDA 版 torch 安装（卸载 CPU 版 → 装 cu121 版）
#   GET  /api/gpu/install_stream/{task_id} — SSE 推送安装进度
#
# 设计要点：
#   1. 状态查询无副作用（不触发 torch 重载）
#   2. CUDA 安装走后台线程，SSE 推进度，失败自动回滚 CPU 版
#   3. 安装完成后需重启 AI Daemon（由前端触发 settings.set + AiRuntimeManager.restart）

_gpu_install_progress: dict = {}  # CUDA 安装任务进度缓存（key=task_id）


def _detect_gpu_info() -> dict:
    """检测 GPU 硬件与 CUDA 状态（不抛异常，失败返回 unknown）

    返回结构：
      {
        cuda_available: bool,           # torch.cuda.is_available() 结果
        device_count: int,              # 可见 GPU 数量
        devices: [{name, vram_mb}],     # GPU 设备列表（含名称与显存）
        torch_version: str,             # torch 版本号（区分 +cpu / +cu121）
        is_cuda_torch: bool,            # 当前 torch 是否为 CUDA 版（基于版本字符串判断）
        cuda_version: str | None,       # CUDA 运行时版本（torch.version.cuda）
        needs_cuda_install: bool        # 是否需要安装 CUDA 版（有 GPU 且当前为 CPU 版）
      }
    """
    info = {
        'cuda_available': False,
        'device_count': 0,
        'devices': [],
        'torch_version': 'unknown',
        'is_cuda_torch': False,
        'cuda_version': None,
        'needs_cuda_install': False,
    }

    try:
        import torch
        info['torch_version'] = torch.__version__  # 如 "2.7.0+cpu" 或 "2.7.0+cu121"
        info['is_cuda_torch'] = '+cu' in torch.__version__ and '+cpu' not in torch.__version__
        info['cuda_version'] = torch.version.cuda  # CUDA 版本字符串或 None
        info['cuda_available'] = torch.cuda.is_available()
        if info['cuda_available']:
            info['device_count'] = torch.cuda.device_count()
            for i in range(info['device_count']):
                try:
                    props = torch.cuda.get_device_properties(i)
                    # 显存以 MB 为单位（保留整数）
                    vram_mb = int(props.total_memory / (1024 * 1024))
                    info['devices'].append({
                        'name': props.name,
                        'vram_mb': vram_mb,
                    })
                except Exception:
                    info['devices'].append({'name': f'GPU {i}', 'vram_mb': 0})
    except ImportError:
        # torch 未安装，保持 unknown 默认值
        pass
    except Exception:
        # 任何异常都视为不可用，避免健康检查崩溃
        pass

    # 需要安装 CUDA 版的条件：有 GPU 硬件 + 当前 torch 为 CPU 版
    info['needs_cuda_install'] = info['cuda_available'] is False and info['device_count'] > 0 \
        or (not info['is_cuda_torch'] and info['device_count'] > 0)
    # 修正：torch.cuda.is_available() 在 CPU 版 torch 下永远 False，需用 nvidia-smi 探测硬件
    # 但若 torch 已是 CUDA 版且 is_available=True，则无需安装
    if info['is_cuda_torch'] and info['cuda_available']:
        info['needs_cuda_install'] = False
    else:
        # 用 nvidia-smi 兜底探测 GPU 硬件存在性（不依赖 torch CUDA 支持）
        info['needs_cuda_install'] = _has_nvidia_gpu() and not info['is_cuda_torch']

    return info


def _has_nvidia_gpu() -> bool:
    """通过 nvidia-smi 探测是否存在 NVIDIA GPU（不依赖 torch CUDA 支持）

    用途：当 torch 为 CPU 版时，torch.cuda.is_available() 永远返回 False，
          无法判断用户机器是否有 NVIDIA 显卡。此函数用系统命令兜底探测。
    """
    import subprocess
    try:
        result = subprocess.run(
            ['nvidia-smi', '--query-gpu=name', '--format=csv,noheader'],
            capture_output=True, text=True, timeout=5
        )
        # 退出码 0 且有输出 = 有 NVIDIA GPU
        return result.returncode == 0 and bool(result.stdout.strip())
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return False


@app.get('/api/gpu/status')
async def gpu_status():
    """查询 GPU 与 CUDA 状态（无副作用，可在健康检查页轮询）

    前端用途：
      - HealthPage GPU 卡片显示显卡型号、CUDA 可用性
      - 决定是否显示"安装 CUDA 版 torch"按钮
      - 显示当前 torch 版本（+cpu / +cu121）
    """
    return _detect_gpu_info()


@app.post('/api/gpu/install_cuda')
async def install_cuda_torch():
    """触发 CUDA 版 torch 安装（cu121）

    流程：
      1. 卸载当前 CPU 版 torch / torchaudio
      2. 安装 cu121 版 torch==2.7.0 / torchaudio==2.7.0
      3. 失败则回滚：重装 CPU 版 torch / torchaudio

    返回 {task_id}，前端用 task_id 订阅 SSE 进度
    """
    import asyncio
    import uuid

    task_id = f'cuda_install_{uuid.uuid4().hex[:8]}'
    _gpu_install_progress[task_id] = {
        'status': 'pending',      # pending | uninstalling | installing | done | error | rollback
        'percent': 0,
        'message': '准备安装 CUDA 版 torch...',
        'current_step': None,     # uninstall_cpu | install_cuda | verify | rollback
        'error': None,
    }

    loop = asyncio.get_running_loop()
    # 后台线程执行安装，不阻塞 HTTP 响应
    loop.run_in_executor(None, _install_cuda_torch_sync, task_id)

    return {'task_id': task_id, 'status': 'started'}


@app.get('/api/gpu/install_stream/{task_id}')
async def gpu_install_stream(task_id: str):
    """SSE 推流：CUDA 版 torch 安装进度

    前端用 EventSource 订阅，收到 status=done/error 后关闭连接并刷新状态
    """
    import asyncio
    from fastapi.responses import StreamingResponse

    async def event_generator():
        while True:
            progress = _gpu_install_progress.get(task_id, {
                'status': 'error', 'message': '任务不存在', 'error': 'invalid task_id'
            })
            yield f"data: {json.dumps(progress, ensure_ascii=False)}\n\n"
            if progress.get('status') in ('done', 'error'):
                # 任务完成后清理缓存（延迟 60 秒，避免前端读取失败）
                break
            await asyncio.sleep(0.5)  # 500ms 推送间隔
    return StreamingResponse(event_generator(), media_type="text/event-stream")


def _set_gpu_progress(task_id: str, **kwargs) -> None:
    """更新 CUDA 安装任务进度（内部工具函数）"""
    if task_id not in _gpu_install_progress:
        _gpu_install_progress[task_id] = {'status': 'pending', 'percent': 0, 'message': ''}
    _gpu_install_progress[task_id].update(kwargs)


def _install_cuda_torch_sync(task_id: str) -> None:
    """同步执行 CUDA 版 torch 安装（在线程池中跑）

    步骤：
      1. 卸载 CPU 版 torch / torchaudio
      2. 安装 cu121 版 torch==2.7.0 / torchaudio==2.7.0
      3. 验证 import + torch.cuda.is_available()
      4. 任何步骤失败 → 回滚重装 CPU 版

    注意：此函数在子线程中执行，不能直接操作 FastAPI 全局状态
    """
    import subprocess

    # CUDA 版 torch 安装索引（PyTorch 官方 cu121）
    CUDA_INDEX_URL = 'https://download.pytorch.org/whl/cu121'
    CPU_INDEX_URL = 'https://download.pytorch.org/whl/cpu'
    TORCH_VERSION = '2.7.0'

    try:
        # ---------- 步骤 1: 卸载 CPU 版 ----------
        _set_gpu_progress(task_id, status='uninstalling', percent=10,
                          current_step='uninstall_cpu',
                          message='正在卸载 CPU 版 torch / torchaudio...')

        # 卸载 torch 与 torchaudio（--yes 跳过确认）
        result = subprocess.run(
            [sys.executable, '-m', 'pip', 'uninstall', '-y', 'torch', 'torchaudio'],
            capture_output=True, text=True, timeout=120
        )
        if result.returncode != 0:
            # 卸载失败但非致命（可能本就是 CUDA 版或未安装）
            print(f'[GPU Install] 卸载 torch 警告: {result.stderr[-200:]}', file=sys.stderr)

        # ---------- 步骤 2: 安装 CUDA 版 ----------
        _set_gpu_progress(task_id, status='installing', percent=30,
                          current_step='install_cuda',
                          message=f'正在下载安装 CUDA 版 torch=={TORCH_VERSION}+cu121（约 2.5GB，请耐心等待）...')

        result = subprocess.run(
            [sys.executable, '-m', 'pip', 'install',
             f'torch=={TORCH_VERSION}', f'torchaudio=={TORCH_VERSION}',
             '--index-url', CUDA_INDEX_URL,
             '--progress-bar', 'off', '--no-input'],
            capture_output=True, text=True, timeout=1800  # 30 分钟超时（2.5GB 下载）
        )

        if result.returncode != 0:
            err_msg = result.stderr[-500:] if result.stderr else '未知错误'
            _set_gpu_progress(task_id, status='rollback', percent=50,
                              current_step='rollback',
                              message=f'CUDA 版安装失败，正在回滚到 CPU 版...错误: {err_msg[:100]}')
            # 回滚到 CPU 版
            _rollback_to_cpu_torch(task_id, CPU_INDEX_URL, TORCH_VERSION)
            return

        # ---------- 步骤 3: 验证安装 ----------
        _set_gpu_progress(task_id, status='installing', percent=90,
                          current_step='verify',
                          message='正在验证 CUDA 安装...')

        # 重新检测 GPU 状态（验证 torch.cuda.is_available()）
        gpu_info = _detect_gpu_info()
        if not gpu_info['is_cuda_torch']:
            _set_gpu_progress(task_id, status='rollback', percent=95,
                              current_step='rollback',
                              message='CUDA 版 torch 安装后仍检测为 CPU 版，回滚中...')
            _rollback_to_cpu_torch(task_id, CPU_INDEX_URL, TORCH_VERSION)
            return

        # ---------- 步骤 4: 完成 ----------
        _set_gpu_progress(task_id, status='done', percent=100,
                          current_step=None,
                          message=f'CUDA 版 torch 安装完成！torch={gpu_info["torch_version"]}，'
                                  f'CUDA={gpu_info["cuda_version"]}，'
                                  f'GPU 数量={gpu_info["device_count"]}。'
                                  f'请重启 AI 运行时以启用 GPU 加速。')

    except subprocess.TimeoutExpired:
        _set_gpu_progress(task_id, status='rollback', percent=50,
                          current_step='rollback',
                          message='CUDA 版安装超时（>30分钟），正在回滚到 CPU 版...')
        _rollback_to_cpu_torch(task_id, CPU_INDEX_URL, TORCH_VERSION)
    except Exception as e:
        _set_gpu_progress(task_id, status='error', percent=0,
                          current_step=None,
                          error=f'安装异常: {str(e)}',
                          message=f'安装异常: {str(e)}')


def _rollback_to_cpu_torch(task_id: str, cpu_index_url: str, torch_version: str) -> None:
    """回滚到 CPU 版 torch（CUDA 安装失败时调用）"""
    import subprocess
    try:
        _set_gpu_progress(task_id, status='rollback', percent=70,
                          current_step='rollback',
                          message='正在卸载失败的 CUDA 版 torch...')
        subprocess.run(
            [sys.executable, '-m', 'pip', 'uninstall', '-y', 'torch', 'torchaudio'],
            capture_output=True, text=True, timeout=120
        )

        _set_gpu_progress(task_id, status='rollback', percent=85,
                          current_step='rollback',
                          message='正在重装 CPU 版 torch...')
        result = subprocess.run(
            [sys.executable, '-m', 'pip', 'install',
             f'torch=={torch_version}', f'torchaudio=={torch_version}',
             '--index-url', cpu_index_url,
             '--progress-bar', 'off', '--no-input'],
            capture_output=True, text=True, timeout=600  # CPU 版约 200MB，10 分钟超时
        )

        if result.returncode != 0:
            err_msg = result.stderr[-300:] if result.stderr else '未知错误'
            _set_gpu_progress(task_id, status='error', percent=0,
                              current_step=None,
                              error=f'CPU 版回滚失败: {err_msg}',
                              message=f'CPU 版回滚失败，请手动重装 torch: {err_msg[:100]}')
            return

        _set_gpu_progress(task_id, status='error', percent=0,
                          current_step=None,
                          error='CUDA 版安装失败，已回滚到 CPU 版',
                          message='CUDA 版安装失败，已自动回滚到 CPU 版 torch。'
                                  '请检查网络或显卡驱动后重试。')
    except Exception as e:
        _set_gpu_progress(task_id, status='error', percent=0,
                          current_step=None,
                          error=f'回滚异常: {str(e)}',
                          message=f'回滚异常: {str(e)}。请手动执行: '
                                  f'pip install torch=={torch_version} --index-url {cpu_index_url}')


# ============================================================
# 🔧 V8 运行时依赖安装（pip install + SSE 进度推送）
# ============================================================
# 用户在 HealthPage 点"一键安装缺失依赖"时调用
# 流程：POST /api/install_dep 触发后台 pip install → GET /api/install_dep/stream/{task_id} 订阅进度

_install_progress: dict = {}  # task_id → 进度字典（与 audio_pipeline 的 _task_progress 同模式）


def _get_install_progress(task_id: str) -> dict:
    """获取安装任务进度，不存在则初始化"""
    if task_id not in _install_progress:
        _install_progress[task_id] = {
            'status': 'pending',     # pending | downloading | installing | done | error
            'total': 0,              # 待装包总数
            'installed': [],         # 已装包名列表
            'current': None,         # 当前正在装的包名
            'percent': 0,            # 总进度百分比 0-100
            'message': '',           # 人类可读消息
            'error': None,           # 错误信息（status=error 时）
        }
    return _install_progress[task_id]


def _set_install_progress(task_id: str, **kwargs) -> None:
    """增量更新安装任务进度字段"""
    p = _get_install_progress(task_id)
    p.update(kwargs)


@app.post('/api/install_dep')
async def install_dep(payload: dict):
    """触发 pip install 安装缺失依赖（fire-and-forget，立即返回 task_id）

    请求体：
        { "packages": ["demucs", "transformers", "insightface"] }

    返回：
        { "task_id": "xxx", "status": "started" }
    进度通过 GET /api/install_dep/stream/{task_id} 订阅
    """
    import asyncio
    import uuid

    packages = payload.get('packages', [])
    if not packages:
        return {'success': False, 'message': 'packages 不能为空'}

    task_id = str(uuid.uuid4())[:8]
    _set_install_progress(task_id, total=len(packages), status='downloading',
                         message=f'准备安装 {len(packages)} 个包: {", ".join(packages)}')

    loop = asyncio.get_running_loop()
    # fire-and-forget：后台线程池执行 pip install，不阻塞 HTTP 响应
    loop.run_in_executor(None, _pip_install_sync, task_id, packages)

    return {'task_id': task_id, 'status': 'started'}


@app.get('/api/install_dep/stream/{task_id}')
async def install_dep_stream(task_id: str):
    """SSE 推流接口：pip install 进度变化时主动 push"""
    import asyncio
    from fastapi.responses import StreamingResponse

    async def event_generator():
        while True:
            progress = _get_install_progress(task_id)
            yield f"data: {json.dumps(progress, ensure_ascii=False)}\n\n"
            if progress.get('status') in ('done', 'error'):
                break
            await asyncio.sleep(0.3)  # 300ms 推送间隔
    return StreamingResponse(event_generator(), media_type="text/event-stream")


def _pip_install_sync(task_id: str, packages: list) -> None:
    """同步执行 pip install（在线程池中跑），更新 _install_progress

    🔧 关键：用 sys.executable -m pip 调用，确保装到 ai_daemon 当前 Python 环境
       （ai-env 便携环境 或 系统 Python，取决于 AiRuntimeManager.resolvePythonPath）
    """
    import subprocess

    total = len(packages)
    for idx, pkg in enumerate(packages):
        _set_install_progress(task_id, current=pkg, status='downloading',
                             percent=int(idx / total * 100),
                             message=f'[{idx + 1}/{total}] 正在下载安装 {pkg}...')
        try:
            # 用当前 Python 解释器调 pip，确保装对地方
            # - --progress-bar off：禁用进度条（输出到 stderr 会污染日志）
            # - --no-input：禁止交互式提示
            result = subprocess.run(
                [sys.executable, '-m', 'pip', 'install', pkg,
                 '--progress-bar', 'off', '--no-input'],
                capture_output=True, text=True, timeout=600  # 单包 10 分钟超时
            )
            if result.returncode != 0:
                err_msg = result.stderr[-500:] if result.stderr else '未知错误'
                _set_install_progress(task_id, status='error', error=f'{pkg} 安装失败: {err_msg}',
                                     message=f'安装 {pkg} 失败')
                return

            # 标记当前包完成
            installed_list = _get_install_progress(task_id)['installed']
            installed_list.append(pkg)
            _set_install_progress(task_id, installed=installed_list,
                                 percent=int((idx + 1) / total * 100),
                                 message=f'[{idx + 1}/{total}] {pkg} 安装完成')
        except subprocess.TimeoutExpired:
            _set_install_progress(task_id, status='error', error=f'{pkg} 安装超时（>10分钟）',
                                 message=f'安装 {pkg} 超时')
            return
        except Exception as e:
            _set_install_progress(task_id, status='error', error=f'{pkg} 安装异常: {str(e)}',
                                 message=f'安装 {pkg} 异常')
            return

    _set_install_progress(task_id, status='done', percent=100, current=None,
                         message=f'全部 {total} 个包安装完成')


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
