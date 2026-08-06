"""
ai_daemon.py — AI 运行时守护进程（干净主入口）

设计原则：
  1. 入口文件不做任何模型定义（AIModels / MODELS_DIR 等全部下沉到 ai_config.py）
  2. 子模块只依赖 ai_config.py，永不反向依赖 ai_daemon.py → 循环导入为 0
  3. 所有业务路由在模块加载时通过静态 import 100% 注册，无 try/except 吞异常
"""

import sys
import os
import io
import argparse
import warnings

# 🔧 修复 P0：embeddable Python（ai-env）的 ._pth 文件会完全覆盖默认 sys.path，
#   导致 sys.path 不含脚本所在目录 → 子模块全部 ModuleNotFoundError。
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

warnings.filterwarnings('ignore', category=DeprecationWarning)
warnings.filterwarnings('ignore', message='.*pkg_resources.*')
warnings.filterwarnings('ignore', category=UserWarning, module='requests')

import traceback
import json

from fastapi import FastAPI
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

# ============================================================
# 导入 ai_config，初始化全局配置
# ============================================================
from ai_config import MODELS_DIR, FFMPEG_PATH, PROJECT_MATERIAL_POOL, INFERENCE_LOCK, AIModels

if args.models_dir:
    os.environ['MAGIC_MODELS_DIR'] = args.models_dir
if args.ffmpeg_path:
    os.environ['FFMPEG_PATH'] = args.ffmpeg_path

# 告诉 AIModels CLI 指定的设备（在 _ensure_device 中用于 CUDA 检测）
AIModels.set_cli_device(device)

# ============================================================
# FastAPI 应用
# ============================================================
app = FastAPI()

# ============================================================
# ⚡ 静态导入所有子模块（告别循环导入，告别 404）
# ============================================================
import audio_pipeline
import face_analysis
import semantic_engine
import timeline_solver
import video_analyzer
import jianying_export
import tts_kokoro

app.include_router(audio_pipeline.router)
app.include_router(face_analysis.router)
app.include_router(semantic_engine.router)
app.include_router(timeline_solver.router)
app.include_router(video_analyzer.router)
app.include_router(jianying_export.router)
app.include_router(tts_kokoro.router)

print(f"[AI Daemon] ✅ 所有业务路由注册成功！共 {len(app.routes)} 条路由", file=sys.stderr)


# ============================================================
# API 端点
# ============================================================

@app.get('/health')
async def health_check():
    """健康检查端点：供 AiRuntimeManager 轮询确认服务就绪"""
    return {'status': 'ok', 'port': port}


@app.get('/api/check_deps')
async def check_deps():
    """检查 Python 依赖安装状态：供前端健康检查 + 模型管理页展示"""
    import importlib
    targets = {
        'demucs': 'Demucs (音频分离)',
        'audio_separator': 'MDX-Net (音频分离)',
        'funasr': 'SenseVoice (ASR)',
        'insightface': 'InsightFace (人脸识别)',
        'hdbscan': 'HDBSCAN (人脸聚类)',
        'torch': 'PyTorch',
        'torchaudio': 'Torchaudio',
        'transformers': 'Transformers',
        'tokenizers': 'Tokenizers',
        'fastapi': 'FastAPI',
        'uvicorn': 'Uvicorn',
        'cv2': 'OpenCV',
        'librosa': 'Librosa',
        'soundfile': 'SoundFile',
        'scipy': 'SciPy',
        'kokoro': 'Kokoro-82M (本地 TTS)',
        'misaki': 'Misaki (Kokoro G2P)',
        # misaki[zh] 的传递依赖（缺任一个 KPipeline 加载即崩溃，必须纳入检查）
        'ordered_set': 'OrderedSet (misaki 依赖)',
        'pypinyin': 'Pypinyin (misaki 中文注音)',
        'cn2an': 'Cn2An (misaki 中文数字转换)',
    }
    deps = {}
    for mod_name, display_name in targets.items():
        try:
            spec = importlib.util.find_spec(mod_name)
            if spec is not None:
                mod = importlib.import_module(mod_name)
                version = getattr(mod, '__version__', None) or 'unknown'
                deps[mod_name] = {'installed': True, 'version': version, 'display_name': display_name}
            else:
                deps[mod_name] = {'installed': False, 'version': None, 'display_name': display_name}
        except (ImportError, ModuleNotFoundError):
            deps[mod_name] = {'installed': False, 'version': None, 'display_name': display_name}

    def _module_ready(pkg_list):
        missing = [p for p in pkg_list if not deps.get(p, {}).get('installed', False)]
        return {'ready': len(missing) == 0, 'missing': missing}

    modules = {
        'torch': {**_module_ready(['torch', 'torchaudio']),
                  'display_name': 'PyTorch 推理引擎', 'size': '~2.1 GB',
                  'shared_by': ['demucs', 'sensevoice', 'clip']},
        'demucs': {**_module_ready(['demucs', 'torch', 'torchaudio']),
                   'display_name': 'Demucs 音频分离引擎', 'size': '~2.2 GB (含 torch)',
                   'needs': ['torch', 'torchaudio']},
        'mdx_net': {**_module_ready(['audio_separator']),
                    'display_name': 'MDX-Net 音频分离引擎', 'size': '~60 MB',
                    'needs': []},
        'whisper': {**_module_ready([]),
                    'display_name': 'Whisper.cpp ASR 引擎', 'size': '0 (已内置)',
                    'needs': []},
        'sensevoice': {**_module_ready(['funasr', 'torch']),
                       'display_name': 'SenseVoice ASR 引擎', 'size': '~600 MB (含 torch)',
                       'needs': ['torch']},
        'insightface': {**_module_ready(['insightface']),
                        'display_name': 'InsightFace 人脸识别引擎', 'size': '~200 MB',
                        'needs': []},
        'clip': {**_module_ready(['transformers', 'torch']),
                 'display_name': 'Transformers (CLIP 引擎)', 'size': '~100 MB (含 torch)',
                 'needs': ['torch']},
        'kokoro': {**_module_ready(['kokoro', 'misaki', 'soundfile', 'ordered_set', 'pypinyin', 'cn2an']),
                   'display_name': 'Kokoro-82M TTS 引擎', 'size': '~360 MB (模型)',
                   'needs': ['misaki[zh]']},
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
# GPU 加速管理
# ============================================================

_gpu_install_progress: dict = {}


def _detect_gpu_info() -> dict:
    """检测 GPU 硬件与 CUDA 状态（不抛异常，失败返回 unknown）"""
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
        info['torch_version'] = torch.__version__
        info['is_cuda_torch'] = '+cu' in torch.__version__ and '+cpu' not in torch.__version__
        info['cuda_version'] = torch.version.cuda
        info['cuda_available'] = torch.cuda.is_available()
        if info['cuda_available']:
            info['device_count'] = torch.cuda.device_count()
            for i in range(info['device_count']):
                try:
                    props = torch.cuda.get_device_properties(i)
                    vram_mb = int(props.total_memory / (1024 * 1024))
                    info['devices'].append({'name': props.name, 'vram_mb': vram_mb})
                except Exception:
                    info['devices'].append({'name': f'GPU {i}', 'vram_mb': 0})
    except ImportError:
        pass
    except Exception:
        pass

    info['needs_cuda_install'] = info['cuda_available'] is False and info['device_count'] > 0 \
        or (not info['is_cuda_torch'] and info['device_count'] > 0)
    if info['is_cuda_torch'] and info['cuda_available']:
        info['needs_cuda_install'] = False
    else:
        info['needs_cuda_install'] = _has_nvidia_gpu() and not info['is_cuda_torch']
    return info


def _has_nvidia_gpu() -> bool:
    """通过 nvidia-smi 探测是否存在 NVIDIA GPU"""
    import subprocess
    try:
        result = subprocess.run(
            ['nvidia-smi', '--query-gpu=name', '--format=csv,noheader'],
            capture_output=True, text=True, timeout=5
        )
        return result.returncode == 0 and bool(result.stdout.strip())
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return False


@app.get('/api/gpu/status')
async def gpu_status():
    """查询 GPU 与 CUDA 状态"""
    return _detect_gpu_info()


@app.post('/api/gpu/install_cuda')
async def install_cuda_torch():
    """触发 CUDA 版 torch 安装（cu121）"""
    import asyncio
    import uuid
    task_id = f'cuda_install_{uuid.uuid4().hex[:8]}'
    _gpu_install_progress[task_id] = {
        'status': 'pending', 'percent': 0,
        'message': '准备安装 CUDA 版 torch...',
        'current_step': None, 'error': None,
    }
    loop = asyncio.get_running_loop()
    loop.run_in_executor(None, _install_cuda_torch_sync, task_id)
    return {'task_id': task_id, 'status': 'started'}


@app.get('/api/gpu/install_stream/{task_id}')
async def gpu_install_stream(task_id: str):
    """SSE 推流：CUDA 版 torch 安装进度"""
    import asyncio
    from fastapi.responses import StreamingResponse

    async def event_generator():
        while True:
            progress = _gpu_install_progress.get(task_id, {
                'status': 'error', 'message': '任务不存在', 'error': 'invalid task_id'
            })
            yield f"data: {json.dumps(progress, ensure_ascii=False)}\n\n"
            if progress.get('status') in ('done', 'error'):
                break
            await asyncio.sleep(0.5)
    return StreamingResponse(event_generator(), media_type="text/event-stream")


def _set_gpu_progress(task_id: str, **kwargs) -> None:
    """更新 CUDA 安装任务进度"""
    if task_id not in _gpu_install_progress:
        _gpu_install_progress[task_id] = {'status': 'pending', 'percent': 0, 'message': ''}
    _gpu_install_progress[task_id].update(kwargs)


def _install_cuda_torch_sync(task_id: str) -> None:
    """同步执行 CUDA 版 torch 安装（在线程池中跑）"""
    import subprocess
    CUDA_INDEX_URL = 'https://download.pytorch.org/whl/cu121'
    CPU_INDEX_URL = 'https://download.pytorch.org/whl/cpu'
    TORCH_VERSION = '2.7.0'
    try:
        _set_gpu_progress(task_id, status='uninstalling', percent=10,
                          current_step='uninstall_cpu',
                          message='正在卸载 CPU 版 torch / torchaudio...')
        subprocess.run(
            [sys.executable, '-m', 'pip', 'uninstall', '-y', 'torch', 'torchaudio'],
            capture_output=True, text=True, timeout=120
        )

        _set_gpu_progress(task_id, status='installing', percent=30,
                          current_step='install_cuda',
                          message=f'正在下载安装 CUDA 版 torch=={TORCH_VERSION}+cu121（约 2.5GB，请耐心等待）...')
        result = subprocess.run(
            [sys.executable, '-m', 'pip', 'install',
             f'torch=={TORCH_VERSION}', f'torchaudio=={TORCH_VERSION}',
             '--index-url', CUDA_INDEX_URL,
             '--progress-bar', 'off', '--no-input'],
            capture_output=True, text=True, timeout=1800
        )

        if result.returncode != 0:
            err_msg = result.stderr[-500:] if result.stderr else '未知错误'
            _set_gpu_progress(task_id, status='rollback', percent=50,
                              current_step='rollback',
                              message=f'CUDA 版安装失败，正在回滚到 CPU 版...错误: {err_msg[:100]}')
            _rollback_to_cpu_torch(task_id, CPU_INDEX_URL, TORCH_VERSION)
            return

        _set_gpu_progress(task_id, status='installing', percent=90,
                          current_step='verify', message='正在验证 CUDA 安装...')
        gpu_info = _detect_gpu_info()
        if not gpu_info['is_cuda_torch']:
            _set_gpu_progress(task_id, status='rollback', percent=95,
                              current_step='rollback',
                              message='CUDA 版 torch 安装后仍检测为 CPU 版，回滚中...')
            _rollback_to_cpu_torch(task_id, CPU_INDEX_URL, TORCH_VERSION)
            return

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
            capture_output=True, text=True, timeout=600
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
                          message='CUDA 版安装失败，已自动回滚到 CPU 版 torch。请检查网络或显卡驱动后重试。')
    except Exception as e:
        _set_gpu_progress(task_id, status='error', percent=0,
                          current_step=None,
                          error=f'回滚异常: {str(e)}',
                          message=f'回滚异常: {str(e)}。请手动执行: pip install torch=={torch_version} --index-url {cpu_index_url}')


# ============================================================
# 运行时依赖安装（pip install + SSE 进度推送）
# ============================================================

_install_progress: dict = {}


def _get_install_progress(task_id: str) -> dict:
    """获取安装任务进度，不存在则初始化"""
    if task_id not in _install_progress:
        _install_progress[task_id] = {
            'status': 'pending', 'total': 0, 'installed': [],
            'current': None, 'percent': 0, 'message': '', 'error': None,
        }
    return _install_progress[task_id]


def _set_install_progress(task_id: str, **kwargs) -> None:
    """增量更新安装任务进度字段"""
    p = _get_install_progress(task_id)
    p.update(kwargs)


@app.post('/api/install_dep')
async def install_dep(payload: dict):
    """触发 pip install 安装缺失依赖"""
    import asyncio
    import uuid
    packages = payload.get('packages', [])
    if not packages:
        return {'success': False, 'message': 'packages 不能为空'}
    task_id = str(uuid.uuid4())[:8]
    _set_install_progress(task_id, total=len(packages), status='downloading',
                         message=f'准备安装 {len(packages)} 个包: {", ".join(packages)}')
    loop = asyncio.get_running_loop()
    loop.run_in_executor(None, _pip_install_sync, task_id, packages)
    return {'task_id': task_id, 'status': 'started'}


@app.get('/api/install_dep/stream/{task_id}')
async def install_dep_stream(task_id: str):
    """SSE 推流：pip install 进度"""
    import asyncio
    from fastapi.responses import StreamingResponse

    async def event_generator():
        while True:
            progress = _get_install_progress(task_id)
            yield f"data: {json.dumps(progress, ensure_ascii=False)}\n\n"
            if progress.get('status') in ('done', 'error'):
                break
            await asyncio.sleep(0.3)
    return StreamingResponse(event_generator(), media_type="text/event-stream")


def _pip_install_sync(task_id: str, packages: list) -> None:
    """同步执行 pip install（在线程池中跑），安装期间每秒推送当前包进度，避免 UI 长时间无更新"""
    import subprocess
    import threading
    import time
    total = len(packages)
    for idx, pkg in enumerate(packages):
        _set_install_progress(task_id, current=pkg, status='downloading',
                             percent=int(idx / total * 100),
                             message=f'[{idx + 1}/{total}] 正在下载安装 {pkg}...')
        try:
            proc = subprocess.Popen(
                [sys.executable, '-m', 'pip', 'install', pkg,
                 '--progress-bar', 'off', '--no-input'],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, encoding='utf-8', errors='replace'
            )
            # 后台线程持续读取 stdout，防止管道缓冲被填满导致 pip 阻塞
            out_lines: list = []
            reader = threading.Thread(
                target=lambda: out_lines.extend(proc.stdout or []),
                daemon=True
            )
            reader.start()
            # 安装期间每秒推送一次进度（心跳），超时 10 分钟自动终止
            elapsed = 0
            timeout_sec = 600
            while proc.poll() is None:
                time.sleep(1)
                elapsed += 1
                if elapsed >= timeout_sec:
                    proc.kill()
                    proc.wait()
                    _set_install_progress(task_id, status='error',
                                          error=f'{pkg} 安装超时（>10分钟）',
                                          message=f'安装 {pkg} 超时')
                    return
                _set_install_progress(task_id, current=pkg, status='downloading',
                                      percent=int(idx / total * 100),
                                      message=f'[{idx + 1}/{total}] 正在下载安装 {pkg}（已用时 {elapsed} 秒）...')
            reader.join()
            if proc.returncode != 0:
                err_msg = ''.join(out_lines)[-500:] or '未知错误'
                _set_install_progress(task_id, status='error', error=f'{pkg} 安装失败: {err_msg}',
                                     message=f'安装 {pkg} 失败')
                return
            installed_list = _get_install_progress(task_id)['installed']
            installed_list.append(pkg)
            _set_install_progress(task_id, installed=installed_list,
                                 percent=int((idx + 1) / total * 100),
                                 message=f'[{idx + 1}/{total}] {pkg} 安装完成')
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
