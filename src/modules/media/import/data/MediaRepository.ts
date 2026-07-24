// Module: media/import - MediaRepository (data layer)

import { SQLiteConnection } from '../../../infra/database/core/SQLiteConnection';
import { AppLogger } from '../../../infra/logger/AppLogger';
import { LOG_TAGS } from '../../../infra/logger/LogConstants';
import { AppError, ErrorCode } from '../../../infra/error/AppError';
import type { MediaItem, MediaRow } from '../types';
import { MEDIA_SQL } from './MediaQueries';

export class MediaRepository {
  private get db() {
    return SQLiteConnection.getInstance().getDB();
  }

  public insertMedia(
    media: MediaItem & {
      duration: number;
      width: number;
      height: number;
      fps: number;
      [key: string]: any;
    },
  ) {
    console.log(
      `[DEBUG][MediaRepo] insertMedia projectId=${media.projectId}, id=${media.id}, filePath=${media.filePath}`,
    );
    const result = this.db.prepare(MEDIA_SQL.INSERT).run({
      id: media.id,
      projectId: (media as any).projectId,
      type: media.type,
      name: media.name,
      filePath: media.filePath,
      coverPath: media.coverPath,
      duration: media.duration,
      status: media.status || 'ready',
      width: media.width || 0,
      height: media.height || 0,
      fps: media.fps || 0,
      frames: (media as any).frames ? JSON.stringify((media as any).frames) : null,
      extractedAudio: (media as any).extractedAudio || null,
      extractedVocals: (media as any).extractedVocals || null,
      extractedBgm: (media as any).extractedBgm || null,
      extractedText: (media as any).extractedText || null,
      extractDuration: (media as any).extractDuration || null,
      narrationScript: (media as any).narrationScript
        ? JSON.stringify((media as any).narrationScript)
        : null,
      // 音频分离配置：模式(fast/quality)、引擎(demucs/mdx/auto)、是否降级到原始音轨
      separationMode: (media as any).separationMode || 'quality',
      separationEngine: (media as any).separationEngine || 'auto',
      vocalsIsFallback: (media as any).vocalsIsFallback ? 1 : 0,
    });
    console.log(
      `[DEBUG][MediaRepo] insertMedia result changes=${result.changes}, lastInsertRowid=${result.lastInsertRowid}`,
    );
  }

  public findById(id: string): any {
    const row = this.db.prepare(MEDIA_SQL.FIND_BY_ID).get({ id });
    if (row) {
      return {
        ...row,
        frames: row.frames ? JSON.parse(row.frames) : undefined,
        narrationScript: row.narrationScript
          ? JSON.parse(row.narrationScript)
          : undefined,
      };
    }
    return null;
  }

  public updateMedia(id: string, media: any): void {
    this.db.prepare(MEDIA_SQL.UPDATE).run({
      id,
      name: media.name,
      status: media.status,
      frames: media.frames ? JSON.stringify(media.frames) : null,
      extractedAudio: media.extractedAudio || null,
      extractedVocals: media.extractedVocals || null,
      extractedBgm: media.extractedBgm || null,
      extractedText: media.extractedText || null,
      extractDuration: media.extractDuration || null,
      narrationScript: media.narrationScript
        ? JSON.stringify(media.narrationScript)
        : null,
      // 音频分离配置：未提供时回退到默认值，避免覆盖已有记录
      separationMode: media.separationMode || 'quality',
      separationEngine: media.separationEngine || 'auto',
      vocalsIsFallback: media.vocalsIsFallback ? 1 : 0,
    });
  }

  /** 更新媒体元数据字段（coverPath/duration/width/height/fps/status/filePath） */
  public updateMediaMeta(
    id: string,
    patch: {
      coverPath?: string;
      status?: string;
      duration?: number;
      width?: number;
      height?: number;
      fps?: number;
      filePath?: string;
    },
  ): void {
    this.db.prepare(MEDIA_SQL.UPDATE_FULL).run({
      id,
      coverPath: patch.coverPath ?? null,
      status: patch.status ?? null,
      duration: patch.duration ?? null,
      width: patch.width ?? null,
      height: patch.height ?? null,
      fps: patch.fps ?? null,
      filePath: patch.filePath ?? null,
    });
  }

  public deleteMediaById(projectId: string, mediaId: string): void {
    this.db.prepare(MEDIA_SQL.PHYSICAL_DELETE).run({
      id: mediaId,
      projectId,
    });
  }

  public getCoverPath(projectId: string, mediaId: string): string | null {
    const row = this.db
      .prepare(MEDIA_SQL.GET_COVER)
      .get({ id: mediaId, projectId }) as
      | { cover_path: string }
      | undefined;
    return row?.cover_path || null;
  }

  public getByProject(projectId: string): any[] {
    try {
      const medias = this.db
        .prepare(MEDIA_SQL.GET_BY_PROJECT)
        .all({ projectId });
      return medias.map((row: any) => ({
        id: row.id,
        name: row.name,
        type: row.type,
        filePath: row.filePath,
        coverPath: row.coverPath,
        duration: row.duration,
        width: row.width,
        height: row.height,
        fps: row.fps,
        status: row.status || 'parsed',
        frames: row.frames ? JSON.parse(row.frames) : undefined,
        extractedAudio: row.extractedAudio || undefined,
        extractedVocals: row.extractedVocals || undefined,
        extractedBgm: row.extractedBgm || undefined,
        extractedText: row.extractedText || undefined,
        extractDuration: row.extractDuration
          ? parseFloat(row.extractDuration)
          : undefined,
        narrationScript: row.narrationScript
          ? JSON.parse(row.narrationScript)
          : undefined,
        // 音频分离配置：供前端展示降级提示与下游消费
        separationMode: row.separationMode || 'quality',
        separationEngine: row.separationEngine || 'auto',
        vocalsIsFallback: !!row.vocalsIsFallback,
      }));
    } catch (e: any) {
      AppLogger.error(LOG_TAGS.DATABASE, `获取项目媒体列表崩溃：${e.message}`);
      throw new AppError(
        ErrorCode.DATABASE_ERROR,
        `读取项目媒体失败：${e.message}`,
      );
    }
  }

  public getAgentContextData(projectId: string): {
    medias: Partial<MediaItem>[];
    shots: Partial<{ id: string; start: number; end: number; text: string; visionText: string }>[];
  } {
    try {
      const medias = this.db
        .prepare(MEDIA_SQL.GET_AGENT_MEDIAS)
        .all({ projectId }) as Partial<MediaItem>[];
      const shots = this.db
        .prepare(MEDIA_SQL.GET_AGENT_SHOTS)
        .all({ projectId }) as Partial<{
        id: string;
        start: number;
        end: number;
        text: string;
        visionText: string;
      }>[];
      return { medias, shots };
    } catch (e: any) {
      AppLogger.error(
        LOG_TAGS.DATABASE,
        `获取 Agent 工程快照崩溃：${e.message}`,
      );
      throw new AppError(
        ErrorCode.DATABASE_ERROR,
        `读取工程快照失败：${e.message}`,
      );
    }
  }
}
