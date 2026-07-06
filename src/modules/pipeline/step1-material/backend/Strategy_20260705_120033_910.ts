// Module: pipeline/step1-material - Pipeline Strategy

import { BaseNodeStrategy, ExecutionContext } from '../../../main/engine/strategies/BaseNodeStrategy';
import { VideoProcessor } from '../../../main/engine/media/VideoProcessor';
import { AudioProcessor } from '../../../main/engine/media/AudioProcessor';
import { VisionProcessor } from '../../../main/engine/media/VisionProcessor';
import { LocalWhisperStrategy } from '../../../main/engine/strategies/LocalWhisperStrategy';
import { PathManager } from '../../../main/utils/pathManager';
import { AppLogger } from '../../../main/core/AppLogger';
import { LOG_TAGS } from '../../../infra/logger/LogConstants';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Step1 素材分析管线策略
 * 负责编排4个子步骤：抽帧 → 音频分离 → ASR → 人脸检测
 * 复用旧版 ExtractionPipeline 的底层能力（VideoProcessor / AudioProcessor / LocalWhisperStrategy / VisionProcessor）
 */
export class Step1MaterialStrategy extends BaseNodeStrategy {
  readonly nodeType = 'step1-material';
  readonly isRecoverable = true;

  protected async performTask(
    input: any,
    context: ExecutionContext,
    cacheDir: string,
    onProgress: (p: number, s: string) => void
  ): Promise<any> {
    const mediaPath = input.mediaPath;
    const config = input.config || {};
    const projectId = input.projectId || context.projectId;
    const mediaId = input.mediaId || this.deriveMediaId(mediaPath, projectId);

    if (!mediaPath) {
      AppLogger.warn(LOG_TAGS.SCHEDULER, '[Step1] 未提供媒体文件路径');
      return { _failed: true, _error: '未找到媒体文件路径' };
    }

    onProgress(0, '素材分析开始...');

    const results: Record<string, any> = {};

    // 确保目录结构存在
    const mediaDir = PathManager.getProjectMediaDir(projectId);
    const framesBaseDir = PathManager.getProjectExtractionsDir(projectId, 'frames');
    const framesDir = path.join(framesBaseDir, mediaId);
    const facesBaseDir = PathManager.getProjectExtractionsDir(projectId, 'faces');
    const facesDir = path.join(facesBaseDir, mediaId);
    const rawAudioPath = path.join(mediaDir, `audio_${mediaId}_16k.wav`);

    if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir, { recursive: true });
    if (!fs.existsSync(facesDir)) fs.mkdirSync(facesDir, { recursive: true });

    // 解析子步骤开关
    const runFrames = this.isStepEnabled(config.frames);
    const runAudio = this.isStepEnabled(config.audio);
    const runWhisper = this.isStepEnabled(config.whisper);
    const runFaces = this.isStepEnabled(config.faces);

    let validFrames: string[] = [];
    let hasAudio: boolean | string = false;
    let vocalsPath: string | undefined;
    let bgmPath: string | undefined;
    let whisperResult: string = '';

    // === 1. 双子星并行：抽帧 + 音频分离 ===
    if (runFrames || runAudio) {
      try {
        const [_frameResult, _audioResult] = await Promise.all([
          // 轨道 A：视频视觉链路 — 抽帧
          (async () => {
            if (runFrames) {
              onProgress(5, '正在提取关键帧...');
              try {
                const framesConfig = typeof config.frames === 'object' ? config.frames : {};
                const strategy = framesConfig.mode || config.frameStrategy || 'VLM_OPTIMIZED';
                let telemetryResult = await VideoProcessor.extractFrames(mediaPath, framesDir, mediaId, {
                  strategy,
                  fps: framesConfig.fps || config.frameFps || 2,
                  sceneThreshold: framesConfig.sceneThreshold || 0.28,
                  minFrameInterval: framesConfig.minFrameInterval || 4,
                  scale: framesConfig.scale || 1024,
                  quality: framesConfig.quality || 3,
                  timePoint: framesConfig.timePoint,
                });

                // VLM/scene 模式帧数过少时自动降级到 UNIFORM_FPS 重抽
                const needsFallback = (strategy === 'VLM_OPTIMIZED' || strategy === 'scene')
                  && telemetryResult.files.length < 3;
                if (needsFallback) {
                  AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, '[Step1] VLM/Scene 模式帧数过少，降级到 UNIFORM_FPS 重抽', {
                    mediaId, frameCount: telemetryResult.metrics.frameCount,
                  });
                  telemetryResult = await VideoProcessor.extractFrames(mediaPath, framesDir, mediaId, {
                    strategy: 'UNIFORM_FPS',
                    fps: framesConfig.fps || config.frameFps || 2,
                    scale: framesConfig.scale || 1024,
                    quality: framesConfig.quality || 3,
                  });
                }

                validFrames = telemetryResult.files;
                results.frames = {
                  count: validFrames.length,
                  paths: validFrames,
                  metrics: telemetryResult.metrics,
                };
                AppLogger.info(LOG_TAGS.MEDIA_ENGINE, '[Step1] 帧提取完成', {
                  mediaId, frameCount: validFrames.length,
                });
                onProgress(20, `帧提取完成 (${validFrames.length} 帧)`);
                return telemetryResult;
              } catch (e: any) {
                AppLogger.error(LOG_TAGS.MEDIA_ENGINE, '[Step1] 帧提取失败', { mediaId, error: e.message });
                results.frames = { count: 0, paths: [], error: e.message };
                onProgress(20, '帧提取失败，已降级跳过');
                return { files: [] };
              }
            }
            return { files: [] };
          })(),

          // 轨道 B：音频语义链路 — 音频分离
          (async () => {
            if (runAudio) {
              onProgress(10, '正在分离音频...');
              try {
                hasAudio = await (AudioProcessor as any).separateAudio(
                  mediaPath, rawAudioPath, mediaId,
                );
              } catch (e: any) {
                AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, '[Step1] 未检测到有效音频轨道，静默运行', { mediaId });
                hasAudio = false;
              }

              if (hasAudio) {
                onProgress(20, '正在进行人声/背景音分离...');
                try {
                  const separated = await (AudioProcessor as any).separateVocalsBgm(
                    rawAudioPath, mediaDir,
                  );
                  if (separated && separated.vocals) {
                    vocalsPath = separated.vocals;
                    bgmPath = separated.bgm;
                    results.audio = { separated: true, vocalsPath, bgmPath };
                  } else {
                    results.audio = { separated: false };
                  }
                } catch (e: any) {
                  AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, '[Step1] Demucs 分离不可用，使用原始音轨', { mediaId });
                  results.audio = { separated: false };
                }
              } else {
                results.audio = { separated: false };
              }
              onProgress(30, '音频分离完成');
              return hasAudio;
            }
            return false;
          })(),
        ]);
      } catch (error: any) {
        AppLogger.error(LOG_TAGS.MEDIA_ENGINE, '[Step1] 双子星并行执行失败', { mediaId, error: error.message });
      }
    }

    // === 2. ASR 台词识别 ===
    if (hasAudio && runWhisper) {
      const targetAudio = vocalsPath || rawAudioPath;
      if (fs.existsSync(targetAudio)) {
        onProgress(35, '正在进行 ASR 识别...');
        try {
          const langMap: Record<string, string> = {
            'zh-CN': 'zh', 'en-US': 'en', 'ja-JP': 'ja', 'ko-KR': 'ko',
          };
          const targetLang = langMap[config.targetLanguage] || 'zh';
          const whisperStrategy = new LocalWhisperStrategy();
          const textResult = await whisperStrategy.transcribe(
            targetAudio, mediaDir, mediaId, targetLang,
          );
          whisperResult = textResult.whisperJsonPath || '';
          results.asr = { lines: [], whisperJsonPath: whisperResult };
          onProgress(55, 'ASR 识别完成');
        } catch (e: any) {
          AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, '[Step1] ASR 服务失败，跳过语音识别', { mediaId, error: e.message });
          results.asr = { lines: [], error: e.message };
          onProgress(55, 'ASR 识别失败，已降级跳过');
        }
      } else {
        results.asr = { lines: [] };
      }
    } else {
      results.asr = { lines: [] };
    }

    // === 3. 人脸检测 ===
    if (runFaces) {
      if (validFrames.length === 0) {
        AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, '[Step1] 无有效帧，自动跳过人脸检测');
        results.faces = { roles: [] };
      } else {
        onProgress(60, '正在检测人脸...');
        try {
          const roles = await VisionProcessor.scanFaces(validFrames, facesDir);
          results.faces = { roles, count: roles.length };
          onProgress(80, `人脸检测完成 (${roles.length} 个角色)`);
        } catch (e: any) {
          AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, '[Step1] 人脸检测服务不可用，跳过', { mediaId, error: e.message });
          results.faces = { roles: [], error: e.message };
          onProgress(80, '人脸检测失败，已降级跳过');
        }
      }
    } else {
      results.faces = { roles: [] };
    }

    onProgress(100, '素材分析完成');
    AppLogger.info(LOG_TAGS.SCHEDULER, '[Step1] 素材分析策略执行完成', {
      mediaId,
      frameCount: validFrames.length,
      hasAudio: !!hasAudio,
      hasASR: !!whisperResult,
      faceCount: (results.faces?.roles || []).length,
    });

    return {
      ...results,
      mediaId,
      hasAudio: !!hasAudio,
      audioPath: hasAudio ? rawAudioPath : undefined,
      vocalsPath,
      bgmPath,
    };
  }

  /** 判断子步骤是否启用 */
  private isStepEnabled(stepConfig: any): boolean {
    if (stepConfig === false) return false;
    if (stepConfig === true) return true;
    if (typeof stepConfig === 'object' && stepConfig !== null) {
      return stepConfig.enabled !== false;
    }
    return true;
  }

  /** 从 mediaPath 推导 mediaId */
  private deriveMediaId(mediaPath: string, projectId: string): string {
    if (!mediaPath) return `media_${Date.now()}_unknown`;
    const fileName = path.basename(mediaPath);
    const sanitized = fileName.replace(/[^\w\-\u4e00-\u9fff]/g, '_').substring(0, 32);
    return `media_${projectId}_${sanitized}`;
  }
}
