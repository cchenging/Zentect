// 路径: src/main/pipeline/PipelineResultWriter.ts
// 从 JobScheduler 中提取管线结果写入逻辑，分离 DB 写入与任务调度职责
// 职责：将管线执行结果写入 media_assets、roles、projects.metadata
// 不负责：IPC 通知、路径水合（由 JobScheduler 调用方处理）

import { MediaRepository } from '../database/repositories/MediaRepository';
import { RoleRepository } from '../database/repositories/RoleRepository';
import { SQLiteConnection } from '../../modules/infra/database/core/SQLiteConnection';
import { PROJECT_SQL } from '../database/queries/ProjectQueries';
import { PathManager } from '../utils/pathManager';
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../modules/infra/logger/LogConstants';
import * as path from 'path';

/**
 * 清理 magic:// 协议 URL 为本地文件系统绝对路径（与 Strategy.ts 中 resolveDbPath 一致）
 * 用于从 DB 读取的 avatar 字段（相对路径或 magic:// 格式）还原为绝对路径
 */
function resolveDbPath(dbValue: string | undefined | null, projectDir: string): string | undefined {
  if (!dbValue) return undefined;
  const val = dbValue.replace(/\\/g, '/');
  if (val.startsWith('magic://local/')) {
    const raw = val.replace(/^magic:\/\/local\//, '');
    return raw.replace(/\//g, '\\');
  }
  const magicMatch = val.match(/^magic:\/\/(?:[^\/]+)\/(.+)/);
  if (magicMatch) {
    return path.join(projectDir, magicMatch[1].replace(/\//g, '\\'));
  }
  if (path.isAbsolute(val)) {
    return val.replace(/\//g, '\\');
  }
  return path.join(projectDir, val.replace(/\//g, '\\'));
}

/** 管线执行结果（由调用方从 PipelineEngine 输出中提取） */
export interface PipelineStep1Result {
  frames: string[];
  audioPath: string | null;
  vocalsPath: string | null;
  bgmPath: string | null;
  vocalsIsFallback: boolean;
  separationMode: string;
  separationEngine: string;
  shots: Array<{ originalText: string; start: number; end: number }>;
  roles: any[];
}

export interface WriteStep1Params {
  projectId: string;
  mediaId: string;
  result: PipelineStep1Result;
  /** 各子步骤是否因已有数据而被跳过 */
  framesSkipped: boolean;
  audioSkipped: boolean;
  asrSkipped: boolean;
  facesSkipped: boolean;
  /** step1Data 原始输出（含 _failed 标记，用于推导子步骤失败状态） */
  step1Data: Record<string, any>;
}

export interface WriteStep1Output {
  updatedMedia: any;
  finalRoles: any[];
}

export class PipelineResultWriter {
  /**
   * 将 step1 管线结果写入数据库
   * - media_assets: frames / extractedAudio / extractedVocals / extractedBgm / extractedText / 分离配置
   * - roles: 事务性 HARD_DELETE + INSERT（跳过时复用已有角色）
   * - projects.metadata.subStepStatuses: 根据实际执行结果推导并合并写入
   *
   * @returns updatedMedia 和 finalRoles，供调用方进行路径水合和 IPC 通知
   */
  static async writeStep1Results(params: WriteStep1Params): Promise<WriteStep1Output> {
    const { projectId, mediaId, result, framesSkipped, audioSkipped, asrSkipped, facesSkipped, step1Data } = params;

    const mediaRepo = new MediaRepository();
    const updatedMedia = await mediaRepo.findById(mediaId);
    if (!updatedMedia) {
      throw new Error(`媒体记录不存在: ${mediaId}`);
    }

    updatedMedia.status = 'parsed';
    const projectDir = PathManager.getProjectDir(projectId);

    // --- 写入 frames ---
    if (!framesSkipped && result.frames && Array.isArray(result.frames) && result.frames.length > 0) {
      updatedMedia.frames = result.frames.map((framePath: string) => {
        if (path.isAbsolute(framePath)) {
          return path.relative(projectDir, framePath).replace(/\\/g, '/');
        }
        return framePath;
      });
    }

    // --- 写入 audio ---
    if (!audioSkipped) {
      if (result.audioPath) {
        updatedMedia.extractedAudio = path.isAbsolute(result.audioPath)
          ? path.relative(projectDir, result.audioPath).replace(/\\/g, '/')
          : result.audioPath;
      }
      if (result.vocalsPath) {
        updatedMedia.extractedVocals = path.isAbsolute(result.vocalsPath)
          ? path.relative(projectDir, result.vocalsPath).replace(/\\/g, '/')
          : result.vocalsPath;
      }
      if (result.bgmPath) {
        updatedMedia.extractedBgm = path.isAbsolute(result.bgmPath)
          ? path.relative(projectDir, result.bgmPath).replace(/\\/g, '/')
          : result.bgmPath;
      }
      updatedMedia.separationMode = result.separationMode;
      updatedMedia.separationEngine = result.separationEngine;
      updatedMedia.vocalsIsFallback = result.vocalsIsFallback;
    }

    // --- 写入 ASR 台词 ---
    if (!asrSkipped && result.shots && result.shots.length > 0) {
      // 1) 序列化写入 media_assets.extractedText（供增量执行检测已有数据）
      updatedMedia.extractedText = JSON.stringify(
        result.shots.map((s: any) => ({
          start: s.start,
          end: s.end,
          text: s.originalText || '',
        }))
      );

      // 2) 同步更新 shots 表（全量替换，保证重启后数据一致）
      // 🔧 修复：之前只写 extractedText 不写 shots 表，导致重启后从 shots 表加载到旧数据
      const db = SQLiteConnection.getInstance().getDB();
      const shotTransaction = db.transaction(() => {
        db.prepare(PROJECT_SQL.HARD_DELETE_SHOTS).run({ projectId });
        const insertShot = db.prepare(PROJECT_SQL.INSERT_SHOT_FULL);
        for (const shot of result.shots) {
          // 跳过无 id 的 shot，避免 PRIMARY KEY 为 NULL 的脏数据
          if (!shot.id || typeof shot.id !== 'string' || !shot.id.trim()) {
            AppLogger.warn(LOG_TAGS.SCHEDULER, '[PipelineResultWriter] 跳过无 id 的 shot', { projectId });
            continue;
          }
          insertShot.run({
            id: shot.id, projectId, episodeNum: 1, timeCode: '', duration: '',
            aiText: '', originalText: shot.originalText || '',
            roleId: null, originalRoleId: null, coverPath: '',
            reasoning: '', characters: '[]', camera: '',
            audioPath: '', audioDuration: 0, alignStrategy: 'slow',
            startTime: shot.start || 0, endTime: shot.end || 0, audioEmotion: '',
            visionText: '', contextFrames: '[]',
          });
        }
      });
      shotTransaction();
      AppLogger.info(LOG_TAGS.SCHEDULER, `[PipelineResultWriter] shots 表已同步更新 (${result.shots.length} 段)`, { projectId });
    }

    // --- 写入 roles ---
    let finalRoles = result.roles || [];
    const roleRepo = new RoleRepository();
    const dbRoles = roleRepo.findByProjectId(projectId);

    if (facesSkipped && dbRoles.length > 0) {
      finalRoles = dbRoles.map((r: any) => {
        /** 💥 修复黑头像：DB 中 avatar 是相对路径，需转为绝对路径赋给 avatarPath
         * 前端 View.tsx 读取 role.avatarPath 显示头像，缺少此字段 → 黑头像 */
        const avatarAbs = r.avatar ? resolveDbPath(r.avatar, projectDir) : null;
        /** 💥 从 faces_json 恢复详细信息（性别/年龄/多张人脸） */
        let facesData: any = null;
        if (r.faces_json) {
          try {
            facesData = JSON.parse(r.faces_json);
          } catch {}
        }
        /** faces 中的 face_path 也转为绝对路径 */
        const restoredFaces = facesData?.faces?.map((f: any) => {
          const facePath = f.face_path || f.facePath || '';
          const absPath = facePath ? resolveDbPath(facePath, projectDir) : '';
          return { ...f, face_path: absPath, facePath: absPath };
        }) || [];
        const repFace = facesData?.representative ? {
          ...facesData.representative,
          facePath: avatarAbs,
          face_path: avatarAbs,
        } : (avatarAbs ? { facePath: avatarAbs } : null);
        return {
          id: r.id,
          name: r.name,
          faceCount: facesData?.faceCount ?? restoredFaces.length,
          avatar: r.avatar,
          avatarPath: avatarAbs,
          representative: repFace,
          faces: restoredFaces,
          pronoun: r.pronoun,
          description: r.description,
          voiceId: r.voice_id,
          /** 🎭 P1.5 角色主次分级：从 DB tier 列恢复（main/supporting/extra） */
          tier: r.tier || undefined,
          mergedRoles: r.merged_roles ? JSON.parse(r.merged_roles) : [],
        };
      });
    } else if (!facesSkipped && finalRoles.length > 0) {
      const db = SQLiteConnection.getInstance().getDB();
      const roleTransaction = db.transaction(() => {
        db.prepare(PROJECT_SQL.HARD_DELETE_ROLES).run({ projectId });
        const insertRole = db.prepare(PROJECT_SQL.INSERT_ROLE_FULL);
        for (const role of finalRoles) {
          const roleName = role.name || role.label || `角色_${Date.now().toString(36).slice(-4)}`;
          /** 💥 修复黑头像：avatar 转为相对路径（与 frames/audio 一致）
           * 旧版 bug：直接写入绝对路径，resolveDbPath 无法正确解析 → 头像加载失败显示黑色
           * 修复：绝对路径转为 projectDir 相对路径，统一用 '/' 分隔 */
          const rawAvatar = role.avatar || role.representative?.facePath || '';
          const roleAvatar = rawAvatar && path.isAbsolute(rawAvatar)
            ? path.relative(projectDir, rawAvatar).replace(/\\/g, '/')
            : rawAvatar;
          /** 💥 序列化 faces 数据到 faces_json，重进项目后恢复详细信息（性别/年龄/多张人脸）
           * faces 中的 face_path 也转为相对路径，与 avatar 一致 */
          const facesForDb = (role.faces || []).map((f: any) => {
            const facePath = f.face_path || f.facePath || '';
            const relPath = facePath && path.isAbsolute(facePath)
              ? path.relative(projectDir, facePath).replace(/\\/g, '/')
              : facePath;
            return { ...f, face_path: relPath, facePath: relPath };
          });
          const repForDb = role.representative ? {
            ...role.representative,
            facePath: roleAvatar,
            face_path: roleAvatar,
          } : null;
          const facesJson = JSON.stringify({
            representative: repForDb,
            faces: facesForDb,
            faceCount: role.faceCount ?? facesForDb.length,
          });
          insertRole.run({
            id: role.id || `role_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            projectId,
            systemId: role.systemId || null,
            name: roleName,
            pronoun: role.pronoun || '',
            avatar: roleAvatar,
            description: role.description || role.label || roleName,
            voiceId: role.voiceId || null,
            mergedRoles: JSON.stringify(role.mergedRoles || []),
            facesJson,
            // 🎭 P1 全局人物注册中心：持久化 global_character_id（聚类后自动匹配写入）
            globalCharacterId: role.globalCharacterId || null,
            /** 🎭 P1.5 角色主次分级：持久化 tier（main/supporting/extra），跨会话保留标注 */
            tier: role.tier || '',
          });
        }
      });
      roleTransaction();
    }

    // --- 更新 media_assets ---
    mediaRepo.updateMedia(updatedMedia.id, updatedMedia);

    // --- 持久化 subStepStatuses 到 metadata ---
    PipelineResultWriter.writeSubStepStatuses(projectId, result, framesSkipped, audioSkipped, asrSkipped, facesSkipped, step1Data);

    return { updatedMedia, finalRoles };
  }

  /**
   * 根据管线实际执行结果推导 subStepStatuses 并写入 projects.metadata
   * 合并而非覆盖：保留已有的 completed 状态，只更新新状态
   */
  private static writeSubStepStatuses(
    projectId: string,
    result: PipelineStep1Result,
    framesSkipped: boolean,
    audioSkipped: boolean,
    asrSkipped: boolean,
    facesSkipped: boolean,
    step1Data: Record<string, any>,
  ): void {
    try {
      const db = SQLiteConnection.getInstance().getDB();
      const projectRow = db.prepare('SELECT metadata FROM projects WHERE id = ?').get(projectId) as any;
      let existingMeta: any = {};
      if (projectRow?.metadata) {
        try { existingMeta = typeof projectRow.metadata === 'string' ? JSON.parse(projectRow.metadata) : projectRow.metadata; } catch {}
      }

      const subStepStatuses: Record<string, string> = {};
      if (framesSkipped || (result.frames && Array.isArray(result.frames) && result.frames.length > 0)) {
        subStepStatuses.frames = 'completed';
      } else if (step1Data.frames?._failed) {
        subStepStatuses.frames = 'failed';
      }
      if (audioSkipped || result.audioPath || result.vocalsPath) {
        subStepStatuses.audio = 'completed';
      } else if (step1Data.audio?._failed) {
        subStepStatuses.audio = 'failed';
      }
      if (asrSkipped || (result.shots && Array.isArray(result.shots) && result.shots.length > 0)) {
        subStepStatuses.whisper = 'completed';
      } else if (step1Data.asr?._failed) {
        subStepStatuses.whisper = 'failed';
      }
      if (facesSkipped || (result.roles && result.roles.length > 0)) {
        subStepStatuses.faces = 'completed';
      } else if (step1Data.faces?._failed) {
        subStepStatuses.faces = 'failed';
      }

      const mergedSubStepStatuses = { ...(existingMeta.subStepStatuses || {}), ...subStepStatuses };
      const mergedMeta = { ...existingMeta, subStepStatuses: mergedSubStepStatuses };
      db.prepare('UPDATE projects SET metadata = ? WHERE id = ?').run(JSON.stringify(mergedMeta), projectId);

      AppLogger.info(LOG_TAGS.SCHEDULER, `[PipelineResultWriter] subStepStatuses 已持久化到 metadata`, { subStepStatuses: mergedSubStepStatuses });
    } catch (metaErr: any) {
      AppLogger.warn(LOG_TAGS.SCHEDULER, `[PipelineResultWriter] 持久化 subStepStatuses 到 metadata 失败（非致命）`, { error: metaErr.message });
    }
  }
}