// Module: media/import - SQL Queries (data layer)

export const MEDIA_SQL = {
  INSERT: `
    INSERT INTO media_assets (
      id, project_id, episode_num, type, name, file_path, cover_path, duration, status,
      width, height, fps, frames, extracted_audio, extracted_vocals, extracted_bgm,
      extracted_text, extract_duration, narration_script,
      separation_mode, separation_engine, vocals_is_fallback,
      create_time, update_time, is_deleted
    ) VALUES (
      @id, @projectId, 1, @type, @name, @filePath, @coverPath, @duration, @status,
      @width, @height, @fps, @frames, @extractedAudio, @extractedVocals, @extractedBgm,
      @extractedText, @extractDuration, @narrationScript,
      @separationMode, @separationEngine, @vocalsIsFallback,
      datetime('now', 'localtime'), datetime('now', 'localtime'), 0
    )
  `,

  FIND_BY_ID: `
    SELECT
      id, project_id as projectId, type, name, file_path as filePath,
      cover_path as coverPath, duration, status, width, height, fps,
      frames, extracted_audio as extractedAudio, extracted_vocals as extractedVocals,
      extracted_bgm as extractedBgm, extracted_text as extractedText,
      extract_duration as extractDuration, narration_script as narrationScript,
      separation_mode as separationMode, separation_engine as separationEngine,
      vocals_is_fallback as vocalsIsFallback
    FROM media_assets WHERE id = @id AND is_deleted = 0
  `,

  UPDATE: `
    UPDATE media_assets SET
      name = COALESCE(@name, name),
      status = COALESCE(@status, status),
      frames = COALESCE(@frames, frames),
      extracted_audio = COALESCE(@extractedAudio, extracted_audio),
      extracted_vocals = COALESCE(@extractedVocals, extracted_vocals),
      extracted_bgm = COALESCE(@extractedBgm, extracted_bgm),
      extracted_text = COALESCE(@extractedText, extracted_text),
      extract_duration = COALESCE(@extractDuration, extract_duration),
      narration_script = COALESCE(@narrationScript, narration_script),
      separation_mode = COALESCE(@separationMode, separation_mode),
      separation_engine = COALESCE(@separationEngine, separation_engine),
      vocals_is_fallback = COALESCE(@vocalsIsFallback, vocals_is_fallback),
      update_time = datetime('now', 'localtime')
    WHERE id = @id AND is_deleted = 0
  `,

  UPDATE_FULL: `
    UPDATE media_assets SET
      cover_path = @coverPath, status = @status,
      duration = @duration, width = @width, height = @height, fps = @fps,
      file_path = @filePath, update_time = datetime('now', 'localtime')
    WHERE id = @id AND is_deleted = 0
  `,

  PHYSICAL_DELETE: `
    DELETE FROM media_assets WHERE id = @id AND project_id = @projectId
  `,

  GET_COVER: `
    SELECT cover_path FROM media_assets WHERE id = @id AND project_id = @projectId
  `,

  GET_BY_PROJECT: `
    SELECT
      id, project_id as projectId, type, name, file_path as filePath,
      cover_path as coverPath, duration, status, width, height, fps,
      frames, extracted_audio as extractedAudio, extracted_vocals as extractedVocals,
      extracted_bgm as extractedBgm, extracted_text as extractedText,
      extract_duration as extractDuration, narration_script as narrationScript,
      separation_mode as separationMode, separation_engine as separationEngine,
      vocals_is_fallback as vocalsIsFallback
    FROM media_assets WHERE project_id = @projectId AND is_deleted = 0
    ORDER BY create_time DESC
  `,

  GET_AGENT_MEDIAS: `
    SELECT id, name FROM media_assets WHERE project_id = @projectId AND is_deleted = 0
  `,

  GET_AGENT_SHOTS: `
    SELECT id, start_time AS start, end_time AS end, original_text AS text, vision_text AS visionText
    FROM shots WHERE project_id = @projectId AND is_deleted = 0 ORDER BY start_time ASC
  `,
};
