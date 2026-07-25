// 📁 路径：src/modules/media/audio/types.ts
// 接口契约：人声/背景音乐分离模块

/** 分离引擎 */
export type SeparationEngine = 'demucs' | 'mdx' | 'auto';

/** 分离模式 */
export type SeparationMode = 'quality' | 'fast';

/** 音频分离输入参数 */
export interface AudioSeparationInput {
  /** 源媒体文件绝对路径（视频或音频） */
  mediaPath: string;

  /** 输出目录（通常为 cacheDir/audio） */
  outputDir: string;

  /** 媒体唯一标识，用于命名中间产物 */
  mediaId: string;

  /** 取消信号，透传到所有异步子操作 */
  signal?: AbortSignal;

  /**
   * 分离模式
   * - 'quality': 完整分离链（44.1kHz 提取 → Demucs/MDX-Net 分离 → 降采样 16kHz）
   * - 'fast': 仅提取并降采样到 16kHz 供 ASR，跳过分离引擎
   * @default 'quality'
   */
  mode?: SeparationMode;

  /**
   * 分离引擎（仅 quality 模式生效）
   * - 'demucs': 重型高保真，失败不降级
   * - 'mdx': 轻量极速，失败不降级
   * - 'auto': Demucs → MDX-Net 降级链
   * @default 'auto'
   */
  engine?: SeparationEngine;

  /** 进度回调：0-100 进度百分比与描述文本 */
  onProgress?: (pct: number, msg: string) => void;
}

/** 音频分离输出 */
export interface AudioSeparationResult {
  /** 供 ASR 的 16kHz 单声道音频路径（分离成功 = vocals 降采样；分离失败 = 原始音轨降采样） */
  asrAudioPath: string | undefined;

  /** 分离后人声路径（44.1kHz stereo），fast 模式或分离失败时为 undefined */
  vocalsPath: string | undefined;

  /** 分离后背景音乐路径（44.1kHz stereo），fast 模式或分离失败时为 undefined */
  bgmPath: string | undefined;

  /** 是否降级（分离失败 / fast 模式，使用原始音轨降采样供 ASR） */
  isFallback: boolean;

  /** 媒体是否包含有效音轨 */
  hasAudio: boolean;

  // TODO: 音频时长（当前生产代码未提取音频元数据，待后续接入 ffprobe 后填充）
  // duration?: number;

  // TODO: 实际采样率（当前生产代码未提取音频元数据，待后续接入 ffprobe 后填充）
  // sampleRate?: number;
}
