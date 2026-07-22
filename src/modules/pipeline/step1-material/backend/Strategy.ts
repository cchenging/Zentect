// Module: pipeline/step1-material - Pipeline Strategy

import { BaseNodeStrategy, ExecutionContext } from '../../../../main/engine/strategies/BaseNodeStrategy';
import { FrameExtractionService } from '../../../media/frames';
import { PathManager } from '../../../../main/utils/pathManager';
import { AudioProcessor } from '../../../../main/engine/media/AudioProcessor';
import { VisionProcessor } from '../../../../main/engine/media/VisionProcessor';
import { LocalWhisperStrategy } from '../../../../main/engine/strategies/LocalWhisperStrategy';
import { AppLogger } from '../../../../main/core/AppLogger';
import { LOG_TAGS } from '../../../infra/logger/LogConstants';
import { AppError, ErrorCode } from '../../../infra/error/AppError';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Step1 素材分析管线策略
 * 负责编排4个子步骤：抽帧 → 音频分离 → ASR → 人脸检测
 *
 * 双子星并行调度：抽帧与音频分离同时启动（Promise.all），
 * 之后串行执行 ASR 和人脸检测，每个步骤失败时降级跳过不阻断管线。
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
    const mediaId = input.mediaId || `media_${Date.now()}`;

    if (!mediaPath) {
      AppLogger.warn(LOG_TAGS.SCHEDULER, '[Step1] 未提供媒体文件路径');
      throw new AppError(ErrorCode.FS_FILE_NOT_FOUND, '未找到媒体文件路径');
    }

    // 子步骤开关：兼容布尔值和 { enabled: true/false } 两种配置格式
    const runFrames = config.frames !== false &&
      (typeof config.frames === 'boolean' ? config.frames : (config.frames?.enabled ?? true));
    const runAudio = config.audio !== false &&
      (typeof config.audio === 'boolean' ? config.audio : (config.audio?.enabled ?? true));
    const runFaces = config.faces !== false &&
      (typeof config.faces === 'boolean' ? config.faces : (config.faces?.enabled ?? true));
    const runWhisper = config.whisper !== false &&
      (typeof config.whisper === 'boolean' ? config.whisper : (config.whisper?.enabled ?? true));

    onProgress(0, '素材分析开始...');

    // 创建子目录
    const framesDir = path.join(cacheDir, 'frames');
    const audioDir = path.join(cacheDir, 'audio');
    const facesDir = path.join(cacheDir, 'faces');
    if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir, { recursive: true });
    if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });
    if (!fs.existsSync(facesDir)) fs.mkdirSync(facesDir, { recursive: true });

    let validFrames: string[] = [];
    let hasAudio: boolean | string = true;
    let vocalsPath: string | undefined;
    let bgmPath: string | undefined;
    let vocalsIsFallback = false;
    const rawAudioPath = path.join(audioDir, `audio_${mediaId}_16k.wav`);

    // 子步骤失败标记（Repair 2）
    let framesFailed = false;
    let audioFailed = false;
    let asrFailed = false;
    let facesFailed = false;

    // === 双子星并行：抽帧 ∥ 音频分离 ===
    try {
      const [_frameResult, _audioResult] = await Promise.all([
        // 轨道 A：视频抽帧
        (async () => {
          if (!runFrames) return { files: [] };

          onProgress(5, '正在提取关键帧...');
          try {
            const framesConfig = typeof config.frames === 'object' ? config.frames : {};
            const strategy = framesConfig.mode || config.frameStrategy || 'VLM_OPTIMIZED';
            const frameService = new FrameExtractionService({
              getFfmpegPath: () => PathManager.getBinPath('ffmpeg.exe'),
              getFfprobePath: () => PathManager.getBinPath('ffprobe.exe'),
            });
            let telemetryResult = await frameService.extractFrames(mediaPath, framesDir, mediaId, {
              strategy,
              fps: framesConfig.fps || config.frameFps || 2,
              sceneThreshold: framesConfig.sceneThreshold || 0.28,
              minFrameInterval: framesConfig.minFrameInterval || 4,
              scale: framesConfig.scale || 1024,
              quality: framesConfig.quality || 3,
              timePoint: framesConfig.timePoint,
            });

            // 抽帧降级回退：VLM/scene 模式帧数 <3 时自动切到 UNIFORM_FPS
            const needsFallback = (strategy === 'VLM_OPTIMIZED' || strategy === 'scene')
              && telemetryResult.files.length < 3;
            if (needsFallback) {
              AppLogger.warn(LOG_TAGS.MEDIA_ENGINE,
                '[Step1] VLM/Scene 帧数过少，自动降级到 UNIFORM_FPS', {
                mediaId, frameCount: telemetryResult.metrics.frameCount
              });
              telemetryResult = await frameService.extractFrames(mediaPath, framesDir, mediaId, {
                strategy: 'UNIFORM_FPS',
                fps: framesConfig.fps || config.frameFps || 2,
                scale: framesConfig.scale || 1024,
                quality: framesConfig.quality || 3,
              });
            }

            validFrames = telemetryResult.files;
            onProgress(20, `关键帧提取完成 (${validFrames.length}帧)`);
            return telemetryResult;
          } catch (e: any) {
            AppLogger.error(LOG_TAGS.MEDIA_ENGINE, '[Step1] 抽帧失败', { mediaId, error: e });
            framesFailed = true;
            return { files: [] };
          }
        })(),

        // 轨道 B：音频分离 + Demucs 人声分离
        (async () => {
          if (!runAudio) return null;

          onProgress(15, '正在分离音频...');
          try {
            hasAudio = await AudioProcessor.separateAudio(mediaPath, rawAudioPath, mediaId);
          } catch (e) {
            AppLogger.warn(LOG_TAGS.MEDIA_ENGINE,
              '[Step1] 无有效音轨，静默运行', { mediaId });
            hasAudio = false;
            audioFailed = true;
          }

          if (hasAudio && fs.existsSync(rawAudioPath)) {
            onProgress(25, '正在分离人声...');
            try {
              const separated = await AudioProcessor.separateVocalsBgm(rawAudioPath, audioDir);
              if (separated && separated.vocals) {
                vocalsPath = separated.vocals;
                bgmPath = separated.bgm;
                vocalsIsFallback = !!separated._isFallback;
                onProgress(30, '人声分离完成');
                return separated;
              }
            } catch (e: any) {
              AppLogger.warn(LOG_TAGS.MEDIA_ENGINE,
                '[Step1] Demucs 不可用，降级到原始音轨', { mediaId });
              audioFailed = true;
            }
          }
          return null;
        })(),
      ]);
    } catch (error: any) {
      AppLogger.error(LOG_TAGS.MEDIA_ENGINE, '[Step1] 双子星并行执行失败', { mediaId, error });
    }

    // === ASR 语音识别 ===
    let whisperResult: any = null;
    const targetAudio = vocalsPath || rawAudioPath;
    if (hasAudio && runWhisper && fs.existsSync(targetAudio)) {
      onProgress(50, '正在进行 ASR 识别...');
      if (vocalsIsFallback) {
        AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, '[Step1] 人声分离降级模式，ASR 使用含 BGM 的原始音轨，识别质量可能下降', { mediaId });
      }
      try {
        const whisperStrategy = new LocalWhisperStrategy();
        const langMap: Record<string, string> = {
          'zh-CN': 'zh', 'en-US': 'en', 'ja-JP': 'ja', 'ko-KR': 'ko'
        };
        const targetLang = langMap[config.targetLanguage] || 'auto';
        const asrEngine = (typeof config.whisper === 'object' ? config.whisper.engine : 'sensevoice') || 'sensevoice';
        whisperResult = await whisperStrategy.transcribe(
          targetAudio, audioDir, mediaId, targetLang, asrEngine
        );
        onProgress(65, 'ASR 识别完成');
      } catch (e: any) {
        AppLogger.warn(LOG_TAGS.MEDIA_ENGINE,
          '[Step1] ASR 失败，降级跳过', { mediaId, error: e.message });
        asrFailed = true;
      }
    }

    // === 人脸检测 ===
    let roles: any[] = [];
    if (runFaces) {
      if (validFrames.length === 0) {
        AppLogger.warn(LOG_TAGS.MEDIA_ENGINE,
          '[Step1] 无有效帧，自动跳过人脸检测');
      } else {
        onProgress(75, '正在检测人脸...');
        try {
          roles = await VisionProcessor.scanFaces(validFrames, facesDir);
          onProgress(85, `人脸检测完成 (${roles.length}个角色)`);
        } catch (e: any) {
          AppLogger.warn(LOG_TAGS.MEDIA_ENGINE,
            '[Step1] 人脸检测失败，降级跳过', { mediaId, error: e.message });
          facesFailed = true;
        }
      }
    }

    // === 解析 Whisper JSON 生成 AsrLine[] ===
    let asrLines: any[] = [];
    if (whisperResult?.whisperJsonPath) {
      try {
        const jsonPath = whisperResult.whisperJsonPath;
        if (fs.existsSync(jsonPath)) {
          const whisperJson = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
          const transcription = whisperJson.transcription || [];

          const toMmSs = (srt: string): string => {
            const match = srt.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
            if (!match) return '00:00';
            const m = parseInt(match[2], 10);
            const s = parseInt(match[3], 10);
            return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
          };

          asrLines = transcription.map((t: any) => {
            const text = (t.text || '').replace(/<\|.*?\|>/g, '').trim();
            return {
              start: toMmSs(t.timestamps?.from || '00:00:00,000'),
              end: toMmSs(t.timestamps?.to || '00:00:00,000'),
              text,
              originalText: text,
              editing: false,
            };
          });

          AppLogger.info(LOG_TAGS.MEDIA_ENGINE,
            `[Step1] Whisper JSON 解析完成，${asrLines.length} 段台词`);
        }
      } catch (e: any) {
        AppLogger.warn(LOG_TAGS.MEDIA_ENGINE,
          '[Step1] 解析 Whisper JSON 失败', { error: e.message });
      }
    }
    const framePaths = validFrames;
    const frameCount = validFrames.length;
    const audioSeparated = !!vocalsPath;

    const results: Record<string, any> = {
      frames: { count: frameCount, paths: framePaths, _failed: framesFailed },
      audio: {
        separated: audioSeparated,
        audioPath: hasAudio ? rawAudioPath : undefined,
        vocalsPath,
        bgmPath,
        _failed: audioFailed,
      },
      asr: {
        lines: asrLines,
        whisperJsonPath: whisperResult?.whisperJsonPath || '',
        _failed: asrFailed,
      },
      faces: { roles, count: roles.length, _failed: facesFailed },
    };

    // 写入 context.bus 供下游策略消费
    context.bus.set('step1-result', results);
    if (validFrames.length > 0) context.bus.set('step1-frames', validFrames);
    if (whisperResult) context.bus.set('asr-result', { ...whisperResult, asrLines });

    // 返回扁平 ExtractionOutput 形状
    const output = { asrLines, framePaths, frameCount, audioSeparated, roles };

    onProgress(100, '素材分析完成');
    AppLogger.info(LOG_TAGS.SCHEDULER,
      `[Step1] 素材分析策略执行完成 (帧:${frameCount}, 音频:${hasAudio ? '是' : '否'}, 人脸:${roles.length})`);

    return output;
  }
}
