export const PROJECT_SQL = {
  // --- 基础读写 ---
  FIND_ALL: `
    SELECT id, name, category, cover_path as coverPath, duration, create_time as createdAt, update_time as updatedAt 
    FROM projects WHERE is_deleted = 0 ORDER BY create_time DESC, update_time DESC
  `,
  FIND_BY_ID: `\n    SELECT id, name, category, cover_path as coverPath, duration, \n           canvas_data as canvasData,\n           create_time as createdAt, update_time as updatedAt \n    FROM projects WHERE id = @id AND is_deleted = 0\n  `,
  CREATE: `
    INSERT INTO projects (id, name, create_time, update_time, is_deleted) 
    VALUES (@id, @name, datetime('now', 'localtime'), datetime('now', 'localtime'), 0)
  `,
  UPDATE_NAME: `UPDATE projects SET name = @name, update_time = datetime('now', 'localtime') WHERE id = @id AND is_deleted = 0`,
  UPDATE_PATH: `UPDATE projects SET path = @path, update_time = datetime('now', 'localtime') WHERE id = @id AND is_deleted = 0`,
  UPDATE_NAME_AND_PATH: `UPDATE projects SET name = @name, path = @path, update_time = datetime('now', 'localtime') WHERE id = @id AND is_deleted = 0`,
  
  // --- 级联软删除 ---
  SOFT_DELETE_PROJECT: `UPDATE projects SET is_deleted = 1, update_time = datetime('now', 'localtime') WHERE id = @projectId`,
  SOFT_DELETE_MEDIA: `UPDATE media_assets SET is_deleted = 1 WHERE project_id = @projectId`,
  SOFT_DELETE_ROLES: `UPDATE roles SET is_deleted = 1 WHERE project_id = @projectId`,
  SOFT_DELETE_SHOTS: `UPDATE shots SET is_deleted = 1 WHERE project_id = @projectId`,

  // --- 工程克隆 (Duplicate) 提取 ---
  COPY_PROJECT: `
    INSERT INTO projects (id, name, path, cover_path, duration, create_time, update_time, is_deleted) 
    VALUES (@newId, @newName, @path, @coverPath, @duration, datetime('now', 'localtime'), datetime('now', 'localtime'), 0)
  `,
  GET_ALL_MEDIA: `SELECT * FROM media_assets WHERE project_id = @projectId AND is_deleted = 0`,
  GET_ALL_ROLES: `SELECT * FROM roles WHERE project_id = @projectId AND is_deleted = 0`,
  GET_ALL_SHOTS: `SELECT * FROM shots WHERE project_id = @projectId AND is_deleted = 0 ORDER BY time_code ASC, start_time ASC`,

  // --- 宪法级防呆设计：全字段安全写入 ---
  INSERT_MEDIA_FULL: `
    INSERT INTO media_assets (
      id, project_id, episode_num, type, name, file_path, cover_path, duration, status,
      width, height, fps, frames, extracted_audio, extracted_vocals, extracted_bgm,
      extracted_text, extract_duration, narration_script, create_time, update_time, is_deleted
    ) VALUES (
      @id, @projectId, @episodeNum, @type, @name, @filePath, @coverPath, @duration, @status,
      @width, @height, @fps, @frames, @extractedAudio, @extractedVocals, @extractedBgm,
      @extractedText, @extractDuration, @narrationScript, datetime('now', 'localtime'), datetime('now', 'localtime'), 0
    )
  `,
  INSERT_ROLE_FULL: `
    INSERT INTO roles (
      id, project_id, system_id, name, pronoun, avatar, description, voice_id, merged_roles, create_time, update_time, is_deleted
    ) VALUES (
      @id, @projectId, @systemId, @name, @pronoun, @avatar, @description, @voiceId, @mergedRoles, datetime('now', 'localtime'), datetime('now', 'localtime'), 0
    )
  `,
  INSERT_SHOT_FULL: `
    INSERT INTO shots (
      id, project_id, episode_num, time_code, duration, ai_text, original_text,
      role_id, original_role_id, cover_path, reasoning, characters, camera,
      audio_path, audio_duration, align_strategy, start_time, end_time,
      audio_emotion, vision_text, context_frames, create_time, update_time, is_deleted
    ) VALUES (
      @id, @projectId, @episodeNum, @timeCode, @duration, @aiText, @originalText,
      @roleId, @originalRoleId, @coverPath, @reasoning, @characters, @camera,
      @audioPath, @audioDuration, @alignStrategy, @startTime, @endTime,
      @audioEmotion, @visionText, @contextFrames, datetime('now', 'localtime'), datetime('now', 'localtime'), 0
    )
  `,

  // --- 大盘保存 (Upsert) ---
  UPSERT_MEDIA: `
    INSERT INTO media_assets (
      id, project_id, episode_num, type, name, file_path, cover_path, duration, status, width, height, fps, frames,
      extracted_audio, extracted_vocals, extracted_bgm, extracted_text, extract_duration, narration_script, update_time, is_deleted
    ) VALUES (
      @id, @projectId, @episodeNum, @type, @name, @filePath, @coverPath, @duration, @status, @width, @height, @fps, @frames,
      @extractedAudio, @extractedVocals, @extractedBgm, @extractedText, @extractDuration, @narrationScript, datetime('now', 'localtime'), 0
    ) ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, file_path = excluded.file_path, cover_path = excluded.cover_path, duration = excluded.duration,
      status = excluded.status, frames = excluded.frames, extracted_audio = excluded.extracted_audio,
      extracted_vocals = excluded.extracted_vocals, extracted_bgm = excluded.extracted_bgm, extracted_text = excluded.extracted_text,
      extract_duration = excluded.extract_duration, narration_script = excluded.narration_script, update_time = datetime('now', 'localtime')
  `,
  HARD_DELETE_ROLES: `DELETE FROM roles WHERE project_id = @projectId`,
  HARD_DELETE_SHOTS: `DELETE FROM shots WHERE project_id = @projectId`,
  HARD_DELETE_AI_SHOTS: `DELETE FROM shots WHERE project_id = @projectId AND id LIKE 'ai_shot_%'`,

  // --- 局部更新 ---
  UPDATE_SHOT_VISION: `UPDATE shots SET vision_text = @visionText, update_time = datetime("now", "localtime") WHERE id = @id`,
  UPDATE_SHOT_AUDIO: `UPDATE shots SET audio_emotion = @audioEmotion, update_time = datetime("now", "localtime") WHERE id = @id`,
  
  // 💥 Phase 1.2: 新增画布数据更新语句
  UPDATE_CANVAS_DATA: `\n    UPDATE projects \n    SET canvas_data = @canvasData, update_time = datetime('now', 'localtime') \n    WHERE id = @id AND is_deleted = 0\n  `
};
