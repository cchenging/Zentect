// 💥 宪法级统一管理：媒体资产域的所有 SQL 语句单一事实来源
export const MEDIA_SQL = {
  // 采用 @ 命名参数，彻底消灭参数顺序错位的隐患
  INSERT: `
    INSERT INTO media_assets (
      id, project_id, episode_num, type, name, file_path, cover_path, duration, status,
      width, height, fps, frames, extracted_audio, extracted_vocals, extracted_bgm,
      extracted_text, extract_duration, narration_script, create_time, update_time, is_deleted
    ) VALUES (
      @id, @projectId, 1, @type, @name, @filePath, @coverPath, @duration, @status,
      @width, @height, @fps, @frames, @extractedAudio, @extractedVocals, @extractedBgm,
      @extractedText, @extractDuration, @narrationScript, datetime('now', 'localtime'), datetime('now', 'localtime'), 0
    )
  `,

  FIND_BY_ID: `
    SELECT
      id,
      project_id as projectId,
      type,
      name,
      file_path as filePath,
      cover_path as coverPath,
      duration,
      status,
      width,
      height,
      fps,
      frames,
      extracted_audio as extractedAudio,
      extracted_vocals as extractedVocals,
      extracted_bgm as extractedBgm,
      extracted_text as extractedText,
      extract_duration as extractDuration,
      narration_script as narrationScript
    FROM media_assets
    WHERE id = @id AND is_deleted = 0
  `,

  UPDATE: `
    UPDATE media_assets
    SET name = @name,
        status = @status,
        frames = @frames,
        extracted_audio = @extractedAudio,
        extracted_vocals = @extractedVocals,
        extracted_bgm = @extractedBgm,
        extracted_text = @extractedText,
        extract_duration = @extractDuration,
        narration_script = @narrationScript,
        update_time = datetime('now', 'localtime')
    WHERE id = @id AND is_deleted = 0
  `,

  PHYSICAL_DELETE: `
    DELETE FROM media_assets
    WHERE id = @id AND project_id = @projectId
  `,

  GET_COVER: `
    SELECT cover_path
    FROM media_assets
    WHERE id = @id AND project_id = @projectId
  `,

  // 💥 宪法级标准：严格提取必要的字段，拒绝 SELECT *
  GET_AGENT_MEDIAS: `
    SELECT
      id,
      name
    FROM media_assets
    WHERE project_id = @projectId AND is_deleted = 0
  `,
  
  // 💥 新增：按项目获取所有媒体资产（完整信息）
  GET_BY_PROJECT: `
    SELECT
      id,
      project_id as projectId,
      type,
      name,
      file_path as filePath,
      cover_path as coverPath,
      duration,
      status,
      width,
      height,
      fps,
      frames,
      extracted_audio as extractedAudio,
      extracted_vocals as extractedVocals,
      extracted_bgm as extractedBgm,
      extracted_text as extractedText,
      extract_duration as extractDuration,
      narration_script as narrationScript
    FROM media_assets
    WHERE project_id = @projectId AND is_deleted = 0
    ORDER BY create_time DESC
  `,
  
  // 💥 宪法级修正：严格按照 ProjectQueries.ts 中的真实物理字段提取，剔除不存在的 media_id
  GET_AGENT_SHOTS: `
    SELECT
      id,
      start_time AS start,
      end_time AS end,
      original_text AS text,
      vision_text AS visionText
    FROM shots
    WHERE project_id = @projectId AND is_deleted = 0
    ORDER BY start_time ASC
  `
};
