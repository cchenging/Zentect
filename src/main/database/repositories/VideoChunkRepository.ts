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
   * @returns 阶段 B 缓存契约（v2）：
   *    { version: 2, chunks: any[], matchSegments: any[] }
   *    兼容 v1：老缓存存的是裸数组（chunks_json = [...]），读端将其包装为
   *    { version: 1, chunks: 原数组, matchSegments: [] }，由调用方（SemanticAnalyzeStrategy）
   *    对空 matchSegments 走 buildMatchSegmentsFromChunks 降级兜底。
   *    无缓存或解析失败返回 null（null = 未命中，需重新切片）
   */
  public getByMediaId(mediaId: string): { version: number; chunks: any[]; matchSegments: any[] } | null {
    if (!mediaId) return null;
    try {
      const row = this.db.prepare(
        'SELECT chunks_json FROM video_chunks WHERE media_id = ?',
      ).get(mediaId) as { chunks_json: string } | undefined;
      if (!row || !row.chunks_json) return null;
      const parsed = JSON.parse(row.chunks_json);
      // 🎬 阶段 B：v2 结构 { version, chunks, matchSegments }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.chunks)) {
        const chunks = parsed.chunks.filter((c: any) => c && typeof c === 'object');
        return {
          version: parsed.version === 2 ? 2 : 1,
          chunks,
          matchSegments: Array.isArray(parsed.matchSegments) ? parsed.matchSegments.filter((c: any) => c && typeof c === 'object') : [],
        };
      }
      // 兼容 v1：裸数组
      if (Array.isArray(parsed)) {
        const chunks = parsed.filter((c: any) => c && typeof c === 'object');
        if (chunks.length === 0) return null;
        return { version: 1, chunks, matchSegments: [] };
      }
      return null;
    } catch (e: any) {
      AppLogger.warn(LOG_TAGS.DATABASE, `[VideoChunkRepository] 读取切片缓存失败: ${e.message}`);
      return null;
    }
  }

  /**
   * 保存切片缓存（幂等 upsert：同一视频重复切片时覆盖旧数据）
   * @param mediaId 视频物理绝对路径
   * @param chunks 镜头级切片数组（Layer 1）
   * @param matchSegments 匹配候选级数组（Layer 2），可省略（v1 语义下仅存 chunks）
   */
  public save(mediaId: string, chunks: any[], matchSegments?: any[]): void {
    if (!mediaId || !Array.isArray(chunks) || chunks.length === 0) return;
    const now = Date.now();
    const segs = Array.isArray(matchSegments) ? matchSegments : [];
    const payload = { version: 2, chunks, matchSegments: segs };
    try {
      this.db.prepare(`
        INSERT INTO video_chunks (media_id, chunks_json, chunk_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(media_id) DO UPDATE SET
          chunks_json = excluded.chunks_json,
          chunk_count = excluded.chunk_count,
          updated_at = excluded.updated_at
      `).run(mediaId, JSON.stringify(payload), chunks.length, now, now);
      AppLogger.info(LOG_TAGS.DATABASE, `[VideoChunkRepository] 切片缓存已写入(v2): 镜头 ${chunks.length} 个, 匹配候选段 ${segs.length} 个`);
    } catch (e: any) {
      AppLogger.warn(LOG_TAGS.DATABASE, `[VideoChunkRepository] 写入切片缓存失败: ${e.message}`);
    }
  }
}
