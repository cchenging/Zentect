// 📁 路径: src/main/database/repositories/FrameIndexRepository.ts
// P2（2026-09-30）：帧向量索引 —— 步骤5 **帧级召回**的数据底座
//
// 定位：一帧一行，落「帧内容 hash（图像 md5，与 vlm_frame_cache 同源）+ 归属镜头 chunk_id +
//      源时间 timeMs + 帧释义 description + BGE 向量 vec」。步骤5 的帧召回（P3）据此
//      用「句文案 + visualIntent + refFrameDesc」在**帧级**求最像画面瞬间，再按 chunk_id 上卷成镜头候选。
//
// 为什么必须独立于 vlm_frame_cache：后者主键是图像 md5（全局跨项目去重），**结构上不承载
//      「这帧属于哪个镜头」**（归属是项目级的），且不存向量（每次召回要重编码 3325 帧）。
//      故帧身份 + 向量按项目落本表，编码一次性、复跑秒级命中。
//
// ⚠️ 与 vlm_frame_cache 的版本联动：帧释义文本随 PROMPT_VERSION 变，同一 frame_hash 的
//      description 会更新 ⇒ 本表以 (frame_hash, project_id, media_id, model_name) 为唯一键
//      做 upsert，重跑时用新释义**覆盖**旧行，避免「旧释义 + 新向量」错配。
import { SQLiteConnection } from '@modules/infra/database/SQLiteConnection';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '@modules/infra/logger/LogConstants';

/** BGE 编码模型标识：模型/池化口径变更时递增，使旧向量整体失效（与 PROMPT_VERSION 同思路） */
export const FRAME_INDEX_MODEL = 'bge-small-zh-v1.5';

/** 待写入的索引记录（vec 为未压缩 float32 数组，落库时转 BLOB） */
export interface FrameIndexRecord {
  frameHash: string;
  chunkId: string;
  projectId?: string;
  mediaId?: string;
  timeMs: number;
  description: string;
  vec: number[];
}

/** 召回读取行（vec 已解码为 Float32Array，与库内 float32 字节一一对应） */
export interface FrameIndexRow {
  frameHash: string;
  chunkId: string;
  timeMs: number;
  description: string;
  vec: Float32Array;
}

/**
 * 帧向量索引仓库
 * 唯一键：frame_hash + project_id + media_id + model_name
 */
export class FrameIndexRepository {
  private db = SQLiteConnection.getInstance().getDB();

  constructor() {
    this.ensureSchema();
  }

  /** 自愈建表（幂等，与 VlmFrameCacheRepository 同款风格，无迁移文件依赖） */
  private ensureSchema(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS frame_index (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          frame_hash TEXT NOT NULL,
          chunk_id TEXT NOT NULL,
          project_id TEXT NOT NULL DEFAULT '',
          media_id TEXT NOT NULL DEFAULT '',
          time_ms REAL NOT NULL DEFAULT 0,
          description TEXT NOT NULL,
          dim INTEGER NOT NULL,
          vec BLOB NOT NULL,
          model_name TEXT NOT NULL DEFAULT '${FRAME_INDEX_MODEL}',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_frame_index_unique
          ON frame_index(frame_hash, project_id, media_id, model_name);
        CREATE INDEX IF NOT EXISTS idx_frame_index_chunk
          ON frame_index(project_id, media_id, chunk_id);
      `);
    } catch (e: any) {
      AppLogger.warn(LOG_TAGS.AI_AGENT, `[FrameIndex] 自愈建表失败: ${e.message}`);
    }
  }

  /**
   * 查已建索引的帧 hash（限定项目/素材域）：调用方据此只编码缺失帧。
   * @param frameHashes 待检查的帧 hash 列表
   * @param projectId 项目 id
   * @param mediaId 素材 id
   * @returns 已存在向量的 hash 集合
   */
  getIndexedHashes(frameHashes: string[], projectId: string, mediaId: string): Set<string> {
    const found = new Set<string>();
    if (frameHashes.length === 0) return found;
    try {
      const placeholders = frameHashes.map(() => '?').join(',');
      const rows = this.db.prepare(
        `SELECT frame_hash FROM frame_index
         WHERE project_id = ? AND media_id = ? AND model_name = ? AND frame_hash IN (${placeholders})`
      ).all(projectId, mediaId, FRAME_INDEX_MODEL, ...frameHashes) as any[];
      for (const r of rows) found.add(String(r.frame_hash));
    } catch (e: any) {
      AppLogger.warn(LOG_TAGS.AI_AGENT, `[FrameIndex] 查询已索引 hash 失败: ${e.message}`);
    }
    return found;
  }

  /** 批量写入（单事务 upsert；vec 以 float32 小端字节落 BLOB） */
  batchSet(records: FrameIndexRecord[]): number {
    if (records.length === 0) return 0;
    let written = 0;
    try {
      const stmt = this.db.prepare(
        `INSERT INTO frame_index (frame_hash, chunk_id, project_id, media_id, time_ms, description, dim, vec, model_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(frame_hash, project_id, media_id, model_name) DO UPDATE SET
           chunk_id = excluded.chunk_id,
           time_ms = excluded.time_ms,
           description = excluded.description,
           dim = excluded.dim,
           vec = excluded.vec,
           created_at = CURRENT_TIMESTAMP`
      );
      const insertMany = this.db.transaction((items: FrameIndexRecord[]) => {
        for (const r of items) {
          const buf = Buffer.from(new Float32Array(r.vec).buffer);
          stmt.run(
            r.frameHash, r.chunkId, r.projectId || '', r.mediaId || '',
            Number(r.timeMs) || 0, r.description || '', r.vec.length, buf, FRAME_INDEX_MODEL,
          );
        }
      });
      insertMany(records);
      written = records.length;
    } catch (e: any) {
      AppLogger.warn(LOG_TAGS.AI_AGENT, `[FrameIndex] 批量写入失败: ${e.message}`);
    }
    return written;
  }

  /**
   * 读取某项目/素材的全量帧索引行（供帧召回一次性载入内存求点积）。
   * @param projectId 项目 id
   * @param mediaId 素材 id
   * @returns 索引行列表（vec 已解码）；无数据返回空数组，不抛错
   */
  queryByProject(projectId: string, mediaId: string): FrameIndexRow[] {
    const out: FrameIndexRow[] = [];
    try {
      const rows = this.db.prepare(
        `SELECT frame_hash, chunk_id, time_ms, description, vec FROM frame_index
         WHERE project_id = ? AND media_id = ? AND model_name = ?`
      ).all(projectId, mediaId, FRAME_INDEX_MODEL) as any[];
      for (const r of rows) {
        const buf: Buffer = r.vec;
        if (!buf || buf.length === 0) continue;
        const copy = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        out.push({
          frameHash: String(r.frame_hash),
          chunkId: String(r.chunk_id),
          timeMs: Number(r.time_ms) || 0,
          description: String(r.description || ''),
          vec: new Float32Array(copy),
        });
      }
    } catch (e: any) {
      AppLogger.warn(LOG_TAGS.AI_AGENT, `[FrameIndex] 读取项目帧索引失败: ${e.message}`);
    }
    return out;
  }

  /** 清空某项目/素材的帧索引（重切镜头/换帧源后强制重建时用） */
  clearProject(projectId: string, mediaId: string): void {
    try {
      this.db.prepare(
        `DELETE FROM frame_index WHERE project_id = ? AND media_id = ?`
      ).run(projectId, mediaId);
    } catch (e: any) {
      AppLogger.warn(LOG_TAGS.AI_AGENT, `[FrameIndex] 清理项目帧索引失败: ${e.message}`);
    }
  }
}