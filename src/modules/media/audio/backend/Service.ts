// 📁 路径：src/modules/media/audio/backend/Service.ts
// 音频分离服务：编排层，基于 AudioProcessor 底层引擎
//
// 核心流程（quality 模式）：
//   1. AudioProcessor.extractHQAudio → 提取 44.1kHz stereo WAV
//   2. AudioProcessor.separateVocalsBgm → Python Daemon HTTP API 分离人声/背景
//   3. AudioProcessor.downsampleTo16k → vocals 降采样到 16kHz mono 供 ASR
//
// 降级策略（quality 模式分离失败 | fast 模式）：
//   44.1kHz 原始音轨直接降采样到 16kHz mono 供 ASR，标记 isFallback=true
//
// 依赖：
//   - AudioProcessor（src/main/engine/media/AudioProcessor.ts）：底层引擎
//   - Python Daemon /api/separate：Demucs/MDX-Net 分离引擎
//   - PythonProgressSubscriber：SSE 进度流订阅
//
// 设计原则：
//   - 本 Service 是编排层，不做重复造轮子
//   - 内部调用链与 AudioProcessor.extractAndSeparate 完全一致
//   - 接口设计面向未来，覆盖当前生产代码已使用的所有字段

import * as path from 'path';
import * as fs from 'fs';
import { AudioProcessor } from '../../../../main/engine/media/AudioProcessor';
import type { AudioSeparationInput, AudioSeparationResult } from '../types';

// ──────────────────────────────────────────────
// 进度回调类型（兼容旧导出）
// ──────────────────────────────────────────────

export type SeparationProgressCallback = (progress: number, message: string) => void;

/** @deprecated 使用 AudioSeparationInput 替代 */
export interface SeparationOptions {
  outputDir: string;
  filePrefix: string;
  onProgress?: SeparationProgressCallback;
}

// ──────────────────────────────────────────────
// 服务实现
// ──────────────────────────────────────────────

export class AudioSeparationService {
  /**
   * 从媒体文件中提取并分离人声和背景音乐
   *
   * 内部调用 AudioProcessor 的底层方法链，与生产路径
   * AudioProcessor.extractAndSeparate() 逻辑完全一致：
   *   extractHQAudio → (skipSeparation? → separateVocalsBgm) → downsampleTo16k
   *
   * @param input - 输入参数（mediaPath / outputDir / mediaId / signal / mode / engine / onProgress）
   * @returns 分离结果（asrAudioPath / vocalsPath / bgmPath / isFallback / hasAudio）
   */
  static async separate(input: AudioSeparationInput): Promise<AudioSeparationResult> {
    const { mediaPath, outputDir, mediaId, signal, mode, engine, onProgress } = input;

    // ── 0. 参数校验 & 目录准备 ──
    if (!fs.existsSync(mediaPath)) {
      return {
        asrAudioPath: undefined,
        vocalsPath: undefined,
        bgmPath: undefined,
        isFallback: false,
        hasAudio: false,
      };
    }

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const hqPath = path.join(outputDir, `audio_${mediaId}_44k.wav`);
    const asrPath = path.join(outputDir, `audio_${mediaId}_16k.wav`);
    const skipSeparation = mode === 'fast';

    // ── 1. 提取 44.1kHz stereo（分离引擎输入，也是后续降采样的源头） ──
    onProgress?.(5, '正在提取音频...');
    const hqResult = await AudioProcessor.extractHQAudio(mediaPath, hqPath, signal);
    if (!hqResult) {
      return {
        asrAudioPath: undefined,
        vocalsPath: undefined,
        bgmPath: undefined,
        isFallback: false,
        hasAudio: false,
      };
    }

    // ── 2. fast 模式：跳过分离，直接降采样到 16kHz 供 ASR ──
    if (skipSeparation) {
      onProgress?.(50, '极速模式：跳过分离，正在降采样...');
      const ok = await AudioProcessor.downsampleTo16k(hqPath, asrPath, signal);
      const finalAsr = ok ? asrPath : hqPath;
      if (ok) fs.unlink(hqPath, () => {});
      onProgress?.(100, '音频处理完成');
      return {
        asrAudioPath: finalAsr,
        vocalsPath: undefined,
        bgmPath: undefined,
        isFallback: true,
        hasAudio: true,
      };
    }

    // ── 3. 人声分离（Demucs/MDX-Net，吃 44.1kHz stereo 保证质量）──
    onProgress?.(10, '正在分离人声...');
    const separated = await AudioProcessor.separateVocalsBgm(
      hqPath,
      outputDir,
      signal,
      engine || 'mdx',
      onProgress,
    );

    // ── 4. 分离成功：vocals 降采样到 16kHz mono 供 ASR ──
    if (separated && separated.vocals) {
      onProgress?.(95, '正在准备 ASR 音频...');
      const ok = await AudioProcessor.downsampleTo16k(separated.vocals, asrPath, signal);
      // 降采样失败时直接用原 vocals（44.1kHz）作为 fallback，ASR 内部也能转
      const finalAsr = ok ? asrPath : separated.vocals;
      // 清理中间产物：44.1kHz 原始提取文件（分离已完成，不再需要）
      fs.unlink(hqPath, () => {});
      onProgress?.(100, '人声分离完成');
      return {
        asrAudioPath: finalAsr,
        vocalsPath: separated.vocals,
        bgmPath: separated.bgm,
        isFallback: !!separated._isFallback,
        hasAudio: true,
      };
    }

    // ── 5. 分离失败：从 44.1kHz 降采样到 16kHz mono 供 ASR ──
    onProgress?.(95, '分离失败，正在降级处理...');
    const ok = await AudioProcessor.downsampleTo16k(hqPath, asrPath, signal);
    // 降采样失败时直接用 44.1kHz 作为最后兜底
    const finalAsr = ok ? asrPath : hqPath;
    onProgress?.(100, '降级处理完成');
    return {
      asrAudioPath: finalAsr,
      vocalsPath: undefined,
      bgmPath: undefined,
      isFallback: true,
      hasAudio: true,
    };
  }

  /**
   * 仅提取音频，不做分离
   *
   * 等价于调用 mode='fast' 时的 separate()，但接口更简洁。
   * 内部调用 extractHQAudio → downsampleTo16k。
   *
   * @param mediaPath - 源媒体文件路径
   * @param outputDir - 输出目录
   * @param mediaId   - 媒体标识
   * @param signal    - 取消信号
   * @returns 16kHz mono WAV 路径，无音轨时返回 undefined
   */
  static async extractForASR(
    mediaPath: string,
    outputDir: string,
    mediaId: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const hqPath = path.join(outputDir, `audio_${mediaId}_44k.wav`);
    const asrPath = path.join(outputDir, `audio_${mediaId}_16k.wav`);

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const hqResult = await AudioProcessor.extractHQAudio(mediaPath, hqPath, signal);
    if (!hqResult) return undefined;

    const ok = await AudioProcessor.downsampleTo16k(hqPath, asrPath, signal);
    if (ok) fs.unlink(hqPath, () => {});
    // 降采样失败时直接用 44.1kHz 作为 fallback
    return ok ? asrPath : hqPath;
  }
}
