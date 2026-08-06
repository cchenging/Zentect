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

# 清理 modelscope 下载中断残留的 .lock 和临时文件，防止下次加载时触发异常下载
import glob as _glob
for _lock_file in _glob.glob(os.path.join(MODELS_DIR, '**', '.lock'), recursive=True):
    try:
        os.remove(_lock_file)
        print(f'[AI Config] 清理残留锁文件: {_lock_file}', file=sys.stderr)
    except OSError:
        pass
for _tmp_dir in _glob.glob(os.path.join(MODELS_DIR, '**', '._____temp'), recursive=True):
    try:
        import shutil as _shutil
        _shutil.rmtree(_tmp_dir, ignore_errors=True)
        print(f'[AI Config] 清理残留临时目录: {_tmp_dir}', file=sys.stderr)
    except OSError:
        pass


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
                    # 💥 修复：det_size 从 (640, 640) 提升到 (1280, 1280)
                    # 旧版 640 对远景小脸/侧脸漏检严重，导致视频中远景人物完全识别不到
                    # 1280 显著提升小脸检测能力（耗时约4倍，但人脸识别子步骤不频繁，可接受）
                    cls.face_app.prepare(ctx_id=0, det_size=(1280, 1280))
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
    def get_chinese_clip(cls):
        """获取中文 CLIP 模型和处理器（OFA Chinese-CLIP，中文文案直编无需翻译，带锁保护）。
        失败时返回 (None, None)，调用方回退英文 CLIP + LLM 翻译链路。"""
        if cls.chinese_clip_model is None:
            with INFERENCE_LOCK:
                if cls.chinese_clip_model is None:
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
        if cls.chinese_clip_model is False:
            return (None, None)
        return (cls.chinese_clip_model, cls.chinese_clip_processor)

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
                        trust_remote_code=True,  # SenseVoice 有自定义 model.py，必须信任远程代码
                        hub='ms',  # 明确指定 ModelScope hub，避免自动探测触发联网
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
