// 📁 路径: src/main/database/repositories/VideoChunkRepository.ts
// 视频切片持久化缓存仓库：以视频物理路径为 key 存取步骤5 的切片池
// 目的：detect_scene_chunks 每次约 80 秒（6 分钟视频），进程内缓存重启即失效，
//       写入 SQLite 后同视频任意会话匹配秒级复用
import { SQLiteConnection } from '../core/SQLiteConnection';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '@modules/infra/logger/LogConstants';

export class VideoChunkRepository {
  private get db() { return SQLiteConnection.getInstance().getDB(); }

  /**
   * 按视频路径读取缓存切片
   * @param mediaId 视频物理绝对路径（detect_scene_chunks 的 mediaId）
   * @returns 切片数组；无缓存或解析失败返回 null（null = 未命中，需重新切片）
   */
  public getByMediaId(mediaId: string): any[] | null {
    if (!mediaId) return null;
    try {
      const row = this.db.prepare(
        'SELECT chunks_json FROM video_chunks WHERE media_id = ?',
      ).get(mediaId) as { chunks_json: string } | undefined;
      if (!row || !row.chunks_json) return null;
      const chunks = JSON.parse(row.chunks_json);
      return Array.isArray(chunks) && chunks.length > 0 ? chunks : null;
    } catch (e: any) {
      AppLogger.warn(LOG_TAGS.DATABASE, `[VideoChunkRepository] 读取切片缓存失败: ${e.message}`);
      return null;
    }
  }

  /**
   * 保存切片缓存（幂等 upsert：同一视频重复切片时覆盖旧数据）
   * @param mediaId 视频物理绝对路径
   * @param chunks 切片数组
   */
  public save(mediaId: string, chunks: any[]): void {
    if (!mediaId || !Array.isArray(chunks) || chunks.length === 0) return;
    const now = Date.now();
    try {
      this.db.prepare(`
        INSERT INTO video_chunks (media_id, chunks_json, chunk_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(media_id) DO UPDATE SET
          chunks_json = excluded.chunks_json,
          chunk_count = excluded.chunk_count,
          updated_at = excluded.updated_at
      `).run(mediaId, JSON.stringify(chunks), chunks.length, now, now);
      AppLogger.info(LOG_TAGS.DATABASE, `[VideoChunkRepository] 切片缓存已写入: ${chunks.length} 个切片`);
    } catch (e: any) {
      AppLogger.warn(LOG_TAGS.DATABASE, `[VideoChunkRepository] 写入切片缓存失败: ${e.message}`);
    }
  }
}
