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


INFERENCE_LOCK = threading.RLock()


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
    sensevoice_model = None
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
        cls.release_sensevoice()
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
        """获取 InsightFace 人脸检测模型（懒加载，带锁保护防止并发加载崩溃）"""
        if cls.face_app is None:
            with INFERENCE_LOCK:
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
        """获取 CLIP 模型和处理器，失败时返回 (None, None) 降级为直方图匹配（带锁保护）"""
        if cls.clip_model is None:
            with INFERENCE_LOCK:
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
        """获取 SenseVoice ONNX 模型（懒加载，带锁保护）"""
        if cls.sensevoice_model is None:
            with INFERENCE_LOCK:
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
        """获取 funasr AutoModel（SenseVoiceSmall + fsmn-vad，本地目录加载，带锁保护）

        参考：https://github.com/FunAudioLLM/SenseVoice
        用法：AutoModel(model=本地目录, trust_remote_code=True,
                       vad_model=fsmn_vad目录)
        注意：不传 remote_code 参数，让 funasr 自动从模型目录发现 model.py，
              传绝对路径会导致 importlib 导入失败（No module named 错误）
        """
        if cls._funasr_model is None:
            with INFERENCE_LOCK:
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
                        vad_model=vad_dir,
                        vad_kwargs={'max_single_segment_time': 30000},
                        device=cls._ensure_device(),
                        disable_update=True,
                    )
        return cls._funasr_model

    @classmethod
    def get_faster_whisper(cls, model_size='large-v3'):
        """获取 faster-whisper 模型（懒加载，英文/欧洲语言 ASR，带锁保护）

        基于 CTranslate2，比 whisper.cpp 快 4-8 倍。
        模型首次使用时自动从 HuggingFace 下载到本地缓存目录。
        如需手动放置，可下载 CTranslate2 格式模型到 resources/models/faster_whisper/large-v3/

        参数：
            model_size: 模型大小，可选 tiny/base/small/medium/large-v3，默认 large-v3
        返回：
            faster_whisper.WhisperModel 实例
        """
        if cls._faster_whisper_model is None:
            with INFERENCE_LOCK:
                if cls._faster_whisper_model is None:
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

                    cls._faster_whisper_model = WhisperModel(
                        model_path,
                        device=device,
                        compute_type=compute_type,
                    )
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
