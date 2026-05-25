// 📁 路径：src/main/database/repositories/MediaRepository.ts
import { SQLiteConnection } from '../core/SQLiteConnection';
import { MediaItem, Shot } from '../../../shared/types'; // 💥 修复：修正目录层级为 3 层
import { MEDIA_SQL } from '../queries/MediaQueries';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '../../../shared/utils/LogConstants';
import { AppError, ErrorCode } from '../../../shared/utils/AppError';

export class MediaRepository {
  private get db() { return SQLiteConnection.getInstance().getDB(); }

  public insertMedia(media: MediaItem & { duration: number, width: number, height: number, fps: number }) {
    this.db.prepare(MEDIA_SQL.INSERT).run({
      id: media.id,
      projectId: media.projectId,
      type: media.type,
      name: media.name,
      filePath: media.filePath,
      coverPath: media.coverPath,
      duration: media.duration,
      width: media.width,
      height: media.height,
      fps: media.fps
    });
  }

  public findById(id: string): any {
    const row = this.db.prepare(MEDIA_SQL.FIND_BY_ID).get({ id });
    
    if (row) {
      return {
        ...row,
        frames: row.frames ? JSON.parse(row.frames) : undefined
      };
    }
    return null;
  }

  public update(id: string, media: any): void {
    this.db.prepare(MEDIA_SQL.UPDATE_STATUS).run({
      id: id,
      name: media.name,
      status: media.status,
      frames: media.frames ? JSON.stringify(media.frames) : null,
      extractedAudio: media.extractedAudio || null,
      extractedVocals: media.extractedVocals || null,
      extractedBgm: media.extractedBgm || null,
      extractDuration: media.extractDuration || null
    });
  }

  public deleteMediaById(projectId: string, mediaId: string): void {
    this.db.prepare(MEDIA_SQL.PHYSICAL_DELETE).run({ id: mediaId, projectId });
  }

  public getCoverPath(projectId: string, mediaId: string): string | null {
    const row = this.db.prepare(MEDIA_SQL.GET_COVER).get({ id: mediaId, projectId }) as { cover_path: string } | undefined;
    return row?.cover_path || null;
  }

  // 💥 新增：按项目获取所有媒体资产（完整信息）
  public getByProject(projectId: string): any[] {
    try {
      const medias = this.db.prepare(MEDIA_SQL.GET_BY_PROJECT).all({ projectId });
      // 解析 frames JSON 字段
      return medias.map((row: any) => ({
        ...row,
        frames: row.frames ? JSON.parse(row.frames) : undefined
      }));
    } catch (e: any) {
      AppLogger.error(LOG_TAGS.DATABASE, `获取项目媒体列表崩溃：${e.message}`);
      throw new AppError(ErrorCode.DATABASE_ERROR, `读取项目媒体失败：${e.message}`);
    }
  }

  // 💥 绝对规范：严格返回符合 types/index.ts 定义的数据结构
  public getAgentContextData(projectId: string): { medias: Partial<MediaItem>[], shots: Partial<Shot>[] } {
    try {
      const medias = this.db.prepare(MEDIA_SQL.GET_AGENT_MEDIAS).all({ projectId }) as Partial<MediaItem>[];
      const shots = this.db.prepare(MEDIA_SQL.GET_AGENT_SHOTS).all({ projectId }) as Partial<Shot>[];
      
      return { medias, shots };
    } catch (e: any) {
      AppLogger.error(LOG_TAGS.DATABASE, `获取 Agent 工程快照崩溃：${e.message}`);
      // 抛出受控异常，外层 AIEngine 会将其拦截
      throw new AppError(ErrorCode.DATABASE_ERROR, `读取工程快照失败：${e.message}`);
    }
  }
}
