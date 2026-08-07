// Module: pipeline/step1-material - Pipeline Strategy

import { BaseNodeStrategy } from '../../../../main/engine/strategies/BaseNodeStrategy';
import type { ExecutionContext } from '../../../../main/engine/strategies/BaseNodeStrategy';
import { FrameExtractionService } from '@modules/media/frames';
import { PathManager } from '../../../../main/utils/pathManager';
import { AudioProcessor } from '../../../../main/engine/media/AudioProcessor';
import { VisionProcessor } from '../../../../main/engine/media/VisionProcessor';
import { LocalWhisperStrategy } from '../../../../main/engine/strategies/LocalWhisperStrategy';
import { AppLogger } from '../../../../main/core/AppLogger';
import { LOG_TAGS } from '@modules/infra/logger/LogConstants';
import { AppError, ErrorCode } from '@modules/infra/error/AppError';
import { MediaRepository } from '@modules/media/import/data/MediaRepository';
import { RoleRepository } from '../../../../main/database/repositories/RoleRepository';
import { GlobalCharacterRepository } from '../../../../main/database/repositories/GlobalCharacterRepository';
import * as path from 'path';
import * as fs from 'fs';

/**
 * 清理 magic:// 协议 URL 为本地文件系统绝对路径
 *
 * DB 中可能存储了三种格式的路径：
 * 1. magic://{projectId}/relative/path  → projectDir/relative/path
 * 2. magic://local/F:/absolute/path      → F:\absolute\path（跨盘符）
 * 3. 普通相对路径 nodes/xxx/audio.wav     → projectDir/nodes/xxx/audio.wav
 */
function resolveDbPath(dbValue: string | undefined | null, projectDir: string): string | undefined {
  if (!dbValue) return undefined;
  const val = dbValue.replace(/\\/g, '/');

  // 格式2: magic://local/F:/absolute/path → 直接提取绝对路径
  if (val.startsWith('magic://local/')) {
    const raw = val.replace(/^magic:\/\/local\//, '');
    return raw.replace(/\//g, '\\');
  }

  // 格式1: magic://{projectId}/nodes/... → 提取 relative 部分，拼 projectDir
  const magicMatch = val.match(/^magic:\/\/(?:[^\/]+)\/(.+)/);
  if (magicMatch) {
    return path.join(projectDir, magicMatch[1].replace(/\//g, '\\'));
  }

  // 格式3: 普通相对路径（新代码写入的干净数据）
  if (path.isAbsolute(val)) {
    return val.replace(/\//g, '\\');
  }
  return path.join(projectDir, val.replace(/\//g, '\\'));
}

/**
 * Step1 素材分析管线策略
 * 负责编排4个子步骤：抽帧 → 音频分离 → ASR → 人脸检测
 *
 * 双子星并行调度：抽帧与音频分离同时启动（Promise.all），
 * 之后串行执行 ASR 和人脸检测，每个步骤失败时降级跳过不阻断管线。
 *
 * V1.2: 支持增量执行 - 检测已有产出并跳过对应子步骤
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
    const engine = config.audio?.engine || 'auto';
    const mediaId = input.mediaId || `media_${Date.now()}`;
    const signal = context.signal;
    // 🔧 修复重试：forceRetryStep 表示用户点击了单个子步骤的重试按钮，该子步骤必须强制执行不跳过
    const forceRetryStep: string | null = input.forceRetryStep || config._forceRetry || null;

    if (!mediaPath) {
      AppLogger.warn(LOG_TAGS.SCHEDULER, '[Step1] 未提供媒体文件路径');
      throw new AppError(ErrorCode.FS_FILE_NOT_FOUND, '未找到媒体文件路径');
    }

    const runFrames = config.frames !== false &&
      (typeof config.frames === 'boolean' ? config.frames : (config.frames?.enabled ?? true));
    const runAudio = config.audio !== false &&
      (typeof config.audio === 'boolean' ? config.audio : (config.audio?.enabled ?? true));
    const runFaces = config.faces !== false &&
      (typeof config.faces === 'boolean' ? config.faces : (config.faces?.enabled ?? true));
    const runWhisper = config.whisper !== false &&
      (typeof config.whisper === 'boolean' ? config.whisper : (config.whisper?.enabled ?? true));

    onProgress(0, '素材分析开始...');

    const projectDir = PathManager.getProjectDir(context.projectId);

    const existingMedia = input.existingMedia || null;
    const mediaRepo = new MediaRepository();
    const roleRepo = new RoleRepository();

    let existingFrames: string[] = [];
    let existingAudioPath: string | undefined;
    let existingVocalsPath: string | undefined;
    let existingBgmPath: string | undefined;
    let existingVocalsIsFallback = false;
    let existingAsrLines: any[] = [];
    let existingRoles: any[] = [];

    // 🔧 修复重试：初始化跳过标志
    // - forceRetryStep 指定的子步骤：强制重新执行，不跳过
    // - 其他子步骤：默认不跳过（后续检查已有数据时再决定是否跳过）
    let skipFrames = false;
    let skipAudio = false;
    let skipAsr = false;
    let skipFaces = false;

    const dbMedia = existingMedia || (mediaId ? mediaRepo.findById(mediaId) : null);
    if (dbMedia && !forceRetryStep) {
      AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[Step1] 检测到已有媒体数据，开始检查可跳过的子步骤`, { mediaId });

      if (Array.isArray(dbMedia.frames) && dbMedia.frames.length > 0) {
        const absoluteFrames = dbMedia.frames
          .map((f: string) => resolveDbPath(f, projectDir))
          .filter((f: string | undefined): f is string => !!f && fs.existsSync(f));
        if (absoluteFrames.length > 0) {
          existingFrames = absoluteFrames;
          skipFrames = true;
          AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[Step1] 🟢 检测到已有帧数据 (${absoluteFrames.length}帧)，跳过抽帧`, { mediaId });
        }
      }

      const vocalsAbs = dbMedia.extractedVocals ? resolveDbPath(dbMedia.extractedVocals, projectDir) : undefined;
      const bgmAbs = dbMedia.extractedBgm ? resolveDbPath(dbMedia.extractedBgm, projectDir) : undefined;
      const audioAbs = dbMedia.extractedAudio ? resolveDbPath(dbMedia.extractedAudio, projectDir) : undefined;
      const audioExists = !!(audioAbs && fs.existsSync(audioAbs));
      if (vocalsAbs && fs.existsSync(vocalsAbs) && bgmAbs && fs.existsSync(bgmAbs)) {
        existingVocalsPath = vocalsAbs;
        existingBgmPath = bgmAbs;
        // 🔧 修复：ASR 只用原始音频降采样（extractedAudio），不复用分离后 vocals
        // 原因：Demucs 分离损失高频细节，导致 faster-whisper 误识别（如 "I'm"→"Mom"）
        // vocals/bgm 仍复用分离产物供 BGM 提取、TTS 等其他用途
        existingAudioPath = audioExists ? audioAbs : undefined;
        existingVocalsIsFallback = !!dbMedia.vocalsIsFallback;
        // 仅当 16k ASR 音频存在时才跳过音频处理；否则需重新生成
        skipAudio = !!existingAudioPath;
        AppLogger.info(LOG_TAGS.MEDIA_ENGINE,
          `[Step1] 🟢 检测到已有音频分离产物，跳过音频分离${existingAudioPath ? '（ASR用原始音轨降采样）' : '（需重新生成 ASR 音频）'}`,
          { mediaId });
      } else if (separationMode === 'fast' && audioExists) {
        existingAudioPath = audioAbs;
        existingVocalsIsFallback = true;
        skipAudio = true;
        AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[Step1] 🟢 极速模式：检测到已有音频，跳过提取`, { mediaId });
      }

      if (dbMedia.extractedText) {
        try {
          const parsed = JSON.parse(dbMedia.extractedText);
          if (Array.isArray(parsed) && parsed.length > 0) {
            existingAsrLines = parsed.map((s: any) => {
              let startSec: number;
              let endSec: number;
              let startMs: number;
              let endMs: number;
              let startMmss: string;
              let endMmss: string;

              if (typeof s.start === 'string' && s.start.includes(':')) {
                const parts = s.start.split(':');
                startSec = (parseInt(parts[0], 10) || 0) * 60 + (parseInt(parts[1], 10) || 0);
                startMs = startSec * 1000;
                startMmss = s.start;
              } else {
                startSec = typeof s.start === 'number' ? s.start : (s.startMs ? s.startMs / 1000 : 0);
                startMs = s.startMs || startSec * 1000;
                const m = Math.floor(startSec / 60);
                const sec = Math.floor(startSec % 60);
                startMmss = `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
              }

              if (typeof s.end === 'string' && s.end.includes(':')) {
                const parts = s.end.split(':');
                endSec = (parseInt(parts[0], 10) || 0) * 60 + (parseInt(parts[1], 10) || 0);
                endMs = endSec * 1000;
                endMmss = s.end;
              } else {
                endSec = typeof s.end === 'number' ? s.end : (s.endMs ? s.endMs / 1000 : 0);
                endMs = s.endMs || endSec * 1000;
                const m = Math.floor(endSec / 60);
                const sec = Math.floor(endSec % 60);
                endMmss = `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
              }

              return {
                start: startMmss,
                startMs,
                end: endMmss,
                endMs,
                text: s.text || '',
                originalText: s.text || s.originalText || '',
                editing: false,
              };
            });
            skipAsr = true;
            AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[Step1] 🟢 检测到已有ASR结果 (${existingAsrLines.length}段)，跳过语音识别`, { mediaId });
          }
        } catch (e) {
          AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, `[Step1] 解析已有ASR结果失败，将重新识别`, { mediaId });
        }
      }

      try {
        const dbRoles = roleRepo.findByProjectId(context.projectId);
        if (dbRoles.length > 0) {
          existingRoles = dbRoles.map((r: any) => {
            const avatarAbs = r.avatar ? resolveDbPath(r.avatar, projectDir) : null;
            return {
              id: r.id,
              name: r.name,
              faceCount: 0,
              representative: avatarAbs ? { facePath: avatarAbs } : null,
              faces: [],
              avatar: r.avatar,
              avatarPath: avatarAbs,
              pronoun: r.pronoun,
              description: r.description,
              voiceId: r.voice_id,
              /** 🎭 P1.5 角色主次分级：从 DB tier 列恢复标注 */
              tier: r.tier || undefined,
              mergedRoles: r.merged_roles ? JSON.parse(r.merged_roles) : [],
            };
          });
          /** 💥 修复：skipFaces 应判断 existingRoles.length > 0（有角色才跳过），而非 existingFrames.length > 0
           * 旧版 bug：用 existingFrames 判断 → 只要有帧就跳过人脸检测 → 重试 faces 永远被跳过
           * 修复：只有 DB 中已有角色数据时才跳过，否则即使有帧也重新检测 */
          skipFaces = existingRoles.length > 0;
          if (skipFaces) {
            AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[Step1] 🟢 检测到已有角色数据 (${existingRoles.length}个)，跳过人脸检测`, { mediaId });
          }
        }
      } catch (e) {
        AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, `[Step1] 查询已有角色失败，将重新检测`, { mediaId });
      }
    } else if (forceRetryStep) {
      // 🔧 强制重试单个子步骤时，其他子步骤尝试从 DB 加载已有结果（即使被禁用也加载已有数据）
      AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[Step1] 🔄 强制重试子步骤: ${forceRetryStep}，将加载其他子步骤的已有结果`, { mediaId });

      // 🔧 加载已有帧数据
      if (forceRetryStep !== 'frames' && dbMedia) {
        if (Array.isArray(dbMedia.frames) && dbMedia.frames.length > 0) {
          const absoluteFrames = dbMedia.frames
            .map((f: string) => resolveDbPath(f, projectDir))
            .filter((f: string | undefined): f is string => !!f && fs.existsSync(f));
          AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[Step1] [诊断] 帧路径加载: DB中${dbMedia.frames.length}个, 文件存在${absoluteFrames.length}个`, {
            mediaId,
            sampleDbPath: dbMedia.frames[0],
            sampleAbsPath: absoluteFrames[0],
            projectDir,
          });
          if (absoluteFrames.length > 0) {
            existingFrames = absoluteFrames;
            skipFrames = true; // 🔧 修复：加载成功后标记为跳过，不重复抽帧
          }
        }
      }

      // 🔧 加载已有音频数据（修复：只要有任何可用音频就加载，不需要vocals+bgm同时存在）
      if (forceRetryStep !== 'audio' && dbMedia) {
        const vocalsAbs = dbMedia.extractedVocals ? resolveDbPath(dbMedia.extractedVocals, projectDir) : undefined;
        const bgmAbs = dbMedia.extractedBgm ? resolveDbPath(dbMedia.extractedBgm, projectDir) : undefined;
        const audioAbs = dbMedia.extractedAudio ? resolveDbPath(dbMedia.extractedAudio, projectDir) : undefined;

        const vocalsExists = vocalsAbs && fs.existsSync(vocalsAbs);
        const bgmExists = bgmAbs && fs.existsSync(bgmAbs);
        const audioExists = audioAbs && fs.existsSync(audioAbs);

        AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[Step1] [诊断] 音频路径加载`, {
          mediaId,
          vocalsAbs: vocalsAbs ? { path: vocalsAbs, exists: vocalsExists } : null,
          bgmAbs: bgmAbs ? { path: bgmAbs, exists: bgmExists } : null,
          audioAbs: audioAbs ? { path: audioAbs, exists: audioExists } : null,
          projectDir,
        });

        // 🔧 修复：ASR 只用原始音频降采样（extractedAudio），不使用分离后 vocals
        // 原因：Demucs 分离损失高频细节，导致 faster-whisper 误识别（如 "I'm"→"Mom"）
        // vocals/bgm 仅复用分离产物供其他用途（BGM 提取、TTS 等），不作为 ASR 音频源
        if (vocalsExists) {
          existingVocalsPath = vocalsAbs;
          existingBgmPath = bgmExists ? bgmAbs : undefined;
          existingVocalsIsFallback = false;
          // 仅当 16k ASR 音频存在时才跳过音频处理；否则需重新跑 extractAndSeparate 生成
          existingAudioPath = audioExists ? audioAbs : undefined;
          skipAudio = !!existingAudioPath;
          AppLogger.info(LOG_TAGS.MEDIA_ENGINE,
            `[Step1] 🟢 检测到已有人声分离产物，跳过音频分离${existingAudioPath ? '（ASR用原始音轨降采样）' : '（需重新生成 ASR 音频）'}`,
            { mediaId });
        } else if (audioExists) {
          // 回退到原始音轨（极速模式或分离失败后的降级）
          existingAudioPath = audioAbs;
          existingVocalsIsFallback = true;
          skipAudio = true; // 🔧 修复：加载成功后标记为跳过
          AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[Step1] 🟢 检测到已有音频，跳过音频分离（ASR将使用原始音轨）`, { mediaId });
        } else {
          AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, `[Step1] ⚠️ 未找到可用音频文件，ASR可能无法执行`, { mediaId });
        }
      }

      // 🔧 加载已有ASR结果（重试whisper时不加载，需要重新识别）
      if (forceRetryStep !== 'whisper' && dbMedia?.extractedText) {
        try {
          const parsed = JSON.parse(dbMedia.extractedText);
          if (Array.isArray(parsed) && parsed.length > 0) {
            existingAsrLines = parsed.map((s: any) => ({
              start: typeof s.start === 'string' ? s.start : '00:00',
              startMs: s.startMs || 0,
              end: typeof s.end === 'string' ? s.end : '00:00',
              endMs: s.endMs || 0,
              text: s.text || '',
              originalText: s.originalText || s.text || '',
              editing: false,
            }));
            skipAsr = true; // 🔧 修复：加载成功后标记为跳过
          }
        } catch {}
      }

      // 🔧 加载已有角色数据
      if (forceRetryStep !== 'faces') {
        try {
          const dbRoles = roleRepo.findByProjectId(context.projectId);
          if (dbRoles.length > 0) {
            existingRoles = dbRoles.map((r: any) => {
              const avatarAbs = r.avatar ? resolveDbPath(r.avatar, projectDir) : null;
              return {
                id: r.id, name: r.name, faceCount: 0,
                representative: avatarAbs ? { facePath: avatarAbs } : null,
                faces: [], avatar: r.avatar, avatarPath: avatarAbs,
                pronoun: r.pronoun, description: r.description, voiceId: r.voice_id,
                /** 🎭 P1.5 角色主次分级：从 DB tier 列恢复标注 */
                tier: r.tier || undefined,
                mergedRoles: r.merged_roles ? JSON.parse(r.merged_roles) : [],
              };
            });
            /** 💥 修复：skipFaces 应判断 existingRoles.length > 0，而非 existingFrames.length > 0
             * 旧版 bug：用 existingFrames 判断 → 有帧就跳过 → 非 faces 重试时人脸永远不更新 */
            skipFaces = existingRoles.length > 0;
            if (skipFaces) {
              AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[Step1] 🟢 检测到已有角色数据 (${existingRoles.length}个)，跳过人脸检测`, { mediaId });
            }
          }
        } catch {}
      }
    }

    // 🔧 修复：重试单个子步骤时，自动检查并修复依赖
    // 如果重试的子步骤依赖的前置产物不存在（文件丢失或之前因MODULE_NOT_FOUND等bug未写入），
    // 则自动启用前置子步骤，确保依赖链路完整
    if (forceRetryStep) {
      // ASR(whisper) 依赖音频：如果音频文件不存在，强制启用音频分离
      if (forceRetryStep === 'whisper' && !existingAudioPath) {
        AppLogger.warn(LOG_TAGS.MEDIA_ENGINE,
          `[Step1] ⚠️ 重试ASR但音频文件不存在，将自动先执行音频分离`, { mediaId });
        skipAudio = false;
        // 注意：不能直接改runAudio（它是const），需要通过其他方式让音频执行
        // 我们在下面needRunAudio判断中处理这个情况
      }
      // 人脸检测依赖关键帧：如果帧不存在，强制启用抽帧
      if (forceRetryStep === 'faces' && existingFrames.length === 0) {
        AppLogger.warn(LOG_TAGS.MEDIA_ENGINE,
          `[Step1] ⚠️ 重试人脸检测但关键帧不存在，将自动先执行抽帧`, { mediaId });
        skipFrames = false;
      }
    }

    const framesDir = path.join(cacheDir, 'frames');
    const audioDir = path.join(cacheDir, 'audio');
    const facesDir = path.join(cacheDir, 'faces');
    if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir, { recursive: true });
    if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });
    if (!fs.existsSync(facesDir)) fs.mkdirSync(facesDir, { recursive: true });

    let validFrames: string[] = skipFrames ? [...existingFrames] : (forceRetryStep && forceRetryStep !== 'frames' ? [...existingFrames] : []);
    let audioPath: string | undefined = existingAudioPath;
    let vocalsPath: string | undefined = existingVocalsPath;
    let bgmPath: string | undefined = existingBgmPath;
    let vocalsIsFallback = existingVocalsIsFallback;
    let asrLines: any[] = skipAsr ? [...existingAsrLines] : (forceRetryStep && forceRetryStep !== 'whisper' ? [...existingAsrLines] : []);
    let roles: any[] = skipFaces ? [...existingRoles] : (forceRetryStep && forceRetryStep !== 'faces' ? [...existingRoles] : []);

    let whisperResult: any = skipAsr ? { _skipped: true, whisperJsonPath: '' } : (forceRetryStep && forceRetryStep !== 'whisper' ? { _skipped: true, whisperJsonPath: '' } : null);

    let framesFailed = false;
    let audioFailed = false;
    let asrFailed = false;
    let facesFailed = false;

    let lastProgress = 0;

    if (skipFrames) {
      lastProgress = Math.max(lastProgress, 20);
      onProgress(lastProgress, `关键帧已存在 (${validFrames.length}帧)，跳过抽帧`);
    }
    if (skipAudio) {
      lastProgress = Math.max(lastProgress, 30);
      onProgress(lastProgress, vocalsIsFallback ? '极速模式：音频已存在，跳过分离' : '音频分离产物已存在，跳过分离');
    }
    if (skipAsr) {
      lastProgress = Math.max(lastProgress, 65);
      onProgress(lastProgress, `ASR结果已存在 (${asrLines.length}段)，跳过识别`);
    }
    if (skipFaces) {
      lastProgress = Math.max(lastProgress, 85);
      onProgress(lastProgress, `角色数据已存在 (${roles.length}个)，跳过人脸检测`);
    }

    // 🔧 修复：forceRetryStep模式下，如果依赖产物不存在，即使config中该子步骤被禁用也要自动执行
    // 例如：重试ASR但音频文件丢失 → 自动先做音频分离；重试人脸但帧不存在 → 自动先抽帧
    const forceRunFrames = forceRetryStep === 'faces' && existingFrames.length === 0;
    const forceRunAudio = forceRetryStep === 'whisper' && !existingAudioPath;
    const needRunFrames = (runFrames || forceRunFrames) && !skipFrames;
    const needRunAudio = (runAudio || forceRunAudio) && !skipAudio;

    const tasks: Promise<any>[] = [];

    if (needRunFrames) {
      tasks.push((async () => {
        lastProgress = Math.max(lastProgress, 5);
        onProgress(lastProgress, '正在提取关键帧...');
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
            sceneThreshold: framesConfig.sceneThreshold || 0.25,
            minFrameInterval: framesConfig.minFrameInterval || 3.5,
            scale: framesConfig.scale || 1024,
            quality: framesConfig.quality || 3,
            timePoint: framesConfig.timePoint,
            abortSignal: signal,
            // 🎭 追加式后处理：清晰度/黑屏过滤 + 静态去重 + timeMs 元数据
            postProcess: true,
          });

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
              postProcess: true,
            });
          }

          validFrames = telemetryResult.files;
          lastProgress = Math.max(lastProgress, 20);
          onProgress(lastProgress, `关键帧提取完成 (${validFrames.length}帧)`);
          return telemetryResult;
        } catch (e: any) {
          AppLogger.error(LOG_TAGS.MEDIA_ENGINE, '[Step1] 抽帧失败', { mediaId, error: e });
          framesFailed = true;
          return { files: [] };
        }
      })());
    }

    if (needRunAudio) {
      tasks.push((async () => {
        const skipSeparation = separationMode === 'fast';
        if (skipSeparation) {
          AppLogger.info(LOG_TAGS.MEDIA_ENGINE,
            '[Step1] 极速模式：跳过人声分离，使用原始音轨', { mediaId });
        }

        const onSubProgress = (pct: number, msg: string) => {
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
            '[Step1] 人声分离失败，降级到原始音轨（ASR 仍将执行）', { mediaId });
        }

        if (vocalsPath && !result.isFallback) {
          lastProgress = Math.max(lastProgress, 30);
          onProgress(lastProgress, '人声分离完成');
        } else if (skipSeparation) {
          lastProgress = Math.max(lastProgress, 30);
          onProgress(lastProgress, '极速模式：跳过人声分离');
        }
        return result;
      })());
    }

    if (tasks.length > 0) {
      try {
        await Promise.all(tasks);
      } catch (error: any) {
        AppLogger.error(LOG_TAGS.MEDIA_ENGINE, '[Step1] 双子星并行执行失败', { mediaId, error });
      }
    }

    const targetAudio = audioPath;
    if (!skipAsr && !audioFailed && runWhisper && targetAudio && fs.existsSync(targetAudio)) {
      onProgress(Math.max(lastProgress, 50), '正在进行 ASR 识别...');
      if (vocalsIsFallback) {
        AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, '[Step1] 人声分离降级模式，ASR 使用含 BGM 的原始音轨，识别质量可能下降', { mediaId });
      }
      try {
        const whisperStrategy = new LocalWhisperStrategy();
        const whisperCfg = typeof config.whisper === 'object' ? config.whisper : { enabled: true, engine: 'auto' as const };
        const asrLang = whisperCfg.language || 'auto';
        const CJK_LANGS = ['zh', 'ja', 'ko', 'yue'];
        // 🔧 修复：language='auto' 时强制 engine='auto'，让 Python 端根据 faster-whisper 检测结果自动选择引擎
        // 旧版 bug：前端默认 engine='sensevoice' 是 truthy → 走第一分支 → 英文视频被 SenseVoice 识别导致字幕不一致
        // 且 zustand persist 持久化了旧默认值，仅改默认值对老数据无效，故此处强制覆盖
        let asrEngine: 'sensevoice' | 'faster-whisper' | 'auto';
        if (asrLang === 'auto') {
          asrEngine = 'auto';
        } else if (whisperCfg.engine && whisperCfg.engine !== 'auto') {
          asrEngine = whisperCfg.engine;
        } else if (CJK_LANGS.includes(asrLang)) {
          asrEngine = 'sensevoice';
        } else {
          asrEngine = 'faster-whisper';
        }
        const asrOnProgress = (pct: number, msg: string) => {
          const mapped = 45 + Math.round(pct * 0.2);
          onProgress(Math.max(lastProgress, mapped), msg || 'ASR 识别中');
        };
        whisperResult = await whisperStrategy.transcribe(
          targetAudio, audioDir, mediaId, asrLang, asrEngine, signal, asrOnProgress
        );
        lastProgress = Math.max(lastProgress, 65);
        onProgress(lastProgress, 'ASR 识别完成');
      } catch (e: any) {
        AppLogger.warn(LOG_TAGS.MEDIA_ENGINE,
          '[Step1] ASR 失败，降级跳过', { mediaId, error: e.message });
        asrFailed = true;
      }
    }

    if (!skipFaces && runFaces) {
      if (validFrames.length === 0) {
        AppLogger.warn(LOG_TAGS.MEDIA_ENGINE,
          '[Step1] 无有效帧，自动跳过人脸检测');
      } else {
        // 重试人脸检测时清理旧的人脸图片，避免旧数据干扰聚类结果
        if (forceRetryStep === 'faces' && fs.existsSync(facesDir)) {
          try {
            const oldFiles = fs.readdirSync(facesDir).filter(f => f.endsWith('.jpg') || f.endsWith('.json'));
            for (const f of oldFiles) {
              fs.unlinkSync(path.join(facesDir, f));
            }
            AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[Step1] 重试人脸检测：已清理 ${oldFiles.length} 个旧文件`, { mediaId });
          } catch (e: any) {
            AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, `[Step1] 清理旧人脸文件失败（非致命）: ${e.message}`);
          }
        }
        lastProgress = Math.max(lastProgress, 72);
        onProgress(lastProgress, '正在为人脸识别单独抽帧...');

        /** 💥 关键修复：为人脸识别单独抽帧（不复用 VLM 场景切换帧）
         * 旧版 bug：复用 VLM_OPTIMIZED 抽的帧（场景切换 + 4秒最小间隔），
         *   抽帧数量少且按场景切换抽取，远景/侧脸/快速镜头中的人物漏检，
         *   某些角色从未在抽出的帧中正面清晰出现 → 只识别2个角色。
         * 修复：用 UNIFORM_FPS 模式独立抽帧（每秒1帧），保证视频中
         *   所有出现的人物都有机会被检测到。抽完后均匀采样至最多120帧，
         *   避免长视频耗时过长。失败时回退到 VLM 帧。 */
        let faceFrames: string[] = [...validFrames];
        try {
          const faceFramesDir = path.join(facesDir, 'face_frames');
          if (!fs.existsSync(faceFramesDir)) fs.mkdirSync(faceFramesDir, { recursive: true });
          const frameService = new FrameExtractionService({
            getFfmpegPath: () => PathManager.getBinPath('ffmpeg.exe'),
            getFfprobePath: () => PathManager.getBinPath('ffprobe.exe'),
          });
          const faceFramesResult = await frameService.extractFrames(mediaPath, faceFramesDir, mediaId, {
            strategy: 'UNIFORM_FPS',
            fps: 1,
            scale: 1280,
            quality: 3,
            abortSignal: signal,
          });
          if (faceFramesResult.files.length > 0) {
            const MAX_FACE_FRAMES = 120;
            const allFrames = faceFramesResult.files;
            faceFrames = allFrames.length > MAX_FACE_FRAMES
              ? allFrames
                  .filter((_, idx) => Math.floor(idx * MAX_FACE_FRAMES / allFrames.length) !== Math.floor((idx + 1) * MAX_FACE_FRAMES / allFrames.length))
              : allFrames;
            AppLogger.info(LOG_TAGS.MEDIA_ENGINE,
              `[Step1] 人脸识别专用抽帧完成: ${allFrames.length} 帧 → 采样 ${faceFrames.length} 帧 (UNIFORM_FPS@1fps)`, { mediaId });
          } else {
            AppLogger.warn(LOG_TAGS.MEDIA_ENGINE,
              `[Step1] 人脸识别专用抽帧失败，回退到 VLM 帧 (${validFrames.length}帧)`, { mediaId });
          }
        } catch (e: any) {
          AppLogger.warn(LOG_TAGS.MEDIA_ENGINE,
            `[Step1] 人脸识别专用抽帧异常，回退到 VLM 帧: ${e.message}`, { mediaId });
        }

        lastProgress = Math.max(lastProgress, 75);
        onProgress(lastProgress, `正在检测人脸 (${faceFrames.length}帧)...`);
        try {
          const detectedFaces = await VisionProcessor.scanFaces(faceFrames, facesDir, signal);
          if (detectedFaces.length > 0) {
            lastProgress = Math.max(lastProgress, 80);
            onProgress(lastProgress, `人脸检测完成 (${detectedFaces.length}张)，正在聚类...`);
            const clustersMap = await VisionProcessor.clusterFaces(
              mediaId,
              detectedFaces,
              facesDir,
              // 🎭 P0.5+ 透传余弦相似度阈值（未配置时 Python 端使用默认 0.70）
              typeof config.faces === 'object' && config.faces
                ? (config.faces as any).cosineThreshold
                : undefined,
            );
            const roleGroups: Record<string, any[]> = {};
            for (const face of detectedFaces) {
              const faceId = face.id || face.face_id || '';
              const clusterId = clustersMap[faceId] || 'role_unknown';
              if (!roleGroups[clusterId]) roleGroups[clusterId] = [];
              roleGroups[clusterId].push(face);
            }
            /** 💥 修复：过滤 role_unknown（HDBSCAN 噪声点 label=-1）
             * 噪声点是无法归类的低质量人脸检测（模糊/侧脸/远距离），
             * 作为独立角色展示无意义，反而干扰用户识别真实角色。
             * 只有当 unknown 是唯一结果时才保留（避免完全无角色）。 */
            const noUnknownEntries = Object.entries(roleGroups).filter(([clusterId]) => {
              if (clusterId === 'role_unknown' && Object.keys(roleGroups).length > 1) {
                AppLogger.info(LOG_TAGS.MEDIA_ENGINE,
                  `[Step1] 过滤 role_unknown 噪声点 (${roleGroups[clusterId].length}张人脸)，保留 ${Object.keys(roleGroups).length - 1} 个有效角色`,
                  { mediaId });
                return false;
              }
              return true;
            });

            /** 🎭 P1.5 角色主次分级：为主角/配角/路人标注 tier
             * 痛点：低频路人簇（一闪而过的群演）若直接丢弃则完全不可见，若被当独立角色又淹没主角。
             * 分级规则（tier）：
             *   - 'main'      主要角色：出现频次 >= minRoleFaces（缺省 3）的簇；
             *   - 'supporting'配角：出现频次 >= 2 的簇（比路人多，但不够主角）；
             *   - 'extra'     背景路人：只出现 1 次的簇，前端折叠进"背景路人"组，不喧宾夺主。
             * 兜底保底：若没有任何簇达到 main 阈值，则保留频次最高的簇并升为 main（避免完全无主角）。
             * @note minRoleFaces 可经 config.faces.minRoleFaces 配置，缺省 3（对应"出现>=3次"）。 */
            const minRoleFaces = (
              typeof config.faces === 'object' && config.faces
              && (config.faces as any).minRoleFaces !== undefined
            ) ? (config.faces as any).minRoleFaces : 3;
            const baseEntries = noUnknownEntries.length > 0 ? noUnknownEntries : Object.entries(roleGroups);
            const maxFaces = baseEntries.reduce((m, [, g]) => Math.max(m, g.length), 0);
            const hasMain = baseEntries.some(([, g]) => g.length >= minRoleFaces);
            /** 计算单个簇的主次分级（main / supporting / extra） */
            const tierOf = ([, groupFaces]: [string, any[]]): 'main' | 'supporting' | 'extra' => {
              if (groupFaces.length >= minRoleFaces) return 'main';          // 主角色
              if (groupFaces.length === maxFaces && maxFaces > 0 && !hasMain) return 'main'; // 兜底：无 main 时最高频簇升为 main
              if (groupFaces.length >= 2) return 'supporting';               // 配角
              return 'extra';                                                // 背景路人
            };
            /** 💥 关键修复：角色 ID 全局唯一化
             * 旧版 bug：clusterId 是 "role_0"/"role_1"/"role_unknown"，跨项目会重复
             *   → roles 表 id 是 PRIMARY KEY（全局唯一），第二个项目插入时 UNIQUE constraint failed
             * 修复：id 前缀加上 mediaId，确保跨项目、跨媒体全局唯一 */
            roles = baseEntries.map(([clusterId, groupFaces]) => {
              /** 💥 修复黑头像：统一提取 facePath（Python 返回 face_path 绝对路径）
               * 同时设置 representative.facePath 和顶层 avatarPath，
               * 确保三条下游路径（SSE 实时结果/线性向导/DB 重读）都能拿到头像路径 */
              const facePath = groupFaces[0].face_path || groupFaces[0].facePath || '';
              const tier = tierOf([clusterId, groupFaces]);
              if (tier === 'extra') {
                AppLogger.info(LOG_TAGS.MEDIA_ENGINE,
                  `[Step1] 标注路人簇 ${clusterId}（${groupFaces.length}张 < ${minRoleFaces}），折叠进背景路人组`,
                  { mediaId });
              }
              return {
                id: `${mediaId}_${clusterId}`,
                name: `角色_${clusterId.replace('role_', '')}`,
                /** 🎭 角色主次分级：main 主角 / supporting 配角 / extra 背景路人 */
                tier,
                faceCount: groupFaces.length,
                /** representative.facePath 供 PipelineResultWriter 读取并存入 DB avatar 字段 */
                representative: {
                  ...groupFaces[0],
                  facePath,
                },
                /** avatarPath 供前端 View.tsx 直接读取显示头像（getSafeMediaUrl 可处理绝对路径） */
                avatarPath: facePath,
                faces: groupFaces,
              };
            });
            AppLogger.info(LOG_TAGS.MEDIA_ENGINE,
              `[Step1] 人脸聚类完成: ${roles.length} 个角色 (${detectedFaces.length} 张人脸)`, { mediaId });

            /** 🎭 P1 全局人物注册中心：聚类后自动匹配全局人物
             * 对每个本地角色计算代表 embedding（聚类中心 = 成员 embedding 平均后归一化），
             * 与全局人物库比对：命中则绑定 + absorbEmbedding，未命中则新建全局人物。
             * 异常不阻断主流程（降级为不绑定全局人物）。 */
            try {
              const globalCharRepo = new GlobalCharacterRepository();
              let matchCount = 0;
              let createCount = 0;
              for (const role of roles) {
                const groupFaces = (role as any).faces as any[];
                if (!groupFaces || groupFaces.length === 0) continue;
                // 收集有效 embedding
                const embeddings: number[][] = groupFaces
                  .map((f: any) => f.embedding)
                  .filter((e: any): e is number[] => Array.isArray(e) && e.length > 0);
                if (embeddings.length === 0) continue;

                // 计算聚类中心（成员 embedding 平均后归一化）
                const dim = embeddings[0].length;
                const center: number[] = new Array(dim).fill(0);
                for (const e of embeddings) {
                  for (let i = 0; i < dim; i++) center[i] += e[i];
                }
                const norm = Math.sqrt(center.reduce((s, v) => s + v * v, 0));
                const normalizedCenter = norm > 0 ? center.map((v) => v / norm) : center;

                // 匹配或创建全局人物
                const matchResult = globalCharRepo.matchOrCreate(
                  normalizedCenter,
                  (role as any).name,
                  (role as any).avatarPath || (role as any).representative?.facePath,
                  context.projectId,
                );
                (role as any).globalCharacterId = matchResult.character?.id;

                if (matchResult.created) {
                  createCount++;
                } else if (matchResult.character) {
                  // 命中现有人物：吸收新样本（更新中心向量 + 累加出现次数 + 追加项目 ID）
                  globalCharRepo.absorbEmbedding(matchResult.character.id, normalizedCenter, context.projectId);
                  matchCount++;
                  // 如果全局人物有 voiceId 而本地角色没有，回填 voiceId
                  if (matchResult.character.voiceId && !(role as any).voiceId) {
                    (role as any).voiceId = matchResult.character.voiceId;
                  }
                }
              }
              AppLogger.info(LOG_TAGS.MEDIA_ENGINE,
                `[Step1] 全局人物匹配完成: 新建 ${createCount} 个，绑定现有 ${matchCount} 个`, { mediaId, projectId: context.projectId });
            } catch (e: any) {
              AppLogger.warn(LOG_TAGS.MEDIA_ENGINE,
                `[Step1] 全局人物匹配失败，降级为不绑定: ${e.message}`, { mediaId });
            }
          } else {
            AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, '[Step1] 人脸检测未返回结果', { mediaId });
          }
          lastProgress = Math.max(lastProgress, 85);
          onProgress(lastProgress, `人脸识别完成 (${roles.length}个角色)`);
        } catch (e: any) {
          AppLogger.warn(LOG_TAGS.MEDIA_ENGINE,
            '[Step1] 人脸检测失败，降级跳过', { mediaId, error: e.message });
          facesFailed = true;
        }
      }
    }

    if (whisperResult?.whisperJsonPath && !skipAsr) {
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

    // 🔧 修复：_skipped 标志需要同时考虑两种跳过情况：
    // 1. skipXxx = true：增量执行时已有数据跳过
    // 2. runXxx = false：配置中禁用了该子步骤（重试单个子步骤时其他子步骤被禁用）
    const results: Record<string, any> = {
      frames: { count: frameCount, paths: framePaths, _failed: framesFailed, _skipped: skipFrames || !runFrames },
      audio: {
        separated: audioSeparated,
        audioPath,
        vocalsPath,
        bgmPath,
        vocalsIsFallback,
        _failed: audioFailed,
        _skipped: skipAudio || !runAudio,
      },
      asr: {
        lines: asrLines,
        whisperJsonPath: whisperResult?.whisperJsonPath || '',
        _failed: asrFailed,
        _skipped: skipAsr || !runWhisper,
      },
      faces: { roles, count: roles.length, _failed: facesFailed, _skipped: skipFaces || !runFaces },
    };

    context.bus.set('step1-result', results);
    if (validFrames.length > 0) context.bus.set('step1-frames', validFrames);
    if (whisperResult) context.bus.set('asr-result', { ...whisperResult, asrLines });

    const output = { asrLines, framePaths, frameCount, audioSeparated, roles };

    onProgress(100, '素材分析完成');
    AppLogger.info(LOG_TAGS.SCHEDULER,
      `[Step1] 素材分析策略执行完成 (帧:${frameCount}, 音频:${audioPath ? '是' : '否'}, 人脸:${roles.length})`);

    return output;
  }
}
