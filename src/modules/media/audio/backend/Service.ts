// 📁 路径：src/modules/media/audio/backend/Service.ts
// 音频分离服务：从视频中提取人声与背景音乐
//
// 核心流程：
//   1. FFmpeg 提取音轨（16kHz 单声道 WAV）
//   2. Spleeter/UVR5 分离人声与背景音乐
//
// 依赖：AudioProcessor（src/main/engine/media/，底层引擎工具）

import * as path from 'path';
import * as fs from 'fs';
import { AudioProcessor } from '../../../../main/engine/media/AudioProcessor';
import type { AudioSeparateInput, AudioSeparateOutput } from '../types';

// ──────────────────────────────────────────────
// 进度回调
// ──────────────────────────────────────────────

export type SeparationProgressCallback = (progress: number, message: string) => void;

// ──────────────────────────────────────────────
// 配置选项
// ──────────────────────────────────────────────

export interface SeparationOptions {
  /** 输出目录（缓存目录） */
  outputDir: string;
  /** 中间产物前缀（如 mediaId），用于生成临时文件名 */
  filePrefix: string;
  /** 进度回调 */
  onProgress?: SeparationProgressCallback;
}

// ──────────────────────────────────────────────
// 服务实现
// ──────────────────────────────────────────────

export class AudioSeparationService {
  /**
   * 从视频中分离人声和背景音乐
   *
   * @param input   - 输入参数（videoPath + engine）
   * @param options - 输出配置（outputDir / filePrefix / onProgress）
   * @returns 分离结果（vocalsPath + bgmPath）
   */
  static async separate(
    input: AudioSeparateInput,
    options: SeparationOptions
  ): Promise<AudioSeparateOutput> {
    const { videoPath, engine } = input;
    const { outputDir, filePrefix, onProgress } = options;

    // 确保输出目录存在
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // ── 阶段1：从视频中提取原始音轨 ──
    const extractWavPath = path.join(outputDir, `${filePrefix}_extracted.wav`);

    onProgress?.(5, '正在分离物理音轨...');
    await AudioProcessor.extractAudioForASR(videoPath, extractWavPath, (percent, msg) => {
      const mappedProgress = 5 + Math.floor(percent * 0.35);
      onProgress?.(mappedProgress, `抽取音轨: ${msg}`);
    });

    // ── 阶段2：AI 引擎分离人声与背景音乐 ──
    onProgress?.(40, `正在启动 ${engine.toUpperCase()} 引擎进行频段分离...`);
    const { vocalPath, bgmPath } = await AudioProcessor.separateVocals(
      extractWavPath,
      outputDir,
      engine as 'spleeter' | 'uvr5',
      (percent, msg) => {
        const mappedProgress = 40 + Math.floor((percent > 0 ? percent : 50) * 0.55);
        onProgress?.(mappedProgress, msg);
      }
    );

    onProgress?.(100, '人声与伴奏分离完成！');

    return {
      vocalsPath: vocalPath,
      bgmPath: bgmPath,
    };
  }
}
