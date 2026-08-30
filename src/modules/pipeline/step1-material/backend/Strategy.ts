// Module: pipeline/step1-material - Pipeline Strategy

import { BaseNodeStrategy } from '../../../../main/engine/strategies/BaseNodeStrategy';
import type { ExecutionContext, SubStepProgressMeta } from '../../../../main/engine/strategies/BaseNodeStrategy';
import { FrameExtractionService, FACE_FRAME_LONG_EDGE } from '@modules/media/frames';
import { PathManager } from '../../../../main/utils/pathManager';
import { AudioProcessor } from '../../../../main/engine/media/AudioProcessor';
import { VisionProcessor } from '../../../../main/engine/media/VisionProcessor';
import { LocalWhisperStrategy } from '../../../../main/engine/strategies/LocalWhisperStrategy';
import { TrimmedSourceResolver } from '../../../../main/engine/utils/TrimmedSourceResolver';
import { resolveForMedia, toMediaWindow, buildTrimFingerprint } from '../../../../main/engine/utils/MediaTrimPolicy';
import { AppLogger } from '../../../../main/core/AppLogger';
import { LOG_TAGS } from '@modules/infra/logger/LogConstants';
import { AppError, ErrorCode } from '@modules/infra/error/AppError';
import { MediaRepository } from '@modules/media/import/data/MediaRepository';
import { RoleRepository } from '../../../../main/database/repositories/RoleRepository';
import { GlobalCharacterRepository } from '../../../../main/database/repositories/GlobalCharacterRepository';
import * as path from 'path';
import * as fs from 'fs';

/**
 * 🎭 解析命中全局人物后的本地角色名
 * 人物库打通：当本地角色命中已有全局人物时，把人物库里的权威真名（matchedName）回填给本地。
 * 仅当本地是自动命名（"角色_N"）时才回填，避免覆盖用户在当前项目已手动命名的称呼。
 * @param localName 本地角色当前名称（可能为 undefined）
 * @param matchedName 命中全局人物的权威名（可能为空）
 * @returns 回填后的新名；无需回填时返回 undefined（保持原值）
 */
export function resolveNameFromGlobalMatch(
  localName: string | undefined,
  matchedName: string | undefined,
): string | undefined {
  // 只有人物库有权威名、且本地是自动命名的机械编号时，才回填真名
  if (matchedName && /^角色_\d+$/.test(localName || '')) {
    return matchedName;
  }
  return undefined;
}

/**
 * 从角色对象提取自动编号"角色_N"中的数字 N，用于排序与自动名去重。
 * 解析优先级：name 的"角色_N" → id 尾部的 _role_N → 兜底返回 MAX 排最后。
 * @param role 角色对象
 * @returns 编号数字；无法解析时返回 Number.MAX_SAFE_INTEGER
 */
function roleAutoIndex(role: any): number {
  const nameMatch = /角色_(\d+)/.exec(role?.name || '');
  if (nameMatch) return parseInt(nameMatch[1], 10);
  const idMatch = /_role_(\d+)$/.exec(role?.id || '');
  return idMatch ? parseInt(idMatch[1], 10) : Number.MAX_SAFE_INTEGER;
}

/**
 * 角色确定性清洗：按自动编号升序排序 + 自动名去重。
 * 修复两个问题：
 *  1. 排序不稳定：roles 由 Object.entries(roleGroups) 遍历生成，该顺序不保证按编号数字排列，
 *     导致 UI 里"角色_0/角色_1/..."顺序错乱。这里统一按编号升序排。
 *  2. 同名叠加：多次识别后可能与旧数据/回填产生同名"角色_N"（同编号不同 id），
 *     这里对自动名按编号去重，保留首个，避免 UI 出现重复角色_0。
 * @param roles 后端生成的角色数组
 * @returns 清洗后的新数组（不修改入参）
 */
function normalizeRoleOrder(roles: any[]): any[] {
  const seenAutoIndex = new Set<number>();
  const result: any[] = [];
  for (const role of roles) {
    const index = roleAutoIndex(role);
    if (index !== Number.MAX_SAFE_INTEGER && seenAutoIndex.has(index)) {
      continue; // 自动名去重：同编号只保留首个，后续同编号角色跳过
    }
    if (index !== Number.MAX_SAFE_INTEGER) seenAutoIndex.add(index);
    result.push(role);
  }
  result.sort((a, b) => roleAutoIndex(a) - roleAutoIndex(b));
  return result;
}

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
    onProgress: (p: number, s: string, results?: any, subStepMeta?: SubStepProgressMeta) => void
  ): Promise<any> {
    const mediaPath = input.mediaPath;
    const config = input.config || {};
    const separationMode = config.audio?.separationMode || 'quality';
    const engine = config.audio?.engine || 'mdx';
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

    // 🎬 P1-1 裁剪指纹：当前 media 的 trim 配置指纹（无裁剪=trim_s0_e0）。
    // 供 skipFrames/skipAudio 判定"已有产物是否在当前裁剪下生成"；不一致则强制重抽/重分离，
    // 修复"先配裁剪→抽帧→改裁剪→复用旧帧仍含 OP/ED"的残留问题。
    // 兼容旧数据：DB 无指纹(NULL)且当前无裁剪 → 视为一致可复用；当前有裁剪 → 强制重抽一次。
    const mediaTrimSig = buildTrimFingerprint(resolveForMedia(context.projectId, mediaId));
    // 指纹一致性判断：DB 无指纹(NULL)且当前无裁剪(trim_s0_e0) → 视为一致（旧数据兼容）；否则严格相等
    const trimSigMatches = (dbSig: string | null | undefined, curSig: string): boolean =>
      dbSig !== null && dbSig !== undefined ? dbSig === curSig : curSig === 'trim_s0_e0';

    if (dbMedia && !forceRetryStep) {
      AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[Step1] 检测到已有媒体数据，开始检查可跳过的子步骤`, { mediaId });

      if (Array.isArray(dbMedia.frames) && dbMedia.frames.length > 0) {
        const absoluteFrames = dbMedia.frames
          .map((f: string) => resolveDbPath(f, projectDir))
          .filter((f: string | undefined): f is string => !!f && fs.existsSync(f));
        if (absoluteFrames.length > 0) {
          // 🎬 P1-1 裁剪指纹校验：仅当已有帧与当前 trim 配置一致时才复用；
          // 不一致（含旧数据无指纹但当前有裁剪）→ 强制重新抽帧，避免复用含 OP/ED 的旧帧
          if (trimSigMatches(dbMedia.framesTrimSig, mediaTrimSig)) {
            existingFrames = absoluteFrames;
            skipFrames = true;
            AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[Step1] 🟢 检测到已有帧数据 (${absoluteFrames.length}帧)，跳过抽帧`, { mediaId });
          } else {
            AppLogger.info(LOG_TAGS.MEDIA_ENGINE,
              `[Step1] ⚠️ 已有帧与当前裁剪配置不一致，重新抽帧（DB sig=${dbMedia.framesTrimSig ?? 'null'} / 当前=${mediaTrimSig}）`,
              { mediaId });
          }
        }
      }

      const vocalsAbs = dbMedia.extractedVocals ? resolveDbPath(dbMedia.extractedVocals, projectDir) : undefined;
      const bgmAbs = dbMedia.extractedBgm ? resolveDbPath(dbMedia.extractedBgm, projectDir) : undefined;
      const audioAbs = dbMedia.extractedAudio ? resolveDbPath(dbMedia.extractedAudio, projectDir) : undefined;
      const audioExists = !!(audioAbs && fs.existsSync(audioAbs));
      // 🎬 P1-1 裁剪指纹校验：音频产物与当前 trim 配置不一致时强制重新分离
      const audioSigOk = trimSigMatches(dbMedia.audioTrimSig, mediaTrimSig);
      if (!audioSigOk) {
        AppLogger.info(LOG_TAGS.MEDIA_ENGINE,
          `[Step1] ⚠️ 已有音频与当前裁剪配置不一致，重新分离（DB sig=${dbMedia.audioTrimSig ?? 'null'} / 当前=${mediaTrimSig}）`,
          { mediaId });
      }
      if (vocalsAbs && fs.existsSync(vocalsAbs) && bgmAbs && fs.existsSync(bgmAbs)) {
        existingVocalsPath = audioSigOk ? vocalsAbs : undefined;
        existingBgmPath = audioSigOk ? bgmAbs : undefined;
        // 🔧 修复：ASR 只用原始音频降采样（extractedAudio），不复用分离后 vocals
        // 原因：Demucs 分离损失高频细节，导致 faster-whisper 误识别（如 "I'm"→"Mom"）
        // vocals/bgm 仍复用分离产物供 BGM 提取、TTS 等其他用途
        existingAudioPath = audioSigOk && audioExists ? audioAbs : undefined;
        existingVocalsIsFallback = !!dbMedia.vocalsIsFallback;
        // 仅当 16k ASR 音频存在时才跳过音频处理；否则需重新生成
        skipAudio = !!existingAudioPath;
        AppLogger.info(LOG_TAGS.MEDIA_ENGINE,
          `[Step1] 🟢 检测到已有音频分离产物，跳过音频分离${existingAudioPath ? '（ASR用原始音轨降采样）' : '（需重新生成 ASR 音频）'}`,
          { mediaId });
      } else if (separationMode === 'fast' && audioExists) {
        existingAudioPath = audioSigOk ? audioAbs : undefined;
        existingVocalsIsFallback = true;
        skipAudio = audioSigOk;
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
            // 🎬 P1-1 裁剪指纹校验（同增量分支）：trim 配置不一致的旧帧不复用，强制重抽
            if (trimSigMatches(dbMedia.framesTrimSig, mediaTrimSig)) {
              existingFrames = absoluteFrames;
              skipFrames = true; // 🔧 修复：加载成功后标记为跳过，不重复抽帧
            } else {
              AppLogger.info(LOG_TAGS.MEDIA_ENGINE,
                `[Step1] ⚠️ [forceRetry] 已有帧与当前裁剪配置不一致，重新抽帧（DB sig=${dbMedia.framesTrimSig ?? 'null'} / 当前=${mediaTrimSig}）`,
                { mediaId });
            }
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
        // 🎬 P1-1 裁剪指纹校验：音频产物与当前 trim 配置不一致时强制重新分离
        const audioSigOk = trimSigMatches(dbMedia.audioTrimSig, mediaTrimSig);
        if (vocalsExists) {
          existingVocalsPath = audioSigOk ? vocalsAbs : undefined;
          existingBgmPath = audioSigOk && bgmExists ? bgmAbs : undefined;
          existingVocalsIsFallback = false;
          // 仅当 16k ASR 音频存在时才跳过音频处理；否则需重新跑 extractAndSeparate 生成
          existingAudioPath = audioSigOk && audioExists ? audioAbs : undefined;
          skipAudio = !!existingAudioPath;
          if (!audioSigOk) {
            AppLogger.info(LOG_TAGS.MEDIA_ENGINE,
              `[Step1] ⚠️ [forceRetry] 已有音频与当前裁剪配置不一致，重新分离（DB sig=${dbMedia.audioTrimSig ?? 'null'} / 当前=${mediaTrimSig}）`,
              { mediaId });
          }
          AppLogger.info(LOG_TAGS.MEDIA_ENGINE,
            `[Step1] 🟢 检测到已有人声分离产物，跳过音频分离${existingAudioPath ? '（ASR用原始音轨降采样）' : '（需重新生成 ASR 音频）'}`,
            { mediaId });
        } else if (audioExists) {
          // 回退到原始音轨（极速模式或分离失败后的降级）
          existingAudioPath = audioSigOk ? audioAbs : undefined;
          existingVocalsIsFallback = true;
          skipAudio = audioSigOk; // 🔧 修复：加载成功后标记为跳过
          if (!audioSigOk) {
            AppLogger.info(LOG_TAGS.MEDIA_ENGINE,
              `[Step1] ⚠️ [forceRetry] 已有音频与当前裁剪配置不一致，重新分离（DB sig=${dbMedia.audioTrimSig ?? 'null'} / 当前=${mediaTrimSig}）`,
              { mediaId });
          }
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
    /** 🎬 帧真实时间戳（源坐标，原视频绝对时间），与 validFrames 顺序对齐；postProcess 产物 frameDetails 派生 */
    let frameTimeMsForFrames: number[] = [];
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

    /** 统一上报子步骤真实进度：
     *   - 全局进度按单调前移
     *   - 附带的 subStepMeta 携带子业务真实局部进度（由子引擎完成量动态计算），前端据此渲染各子业务百分比
     */
    const emitSubStep = (subStep: string, localPct: number, targetGlobal: number, message: string) => {
      const g = Math.max(lastProgress, targetGlobal);
      lastProgress = g;
      onProgress(g, message, undefined, {
        subStep,
        subStepProgress: Math.max(0, Math.min(100, Math.round(localPct))),
      });
    };

    if (skipFrames) {
      lastProgress = Math.max(lastProgress, 20);
      emitSubStep('frames', 100, lastProgress, `关键帧已存在 (${validFrames.length}帧)，跳过抽帧`);
    }
    if (skipAudio) {
      lastProgress = Math.max(lastProgress, 30);
      emitSubStep('audio', 100, lastProgress, vocalsIsFallback ? '极速模式：音频已存在，跳过分离' : '音频分离产物已存在，跳过分离');
    }
    if (skipAsr) {
      lastProgress = Math.max(lastProgress, 65);
      emitSubStep('whisper', 100, lastProgress, `ASR结果已存在 (${asrLines.length}段)，跳过识别`);
    }
    if (skipFaces) {
      lastProgress = Math.max(lastProgress, 85);
      emitSubStep('faces', 100, lastProgress, `角色数据已存在 (${roles.length}个)，跳过人脸检测`);
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
        emitSubStep('frames', 1, Math.max(lastProgress, 5), '正在提取关键帧...');
        try {
          // 🎬 P1-1 OP/ED 源头裁剪：抽帧只抽正剧段（body 窗口）。
          //   时间换算唯一来源是策略层（SSOT）：inPoint=offsetSec(源坐标起点)，
          //   outPoint=durationSec(body 长度)。ffmpeg -ss 前置(input seek)输出时间戳归零，
          //   帧 timeMs 天然为 body 坐标，与 shots/chunks 平移后语义一致，严禁自行换算。
          const trimForFrames = resolveForMedia(context.projectId, mediaId);
          const trimForFramesWin = toMediaWindow(trimForFrames);
          const frameShouldTrim = trimForFrames.trimStartMs > 0 || trimForFrames.trimEndMs > 0;
          // 🎬 源坐标偏移：OP 裁剪后 FFmpeg -ss 前置 seek 使 PTS 归零（body 坐标），
          //   透传 offsetSec×1000 给 SFPP，帧 timeMs 统一换算回源坐标（原视频绝对时间），
          //   与 ASR（源坐标）/ 视频切片定位一致。非裁剪时为 0，行为不变。
          const sourceOffsetMsForFrames = frameShouldTrim ? Math.round(trimForFramesWin.offsetSec * 1000) : 0;
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
            // P0 · 系统级黄金参数：VLM 抽帧默认 longEdge=1024，JPEG -q:v 2（后端自动接管）
            timePoint: framesConfig.timePoint,
            abortSignal: signal,
            // 🆕 真实动态进度：由 FFmpeg 解码 time= 动态计算，映射到 5%~20% 全局区间
            onProgress: (pct, msg) => {
              const g = Math.max(lastProgress, 5 + pct * 0.15);
              lastProgress = g;
              onProgress(g, msg || '正在提取关键帧...', undefined, { subStep: 'frames', subStepProgress: pct });
            },
            // 🎬 P1-1 抽帧只覆盖 body 窗口（OP/ED 不抽帧）
            inPoint: frameShouldTrim ? trimForFramesWin.offsetSec : undefined,
            outPoint: frameShouldTrim && trimForFramesWin.durationSec !== undefined ? trimForFramesWin.durationSec : undefined,
            // 🎬 帧时间戳换算回源坐标（原视频绝对时间），与 ASR 基准一致
            sourceOffsetMs: sourceOffsetMsForFrames,
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
              abortSignal: signal,
              // 🆕 真实动态进度：降级抽帧同样按解码进度上报
              onProgress: (pct, msg) => {
                const g = Math.max(lastProgress, 5 + pct * 0.15);
                lastProgress = g;
                onProgress(g, msg || '正在提取关键帧...', undefined, { subStep: 'frames', subStepProgress: pct });
              },
              // 🎬 P1-1 降级抽帧同样只覆盖 body 窗口
              inPoint: frameShouldTrim ? trimForFramesWin.offsetSec : undefined,
              outPoint: frameShouldTrim && trimForFramesWin.durationSec !== undefined ? trimForFramesWin.durationSec : undefined,
              // 🎬 帧时间戳换算回源坐标
              sourceOffsetMs: sourceOffsetMsForFrames,
              postProcess: true,
            });
          }

          validFrames = telemetryResult.files;
          // 🎬 帧真实时间戳（源坐标，与 framePaths 顺序对齐），从 SFPP 后处理 frameDetails 派生；
          //   未启用 postProcess 或产物缺失时保持空数组（下游将回退估算）
          frameTimeMsForFrames = Array.isArray((telemetryResult as any).frameDetails)
            ? (telemetryResult as any).frameDetails.map((d: any) => Math.round(Number(d?.timeMs) || 0))
            : [];
          lastProgress = Math.max(lastProgress, 20);
          emitSubStep('frames', 100, lastProgress, `关键帧提取完成 (${validFrames.length}帧)`);
          return telemetryResult;
        } catch (e: any) {
          AppLogger.error(LOG_TAGS.MEDIA_ENGINE, '[Step1] 抽帧失败', { mediaId, error: e });
          framesFailed = true;
          return { files: [] };
        }
      })());
    }

    // 🎬 P1-2：音频分离已在源头切好 body 段（true 时 ASR 直接转录该段，不再二次 resolve）
    let audioCutToBody = false;

    if (needRunAudio) {
      tasks.push((async () => {
        const skipSeparation = separationMode === 'fast';
        if (skipSeparation) {
          AppLogger.info(LOG_TAGS.MEDIA_ENGINE,
            '[Step1] 极速模式：跳过人声分离，使用原始音轨', { mediaId });
        }

        const onSubProgress = (pct: number, msg: string) => {
          // 🆕 真实动态进度：透传音频分离子引擎的真实完成百分比（0~100），映射到 15%~30% 全局区间
          const g = Math.max(lastProgress, 15 + pct * 0.15);
          lastProgress = g;
          onProgress(g, msg || '正在分离人声...', undefined, {
            subStep: 'audio',
            subStepProgress: Math.max(0, Math.min(100, Math.round(pct))),
          });
        };

        // 🎬 P1-2 OP/ED 源头裁剪：音频分离只处理正剧段（body 窗口）。
        //   trimStartSec/trimEndSec 为源坐标秒（-ss/-to output seek），
        //   产物 vocals/bgm/asrAudio 时间轴从 0 起（body 坐标）。
        const trimForAudio = resolveForMedia(context.projectId, mediaId);
        const trimForAudioWin = toMediaWindow(trimForAudio);
        const audioShouldTrim = trimForAudio.trimStartMs > 0 || trimForAudio.trimEndMs > 0;
        const audioTrimStartSec = audioShouldTrim ? trimForAudioWin.offsetSec : undefined;
        const audioTrimEndSec = audioShouldTrim && trimForAudioWin.endSec !== undefined
          ? trimForAudioWin.toSource(trimForAudioWin.endSec)
          : undefined;

        const result = await AudioProcessor.extractAndSeparate(
          mediaPath, audioDir, mediaId, signal,
          { skipSeparation, engine, onProgress: onSubProgress, trimStartSec: audioTrimStartSec, trimEndSec: audioTrimEndSec }
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
        // 🎬 P1-2：本次分离产物已是 body 段，ASR 无需再切（audioTrimStartSec 同时供 ASR 偏移换算）
        audioCutToBody = audioShouldTrim && !!result.asrAudioPath;

        if (result.isFallback && !skipSeparation) {
          AppLogger.warn(LOG_TAGS.MEDIA_ENGINE,
            '[Step1] 人声分离失败，降级到原始音轨（ASR 仍将执行）', { mediaId });
        }

        if (vocalsPath && !result.isFallback) {
          lastProgress = Math.max(lastProgress, 30);
          emitSubStep('audio', 100, lastProgress, '人声分离完成');
        } else if (skipSeparation) {
          lastProgress = Math.max(lastProgress, 30);
          emitSubStep('audio', 100, lastProgress, '极速模式：跳过人声分离');
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
    let asrSourcePath: string = targetAudio ?? ''; // audioPath 参数可为 undefined，但 ASR 分支有 targetAudio 存在性守卫
    let asrTrimOffsetMs = 0; // P0-2 OP/ED 源头裁剪：>0 时 ASR 结果(body坐标)需换算回源坐标
    if (!skipAsr && !audioFailed && runWhisper && targetAudio && fs.existsSync(targetAudio)) {
      emitSubStep('whisper', 1, Math.max(lastProgress, 50), '正在进行 ASR 识别...');
      if (vocalsIsFallback) {
        AppLogger.warn(LOG_TAGS.MEDIA_ENGINE, '[Step1] 人声分离降级模式，ASR 使用含 BGM 的原始音轨，识别质量可能下降', { mediaId });
      }
      try {
        // 🆕 P0-2 / P1-2 OP/ED 源头裁剪：只转录正剧段（body 窗口），从源头清除 OP/ED 残留台词。
        //   切片后 ASR 时间戳为 body 坐标，下方解析时统一换算回源坐标，保证 DB 数据流不变。
        if (audioCutToBody) {
          // 🎬 P1-2：音频分离已在源头切好 body 段，直接转录该段，避免双重裁剪
          asrSourcePath = targetAudio;
          asrTrimOffsetMs = Math.round(toMediaWindow(resolveForMedia(context.projectId, mediaId)).offsetSec * 1000);
          AppLogger.info(LOG_TAGS.MEDIA_ENGINE,
            '[Step1] OP/ED 裁剪生效：音频分离已按 body 窗口切好，ASR 直接转录正剧段' +
            `（偏移 ${(asrTrimOffsetMs / 1000).toFixed(1)}s），结果将换算回源坐标`, { mediaId });
        } else {
          try {
            const src = await TrimmedSourceResolver.resolve({
              projectId: context.projectId,
              mediaId,
              mediaPath: targetAudio,
              mode: 'body',
              ext: '.wav',
              ar: 16000,
              ac: 1,
              getFfmpegPath: () => PathManager.getBinPath('ffmpeg.exe'),
            });
            if (src.shouldTrim && src.trimmedPath !== targetAudio) {
              asrSourcePath = src.trimmedPath;
              asrTrimOffsetMs = Math.round(src.window.offsetSec * 1000);
              AppLogger.info(LOG_TAGS.MEDIA_ENGINE,
                `[Step1] OP/ED 裁剪生效：ASR 仅转录正剧段${src.window.durationSec !== undefined ? ` ${src.window.durationSec.toFixed(1)}s` : ''}` +
                `（偏移 ${src.window.offsetSec.toFixed(1)}s），结果将换算回源坐标`, { mediaId });
            }
          } catch (e: any) {
            AppLogger.warn(LOG_TAGS.MEDIA_ENGINE,
              '[Step1] OP/ED 音频切片失败，回退整段转录', { mediaId, error: e.message });
          }
        }
        const whisperStrategy = new LocalWhisperStrategy();
        const whisperCfg = typeof config.whisper === 'object' ? config.whisper : { enabled: true, engine: 'auto' as const };
        const asrLang = whisperCfg.language || 'auto';
        const CJK_LANGS = ['zh', 'ja', 'ko', 'yue'];
        // 🔧 诊断：打印前端实际传入的原始 whisper 配置，便于定位"为什么还是 auto"
        AppLogger.info(LOG_TAGS.MEDIA_ENGINE, `[Step1] ASR 原始配置: ${JSON.stringify(whisperCfg)}, targetLanguage=${(config as any)?.targetLanguage ?? '未传'}`, { mediaId });
        // 🔧 修复：调整引擎选择优先级 —— 显式指定的 engine 优先于语言推断
        // 旧版 bug：`if (asrLang === 'auto') asrEngine='auto'` 排在显式 engine 之前，
        //   前端一旦传 language='auto'（即使 engine='sensevoice'），就会被强制回退到 auto，
        //   导致中文电视剧误走 faster-whisper。现在显式 engine 优先级最高。
        // 另加 targetLanguage 兜底：即便前端 persist 旧数据仍传 engine='auto'，
        //   只要项目目标语言是中文，就强制走 SenseVoice（电视剧场景稳定识别）。
        const targetLang = (config as any)?.targetLanguage || '';
        const isChineseTarget = /^zh/i.test(targetLang);
        // 兜底时同步解析语言：中文目标 → 'zh'，让 LocalWhisperStrategy 日志显示真实语言而非 auto
        let resolvedLang = asrLang;
        let asrEngine: 'sensevoice' | 'faster-whisper' | 'auto';
        if (whisperCfg.engine && whisperCfg.engine !== 'auto') {
          // 上层/前端显式指定了引擎 → 优先尊重
          asrEngine = whisperCfg.engine;
        } else if (isChineseTarget) {
          // 未显式指定引擎，但目标语言是中文 → 默认 SenseVoice（中文剧集又快又稳）
          asrEngine = 'sensevoice';
          if (resolvedLang === 'auto') resolvedLang = 'zh';
        } else if (asrLang === 'auto') {
          // 未指定引擎且语言未知 → 交由 Python 端预检测语言并选定引擎
          asrEngine = 'auto';
        } else if (CJK_LANGS.includes(asrLang)) {
          asrEngine = 'sensevoice';
        } else {
          asrEngine = 'faster-whisper';
        }
        const asrOnProgress = (pct: number, msg: string) => {
          // 🆕 真实动态进度：透传 ASR 子引擎的真实完成百分比（0~100），映射到 45%~65% 全局区间
          const g = Math.max(lastProgress, 45 + pct * 0.2);
          lastProgress = g;
          onProgress(g, msg || 'ASR 识别中', undefined, {
            subStep: 'whisper',
            subStepProgress: Math.max(0, Math.min(100, Math.round(pct))),
          });
        };
        whisperResult = await whisperStrategy.transcribe(
          asrSourcePath, audioDir, mediaId, resolvedLang, asrEngine, signal, asrOnProgress,
          // 🔧 去硬编码：faster-whisper 模型大小从配置读取（默认 large-v3），不写死
          (whisperCfg as any)?.modelSize || 'large-v3'
        );
        lastProgress = Math.max(lastProgress, 65);
        emitSubStep('whisper', 100, lastProgress, 'ASR 识别完成');
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
        emitSubStep('faces', 1, Math.max(lastProgress, 72), '正在为人脸识别单独抽帧...');

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
          // 🎬 P1-3 OP/ED 源头裁剪：人脸专用抽帧同样只覆盖 body 窗口（OP/ED 不采人脸）
          const faceTrim = resolveForMedia(context.projectId, mediaId);
          const faceTrimWin = toMediaWindow(faceTrim);
          const faceShouldTrim = faceTrim.trimStartMs > 0 || faceTrim.trimEndMs > 0;
          const faceFramesResult = await frameService.extractFrames(mediaPath, faceFramesDir, mediaId, {
            strategy: 'UNIFORM_FPS',
            fps: 1,
            // P0 · 人脸专用黄金长边 cap=1280（决策点②：源分辨率低于 1280 保持原始，不放大），JPEG 画质由系统托管 -q:v 2
            frameCap: FACE_FRAME_LONG_EDGE,
            abortSignal: signal,
            // 🆕 真实动态进度：人脸专用抽帧按解码进度上报到 「faces」 子业务（0~40 区间）
            onProgress: (pct) => {
              const g = Math.max(lastProgress, 72 + pct * 0.04);
              lastProgress = g;
              onProgress(g, `正在为人脸识别单独抽帧 (${Math.round(pct)}%)...`, undefined, {
                subStep: 'faces',
                subStepProgress: Math.max(1, Math.min(40, Math.round(pct * 0.4))),
              });
            },
            // 🎬 P1-3 只采 body 窗口
            inPoint: faceShouldTrim ? faceTrimWin.offsetSec : undefined,
            outPoint: faceShouldTrim && faceTrimWin.durationSec !== undefined ? faceTrimWin.durationSec : undefined,
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

        emitSubStep('faces', 42, Math.max(lastProgress, 75), `正在检测人脸 (${faceFrames.length}帧)...`);
        try {
          const detectedFaces = await VisionProcessor.scanFaces(faceFrames, facesDir, signal, undefined, (pct, msg) => {
            // 🆕 真实动态进度：按已检测帧数/总帧数动态计算，映射到 42%~90% 局部区间
            const local = 42 + Math.round((pct / 100) * 48);
            const g = Math.max(lastProgress, 75 + pct * 0.1);
            lastProgress = g;
            onProgress(g, msg || `正在检测人脸 (${pct}%)...`, undefined, {
              subStep: 'faces',
              subStepProgress: Math.max(42, Math.min(90, local)),
            });
          });
          if (detectedFaces.length > 0) {
            emitSubStep('faces', 92, Math.max(lastProgress, 80), `人脸检测完成 (${detectedFaces.length}张)，正在聚类...`);
            const clustersMap = await VisionProcessor.clusterFaces(
              mediaId,
              detectedFaces,
              facesDir,
              // 🎭 P0.5+ 透传余弦相似度阈值（未配置时 Python 端使用默认 0.72）
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
              /** 💥 修复黑头像 + 小头像：用「最佳代表脸」作为头像
               * 旧版用 groupFaces[0]（检测到的第一张脸），可能是远景小脸/侧脸 → 头像看不清
               * 新版选簇中 bbox 面积最大且清晰的代表脸，保证头像清晰易区分
               * 同时统一设置 representative.facePath 和顶层 avatarPath，
               * 确保三条下游路径（SSE 实时结果/线性向导/DB 重读）都能拿到头像路径 */
              const bestFace = VisionProcessor.pickRepresentativeFace(groupFaces) || groupFaces[0] || {};
              const facePath = bestFace.face_path || bestFace.facePath || '';
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
                  ...bestFace,
                  facePath,
                },
                /** avatarPath 供前端 View.tsx 直接读取显示头像（getSafeMediaUrl 可处理绝对路径） */
                avatarPath: facePath,
                faces: groupFaces,
              };
            });
            /** 🔧 确定性清洗：按自动编号排序 + 自动名去重
             * 放在全局人物匹配之前，保证后续 matchOrCreate / DB 回写拿到的
             * roles 顺序稳定且不重复（修复"不按数字排序"与"重复角色_0"）。 */
            roles = normalizeRoleOrder(roles);
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
                  // 🎯 打通人物库：命中已有全局人物时，把人物库里的权威真名回填到本地角色，
                  // 否则本地角色仍叫"角色_1"，人物库维护的姓名无法流入步骤2/3 文案。
                  // 仅当本地是自动命名（"角色_N"）时才回填，避免覆盖用户在当前项目已手动命名。
                  const newName = resolveNameFromGlobalMatch((role as any).name, matchResult.character.name);
                  if (newName !== undefined) {
                    (role as any).name = newName;
                  }
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
          emitSubStep('faces', 100, lastProgress, `人脸识别完成 (${roles.length}个角色)`);
        } catch (e: any) {
          AppLogger.warn(LOG_TAGS.MEDIA_ENGINE,
            '[Step1] 人脸检测失败，降级跳过', { mediaId, error: e.message });
          facesFailed = true;
          // 🛡️ 防复发：重试识别人物（forceRetryStep==='faces'）时若检测失败/不完整，
          //   roles 已被初始化为 []（见上方 roles 声明），直接写库会清空已有完整角色。
          //   这里回退保留旧角色，宁可沿用旧结果也不覆盖成空，让用户重试得到正确结果后再更新。
          if (forceRetryStep === 'faces' && existingRoles.length > 0) {
            roles = [...existingRoles];
            AppLogger.warn(LOG_TAGS.MEDIA_ENGINE,
              `[Step1] 人脸检测失败，已回退保留 ${existingRoles.length} 个旧角色（避免覆盖）`, { mediaId });
          }
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

          // P0-2 毫秒 → mm:ss（用于把 body 坐标换算回源坐标后的显示串）
          const fmtMmss = (ms: number) => {
            const s = Math.max(0, Math.floor(ms / 1000));
            return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
          };

          asrLines = transcription.map((t: any) => {
            const text = (t.text || '').replace(/<\|.*?\|>/g, '').trim();
            const from = parseSrt(t.timestamps?.from || '00:00:00,000');
            const to = parseSrt(t.timestamps?.to || '00:00:00,000');
            // P0-2 body 坐标 → 源坐标（未裁剪时偏移为 0，行为与旧版一致）
            const startMs = from.ms + asrTrimOffsetMs;
            const endMs = to.ms + asrTrimOffsetMs;
            return {
              start: fmtMmss(startMs),
              startMs,
              end: fmtMmss(endMs),
              endMs,
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
      frames: {
        count: frameCount, paths: framePaths, _failed: framesFailed, _skipped: skipFrames || !runFrames,
        // 🎬 P1-1 裁剪指纹：本次抽帧所用 trim 配置指纹，供 PipelineResultWriter 持久化到 media_assets
        framesTrimSig: mediaTrimSig,
        // 🎬 帧真实时间戳（源坐标，与 paths 顺序对齐），供持久化后步骤2 直接使用真实时间戳
        frameTimeMs: frameTimeMsForFrames,
      },
      audio: {
        separated: audioSeparated,
        audioPath,
        vocalsPath,
        bgmPath,
        vocalsIsFallback,
        _failed: audioFailed,
        _skipped: skipAudio || !runAudio,
        // 🎬 P1-1 裁剪指纹：本次音频分离所用 trim 配置指纹，供 PipelineResultWriter 持久化
        audioTrimSig: mediaTrimSig,
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
