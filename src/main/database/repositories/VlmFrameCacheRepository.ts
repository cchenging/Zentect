// 📁 路径: src/main/database/repositories/VlmFrameCacheRepository.ts
// P1-2: VLM 帧描述 L2 磁盘缓存（SQLite 持久化）
// 重跑管线时若帧图像 + 模型 + prompt 版本均未变，直接秒级命中，避免重复 VLM API 调用
import { SQLiteConnection } from '@modules/infra/database/SQLiteConnection';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '@modules/infra/logger/LogConstants';

/** 缓存记录 */
export interface VlmCacheRecord {
  frameHash: string;
  modelName: string;
  promptVersion: string;
  resultJson: string;   // VLM 返回的解析后 JSON 字符串
  description: string;  // 拼装后的 UI 显示描述
}

/** 批量查询结果（Map 形式，key=frameHash） */
export type VlmCacheBatchResult = Map<string, VlmCacheRecord>;

/**
 * VLM 帧缓存仓库
 * 唯一键：frame_hash + model_name + prompt_version
 */
export class VlmFrameCacheRepository {
  private db = SQLiteConnection.getInstance().getDB();

  /** 当前 prompt 版本（修改 prompt 时递增，如 v1 → v2，使旧缓存自动失效） */
  private static readonly PROMPT_VERSION = 'v1';

  /**
   * 批量查询缓存（一次 SQL 拿回多帧结果，避免 N 次 SELECT）
   * @param frameHashes 帧图像 hash 列表
   * @param modelName 模型名
   * @returns Map<frameHash, VlmCacheRecord>
   */
  batchGet(frameHashes: string[], modelName: string): VlmCacheBatchResult {
    const result: VlmCacheBatchResult = new Map();
    if (frameHashes.length === 0) return result;

    try {
      const placeholders = frameHashes.map(() => '?').join(',');
      const rows = this.db.prepare(
        `SELECT frame_hash, result_json, description FROM vlm_frame_cache
         WHERE model_name = ? AND prompt_version = ? AND frame_hash IN (${placeholders})`
      ).all(modelName, VlmFrameCacheRepository.PROMPT_VERSION, ...frameHashes) as any[];

      for (const row of rows) {
        result.set(row.frame_hash, {
          frameHash: row.frame_hash,
          modelName,
          promptVersion: VlmFrameCacheRepository.PROMPT_VERSION,
          resultJson: row.result_json,
          description: row.description,
        });
      }
    } catch (e: any) {
      AppLogger.warn(LOG_TAGS.AI_AGENT, `[VlmCache] 批量查询失败: ${e.message}`);
    }
    return result;
  }

  /**
   * 批量写入缓存（单事务多 INSERT，失败时静默降级，不影响主流程）
   * @param records 缓存记录列表
   */
  batchSet(records: VlmCacheRecord[]): void {
    if (records.length === 0) return;

    try {
      const stmt = this.db.prepare(
        `INSERT INTO vlm_frame_cache (frame_hash, model_name, prompt_version, result_json, description)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(frame_hash, model_name, prompt_version) DO UPDATE SET
           result_json = excluded.result_json,
           description = excluded.description,
           created_at = CURRENT_TIMESTAMP`
      );

      const insertMany = this.db.transaction((items: VlmCacheRecord[]) => {
        for (const r of items) {
          stmt.run(r.frameHash, r.modelName, r.promptVersion, r.resultJson, r.description);
        }
      });
      insertMany(records);
    } catch (e: any) {
      AppLogger.warn(LOG_TAGS.AI_AGENT, `[VlmCache] 批量写入失败: ${e.message}`);
    }
  }

  /**
   * 失效单帧缓存（用户编辑某帧描述后，删除该帧旧缓存）
   * @param frameHash 帧图像 hash
   * @param modelName 模型名
   */
  invalidate(frameHash: string, modelName: string): void {
    try {
      this.db.prepare(
        `DELETE FROM vlm_frame_cache WHERE frame_hash = ? AND model_name = ?`
      ).run(frameHash, modelName);
    } catch (e: any) {
      AppLogger.warn(LOG_TAGS.AI_AGENT, `[VlmCache] 失效缓存失败: ${e.message}`);
    }
  }

  /**
   * 清空全部缓存（切换 prompt 版本或用户手动清理时）
   */
  clearAll(): void {
    try {
      this.db.prepare(`DELETE FROM vlm_frame_cache`).run();
      AppLogger.info(LOG_TAGS.AI_AGENT, `[VlmCache] 已清空全部缓存`);
    } catch (e: any) {
      AppLogger.warn(LOG_TAGS.AI_AGENT, `[VlmCache] 清空缓存失败: ${e.message}`);
    }
  }
}
