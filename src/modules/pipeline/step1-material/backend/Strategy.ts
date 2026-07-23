// Module: pipeline/step1-material - Pipeline Strategy

import { BaseNodeStrategy, ExecutionContext } from '../../../../main/engine/strategies/BaseNodeStrategy';
import { FrameExtractionService } from '@modules/media/frames';
import { PathManager } from '../../../../main/utils/pathManager';
import { AudioProcessor } from '../../../../main/engine/media/AudioProcessor';
import { VisionProcessor } from '../../../../main/engine/media/VisionProcessor';
import { LocalWhisperStrategy } from '../../../../main/engine/strategies/LocalWhisperStrategy';
import { AppLogger } from '../../../../main/core/AppLogger';
import { LOG_TAGS } from '@modules/infra/logger/LogConstants';
import { AppError, ErrorCode } from '@modules/infra/error/AppError';
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
    const separationMode = config.audio?.separationMode || 'quality';
    // 引擎选择：quality 模式下可指定 'demucs' | 'mdx' | 'auto'，默认 'auto'（Python 端 Demucs→MDX 顺序）
    const engine = config.audio?.engine || 'auto';
    const mediaId = input.mediaId || `media_${Date.now()}`;
    const signal = context.signal; // Fix 10: 取消信号，透传给所有异步子操作

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
    let audioPath: string | undefined;
    let vocalsPath: string | undefined;
    let bgmPath: string | undefined;
    let vocalsIsFallback = false;

    // 子步骤失败标记（Repair 2）
    let framesFailed = false;
    let audioFailed = false;
    let asrFailed = false;
    let facesFailed = false;

    // === 双子星并行：抽帧 ∥ 音频分离 ===
    let lastProgress = 0;
    try {
      const [_frameResult, _audioResult] = await Promise.all([
        // 轨道 A：视频抽帧
        (async () => {
          if (!runFrames) return { files: [] };

          lastProgress = Math.max(lastProgress, 5); onProgress(lastProgress, '正在提取关键帧...');
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
              abortSignal: signal,
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
                abortSignal: signal,
              });
            }

            validFrames = telemetryResult.files;
            lastProgress = Math.max(lastProgress, 20); onProgress(lastProgress, `关键帧提取完成 (${validFrames.length}帧)`);
            return telemetryResult;
          } catch (e: any) {
            AppLogger.error(LOG_TAGS.MEDIA_ENGINE, '[Step1] 抽帧失败', { mediaId, error: e });
            framesFailed = true;
            return { files: [] };
          }
        })(),

        // 轨道 B：单流音频提取 + 人声分离（44.1k stereo 提取 → 分离 → vocals 降采样 16k 供 ASR）
        (async () => {
          if (!runAudio) return null;

          // fast 模式跳过分离引擎，只提 16k 供 ASR
          const skipSeparation = separationMode === 'fast';
          if (skipSeparation) {
            AppLogger.info(LOG_TAGS.MEDIA_ENGINE,
              '[Step1] 极速模式：跳过人声分离，使用原始音轨', { mediaId });
          }

          // 子进度回调：将分离引擎的 0-100 pct 映射到管线总进度的 15-30 区间
          const onSubProgress = (pct: number, msg: string) => {
            // pct 0-100 → 管线 15-30
            const mapped = 15 + Math.floor(pct * 0.15);
            lastProgress = Math.max(lastProgress, mapped);
            onProgress(lastProgress, msg || '正在分离人声...');
          };

          const result = await AudioProcessor.extractAndSeparate(
            mediaPath, audioDir, mediaId, signal,
            { skipSeparation, engine, onProgress: onSubProgress }
          );

          if (!result.hasAudio) {
            AppLogger.warn(LOG_TAGS.MEDIA_ENGINE,
              '[Step1] 无有效音轨，静默运行', { mediaId });
            audioFailed = true;
            return null;
          }

          audioPath = result.asrAudioPath;
          vocalsPath = result.vocalsPath;
          bgmPath = result.bgmPath;
          vocalsIsFallback = result.isFallback;

          if (result.isFallback && !skipSeparation) {
            AppLogger.warn(LOG_TAGS.MEDIA_ENGINE,
              '[Step1] 人声分离失败，降级到原始音轨', { mediaId });
            audioFailed = true;
          }

          if (vocalsPath && !result.isFallback) {
            lastProgress = Math.max(lastProgress, 30); onProgress(lastProgress, '人声分离完成');
          } else if (skipSeparation) {
            lastProgress = Math.max(lastProgress, 30); onProgress(lastProgress, '极速模式：跳过人声分离');
          }
          return result;
        })(),
      ]);
    } catch (error: any) {
      AppLogger.error(LOG_TAGS.MEDIA_ENGINE, '[Step1] 双子星并行执行失败', { mediaId, error });
    }

    // === ASR 语音识别 ===
    // targetAudio = extractAndSeparate 返回的 16k mono（分离成功= vocals 降采样版；失败= 原始降采样版；fast= 原始降采样版）
    let whisperResult: any = null;
    const targetAudio = audioPath;
    if (!audioFailed && runWhisper && targetAudio && fs.existsSync(targetAudio)) {
      onProgress(Math.max(lastProgress, 50), '正在进行 ASR 识别...');
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
          targetAudio, audioDir, mediaId, targetLang, asrEngine, signal
        );
        lastProgress = Math.max(lastProgress, 65); onProgress(lastProgress, 'ASR 识别完成');
      } catch (e: any) {
        AppLogger.warn(LOG_TAGS.MEDIA_ENGINE,
          '[Step1] ASR 失败，降级跳过', { mediaId, error: e.message });
        asrFailed = true;
      }
    }
    // 注：中间产物（44.1k 原始 WAV）由 extractAndSeparate 内部清理，此处无需再处理

    // === 人脸检测 ===
    let roles: any[] = [];
    if (runFaces) {
      if (validFrames.length === 0) {
        AppLogger.warn(LOG_TAGS.MEDIA_ENGINE,
          '[Step1] 无有效帧，自动跳过人脸检测');
      } else {
        lastProgress = Math.max(lastProgress, 75); onProgress(lastProgress, '正在检测人脸...');
        try {
          roles = await VisionProcessor.scanFaces(validFrames, facesDir, signal);
          lastProgress = Math.max(lastProgress, 85); onProgress(lastProgress, `人脸检测完成 (${roles.length}个角色)`);
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

          const parseSrt = (srt: string): { ms: number; mmss: string } => {
            const match = srt.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
            if (!match) return { ms: 0, mmss: '00:00' };
            const h = parseInt(match[1], 10);
            const m = parseInt(match[2], 10);
            const s = parseInt(match[3], 10);
            const ms = parseInt(match[4], 10);
            return {
              ms: h * 3600000 + m * 60000 + s * 1000 + ms,
              mmss: `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`,
            };
          };

          asrLines = transcription.map((t: any) => {
            const text = (t.text || '').replace(/<\|.*?\|>/g, '').trim();
            const from = parseSrt(t.timestamps?.from || '00:00:00,000');
            const to = parseSrt(t.timestamps?.to || '00:00:00,000');
            return {
              start: from.mmss,
              startMs: from.ms,
              end: to.mmss,
              endMs: to.ms,
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
        audioPath,
        vocalsPath,
        bgmPath,
        vocalsIsFallback,
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
      `[Step1] 素材分析策略执行完成 (帧:${frameCount}, 音频:${audioPath ? '是' : '否'}, 人脸:${roles.length})`);

    return output;
  }
}
