import { SQLiteConnection } from '../core/SQLiteConnection';
import { PROJECT_SQL } from '../queries/ProjectQueries';

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
    return this.db.prepare(PROJECT_SQL.FIND_BY_ID).get({ id });
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

    const mediaItems = this.db.prepare(PROJECT_SQL.GET_ALL_MEDIA).all({ projectId }).map((m: any) => ({
      id: m.id, name: m.name, type: m.type, filePath: m.file_path, coverPath: m.cover_path,
      duration: m.duration, width: m.width, height: m.height, fps: m.fps, status: m.status || 'parsed',
      frames: m.frames ? JSON.parse(m.frames) : undefined, extractedAudio: m.extracted_audio || undefined,
      extractedVocals: m.extracted_vocals || undefined, extractedBgm: m.extracted_bgm || undefined,
      extractedText: m.extracted_text || undefined, extractDuration: m.extract_duration ? parseFloat(m.extract_duration) : undefined,
      narrationScript: m.narration_script ? JSON.parse(m.narration_script) : undefined
    }));

    const roles = this.db.prepare(PROJECT_SQL.GET_ALL_ROLES).all({ projectId }).map((r: any) => ({
      id: r.id, systemId: r.system_id, name: r.name, pronoun: r.pronoun, avatar: r.avatar, description: r.description,
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
      canvasData: project.canvasData,  // 💥 Phase 1.3: 返回画布 JSON 数据
      mediaItems, 
      roles,
      shots: allShots.filter((s: any) => !s.id.startsWith('ai_shot_')), 
      aiShots: allShots.filter((s: any) => s.id.startsWith('ai_shot_'))
    };
  }

  public saveFullProjectData(projectId: string, data: any) {
    const transaction = this.db.transaction(() => {
      // 💥 Phase 1.3: 如果前端传入了 canvasData，保存到 projects 表
      if (data.canvasData) {
        this.db.prepare(PROJECT_SQL.UPDATE_CANVAS_DATA).run({ 
          id: projectId, 
          canvasData: data.canvasData 
        });
      }

      if (data.mediaItems && Array.isArray(data.mediaItems)) {
        const insertMedia = this.db.prepare(PROJECT_SQL.UPSERT_MEDIA);
        for (const item of data.mediaItems) {
          insertMedia.run({
            id: item.id, projectId, episodeNum: 1, type: item.type, name: item.name, filePath: item.filePath,
            coverPath: item.coverPath || '', duration: item.duration, status: item.status, width: item.width || 0,
            height: item.height || 0, fps: item.fps || 0, frames: item.frames ? JSON.stringify(item.frames) : null,
            extractedAudio: item.extractedAudio || null, extractedVocals: item.extractedVocals || null,
            extractedBgm: item.extractedBgm || null, extractedText: item.extractedText || null,
            extractDuration: item.extractDuration || null, narrationScript: item.narrationScript ? JSON.stringify(item.narrationScript) : null
          });
        }
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
        const allShots = [...(Array.isArray(data.shots) ? data.shots : []), ...(Array.isArray(data.aiShots) ? data.aiShots : [])];
        for (const shot of allShots) {
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
   * @param projectId 项目ID
   * @param canvasData 画布数据JSON字符串
   */
  public updateCanvasDataOnly(projectId: string, canvasData: string) {
    this.db.prepare(PROJECT_SQL.UPDATE_CANVAS_DATA).run({ 
      id: projectId, 
      canvasData: canvasData 
    });
  }
}
