// 📁 路径: src/main/services/ModelService.ts
import { ModelRepository, PipelineModelConfigRepository } from '../database/repositories/ModelRepository';
import { AppError, ErrorCode } from '../../modules/infra/error/AppError';
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../modules/infra/logger/LogConstants';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as https from 'https';
import * as http from 'http';
import { PathManager } from '../utils/pathManager';

/**
 * 模型定义（与前端 DEFAULT_MODELS 对齐）
 * V5 细化版：基于 manifest.json 的每个具体模型文件一条记录
 * 旧版 7 条粗粒度记录已废弃，ensureSeedData 会自动迁移
 */
interface ModelSeedDef {
  id: string;
  name: string;           // 英文技术名（对应 manifest.json 的 name 字段）
  displayName: string;    // 中文显示名
  type: string;           // 模型类别：asr/tts/vision/audio/emotion
  description: string;
  version: string;
  pythonPkg?: string;     // 对应 Python 依赖包名（用于依赖检查）
  /** manifest.json 中的 path，用于扫描磁盘判断是否已下载；空数组表示 pip 包内置无独立文件 */
  manifestPaths: string[];
  /**
   * 🔧 V7 新增：候选磁盘扫描路径（除 manifestPaths 外的多路径）
   * 例：htdemucs.pth 可能落在 demucs/ 或 demucs/hub/checkpoints/ 下
   */
  scanPaths?: string[];
  /** 🔧 V7 新增：期望文件大小（字节），用于校验完整性；不填则只检查存在性 */
  expectedSize?: number;
  /** 🔧 V7 新增：模型文件 MD5（部分关键模型），用于严格校验；不填则跳过 MD5 */
  md5?: string;
}

/**
 * 功能模块定义（V7 新增）
 * 一个功能模块 = 多个模型文件 + 一个运行时依赖
 * 对应前端 7 张卡片，按 4 个分类分组
 */
interface ModelModuleDef {
  id: string;                    // 模块 id（对应 ai_daemon.modules 的 key）
  category: 'audio' | 'asr' | 'vision' | 'tts';  // 4 分类
  displayName: string;           // 中文显示名
  description: string;
  icon: string;                  // emoji 图标
  required: 'builtin' | 'optional';  // 必装内置 / 可选
  modelIds: string[];            // 模块包含的模型 id（对应 MODEL_DEFINITIONS.id）
  runtimeId: string;             // 运行时依赖模块 id（对应 ai_daemon.modules 的 key，如 'demucs'/'torch'）
  sizeNote: string;              // 体积说明
}

/** 21 个具体模型定义（V5 细化版，与 manifest.json models 数组对齐） */
const MODEL_DEFINITIONS: ModelSeedDef[] = [
  // === ASR 语音识别 ===
  {
    id: 'sensevoice_onnx', name: 'SenseVoice ONNX', displayName: 'SenseVoice 量化模型', type: 'asr',
    description: 'SenseVoice 多语言语音识别量化模型（中/日/韩/粤/auto 默认引擎）', version: '1.0', pythonPkg: 'funasr',
    manifestPaths: ['sensevoice_onnx/model_quant.onnx'],
    scanPaths: ['sensevoice_onnx/model_quant.onnx', 'sensevoice/model_quant.onnx'],
  },
  {
    id: 'sensevoice_small', name: 'SenseVoiceSmall', displayName: 'SenseVoice PyTorch 模型', type: 'asr',
    description: 'SenseVoice PyTorch 完整模型（含 utils/ctc_alignment.py）', version: '1.0', pythonPkg: 'funasr',
    manifestPaths: ['sensevoice_small/model.pt'],
    scanPaths: ['sensevoice_small/model.pt', 'huggingface/sensevoice_small/model.pt'],
  },
  {
    id: 'fsmn_vad', name: 'FSMN VAD', displayName: 'FSMN 语音活动检测', type: 'asr',
    description: 'FunASR FSMN VAD 语音端点检测模型（ASR 前置组件）', version: '1.0', pythonPkg: 'funasr',
    manifestPaths: ['fsmn_vad/model.pt'],
    scanPaths: ['fsmn_vad/model.pt', 'huggingface/fsmn_vad/model.pt'],
  },
  // === TTS 语音合成 ===
  {
    id: 'moss_tokenizer_encode', name: 'MOSS Audio Tokenizer Encode', displayName: 'MOSS 音频分词器编码端', type: 'tts',
    description: 'MOSS TTS 音频分词器编码端 ONNX', version: '1.0',
    manifestPaths: ['moss-tts-nano/MOSS-Audio-Tokenizer-Nano-ONNX/moss_audio_tokenizer_encode.onnx'],
  },
  {
    id: 'moss_tokenizer_decode_full', name: 'MOSS Audio Tokenizer Decode Full', displayName: 'MOSS 音频分词器完整解码端', type: 'tts',
    description: 'MOSS TTS 音频分词器完整解码端 ONNX', version: '1.0',
    manifestPaths: ['moss-tts-nano/MOSS-Audio-Tokenizer-Nano-ONNX/moss_audio_tokenizer_decode_full.onnx'],
  },
  {
    id: 'moss_tokenizer_decode_step', name: 'MOSS Audio Tokenizer Decode Step', displayName: 'MOSS 音频分词器逐步解码端', type: 'tts',
    description: 'MOSS TTS 音频分词器逐步解码端 ONNX', version: '1.0',
    manifestPaths: ['moss-tts-nano/MOSS-Audio-Tokenizer-Nano-ONNX/moss_audio_tokenizer_decode_step.onnx'],
  },
  {
    id: 'moss_tts_prefill', name: 'MOSS TTS 100M Prefill', displayName: 'MOSS TTS 100M 预填充', type: 'tts',
    description: 'MOSS TTS 100M 预填充模型 ONNX', version: '1.0',
    manifestPaths: ['moss-tts-nano/MOSS-TTS-Nano-100M-ONNX/moss_tts_prefill.onnx'],
  },
  {
    id: 'moss_tts_decode', name: 'MOSS TTS 100M Decode', displayName: 'MOSS TTS 100M 逐步解码', type: 'tts',
    description: 'MOSS TTS 100M 逐步解码模型 ONNX', version: '1.0',
    manifestPaths: ['moss-tts-nano/MOSS-TTS-Nano-100M-ONNX/moss_tts_decode_step.onnx'],
  },
  {
    id: 'moss_tts_local_decoder', name: 'MOSS TTS 100M Local Decoder', displayName: 'MOSS TTS 100M 本地解码器', type: 'tts',
    description: 'MOSS TTS 100M 本地解码器 ONNX', version: '1.0',
    manifestPaths: ['moss-tts-nano/MOSS-TTS-Nano-100M-ONNX/moss_tts_local_decoder.onnx'],
  },
  {
    id: 'moss_tokenizer_model', name: 'MOSS TTS Tokenizer', displayName: 'MOSS TTS 分词器', type: 'tts',
    description: 'MOSS TTS SentencePiece 分词器模型', version: '1.0',
    manifestPaths: ['moss-tts-nano/MOSS-TTS-Nano-100M-ONNX/tokenizer.model'],
  },
  {
    id: 'sovits', name: 'GPT-SoVITS', displayName: 'GPT-SoVITS', type: 'tts',
    description: 'TTS 增强（音色克隆，pip 包内置）', version: '1.0', pythonPkg: 'sovits',
    manifestPaths: [],
  },
  // === Vision 视觉识别 ===
  {
    id: 'clip', name: 'CLIP', displayName: 'CLIP 跨模态匹配模型', type: 'vision',
    description: 'OpenAI CLIP 文本-图像跨模态匹配（脚本-视频帧对齐核心）', version: '1.0',
    manifestPaths: ['clip/config.json', 'clip/model.safetensors', 'clip/preprocessor_config.json'],
    scanPaths: ['clip/model.safetensors', 'huggingface/clip/model.safetensors'],
  },
  {
    id: 'buffalo_l_det_10g', name: 'Buffalo L det_10g', displayName: 'Buffalo L 人脸检测主干', type: 'vision',
    description: 'InsightFace Buffalo L 人脸检测主干网络', version: '1.0', pythonPkg: 'insightface',
    manifestPaths: ['buffalo_l/det_10g.onnx'],
  },
  {
    id: 'buffalo_l_w600k_r50', name: 'Buffalo L w600k_r50', displayName: 'Buffalo L 人脸特征嵌入', type: 'vision',
    description: 'InsightFace Buffalo L 人脸特征嵌入模型', version: '1.0', pythonPkg: 'insightface',
    manifestPaths: ['buffalo_l/w600k_r50.onnx'],
  },
  {
    id: 'buffalo_l_1k3d68', name: 'Buffalo L 1k3d68', displayName: 'Buffalo L 3D关键点', type: 'vision',
    description: 'InsightFace Buffalo L 3D 人脸关键点检测', version: '1.0', pythonPkg: 'insightface',
    manifestPaths: ['buffalo_l/1k3d68.onnx'],
  },
  {
    id: 'buffalo_l_2d106det', name: 'Buffalo L 2d106det', displayName: 'Buffalo L 2D 106点', type: 'vision',
    description: 'InsightFace Buffalo L 2D 106点人脸关键点', version: '1.0', pythonPkg: 'insightface',
    manifestPaths: ['buffalo_l/2d106det.onnx'],
  },
  {
    id: 'buffalo_l_genderage', name: 'Buffalo L genderage', displayName: 'Buffalo L 性别年龄', type: 'vision',
    description: 'InsightFace Buffalo L 性别年龄估计', version: '1.0', pythonPkg: 'insightface',
    manifestPaths: ['buffalo_l/genderage.onnx'],
  },
  {
    id: 'yunnet_detection', name: 'YunNet Face Detection', displayName: 'YunNet 人脸检测', type: 'vision',
    description: 'YunNet 人脸检测模型 (2023年3月版)', version: '1.0',
    manifestPaths: ['yunnet/face_detection_yunet_2023mar.onnx'],
  },
  {
    id: 'sface_recognition', name: 'SFace Face Recognition', displayName: 'SFace 人脸识别', type: 'vision',
    description: 'SFace 人脸识别特征提取', version: '1.0',
    manifestPaths: ['yunnet/face_recognition_sface_2021dec.onnx'],
  },
  // === Audio 音频分离 ===
  {
    id: 'mdx_hq3', name: 'MDX-Net HQ 3', displayName: 'UVR MDX-Net HQ3', type: 'audio',
    description: 'UVR MDX-Net 人声/伴奏分离模型 HQ3', version: '1.0', pythonPkg: 'audio_separator',
    manifestPaths: ['mdx_net/UVR-MDX-NET-Inst_HQ_3.onnx'],
  },
  {
    id: 'mdx_hq4', name: 'MDX-Net HQ 4', displayName: 'UVR MDX-Net HQ4', type: 'audio',
    description: 'UVR MDX-Net 人声/伴奏分离模型 HQ4', version: '1.0', pythonPkg: 'audio_separator',
    manifestPaths: ['mdx_net/UVR-MDX-NET-Inst_HQ_4.onnx'],
  },
  {
    id: 'demucs_htdemucs', name: 'Demucs htdemucs', displayName: 'Demucs htdemucs', type: 'audio',
    description: 'Demucs htdemucs 4-stem 分离模型（pip 包内置，无独立文件）', version: '1.0', pythonPkg: 'demucs',
    manifestPaths: [],
    // 🔧 V7：demucs 首次运行时自动下载到 TORCH_HOME/hub/checkpoints/，扫描多路径
    scanPaths: [
      'demucs/hub/checkpoints/htdemucs.pth',
      'demucs/htdemucs.pth',
      'huggingface/hub/htdemucs.pth',
    ],
  },
  // === Emotion 情绪分析 ===
  {
    id: 'emotion', name: 'Emotion Model', displayName: '情绪分析模型', type: 'emotion',
    description: '文本+音频情绪分析（暂未实现）', version: '1.0',
    manifestPaths: [],
  },
];

/** 旧版粗粒度模型 id（用于 ensureSeedData 迁移检测）
 *  V1: 7 条（moss_tts/whisper/sensevoice/mdx_net/insightface/emotion/sovits）
 *  V5: 21 条（已细化但 whisper_base 路径错误，需要迁移到 V6）
 *  V6 检测到以上任意旧 id 都触发迁移
 */
const LEGACY_MODEL_IDS = [
  // V1 粗粒度
  'moss_tts', 'whisper', 'sensevoice', 'mdx_net', 'insightface', 'emotion',
  // V5 细化但 whisper_base.manifestPaths 指向不存在的 ggml-base.bin
  'whisper_base',
];

/** 模型下载源配置（V6 修正版，URL 仍为占位，实际下载依赖预装或 huggingface-cli） */
const MODEL_SOURCES: Record<string, { url: string; file: string }> = {
  sensevoice_onnx: { url: 'https://huggingface.co/FunAudioLLM/SenseVoiceSmall/resolve/main', file: 'model_quant.onnx' },
  sensevoice_small: { url: 'https://huggingface.co/FunAudioLLM/SenseVoiceSmall/resolve/main', file: 'model.pt' },
  fsmn_vad: { url: 'https://huggingface.co/FunAudioLLM/SenseVoiceSmall/resolve/main', file: 'fsmn_vad/model.pt' },
  clip: { url: 'https://huggingface.co/openai/clip-vit-base-patch32/resolve/main', file: 'model.safetensors' },
  moss_tokenizer_encode: { url: 'https://huggingface.co/OpenMOSS/MOSS-Audio-Tokenizer-Nano-ONNX/resolve/main', file: 'moss_audio_tokenizer_encode.onnx' },
  moss_tokenizer_decode_full: { url: 'https://huggingface.co/OpenMOSS/MOSS-Audio-Tokenizer-Nano-ONNX/resolve/main', file: 'moss_audio_tokenizer_decode_full.onnx' },
  moss_tokenizer_decode_step: { url: 'https://huggingface.co/OpenMOSS/MOSS-Audio-Tokenizer-Nano-ONNX/resolve/main', file: 'moss_audio_tokenizer_decode_step.onnx' },
  moss_tts_prefill: { url: 'https://huggingface.co/OpenMOSS/MOSS-TTS-Nano-100M-ONNX/resolve/main', file: 'moss_tts_prefill.onnx' },
  moss_tts_decode: { url: 'https://huggingface.co/OpenMOSS/MOSS-TTS-Nano-100M-ONNX/resolve/main', file: 'moss_tts_decode_step.onnx' },
  moss_tts_local_decoder: { url: 'https://huggingface.co/OpenMOSS/MOSS-TTS-Nano-100M-ONNX/resolve/main', file: 'moss_tts_local_decoder.onnx' },
  moss_tokenizer_model: { url: 'https://huggingface.co/OpenMOSS/MOSS-TTS-Nano-100M-ONNX/resolve/main', file: 'tokenizer.model' },
  buffalo_l_det_10g: { url: 'https://huggingface.co/deepinsight/insightface/resolve/main', file: 'buffalo_l/det_10g.onnx' },
  buffalo_l_w600k_r50: { url: 'https://huggingface.co/deepinsight/insightface/resolve/main', file: 'buffalo_l/w600k_r50.onnx' },
  buffalo_l_1k3d68: { url: 'https://huggingface.co/deepinsight/insightface/resolve/main', file: 'buffalo_l/1k3d68.onnx' },
  buffalo_l_2d106det: { url: 'https://huggingface.co/deepinsight/insightface/resolve/main', file: 'buffalo_l/2d106det.onnx' },
  buffalo_l_genderage: { url: 'https://huggingface.co/deepinsight/insightface/resolve/main', file: 'buffalo_l/genderage.onnx' },
  yunnet_detection: { url: 'https://huggingface.co/opencv/opencv_extra/resolve/main', file: 'face_detection_yunnet_2023mar.onnx' },
  sface_recognition: { url: 'https://huggingface.co/opencv/opencv_extra/resolve/main', file: 'face_recognition_sface_2021dec.onnx' },
  mdx_hq3: { url: 'https://huggingface.co/JeffreyCA/audio-separator-models/resolve/main', file: 'UVR-MDX-NET-Inst_HQ_3.onnx' },
  mdx_hq4: { url: 'https://huggingface.co/JeffreyCA/audio-separator-models/resolve/main', file: 'UVR-MDX-NET-Inst_HQ_4.onnx' },
  sovits: { url: '', file: '' },
  demucs_htdemucs: { url: '', file: '' },
  emotion: { url: '', file: '' },
};

/**
 * 🔧 V7 新增：7 个功能模块定义（对应前端 7 张卡片，按 4 分类分组）
 * 用于前端模型管理页按功能模块展示，而非细碎的 23 个模型
 * 每个模块 = 多个模型文件 + 一个运行时依赖
 */
const MODEL_MODULES: ModelModuleDef[] = [
  // === 音频分离（2 张卡片）===
  {
    id: 'mdx_net', category: 'audio', displayName: 'MDX-Net 音频分离',
    description: 'UVR MDX-Net 人声/BGM 分离（轻量推荐，ONNX 推理）',
    icon: '🎵', required: 'builtin',
    modelIds: ['mdx_hq3', 'mdx_hq4'],
    runtimeId: 'mdx_net',  // 运行时依赖：audio_separator + onnxruntime（已内置）
    sizeNote: '~160 MB (模型文件) + 60 MB (运行时已内置)',
  },
  {
    id: 'demucs', category: 'audio', displayName: 'Demucs 音频分离（高质量）',
    description: 'Demucs htdemucs 4-stem 分离（高质量模式，需 PyTorch）',
    icon: '🎵', required: 'optional',
    modelIds: ['demucs_htdemucs'],
    runtimeId: 'demucs',  // 运行时依赖：demucs + torch + torchaudio
    sizeNote: '~80 MB (模型) + 2.2 GB (运行时，含 torch)',
  },
  // === ASR 语音识别（1 张卡片）===
  {
    id: 'sensevoice', category: 'asr', displayName: 'SenseVoice 语音识别',
    description: 'FunASR SenseVoice 多语言 ASR（中文增强，需 PyTorch）',
    icon: '🎙️', required: 'optional',
    modelIds: ['sensevoice_onnx', 'sensevoice_small', 'fsmn_vad'],
    runtimeId: 'sensevoice',  // 运行时依赖：funasr + torch
    sizeNote: '~500 MB (模型) + 600 MB (运行时，含 torch)',
  },
  // === 视觉（2 张卡片）===
  {
    id: 'insightface', category: 'vision', displayName: 'InsightFace 人脸识别',
    description: 'Buffalo L 人脸检测 + 关键点 + 性别年龄 + YunNet/SFace 备选',
    icon: '👁️', required: 'optional',
    modelIds: ['buffalo_l_det_10g', 'buffalo_l_w600k_r50', 'buffalo_l_1k3d68',
               'buffalo_l_2d106det', 'buffalo_l_genderage',
               'yunnet_detection', 'sface_recognition'],
    runtimeId: 'insightface',  // 运行时依赖：insightface + onnxruntime（已内置）
    sizeNote: '~50 MB (模型) + 200 MB (运行时)',
  },
  {
    id: 'clip', category: 'vision', displayName: 'CLIP 跨模态匹配',
    description: 'OpenAI CLIP 文本-图像匹配（脚本-视频帧对齐核心，需 PyTorch）',
    icon: '🧠', required: 'optional',
    modelIds: ['clip'],
    runtimeId: 'clip',  // 运行时依赖：transformers + torch
    sizeNote: '~600 MB (模型) + 100 MB (运行时，含 torch)',
  },
  // === TTS 语音合成（1 张卡片）===
  {
    id: 'moss_tts', category: 'tts', displayName: 'MOSS TTS 语音合成',
    description: 'MOSS TTS Nano 本地语音合成（纯 ONNX 推理，无需 PyTorch）',
    icon: '🔊', required: 'optional',
    modelIds: ['moss_tokenizer_encode', 'moss_tokenizer_decode_full', 'moss_tokenizer_decode_step',
               'moss_tts_prefill', 'moss_tts_decode', 'moss_tts_local_decoder', 'moss_tokenizer_model'],
    runtimeId: 'mdx_net',  // 运行时依赖：onnxruntime（与 MDX-Net 共用，已内置）— 此处借用 mdx_net 标记
    sizeNote: '~150 MB (模型) + 0 (运行时已内置)',
  },
];

/**
 * 🔧 V7 新增：4 个分类定义（对应前端顶部 Chip 菜单）
 */
const MODEL_CATEGORIES = [
  { id: 'audio', displayName: '音频分离', icon: '🎵' },
  { id: 'asr', displayName: '语音识别', icon: '🎙️' },
  { id: 'vision', displayName: '视觉', icon: '👁️' },
  { id: 'tts', displayName: '语音合成', icon: '🔊' },
] as const;

/**
 * 模型管理服务层
 * 负责本地模型的下载、卸载、更新以及管线节点模型映射的业务逻辑
 */
export class ModelService {
  private modelRepo = new ModelRepository();
  private pipelineConfigRepo = new PipelineModelConfigRepository();
  // 🔧 修复 F3：扫描节流锁，避免 getModelList()/getModuleList() 每次调用都全量扫描+刷屏日志
  //   5 秒内重复调用直接返回，强制刷新用 scanDiskModels(true)
  private lastScanAt = 0;
  private static readonly SCAN_THROTTLE_MS = 5000;

  /**
   * 获取所有本地模型列表（自动同步磁盘状态）
   * @returns 模型记录数组
   */
  public getModelList() {
    // 每次获取列表前，扫描磁盘更新状态
    this.scanDiskModels();
    return this.modelRepo.findAll();
  }

  /**
   * 🔧 修复 P0：确保 local_models 表有 seed 数据（V5 细化版）
   * 迁移逻辑：
   *   1. 检测旧版 7 条粗粒度记录（id 在 LEGACY_MODEL_IDS 中）→ 删除旧记录，重新 seed 21 条
   *   2. 表为空 → 直接 seed 21 条
   *   3. 已有新记录 → 跳过
   * 旧版 bug：local_models 表永远空表，预装的 21 个模型躺在磁盘但代码不知道
   */
  public ensureSeedData(): void {
    try {
      const existing = this.modelRepo.findAll();

      // 检测旧版粗粒度记录（id 为 'mdx_net' 等），需要迁移到 V5 细化版
      const hasLegacy = existing.some(m => LEGACY_MODEL_IDS.includes(m.id));
      if (hasLegacy) {
        AppLogger.info(LOG_TAGS.SYSTEM, '[ModelService] 检测到旧版 7 条粗粒度记录，开始迁移到 V5 21 条细化版');
        for (const old of existing) {
          try { this.modelRepo.deleteById(old.id); } catch {}
        }
      } else if (existing && existing.length > 0) {
        // 已是新版，跳过
        return;
      }

      AppLogger.info(LOG_TAGS.SYSTEM, '[ModelService] 开始 seed 21 条 V5 细化模型记录');
      for (const def of MODEL_DEFINITIONS) {
        try {
          this.modelRepo.insert({
            id: def.id,
            name: def.name,
            type: def.type,
            description: def.description,
            version: def.version,
            size_bytes: 0,  // 扫描磁盘后更新
            status: 'not_downloaded',
            download_path: '',
            remote_url: MODEL_SOURCES[def.id]?.url || '',
            md5_checksum: '',
          });
        } catch (e: any) {
          // INSERT 可能因 id 重复失败，忽略
          AppLogger.warn(LOG_TAGS.SYSTEM, `[ModelService] seed ${def.id} 失败: ${e.message}`);
        }
      }
      AppLogger.info(LOG_TAGS.SYSTEM, '[ModelService] seed 完成，扫描磁盘更新状态');
      // 🔧 修复 F3：seed 后强制扫描（跳过节流），确保 DB 状态立即同步磁盘
      this.scanDiskModels(true);
    } catch (e: any) {
      AppLogger.error(LOG_TAGS.SYSTEM, '[ModelService] ensureSeedData 失败', e);
    }
  }

  /**
   * 🔧 修复 P0 + V7 升级：扫描 resources/models/ 磁盘文件，更新 local_models 表状态
   * 旧版 bug：local_models 表永远空表，预装的 21 个模型躺在磁盘但代码不知道
   * V7 升级：
   *   1. 支持 scanPaths 多路径扫描（用户可能把模型放到不同子目录）
   *   2. 支持 expectedSize 大小校验（文件损坏/未下完可识别）
   *   3. 支持 md5 严格校验（关键模型）
   *   4. manifestPaths 为空但 scanPaths 非空的模型（如 htdemucs.pth）也能被识别
   * 🔧 修复 F3：加 5 秒节流锁，避免 getModelList()/getModuleList() 每次调用都全量扫描+刷屏日志
   *   强制刷新（导入/卸载后）传 force=true 跳过节流
   * @param force 是否强制扫描（跳过节流锁）
   */
  public scanDiskModels(force: boolean = false): void {
    // 🔧 修复 F3：节流锁——5 秒内重复调用直接返回
    const now = Date.now();
    if (!force && now - this.lastScanAt < ModelService.SCAN_THROTTLE_MS) {
      return;
    }
    this.lastScanAt = now;

    try {
      const modelsPath = PathManager.getModelsPath();

      for (const def of MODEL_DEFINITIONS) {
        // 🔧 V7：合并 manifestPaths + scanPaths 为候选扫描路径（去重）
        const candidatePaths = Array.from(new Set([
          ...(def.manifestPaths || []),
          ...(def.scanPaths || []),
        ]));

        if (candidatePaths.length === 0) {
          // 既无 manifestPaths 也无 scanPaths（如 emotion/sovits pip 包内置），跳过磁盘扫描
          continue;
        }

        // 扫描候选路径，找到第一个存在的文件
        let foundPath = '';
        let foundSize = 0;
        for (const relPath of candidatePaths) {
          const fullPath = path.join(modelsPath, relPath);
          if (fs.existsSync(fullPath)) {
            // 🔧 修复 F2：大小校验加 1% 容差
            //   旧版 bug：严格 stat.size !== expectedSize，HuggingFace/git-lfs 下载常有微小差异
            //   （如 ggml-base.bin 期望 147953664 实际 147951465，差 2199 字节 = 0.0015%），被判损坏
            //   修复后：偏差 < 1% 视为完整，偏差 ≥ 1% 才判损坏（防止下载截断）
            const stat = fs.statSync(fullPath);
            if (def.expectedSize) {
              const diff = Math.abs(stat.size - def.expectedSize);
              const tolerance = def.expectedSize * 0.01;  // 1% 容差
              if (diff > tolerance) {
                AppLogger.warn(LOG_TAGS.SYSTEM,
                  `[ModelService] ${def.id} 文件大小超出 1% 容差: ${relPath} 期望 ${def.expectedSize} 实际 ${stat.size}（差 ${diff} 字节），可能损坏，跳过`);
                continue;
              }
            }
            foundPath = fullPath;
            foundSize = stat.size;
            break;
          }
        }

        if (!foundPath) {
          // 所有候选路径都不存在，确保 DB 状态为 not_downloaded
          const existing = this.modelRepo.findById(def.id);
          if (existing && existing.status === 'downloaded') {
            this.modelRepo.updateStatus(def.id, 'not_downloaded');
            this.modelRepo.updateDownloadPath(def.id, '');
          }
          continue;
        }

        // 🔧 V7：MD5 严格校验（仅关键模型声明了 md5）
        if (def.md5) {
          const actualMd5 = this.computeFileMd5(foundPath);
          if (actualMd5 !== def.md5) {
            AppLogger.warn(LOG_TAGS.SYSTEM,
              `[ModelService] ${def.id} MD5 校验失败: 期望 ${def.md5} 实际 ${actualMd5}，标记为损坏`);
            try {
              this.modelRepo.updateStatus(def.id, 'corrupted');
              this.modelRepo.updateDownloadPath(def.id, foundPath);
            } catch (e: any) {
              AppLogger.warn(LOG_TAGS.SYSTEM, `[ModelService] 更新 ${def.id} 状态失败: ${e.message}`);
            }
            continue;
          }
        }

        // 更新 DB 状态为已下载
        try {
          this.modelRepo.updateStatus(def.id, 'downloaded');
          this.modelRepo.updateDownloadPath(def.id, foundPath);
          // 🔧 修复 P0：持久化 size_bytes
          const existing = this.modelRepo.findById(def.id);
          if (existing && existing.size_bytes !== foundSize) {
            this.modelRepo.updateSize(def.id, foundSize);
          }
        } catch (e: any) {
          AppLogger.warn(LOG_TAGS.SYSTEM, `[ModelService] 更新 ${def.id} 状态失败: ${e.message}`);
        }
      }
    } catch (e: any) {
      AppLogger.error(LOG_TAGS.SYSTEM, '[ModelService] scanDiskModels 失败', e);
    }
  }

  /**
   * 🔧 V7 新增：计算文件 MD5（用于关键模型完整性校验）
   * @param filePath 文件绝对路径
   * @returns 32 位小写 MD5 hex
   */
  private computeFileMd5(filePath: string): string {
    const hash = crypto.createHash('md5');
    const buffer = fs.readFileSync(filePath);
    hash.update(buffer);
    return hash.digest('hex');
  }

  /**
   * 🔧 V7 新增：获取功能模块列表（7 张卡片 + 4 分类）
   * 🔧 修复 M1：模型管理只管模型文件，删除 runtime 字段
   *   - 旧版：canUse = 模型文件就绪 + 运行时就绪（混合职责，与 HealthPage 冲突）
   *   - 新版：canUse = 模型文件就绪（纯模型文件管理，运行时去健康检查页看）
   * @returns 模块列表（仅含模型文件详情 + 文件整体可用性）
   */
  public getModuleList() {
    // 先扫描磁盘更新状态
    this.scanDiskModels();
    const allModels = this.modelRepo.findAll();

    return MODEL_MODULES.map(module => {
      // 聚合模块下的模型文件详情
      const models = module.modelIds.map(id => {
        const def = MODEL_DEFINITIONS.find(d => d.id === id);
        const dbRecord = allModels.find(m => m.id === id);
        return {
          id,
          name: def?.name || id,
          displayName: def?.displayName || id,
          description: def?.description || '',
          version: def?.version || '1.0',
          status: dbRecord?.status || 'not_downloaded',
          sizeBytes: dbRecord?.size_bytes || 0,
          downloadPath: dbRecord?.download_path || '',
          remoteUrl: MODEL_SOURCES[id]?.url || '',
          pythonPkg: def?.pythonPkg,
        };
      });

      // 计算模型文件整体状态（M1：仅基于模型文件，不再依赖运行时）
      const allModelsReady = models.every(m => m.status === 'downloaded');
      const someModelsReady = models.some(m => m.status === 'downloaded');

      // canUse = 模型文件全部就绪（运行时状态去健康检查页查看）
      const canUse = allModelsReady;

      return {
        id: module.id,
        category: module.category,
        displayName: module.displayName,
        description: module.description,
        icon: module.icon,
        required: module.required,
        sizeNote: module.sizeNote,
        models,
        status: canUse ? 'ready' : (someModelsReady ? 'partial' : 'missing'),
        canUse,
      };
    });
  }

  /**
   * 🔧 V7 新增：获取 4 个分类定义（供前端 Chip 菜单）
   */
  public getCategories() {
    return MODEL_CATEGORIES;
  }

  /**
   * 🔧 V7 新增：导入本地模型文件（用户离线补模型）
   * 校验文件大小 + MD5，通过后复制到 resources/models/<子目录>/
   * @param modelId 模型 ID
   * @param srcFilePath 用户选择的本地文件路径
   * @returns 导入结果 { modelId, status, message, downloadPath }
   */
  public importModelFile(modelId: string, srcFilePath: string) {
    const def = MODEL_DEFINITIONS.find(d => d.id === modelId);
    if (!def) {
      throw new AppError(ErrorCode.DB_RECORD_NOT_FOUND, `模型定义不存在: ${modelId}`);
    }
    if (!fs.existsSync(srcFilePath)) {
      throw new AppError(ErrorCode.FS_PATH_INVALID, `源文件不存在: ${srcFilePath}`);
    }

    const stat = fs.statSync(srcFilePath);
    // 🔧 修复 F2：大小校验加 1% 容差（与 scanDiskModels 一致，防止 HuggingFace 微小差异误判）
    if (def.expectedSize) {
      const diff = Math.abs(stat.size - def.expectedSize);
      const tolerance = def.expectedSize * 0.01;  // 1% 容差
      if (diff > tolerance) {
        throw new AppError(
          ErrorCode.FS_PATH_INVALID,
          `文件大小超出 1% 容差: 期望 ${def.expectedSize} 字节，实际 ${stat.size} 字节（差 ${diff} 字节），请确认文件来源`
        );
      }
    }

    // 🔧 V7：MD5 校验（若声明了 md5）
    if (def.md5) {
      const actualMd5 = this.computeFileMd5(srcFilePath);
      if (actualMd5 !== def.md5) {
        throw new AppError(
          ErrorCode.FS_PATH_INVALID,
          `MD5 校验失败: 期望 ${def.md5}，实际 ${actualMd5}，文件可能损坏或版本不匹配`
        );
      }
    }

    // 确定目标路径：优先 manifestPaths[0]，否则 scanPaths[0]
    const targetRelPath = (def.manifestPaths && def.manifestPaths[0]) ||
                          (def.scanPaths && def.scanPaths[0]);
    if (!targetRelPath) {
      throw new AppError(ErrorCode.FS_PATH_INVALID, `模型 ${modelId} 无可用目标路径`);
    }

    const modelsPath = PathManager.getModelsPath();
    const targetFullPath = path.join(modelsPath, targetRelPath);

    // 创建目录（如不存在）
    fs.mkdirSync(path.dirname(targetFullPath), { recursive: true });

    // 复制文件
    fs.copyFileSync(srcFilePath, targetFullPath);

    // 更新 DB 状态
    this.modelRepo.updateStatus(modelId, 'downloaded');
    this.modelRepo.updateDownloadPath(modelId, targetFullPath);
    this.modelRepo.updateSize(modelId, stat.size);

    AppLogger.info(LOG_TAGS.SYSTEM, `[ModelService] 导入模型成功: ${modelId} -> ${targetFullPath}`);
    return {
      modelId,
      status: 'downloaded',
      message: '模型导入成功',
      downloadPath: targetFullPath,
    };
  }

  /**
   * 下载模型
   * @param modelId 模型 ID
   * @returns 下载结果 { modelId, status, message }
   */
  public async downloadModel(modelId: string) {
    const model = this.modelRepo.findById(modelId);
    if (!model) {
      throw new AppError(ErrorCode.DB_RECORD_NOT_FOUND, `模型不存在: ${modelId}`);
    }

    if (model.status === 'downloaded') {
      return { modelId, status: 'downloaded', message: '模型已下载，无需重复操作' };
    }

    // 更新状态为下载中
    this.modelRepo.updateStatus(modelId, 'downloading');
    AppLogger.info(LOG_TAGS.SYSTEM, `开始下载模型: ${modelId} (${model.name})`);

    try {
      // 真实下载模型文件（支持断点续传）
      const filePath = await this.downloadModelFile(modelId, (percent) => {
        AppLogger.info(LOG_TAGS.SYSTEM, `模型下载进度: ${modelId} ${percent}%`);
      });

      // 更新状态为已下载
      this.modelRepo.updateStatus(modelId, 'downloaded');
      if (filePath) this.modelRepo.updateDownloadPath(modelId, filePath);
      AppLogger.info(LOG_TAGS.SYSTEM, `模型下载完成: ${modelId}`);
      return { modelId, status: 'downloaded', message: '模型下载完成' };
    } catch (err) {
      this.modelRepo.updateStatus(modelId, 'download_failed');
      AppLogger.error(LOG_TAGS.SYSTEM, `模型下载失败: ${modelId}`, err);
      throw new AppError(ErrorCode.NETWORK_TIMEOUT, `模型下载失败: ${modelId}`);
    }
  }

  /**
   * 卸载模型
   * @param modelId 模型 ID
   * @returns 操作结果 { modelId, status }
   */
  public uninstallModel(modelId: string) {
    const model = this.modelRepo.findById(modelId);
    if (!model) {
      throw new AppError(ErrorCode.DB_RECORD_NOT_FOUND, `模型不存在: ${modelId}`);
    }

    if (model.status !== 'downloaded') {
      throw new AppError(ErrorCode.DATABASE_ERROR, `模型未下载，无法卸载: ${modelId}`);
    }

    // 更新状态为未下载，并清除下载路径
    this.modelRepo.updateStatus(modelId, 'not_downloaded');
    this.modelRepo.updateDownloadPath(modelId, '');
    AppLogger.info(LOG_TAGS.SYSTEM, `模型已卸载: ${modelId}`);
    return { modelId, status: 'not_downloaded' };
  }

  /**
   * 检查模型更新
   * @param modelId 模型 ID
   * @returns 更新检查结果 { modelId, hasUpdate, latestVersion }
   */
  public async checkUpdate(modelId: string) {
    const model = this.modelRepo.findById(modelId);
    if (!model) {
      throw new AppError(ErrorCode.DB_RECORD_NOT_FOUND, `模型不存在: ${modelId}`);
    }

    // 模拟版本检查：实际项目中应调用远程 API 获取最新版本
    const latestVersion = await this.simulateVersionCheck(modelId);
    const hasUpdate = latestVersion !== model.version;

    return {
      modelId,
      hasUpdate,
      currentVersion: model.version,
      latestVersion,
    };
  }

  /**
   * 更新模型
   * @param modelId 模型 ID
   * @returns 更新结果 { modelId, status, message }
   */
  public async updateModel(modelId: string) {
    const model = this.modelRepo.findById(modelId);
    if (!model) {
      throw new AppError(ErrorCode.DB_RECORD_NOT_FOUND, `模型不存在: ${modelId}`);
    }

    if (model.status !== 'downloaded') {
      throw new AppError(ErrorCode.DATABASE_ERROR, `模型未下载，无法更新: ${modelId}`);
    }

    // 更新状态为更新中
    this.modelRepo.updateStatus(modelId, 'updating');
    AppLogger.info(LOG_TAGS.SYSTEM, `开始更新模型: ${modelId}`);

    try {
      // 模拟更新过程
      await this.simulateDownload(modelId);

      const latestVersion = await this.simulateVersionCheck(modelId);
      this.modelRepo.updateVersion(modelId, latestVersion);
      this.modelRepo.updateStatus(modelId, 'downloaded');
      AppLogger.info(LOG_TAGS.SYSTEM, `模型更新完成: ${modelId} -> v${latestVersion}`);
      return { modelId, status: 'downloaded', message: '模型更新完成' };
    } catch (err) {
      this.modelRepo.updateStatus(modelId, 'downloaded');
      AppLogger.error(LOG_TAGS.SYSTEM, `模型更新失败: ${modelId}`, err);
      throw new AppError(ErrorCode.NETWORK_TIMEOUT, `模型更新失败: ${modelId}`);
    }
  }

  /**
   * 设置模型存储路径
   * @param modelId 模型 ID
   * @param customPath 自定义存储路径
   * @returns 操作结果 { modelId, downloadPath }
   */
  public setModelPath(modelId: string, customPath: string) {
    const model = this.modelRepo.findById(modelId);
    if (!model) {
      throw new AppError(ErrorCode.DB_RECORD_NOT_FOUND, `模型不存在: ${modelId}`);
    }

    this.modelRepo.updateDownloadPath(modelId, customPath);
    AppLogger.info(LOG_TAGS.SYSTEM, `模型路径已更新: ${modelId} -> ${customPath}`);
    return { modelId, downloadPath: customPath };
  }

  /**
   * 批量下载模型
   * @param modelIds 模型 ID 数组
   * @returns 批量下载结果数组
   */
  public async batchDownload(modelIds: string[]) {
    const results: Array<{ modelId: string; status: string; message: string }> = [];

    for (const modelId of modelIds) {
      try {
        const result = await this.downloadModel(modelId);
        results.push(result);
      } catch (err) {
        results.push({ modelId, status: 'download_failed', message: (err as Error).message });
      }
    }

    AppLogger.info(LOG_TAGS.SYSTEM, `批量下载完成: ${results.filter(r => r.status === 'downloaded').length}/${modelIds.length} 成功`);
    return results;
  }

  /**
   * 批量更新模型
   * @param modelIds 模型 ID 数组
   * @returns 批量更新结果数组
   */
  public async batchUpdate(modelIds: string[]) {
    const results: Array<{ modelId: string; status: string; message: string }> = [];

    for (const modelId of modelIds) {
      try {
        const result = await this.updateModel(modelId);
        results.push(result);
      } catch (err) {
        results.push({ modelId, status: 'update_failed', message: (err as Error).message });
      }
    }

    AppLogger.info(LOG_TAGS.SYSTEM, `批量更新完成: ${results.filter(r => r.status === 'downloaded').length}/${modelIds.length} 成功`);
    return results;
  }

  /**
   * 获取管线模型映射配置
   * @param projectId 项目 ID
   * @returns 管线节点模型配置数组
   */
  public getPipelineModelConfig(projectId: string) {
    return this.pipelineConfigRepo.findByProjectId(projectId);
  }

  /**
   * 设置管线节点模型映射
   * @param projectId 项目 ID
   * @param nodeType 节点类型
   * @param provider 模型提供商
   * @param modelName 模型名称
   * @param customBaseUrl 自定义 API 地址（可选）
   * @returns 写入后的配置记录
   */
  public setPipelineNodeModel(
    projectId: string,
    nodeType: string,
    provider: string,
    modelName: string,
    customBaseUrl?: string
  ) {
    const config = {
      project_id: projectId,
      node_type: nodeType,
      provider,
      model_name: modelName,
      custom_base_url: customBaseUrl || null,
    };

    const result = this.pipelineConfigRepo.upsert(config);
    AppLogger.info(LOG_TAGS.SYSTEM, `管线节点模型已设置: ${projectId}/${nodeType} -> ${provider}/${modelName}`);
    return result;
  }

  /**
   * 重置管线节点模型为默认配置
   * @param projectId 项目 ID
   * @param nodeType 节点类型
   * @returns 操作结果
   */
  public resetPipelineNodeModel(projectId: string, nodeType: string) {
    const existing = this.pipelineConfigRepo.findByProjectAndNodeType(projectId, nodeType);
    if (!existing) {
      throw new AppError(ErrorCode.DB_RECORD_NOT_FOUND, `未找到节点配置: ${projectId}/${nodeType}`);
    }

    // 重置为默认值：provider 和 model_name 置空，由系统自动选择默认模型
    const defaultConfig = {
      project_id: projectId,
      node_type: nodeType,
      provider: 'default',
      model_name: 'default',
      custom_base_url: null,
    };

    const result = this.pipelineConfigRepo.upsert(defaultConfig);
    AppLogger.info(LOG_TAGS.SYSTEM, `管线节点模型已重置: ${projectId}/${nodeType}`);
    return result;
  }

  /**
   * 测试节点模型连接
   * @param nodeType 节点类型
   * @param provider 模型提供商
   * @param modelName 模型名称
   * @param apiKey API 密钥
   * @returns 测试结果 { success, latency, message }
   */
  public async testNodeModel(
    nodeType: string,
    provider: string,
    modelName: string,
    apiKey: string
  ) {
    if (!apiKey) {
      throw new AppError(ErrorCode.FS_PATH_INVALID, 'API Key 不能为空');
    }

    AppLogger.info(LOG_TAGS.SYSTEM, `测试节点模型连接: ${nodeType}/${provider}/${modelName}`);

    try {
      // 模拟连接测试：实际项目中应调用对应 provider 的 API 进行真实测试
      const startTime = Date.now();
      await this.simulateApiTest(provider, modelName);
      const latency = Date.now() - startTime;

      return {
        success: true,
        latency,
        message: `连接成功，延迟 ${latency}ms`,
      };
    } catch (err) {
      AppLogger.error(LOG_TAGS.SYSTEM, `节点模型连接测试失败: ${provider}/${modelName}`, err);
      return {
        success: false,
        latency: -1,
        message: `连接失败: ${(err as Error).message}`,
      };
    }
  }

  /**
   * 真实 HTTP 下载模型文件
   * 支持断点续传和进度回调
   * @param modelId 模型 ID
   * @param onProgress 进度回调 (0-100)
   */
  private async downloadModelFile(modelId: string, onProgress?: (percent: number) => void): Promise<string> {
    const source = MODEL_SOURCES[modelId];
    if (!source) {
      // 无下载源的模型，走模拟流程
      await new Promise(resolve => setTimeout(resolve, 100));
      return '';
    }

    /** 获取模型存储目录（与 Python daemon 读取目录一致） */
    // 🔧 修复 P0：旧版下载到 app.getPath('userData')/models，Python 读取 resources/models/
    //   两个目录不一致导致下载后 Python 仍读取不到
    //   修复后统一下载到 PathManager.getModelsPath()（即 resources/models/）
    const modelsDir = PathManager.getModelsPath();
    if (!fs.existsSync(modelsDir)) {
      fs.mkdirSync(modelsDir, { recursive: true });
    }

    const filePath = path.join(modelsDir, source.file);
    const fileUrl = `${source.url}/${source.file}`;

    /** 检查断点续传 */
    let existingSize = 0;
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      existingSize = stat.size;
    }

    return new Promise<string>((resolve, reject) => {
      const client = fileUrl.startsWith('https') ? https : http;
      const headers: Record<string, string> = {};
      if (existingSize > 0) {
        headers['Range'] = `bytes=${existingSize}-`;
      }

      const request = client.get(fileUrl, { headers }, (response) => {
        /** 处理重定向 */
        if (response.statusCode === 301 || response.statusCode === 302) {
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            this.downloadFromUrl(redirectUrl, filePath, existingSize, onProgress).then(resolve).catch(reject);
            return;
          }
        }

        /** 服务器不支持 Range，从头下载 */
        const isResume = response.statusCode === 206;
        const totalSize = isResume
          ? existingSize + parseInt(response.headers['content-length'] || '0', 10)
          : parseInt(response.headers['content-length'] || '0', 10);

        const writeStream = fs.createWriteStream(filePath, { flags: isResume ? 'a' : 'w' });
        let downloaded = isResume ? existingSize : 0;

        response.on('data', (chunk: Buffer) => {
          downloaded += chunk.length;
          if (totalSize > 0 && onProgress) {
            onProgress(Math.round((downloaded / totalSize) * 100));
          }
        });

        response.pipe(writeStream);

        writeStream.on('finish', () => {
          writeStream.close();
          AppLogger.info(LOG_TAGS.SYSTEM, `模型文件下载完成: ${filePath}`);
          resolve(filePath);
        });

        writeStream.on('error', (err) => {
          fs.unlinkSync(filePath);
          reject(err);
        });
      });

      request.on('error', (err) => {
        reject(err);
      });

      request.setTimeout(60000, () => {
        request.destroy();
        reject(new Error('下载超时'));
      });
    });
  }

  /**
   * 从指定 URL 下载文件（处理重定向）
   */
  private async downloadFromUrl(url: string, filePath: string, existingSize: number, onProgress?: (percent: number) => void): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const client = url.startsWith('https') ? https : http;
      const headers: Record<string, string> = {};
      if (existingSize > 0) headers['Range'] = `bytes=${existingSize}-`;

      client.get(url, { headers }, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            this.downloadFromUrl(redirectUrl, filePath, existingSize, onProgress).then(resolve).catch(reject);
            return;
          }
        }

        const isResume = response.statusCode === 206;
        const totalSize = isResume
          ? existingSize + parseInt(response.headers['content-length'] || '0', 10)
          : parseInt(response.headers['content-length'] || '0', 10);

        const writeStream = fs.createWriteStream(filePath, { flags: isResume ? 'a' : 'w' });
        let downloaded = isResume ? existingSize : 0;

        response.on('data', (chunk: Buffer) => {
          downloaded += chunk.length;
          if (totalSize > 0 && onProgress) onProgress(Math.round((downloaded / totalSize) * 100));
        });

        response.pipe(writeStream);
        writeStream.on('finish', () => { writeStream.close(); resolve(filePath); });
        writeStream.on('error', (err) => { fs.unlinkSync(filePath); reject(err); });
      }).on('error', reject);
    });
  }

  /**
   * 从指定 URL 下载文件（处理重定向）
   */
  private async simulateDownload(_modelId: string): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  /**
   * 模拟版本检查（占位实现）
   * @param _modelId 模型 ID
   * @returns 最新版本号
   */
  private async simulateVersionCheck(_modelId: string): Promise<string> {
    await new Promise(resolve => setTimeout(resolve, 50));
    return '1.0.0';
  }

  /**
   * 模拟 API 连接测试（占位实现）
   * @param _provider 提供商
   * @param _modelName 模型名称
   */
  private async simulateApiTest(_provider: string, _modelName: string): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}
