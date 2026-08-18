"""
ai_config.py — 全局配置与 AI 模型单例共享模块
解耦 ai_daemon.py 与各个 APIRouter 模块的循环引用
"""
import os
import sys
import threading


def _init_paths():
    """初始化路径配置（在模块首次导入时执行）"""
    global BASE_DIR, MODELS_DIR, FFMPEG_PATH, PROJECT_MATERIAL_POOL
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    MODELS_DIR = os.path.abspath(os.environ.get('MAGIC_MODELS_DIR', os.path.join(BASE_DIR, '..', 'models')))
    FFMPEG_PATH = os.environ.get('FFMPEG_PATH', 'ffmpeg')
    PROJECT_MATERIAL_POOL = {}


_init_paths()


os.environ['TORCH_HOME'] = os.path.join(MODELS_DIR, 'demucs')
os.environ['HF_HOME'] = os.path.join(MODELS_DIR, 'huggingface')
os.environ['XDG_CACHE_HOME'] = os.path.join(MODELS_DIR, '.cache')
os.environ['INSIGHTFACE_HOME'] = os.path.join(MODELS_DIR, 'insightface')
# 禁用 modelscope 联网下载，防止 .lock 残留文件触发下载导致进程崩溃
os.environ['MODELSCOPE_CACHE'] = os.path.join(MODELS_DIR, 'modelscope_cache')
os.environ['MODELSCOPE_DOWNLOAD_PARALLELS'] = '0'

# 清理 modelscope 下载中断残留的 .lock 文件和目录、临时文件，防止下次加载时触发异常下载
import glob as _glob
import shutil as _shutil
for _lock_path in _glob.glob(os.path.join(MODELS_DIR, '**', '.lock'), recursive=True):
    try:
        if os.path.isdir(_lock_path):
            _shutil.rmtree(_lock_path, ignore_errors=True)
            print(f'[AI Config] 清理残留锁目录: {_lock_path}', file=sys.stderr)
        else:
            os.remove(_lock_path)
            print(f'[AI Config] 清理残留锁文件: {_lock_path}', file=sys.stderr)
    except OSError:
        pass
for _tmp_dir in _glob.glob(os.path.join(MODELS_DIR, '**', '._____temp'), recursive=True):
    try:
        _shutil.rmtree(_tmp_dir, ignore_errors=True)
        print(f'[AI Config] 清理残留临时目录: {_tmp_dir}', file=sys.stderr)
    except OSError:
        pass


INFERENCE_LOCK = threading.RLock()

# ============================================================
# 💓 模型加载状态指示器（供健康检查端点读取）
#   键：current = 当前正在加载的模型名（clip/chinese_clip/face/funasr/faster_whisper/null）
#       start_at = 加载开始的 unix 时间戳（秒，float）
#   使用 dict 可变引用 + threading.Lock 保护写操作，
#   跨线程可见，读取端不加锁避免与加载路径抢锁导致 /health 再次被饿死
# ============================================================
_MODEL_LOADING_STATE: dict = {"current": None, "start_at": None}
_MODEL_LOADING_STATE_LOCK = threading.Lock()


def get_model_loading_state() -> dict:
    """函数级中文注释：返回 AIModels 当前加载状态快照（深拷贝简单值，避免跨线程引用竞态）。
    供 ai_daemon.py /health 端点读取，读取端始终 O(1) 不持锁不阻塞。"""
    snap = _MODEL_LOADING_STATE
    return {"current": snap.get("current"), "start_at": snap.get("start_at")}


def _mark_loading_start(model_name: str) -> None:
    """函数级中文注释：进入懒加载前写入「正加载」标记。使用独立小锁（1μs量级）不占用 INFERENCE_LOCK。"""
    with _MODEL_LOADING_STATE_LOCK:
        _MODEL_LOADING_STATE["current"] = model_name
        _MODEL_LOADING_STATE["start_at"] = _time_monotonic_sec()


def _mark_loading_done() -> None:
    """函数级中文注释：懒加载完成（成功/失败）后清空「正加载」标记。与 start 配对，必须在 finally 中调用。"""
    with _MODEL_LOADING_STATE_LOCK:
        _MODEL_LOADING_STATE["current"] = None
        _MODEL_LOADING_STATE["start_at"] = None


def _time_monotonic_sec() -> float:
    """函数级中文注释：单调时钟秒（不受系统时间回拨影响），用于估算加载耗时。"""
    import time as _time
    return _time.monotonic()


class AIModels:
    """全局 AI 模型管理器（类级别单例）

    所有模型加载和推理操作必须获取 INFERENCE_LOCK，
    确保同一时间只有一个原生推理任务运行，防止并发崩溃。
    """

    device = 'cpu'
    MODELS_DIR = MODELS_DIR
    _cli_device = 'cpu'

    face_app = None
    clip_model = None
    clip_processor = None
    chinese_clip_model = None
    chinese_clip_processor = None
    _funasr_model = None
    _faster_whisper_model = None

    @classmethod
    def set_cli_device(cls, device_str: str):
        """设置命令行指定的设备（由 ai_daemon.py 在解析参数后调用）"""
        cls._cli_device = device_str or 'cpu'

    @classmethod
    def _ensure_device(cls):
        """延迟检测 CUDA 可用性，避免启动时加载 torch"""
        if cls.device == 'cpu':
            try:
                import torch
                cls.device = cls._cli_device if torch.cuda.is_available() else 'cpu'
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
    def release_chinese_clip(cls):
        """释放中文 CLIP 模型内存"""
        if cls.chinese_clip_model is not None and cls.chinese_clip_model is not False:
            import torch
            del cls.chinese_clip_model
            del cls.chinese_clip_processor
            cls.chinese_clip_model = None
            cls.chinese_clip_processor = None
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            cls._gc_collect()

    @classmethod
    def release_funasr_sensevoice(cls):
        """释放 FunASR SenseVoice + VAD 模型内存"""
        if cls._funasr_model is not None:
            del cls._funasr_model
            cls._funasr_model = None
            cls._gc_collect()

    @classmethod
    def release_faster_whisper(cls):
        """释放 faster-whisper 模型内存"""
        if cls._faster_whisper_model is not None:
            del cls._faster_whisper_model
            cls._faster_whisper_model = None
            cls._gc_collect()

    @classmethod
    def release_all_models(cls):
        """释放所有已加载模型，回收内存"""
        cls.release_face_app()
        cls.release_clip()
        cls.release_chinese_clip()
        cls.release_funasr_sensevoice()
        cls.release_faster_whisper()
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
        """函数级中文注释：获取 InsightFace 人脸检测模型（懒加载），仅在模型还未加载时加 INFERENCE_LOCK。
        进入真正加载分支前设置 loading 状态标记，供健康检查端点识别（不算做 daemon 死亡）。
        成功/失败/异常都会在 finally 中清除标记，避免卡死"正在加载"状态。"""
        if cls.face_app is None:
            with INFERENCE_LOCK:
                if cls.face_app is None:
                    _mark_loading_start("face")
                    try:
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
                        # 💥 修复：det_size 从 (640, 640) 提升到 (1280, 1280)
                        # 旧版 640 对远景小脸/侧脸漏检严重，导致视频中远景人物完全识别不到
                        # 1280 显著提升小脸检测能力（耗时约4倍，但人脸识别子步骤不频繁，可接受）
                        cls.face_app.prepare(ctx_id=0, det_size=(1280, 1280))
                    finally:
                        _mark_loading_done()
        return cls.face_app

    @classmethod
    def get_clip(cls):
        """函数级中文注释：获取英文 CLIP 模型和处理器（懒加载，带锁保护）。
        仅在模型未加载（即真正走 from_pretrained 初始化）分支写 loading 状态，让健康检查能区分"真死"vs"正加载"。
        失败时 cls.clip_model = False 标记不可用，返回 (None, None) 供调用方降级为直方图匹配。"""
        if cls.clip_model is None:
            with INFERENCE_LOCK:
                if cls.clip_model is None:
                    _mark_loading_start("clip")
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
                    finally:
                        _mark_loading_done()
        if cls.clip_model is False:
            return (None, None)
        return (cls.clip_model, cls.clip_processor)

    @classmethod
    def get_chinese_clip(cls):
        """函数级中文注释：获取中文 CLIP（OFA Chinese-CLIP）模型与处理器（懒加载，带锁保护）。
        在真正走模型初始化的分支设置 loading 状态，让 Node 健康检查不把 26 秒的权重加载判定成 daemon 崩溃。
        目录不存在/加载失败均标记 False 并返回 (None, None)，调用方自动回退英文 CLIP + 翻译链路。"""
        if cls.chinese_clip_model is None:
            with INFERENCE_LOCK:
                if cls.chinese_clip_model is None:
                    _mark_loading_start("chinese_clip")
                    try:
                        zh_dir = os.path.join(MODELS_DIR, 'chinese-clip')
                        # 目录不存在直接标记不可用，避免 from_pretrained 打印误导性 Repo id 报错
                        if not os.path.isdir(zh_dir) or not os.path.exists(os.path.join(zh_dir, 'config.json')):
                            print('[AI Daemon] ⚠️ Chinese-CLIP 模型目录不存在，回退英文 CLIP 翻译匹配', file=sys.stderr)
                            cls.chinese_clip_model = False
                            cls.chinese_clip_processor = False
                        else:
                            try:
                                import torch
                                from transformers import ChineseCLIPModel, ChineseCLIPProcessor
                                print('[AI Daemon] 🧠 首次按需加载: Chinese-CLIP 中文多模态匹配雷达...',
                                      file=sys.stderr)
                                cls.chinese_clip_model = ChineseCLIPModel.from_pretrained(
                                    zh_dir, local_files_only=True
                                ).to(cls._ensure_device())
                                cls.chinese_clip_processor = ChineseCLIPProcessor.from_pretrained(
                                    zh_dir, local_files_only=True
                                )
                            except Exception as e:
                                print(f'[AI Daemon] ⚠️ Chinese-CLIP 加载失败，将回退英文 CLIP 翻译匹配: {e}',
                                      file=sys.stderr)
                                cls.chinese_clip_model = False
                                cls.chinese_clip_processor = False
                    finally:
                        _mark_loading_done()
        if cls.chinese_clip_model is False:
            return (None, None)
        return (cls.chinese_clip_model, cls.chinese_clip_processor)

    @classmethod
    def get_funasr_sensevoice(cls):
        """函数级中文注释：获取 funasr AutoModel（SenseVoiceSmall + fsmn-vad），懒加载+带锁保护。
        首次加载（200MB 权重+反序列化）需要几秒，设置 loading 状态让健康检查不误判重启。
        失败不做显式降级（缺依赖直接抛错在上层 ASR 入口处理）。"""
        if cls._funasr_model is None:
            with INFERENCE_LOCK:
                if cls._funasr_model is None:
                    _mark_loading_start("funasr")
                    try:
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
                            vad_model=vad_dir,
                            vad_kwargs={'max_single_segment_time': 30000},
                            device=cls._ensure_device(),
                            disable_update=True,
                            trust_remote_code=True,  # SenseVoice 有自定义 model.py，必须信任远程代码
                            hub='ms',  # 明确指定 ModelScope hub，避免自动探测触发联网
                        )
                    finally:
                        _mark_loading_done()
        return cls._funasr_model

    @classmethod
    def get_faster_whisper(cls, model_size='large-v3'):
        """函数级中文注释：获取 faster-whisper 模型（懒加载，英文/欧洲语言 ASR），带锁保护。
        首次加载（CTranslate2 模型实例化）耗时较长，设置 loading 状态让健康检查不误杀。
        优先使用 resources/models/faster_whisper/{size}/model.bin 本地目录，缺省自动 HF 下载。"""
        if cls._faster_whisper_model is None:
            with INFERENCE_LOCK:
                if cls._faster_whisper_model is None:
                    _mark_loading_start("faster_whisper")
                    try:
                        from faster_whisper import WhisperModel
                        device = cls._ensure_device()
                        compute_type = 'float16' if device == 'cuda' else 'int8'
                        print(f'[AI Daemon] 🧠 Faster-Whisper 启动… (model={model_size}, device={device}, compute_type={compute_type})',
                              file=sys.stderr)

                        local_model_dir = os.path.join(MODELS_DIR, 'faster_whisper', model_size)
                        if os.path.isdir(local_model_dir) and os.path.exists(os.path.join(local_model_dir, 'model.bin')):
                            model_path = local_model_dir
                            print(f'[AI Daemon]    使用本地模型: {model_path}', file=sys.stderr)
                        else:
                            model_path = model_size
                            print(f'[AI Daemon]    从 HuggingFace 自动下载: {model_size}', file=sys.stderr)

                        # 💥 CPU 满核线程：faster-whisper(CTranslate2) 有独立的 cpu_threads 参数，
                        #   不显式传入时 CTranslate2 只按自身默认初始化线程池，可能用不满全部物理核。
                        #   这里显式锁定为物理核数量，最大化 CPU 推理吞吐（int8 + 满核）。
                        #   仅在 device='cpu' 时生效；cuda 设备忽略该参数（传给 GPU 也无副作用，但为清晰起见仅在 CPU 时传）。
                        _cpu_threads = os.cpu_count() or 4
                        whisper_kwargs = dict(
                            device=device,
                            compute_type=compute_type,
                        )
                        if device == 'cpu':
                            whisper_kwargs['cpu_threads'] = _cpu_threads
                        cls._faster_whisper_model = WhisperModel(
                            model_path,
                            **whisper_kwargs,
                        )
                    finally:
                        _mark_loading_done()
        return cls._faster_whisper_model

    @staticmethod
    def get_batches(items, batch_size):
        """💥 批处理生成器：将大数据集切分为小批次，保护内存并提升 GPU 利用率

        :param items: 待处理的项目列表
        :param batch_size: 每个批次的大小
        :yield: 分批次的子列表
        """
        for i in range(0, len(items), batch_size):
            yield items[i:i + batch_size]
