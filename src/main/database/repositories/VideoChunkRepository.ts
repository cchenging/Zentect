// 📁 路径: src/main/database/repositories/VideoChunkRepository.ts
// 视频切片持久化缓存仓库：以视频物理路径为 key 存取步骤5 的切片池
// 目的：detect_scene_chunks 每次约 80 秒（6 分钟视频），进程内缓存重启即失效，
//       写入 SQLite 后同视频任意会话匹配秒级复用
import { SQLiteConnection } from '../core/SQLiteConnection';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '@modules/infra/logger/LogConstants';

export class VideoChunkRepository {
  /** 🔧 R7 分片大小（PR-2）：每片 ≤200 条，独立事务 commit，避免单次大事务锁库 */
  private static readonly CHUNK_PART_SIZE = 200;

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
      // 🔧 R7 优先读分片表（PR-2）：parts 有数据说明是本版本写入的 v2 分片缓存
      const partRows = this.db.prepare(
        'SELECT kind, items_json FROM video_chunk_parts WHERE media_id = ? ORDER BY part_index',
      ).all(mediaId) as { kind: string; items_json: string }[];
      if (partRows.length > 0) {
        const chunks: any[] = [];
        const matchSegments: any[] = [];
        for (const r of partRows) {
          try {
            const items = JSON.parse(r.items_json);
            if (!Array.isArray(items)) continue;
            const objs = items.filter((c: any) => c && typeof c === 'object');
            if (r.kind === 'segs') matchSegments.push(...objs);
            else chunks.push(...objs);
          } catch {
            // 单片解析失败跳过，保留其余片（容错不阻断读缓存）
          }
        }
        if (chunks.length === 0) return null;
        return { version: 2, chunks, matchSegments };
      }

      // 兼容 v1/v2 旧整行缓存（历史数据回退）
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
    try {
      // 🔧 R7 分片写（PR-2）：先清同 media 旧数据（旧整行 + 旧分片），保持覆盖语义；
      //   better-sqlite3 语句级 autocommit = 每片独立事务 commit，避免单次大事务锁库；
      //   表结构 video_chunk_parts 由迁移 031 创建，WAL 由 SQLiteConnection 全局开启。
      this.db.prepare('DELETE FROM video_chunk_parts WHERE media_id = ?').run(mediaId);
      this.db.prepare('DELETE FROM video_chunks WHERE media_id = ?').run(mediaId);
      // part_index 跨 kind 连续编号（chunks 0..n-1, segs n..），保证复合主键唯一
      const partStmt = this.db.prepare(`
        INSERT INTO video_chunk_parts (media_id, part_index, kind, items_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      let partIndex = 0;
      for (let i = 0; i < chunks.length; i += VideoChunkRepository.CHUNK_PART_SIZE) {
        partStmt.run(mediaId, partIndex++, 'chunks', JSON.stringify(chunks.slice(i, i + VideoChunkRepository.CHUNK_PART_SIZE)), now, now);
      }
      for (let i = 0; i < segs.length; i += VideoChunkRepository.CHUNK_PART_SIZE) {
        partStmt.run(mediaId, partIndex++, 'segs', JSON.stringify(segs.slice(i, i + VideoChunkRepository.CHUNK_PART_SIZE)), now, now);
      }
      AppLogger.info(LOG_TAGS.DATABASE, `[VideoChunkRepository] 切片缓存分片写入(v2/R7): 镜头 ${chunks.length} 个, 匹配候选段 ${segs.length} 个, 共 ${partIndex} 片`);
    } catch (e: any) {
      AppLogger.warn(LOG_TAGS.DATABASE, `[VideoChunkRepository] 写入切片缓存失败: ${e.message}`);
    }
  }
}
