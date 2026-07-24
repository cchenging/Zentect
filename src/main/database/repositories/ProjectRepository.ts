// 📁 路径: src/main/database/repositories/ProjectRepository.ts
import { SQLiteConnection } from '../core/SQLiteConnection';
import { PROJECT_SQL } from '../queries/ProjectQueries';
import { AppLogger } from '../../core/AppLogger';

export class ProjectRepository {
  private get db() { return SQLiteConnection.getInstance().getDB(); }

  /**
   * 💥 统一插入入口：所有通过 insert 进来的项目，都有统一的 create_time 和 update_time 强校验
   * 避免上层 Service 乱传导致时间戳格式不统一
   * @param project 项目数据对象
   * @returns 写入后的安全项目记录
   */
  public insert(project: any) {
    const now = Date.now(); // 💥 统一在此处生成标准 13 位毫秒时间戳
    
    // 补齐缺省字段，确保不出 NOT NULL 错误，并统一时间基准
    const safeProject = {
      ...project,
      create_time: project.create_time || now,
      update_time: project.update_time || now,
      status: project.status || 'active',
      type: project.type || 'workflow'
    };

    const stmt = this.db.prepare(`
      INSERT INTO projects (id, name, path, type, status, create_time, update_time)
      VALUES (@id, @name, @path, @type, @status, @create_time, @update_time)
    `);
    
    stmt.run({
      id: safeProject.id,
      name: safeProject.name,
      path: safeProject.path || '',
      type: safeProject.type,
      status: safeProject.status,
      create_time: safeProject.create_time,
      update_time: safeProject.update_time
    });

    return safeProject;
  }

  public findAll() {
    return this.db.prepare(PROJECT_SQL.FIND_ALL).all();
  }

  public findById(id: string): any {
    return this.findQuickProjectById(id);
  }

  public create(id: string, name: string) {
    this.db.prepare(PROJECT_SQL.CREATE).run({ id, name });
  }

  public delete(id: string) {
    const transaction = this.db.transaction(() => {
      this.db.prepare(PROJECT_SQL.SOFT_DELETE_PROJECT).run({ projectId: id });
      this.db.prepare(PROJECT_SQL.SOFT_DELETE_MEDIA).run({ projectId: id });
      this.db.prepare(PROJECT_SQL.SOFT_DELETE_ROLES).run({ projectId: id });
      this.db.prepare(PROJECT_SQL.SOFT_DELETE_SHOTS).run({ projectId: id });
    });
    transaction();
  }

  public updateName(id: string, name: string) {
    this.db.prepare(PROJECT_SQL.UPDATE_NAME).run({ id, name });
  }

  public updatePath(id: string, dir: string) {
    this.db.prepare(PROJECT_SQL.UPDATE_PATH).run({ id, path: dir });
  }

  public updateNameAndPath(id: string, name: string, dir: string) {
    this.db.prepare(PROJECT_SQL.UPDATE_NAME_AND_PATH).run({ id, name, path: dir });
  }

  /** 回写项目目录磁盘占用大小（字节） */
  public updateDiskSize(id: string, size: number) {
    this.db.prepare(`
      UPDATE projects SET disk_size = @size, update_time = datetime('now', 'localtime') WHERE id = @id
    `).run({ id, size });
  }

  /** 回写项目总时长（秒数，TEXT 类型） */
  public updateDuration(id: string, duration: string) {
    this.db.prepare(`
      UPDATE projects SET duration = @duration, update_time = datetime('now', 'localtime') WHERE id = @id
    `).run({ id, duration });
  }

  /** 汇总项目关联素材的总时长（秒数，从 media_assets 聚合） */
  public getMediaTotalDuration(projectId: string): number | null {
    const row = this.db.prepare(
      `SELECT SUM(duration) as total FROM media_assets WHERE project_id = ? AND is_deleted = 0`
    ).get(projectId) as { total: number | null };
    return row?.total ?? null;
  }

  public duplicate(oldId: string, newId: string, newName: string, suffix: string, oldProject: any, newPath: string) {
    const transaction = this.db.transaction(() => {
      this.db.prepare(PROJECT_SQL.COPY_PROJECT).run({
        newId, newName, path: newPath, coverPath: oldProject.coverPath || null, duration: oldProject.duration || '0'
      });

      const medias = this.db.prepare(PROJECT_SQL.GET_ALL_MEDIA).all({ projectId: oldId }) as any[];
      const insertMedia = this.db.prepare(PROJECT_SQL.INSERT_MEDIA_FULL);
      for (const m of medias) {
        insertMedia.run({
          id: m.id + suffix, projectId: newId, episodeNum: m.episode_num || 1, type: m.type, name: m.name,
          filePath: m.file_path ? m.file_path.replace(oldId, newId) : null,
          coverPath: m.cover_path ? m.cover_path.replace(oldId, newId) : null,
          duration: m.duration, status: m.status, width: m.width, height: m.height, fps: m.fps,
          frames: m.frames ? m.frames.replace(new RegExp(oldId, 'g'), newId) : null,
          extractedAudio: m.extracted_audio ? m.extracted_audio.replace(oldId, newId) : null,
          extractedVocals: m.extracted_vocals ? m.extracted_vocals.replace(oldId, newId) : null,
          extractedBgm: m.extracted_bgm ? m.extracted_bgm.replace(oldId, newId) : null,
          extractedText: m.extracted_text || null, extractDuration: m.extract_duration || null, narrationScript: m.narration_script || null
        });
      }

      const roles = this.db.prepare(PROJECT_SQL.GET_ALL_ROLES).all({ projectId: oldId }) as any[];
      const insertRole = this.db.prepare(PROJECT_SQL.INSERT_ROLE_FULL);
      for (const r of roles) {
        insertRole.run({
          id: r.id + suffix, projectId: newId, systemId: r.system_id || null, name: r.name, pronoun: r.pronoun,
          avatar: r.avatar ? r.avatar.replace(oldId, newId) : null, description: r.description, voiceId: r.voice_id,
          mergedRoles: r.merged_roles ? r.merged_roles.replace(new RegExp(oldId, 'g'), newId) : null
        });
      }

      const shots = this.db.prepare(PROJECT_SQL.GET_ALL_SHOTS).all({ projectId: oldId }) as any[];
      const insertShot = this.db.prepare(PROJECT_SQL.INSERT_SHOT_FULL);
      for (const s of shots) {
        insertShot.run({
          id: s.id + suffix, projectId: newId, episodeNum: s.episode_num || 1, timeCode: s.time_code, duration: s.duration,
          aiText: s.ai_text || '', originalText: s.original_text || '',
          roleId: s.role_id ? s.role_id + suffix : null, originalRoleId: s.original_role_id ? s.original_role_id + suffix : null,
          coverPath: s.cover_path ? s.cover_path.replace(oldId, newId) : null, reasoning: s.reasoning || '',
          characters: s.characters ? s.characters.replace(new RegExp(oldId, 'g'), newId) : null, camera: s.camera || '',
          audioPath: s.audio_path ? s.audio_path.replace(oldId, newId) : null, audioDuration: s.audio_duration || 0,
          alignStrategy: s.align_strategy || 'slow', startTime: s.start_time || 0, endTime: s.end_time || 0,
          audioEmotion: s.audio_emotion || '', visionText: s.vision_text || '',
          contextFrames: s.context_frames ? s.context_frames.replace(new RegExp(oldId, 'g'), newId) : null
        });
      }
    });
    transaction();
  }

  public loadFullProjectData(projectId: string) {
    const project = this.findById(projectId);
    if (!project) return null;

    // 从 metadata 中恢复数据
    let metadata: any = {};
    if (project.metadata) {
      try {
        metadata = typeof project.metadata === 'string' ? JSON.parse(project.metadata) : project.metadata;
      } catch (e) {
        console.error('[Repo] 解析 metadata 失败:', e);
      }
    }

    // 💥 关键修复：canvas_data 中保存的管线运行时状态（frameCount/audioSeparated/subStepStatuses 等）
    // 优先于 metadata 中的旧值。SyncDaemon 每 5 秒将最新状态写入 canvas_data，
    // 而 metadata 仅在管线步骤完成时通过 saveFullProjectData 更新。
    // 若管线中断，metadata 中可能残留旧值或 running 状态，canvas_data 中的值更准确。
    let canvasObj: any = {};
    if (project.canvasData) {
      try {
        canvasObj = typeof project.canvasData === 'string' ? JSON.parse(project.canvasData) : project.canvasData;
      } catch (e) {
        console.error('[Repo] 解析 canvas_data 失败:', e);
      }
    }
    // canvas_data 中的值覆盖 metadata（排除画布结构专用字段和独立表已有字段）
    const CANVAS_SKIP_KEYS = new Set(['nodes', 'edges', 'mediaItems', 'viewport', 'shots', 'aiShots', 'roles']);
    for (const [key, val] of Object.entries(canvasObj)) {
      if (CANVAS_SKIP_KEYS.has(key)) continue;
      if (val !== undefined && val !== null) {
        (metadata as any)[key] = val;
      }
    }

    const rawMediaRows = this.db.prepare(PROJECT_SQL.GET_ALL_MEDIA).all({ projectId });
    console.log(`[DEBUG][Repo] projectId=${projectId}, rawMediaRows count=${rawMediaRows.length}`);
    if (rawMediaRows.length > 0) {
      console.log(`[DEBUG][Repo] first raw row:`, JSON.stringify(rawMediaRows[0]));
    }

    let mediaItems = rawMediaRows.map((m: any) => ({
      id: m.id, name: m.name, type: m.type, filePath: m.file_path, coverPath: m.cover_path,
      duration: m.duration, width: m.width, height: m.height, fps: m.fps, status: m.status || 'parsed',
      frames: m.frames ? JSON.parse(m.frames) : undefined, extractedAudio: m.extracted_audio || undefined,
      extractedVocals: m.extracted_vocals || undefined, extractedBgm: m.extracted_bgm || undefined,
      extractedText: m.extracted_text || undefined, extractDuration: m.extract_duration ? parseFloat(m.extract_duration) : undefined,
      narrationScript: m.narration_script ? JSON.parse(m.narration_script) : undefined
    }));
    console.log(`[DEBUG][Repo] mapped mediaItems count=${mediaItems.length}`);

    // 💥 关键修复：DB 中的数据（管线最新结果）优先于 metadata 中的旧数据
    // metadata 中的 mediaItems 可能包含过时的 frames（如旧策略的 211 帧），
    // 而 DB 中已被管线更新为新值（如 13 帧），应始终以 DB 为准
    if (metadata.mediaItems && Array.isArray(metadata.mediaItems) && metadata.mediaItems.length > 0) {
      const rawMediaMap = new Map(mediaItems.map((m: any) => [m.id, m]));
      mediaItems = metadata.mediaItems.map((m: any) => {
        const raw = rawMediaMap.get(m.id);
        if (raw) {
          // 🔧 修复：DB 数据优先，但过滤掉 null/undefined 字段，避免覆盖 metadata 的好值
          // 旧版 bug：{ ...m, ...raw } 会让 raw.name=null 覆盖 m.name=文件名 → "未命名"
          // 新版：对 raw 的 null/undefined 字段不覆盖，只让真实值生效
          const filteredRaw: Record<string, any> = {};
          for (const [k, v] of Object.entries(raw)) {
            if (v !== null && v !== undefined) {
              filteredRaw[k] = v;
            }
          }
          return { ...m, ...filteredRaw };
        }
        return { ...m, name: m.name || m.fileName || (m.filePath ? m.filePath.split(/[\\/]/).pop() : '未命名') };
      });
    }

    const roles = this.db.prepare(PROJECT_SQL.GET_ALL_ROLES).all({ projectId }).map((r: any) => ({
      id: r.id, systemId: r.systemId, name: r.name, pronoun: r.pronoun, description: r.description,
      voiceId: r.voice_id, mergedRoles: r.merged_roles ? JSON.parse(r.merged_roles) : []
    }));

    const allShots = this.db.prepare(PROJECT_SQL.GET_ALL_SHOTS).all({ projectId }).map((s: any) => ({
      id: s.id, time: s.time_code, duration: s.duration, start: s.start_time || 0, end: s.end_time || 0,
      originalText: s.original_text || '', aiText: s.ai_text || '', roleId: s.role_id || null, originalRoleId: s.original_role_id || null,
      coverPath: s.cover_path || '', reasoning: s.reasoning || '', characters: s.characters ? JSON.parse(s.characters) : [],
      camera: s.camera || '', audioPath: s.audio_path || '', audioDuration: s.audio_duration || 0, alignStrategy: s.align_strategy || 'slow',
      audioEmotion: s.audio_emotion || '', visionText: s.vision_text || '', contextFrames: s.context_frames ? JSON.parse(s.context_frames) : []
    }));

    return {
      projectId,
      projectName: project.name,
      canvasData: project.canvasData,
      mediaItems,
      roles,
      shots: allShots.filter((s: any) => !s.id.startsWith('ai_shot_')),
      aiShots: allShots.filter((s: any) => s.id.startsWith('ai_shot_')),
      // 把 metadata 中的其他字段也返回，方便 hydrate
      // 💥 关键修复：排除 mediaItems（已在上面精确合并），防止 ...metadata 覆盖带 frames 的数据
      ...Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== 'mediaItems'))
    };
  }

  public saveFullProjectData(projectId: string, data: any) {
    const transaction = this.db.transaction(() => {
      /** 💥 关键修复：合并现有 metadata 而非覆盖，防止不同调用方写入的字段互相覆盖 */
      const project = this.findById(projectId);
      let existingMetadata: any = {};
      if (project?.metadata) {
        try {
          existingMetadata = typeof project.metadata === 'string'
            ? JSON.parse(project.metadata) : project.metadata;
        } catch {}
      }

      const metadata: any = { ...existingMetadata };
      if (data.asrLines) metadata.asrLines = data.asrLines;
      if (data.frameCount !== undefined) metadata.frameCount = data.frameCount;
      /** 💥 持久化帧路径数组，确保重进项目帧数据不丢失 */
      if (data.framePaths && Array.isArray(data.framePaths) && data.framePaths.length > 0) {
        metadata.framePaths = data.framePaths;
      }
      if (data.audioSeparated !== undefined) metadata.audioSeparated = data.audioSeparated;
      if (data.subStepStatuses) metadata.subStepStatuses = data.subStepStatuses;
      if (data.subStepProgresses) metadata.subStepProgresses = data.subStepProgresses;
      if (data.stepStatuses) metadata.stepStatuses = data.stepStatuses;
      if (data.stepCompleted) metadata.stepCompleted = data.stepCompleted;
      /** 💥 持久化当前步骤，确保重进后能继续下一步 */
      if (data.currentStep) metadata.currentStep = data.currentStep;
      if (data.storyboardMode) metadata.storyboardMode = data.storyboardMode;
      /** 💥 持久化抽帧配置，确保重进项目后参数不丢失 */
      if (data.extractionConfig) metadata.extractionConfig = data.extractionConfig;
      /** 💥 持久化 VLM 画面描述数据，确保重进项目后步骤2数据不丢失 */
      if (data.vlmFrames && Array.isArray(data.vlmFrames) && data.vlmFrames.length > 0) {
        metadata.vlmFrames = data.vlmFrames;
      }
      /** 💥 持久化步骤3解说文案数据，确保重进项目后文案不丢失 */
      if (data.scriptParagraphs && Array.isArray(data.scriptParagraphs) && data.scriptParagraphs.length > 0) {
        metadata.scriptParagraphs = data.scriptParagraphs;
      }
      if (data.scriptStyle) metadata.scriptStyle = data.scriptStyle;
      if (data.speechRate) metadata.speechRate = data.speechRate;
      if (data.pipelineParams) metadata.pipelineParams = data.pipelineParams;
      /** 💥 持久化步骤4配音结果，确保重进项目后配音数据不丢失 */
      if (data.ttsResults && Array.isArray(data.ttsResults) && data.ttsResults.length > 0) {
        metadata.ttsResults = data.ttsResults;
      }
      if (data.ttsEngine) metadata.ttsEngine = data.ttsEngine;
      if (data.ttsVoiceId) metadata.ttsVoiceId = data.ttsVoiceId;

      // 保存 mediaItems 到 metadata（因为 media 表主要用于视频，而关键帧和音频是临时的）
      if (data.mediaItems && Array.isArray(data.mediaItems)) {
        metadata.mediaItems = data.mediaItems;
      }

      const metadataString = JSON.stringify(metadata);
      this.db.prepare(`UPDATE projects SET metadata = ? WHERE id = ?`).run(metadataString, projectId);

      if (data.canvasData) {
        this.db.prepare(PROJECT_SQL.UPDATE_CANVAS_DATA).run({ 
          id: projectId, 
          canvasData: data.canvasData 
        });
      }

      if (data.roles && Array.isArray(data.roles)) {
        this.db.prepare(PROJECT_SQL.HARD_DELETE_ROLES).run({ projectId });
        const insertRole = this.db.prepare(PROJECT_SQL.INSERT_ROLE_FULL);
        for (const role of data.roles) {
          insertRole.run({
            id: role.id, projectId, systemId: role.systemId || null, name: role.name || '', pronoun: role.pronoun || '',
            avatar: role.avatar || '', description: role.description || '', voiceId: role.voiceId || role.voice_id || '',
            mergedRoles: JSON.stringify(role.mergedRoles || [])
          });
        }
      }

      if (data.shots || data.aiShots) {
        this.db.prepare(PROJECT_SQL.HARD_DELETE_SHOTS).run({ projectId });
        const insertShot = this.db.prepare(PROJECT_SQL.INSERT_SHOT_FULL);
        /** 💥 关键修复：去重 shots 和 aiShots 中相同 id 的条目，防止 UNIQUE constraint failed */
        const allShots = [...(Array.isArray(data.shots) ? data.shots : []), ...(Array.isArray(data.aiShots) ? data.aiShots : [])];
        const seenIds = new Set<string>();
        for (const shot of allShots) {
          if (seenIds.has(shot.id)) continue;
          seenIds.add(shot.id);
          insertShot.run({
            id: shot.id, projectId, episodeNum: 1, timeCode: shot.time || shot.time_code || '', duration: shot.duration || '',
            aiText: shot.aiText || shot.ai_text || '', originalText: shot.originalText || shot.original_text || '',
            roleId: shot.roleId || shot.role_id || null, originalRoleId: shot.originalRoleId || null, coverPath: shot.coverPath || '',
            reasoning: shot.reasoning || '', characters: JSON.stringify(shot.characters || []), camera: shot.camera || '',
            audioPath: shot.audioPath || '', audioDuration: shot.audioDuration || 0, alignStrategy: shot.alignStrategy || 'slow',
            startTime: shot.start || 0, endTime: shot.end || 0, audioEmotion: shot.audioEmotion || '',
            visionText: shot.visionText || '', contextFrames: JSON.stringify(shot.contextFrames || [])
          });
        }
      }
    });
    transaction();
  }

  public replaceAiShots(projectId: string, aiShots: any[]) {
    const transaction = this.db.transaction(() => {
      this.db.prepare(PROJECT_SQL.HARD_DELETE_AI_SHOTS).run({ projectId });
      const insertShot = this.db.prepare(PROJECT_SQL.INSERT_SHOT_FULL);
      for (const shot of aiShots) {
        const safeId = shot.id.startsWith('ai_shot_') ? shot.id : `ai_shot_${shot.id}`;
        insertShot.run({
          id: safeId, projectId, episodeNum: 1, timeCode: shot.time || shot.time_code || '', duration: shot.duration || '',
          aiText: shot.aiText || shot.ai_text || '', originalText: shot.originalText || shot.original_text || '',
          roleId: shot.roleId || shot.role_id || null, originalRoleId: shot.originalRoleId || null, coverPath: shot.coverPath || '',
          reasoning: shot.reasoning || '', characters: JSON.stringify(shot.characters || []), camera: shot.camera || '',
          audioPath: shot.audioPath || '', audioDuration: shot.audioDuration || 0, alignStrategy: shot.alignStrategy || 'slow',
          startTime: shot.start || 0, endTime: shot.end || 0, audioEmotion: shot.audioEmotion || '',
          visionText: shot.visionText || '', contextFrames: JSON.stringify(shot.contextFrames || [])
        });
      }
    });
    transaction();
  }

  public updateShotFeatures(shotId: string, features: { visionText?: string, audioEmotion?: string }) {
    if (features.visionText !== undefined) {
      this.db.prepare(PROJECT_SQL.UPDATE_SHOT_VISION).run({ visionText: features.visionText, id: shotId });
    }
    if (features.audioEmotion !== undefined) {
      this.db.prepare(PROJECT_SQL.UPDATE_SHOT_AUDIO).run({ audioEmotion: features.audioEmotion, id: shotId });
    }
  }

  /**
   * 仅更新画布数据
   */
  public updateCanvasDataOnly(projectId: string, canvasData: string) {
    this.db.prepare(PROJECT_SQL.UPDATE_CANVAS_DATA).run({
      id: projectId,
      canvasData: canvasData
    });
  }

  /**
   * 更新项目封面
   */
  public updateCover(projectId: string, coverPath: string) {
    this.db.prepare(PROJECT_SQL.UPDATE_COVER).run({
      projectId,
      coverPath
    });
  }

  /** 💥【持久化打通 1】：完工写盘大闸。将生成的 ASR 字幕、音轨文件物理路径安全持久化更新入 projects 主表 */
  public updateQuickCardMetadata(projectId: string, extractedData: any): boolean {
    try {
      // 💥 关键修复：合并现有 metadata（不再粗暴覆盖整个列！）
      const project = this.findById(projectId);
      let existingMetadata: any = {};
      if (project?.metadata) {
        try {
          existingMetadata = typeof project.metadata === 'string'
            ? JSON.parse(project.metadata) : project.metadata;
        } catch {}
      }

      const metadataString = JSON.stringify({
        ...existingMetadata,
        videoPath: extractedData.videoPath || existingMetadata.videoPath || '',
        vocalPath: extractedData.vocalPath || existingMetadata.vocalPath || '',
        backgroundPath: extractedData.backgroundPath || existingMetadata.backgroundPath || '',
        asrLines: extractedData.asrLines || existingMetadata.asrLines || [],
        frameCount: extractedData.frameCount || existingMetadata.frameCount || 0,
        /** 💥 持久化帧路径数组，确保重进项目帧预览不丢失 */
        framePaths: extractedData.framePaths || existingMetadata.framePaths || [],
        updatedAt: Date.now()
      });

      // 极致性能：直接强刷主表的元数据列，消灭 [JobScheduler] 状态回写失败
      // 🔧 修复 P2-B：移除不存在的 video_path 列引用
      // 旧版 bug：projects 表 DDL（001_initial_schema.sql）无 video_path 列，
      //          该 SQL 执行时会抛 SQLITE_ERROR: no such column: video_path
      //          videoPath 已写入 metadata JSON，读取端 findQuickProjectById 从 metadata 解析即可
      const result = this.db.prepare(`
        UPDATE projects
        SET metadata = ?, status = 'analyzed'
        WHERE id = ?
      `).run(metadataString, projectId);

      AppLogger.info('ProjectRepository', `项目 [${projectId}] 核心影音资产在 100% 完工时安全写盘成功！`);
      return result.changes > 0;
    } catch (error: any) {
      console.error('[SQLite 完工状态回写意外流产]:', error);
      return false;
    }
  }

  /** 💥【持久化打通 2】：自愈拉盘大闸。重新进场第一毫秒，完美还原 assets 状态，阻击 undefined 发生 */
  public findQuickProjectById(id: string): any {
    try {
      const project = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
      if (!project) return null;

      // 如果有历史遗留的独立轨道资产，做向前兼容，保底令前端接收到的 shots 绝非 undefined
      let shots = [];
      try {
        shots = this.db.prepare('SELECT * FROM project_shots WHERE project_id = ?').all(id) || [];
      } catch {
        const meta = (project as any).metadata ? JSON.parse((project as any).metadata) : {};
        shots = meta.shots || [];
      }

      // 🔧 修复 P2-B：videoPath 从 metadata JSON 解析（projects 表无 video_path 列）
      // 旧版 bug：SELECT * 不含 video_path 列，始终返回 undefined
      const meta = (project as any).metadata
        ? (typeof (project as any).metadata === 'string'
            ? JSON.parse((project as any).metadata)
            : (project as any).metadata)
        : {};

      return {
        id: (project as any).id,
        name: (project as any).name,
        videoPath: meta.videoPath || '',
        metadata: (project as any).metadata,
        shots: shots
      };
    } catch (error) {
      console.error('[SQLite 仓储层读盘崩溃]:', error);
      return null;
    }
  }
}
