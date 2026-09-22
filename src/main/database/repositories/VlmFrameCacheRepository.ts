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

  constructor() {
    this.ensureSchema();
  }

  /**
   * 自愈建表（幂等）
   * 🔧 修复脏数据：历史迁移 026 曾被"标记已执行但 SQL 未生效"（_migrations 记录存在、但表实际缺失），
   *    而 runFile 见已执行即永久跳过 → 表永不建 → 缓存读写被静默吞掉，导致每次重跑全量调 VLM。
   *    此处每次实例化时补建表 + 索引，CREATE IF NOT EXISTS 幂等，与迁移 026 内容保持一致，
   *    既不掩盖正常启动下的新表创建，又能修复已污染的存量库。
   */
  private ensureSchema(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS vlm_frame_cache (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          frame_hash TEXT NOT NULL,
          model_name TEXT NOT NULL,
          prompt_version TEXT NOT NULL DEFAULT 'v1',
          result_json TEXT NOT NULL,
          description TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_vlm_cache_unique
          ON vlm_frame_cache(frame_hash, model_name, prompt_version);
        CREATE INDEX IF NOT EXISTS idx_vlm_cache_frame_hash
          ON vlm_frame_cache(frame_hash);
      `);
    } catch (e: any) {
      AppLogger.warn(LOG_TAGS.AI_AGENT, `[VlmCache] 自愈建表失败: ${e.message}`);
    }
  }

  /** 当前 prompt 版本（修改 prompt/schema 时递增，如 v1 → v2，使旧缓存自动失效）
   *  🔧 v4：拉片式场景重写 + 新增 keyProps 道具字段 + scene/narrativeAction 约束变更，
   *        旧 v2/v3 缓存（短场景描述）必须全部失效，否则重跑会命中旧结果不生效。
   *  🔧 v5（§20 第4步 2026-09-16）：prompt 正文补齐 keyProps（v4 只在 schema 要求、正文未列 → 实测 0/665 产出），
   *        并新增 costume（服装造型）/ weatherEnv（环境介质·时段）两字段；
   *        递增版本使 665 帧旧缓存整体失效 → 全量重跑 VLM 一次拿到全部新字段。
   *  🔧 v6（2026-09-18）：characters 字段生成口径收紧——只写该帧画面中肉眼可见的人物
   *        （客观外观描述），严禁混入道具/布景/家具/车辆/植物等非人物，严禁凭脸猜测演员名/角色名。
   *        prompt 正文 + JSON 模板 + schema 三处同改，必须 bump 版本使旧缓存失效，
   *        否则重跑会命中旧 characters（含 绿植/窗外路灯/三人围坐沙发 等脏值）掩盖本次改动。
   *  🔧 v7（A域 §10.2.1）：新增 eyelineDirection（主体视线 LEFT|RIGHT|FRONT|NONE，补丁14 跳轴守卫）
   *         + 校准 primarySubject（画面绝对单焦点，含物件/空镜）+ keyProps 收拢为可枚举道具类别
   *        （具体道具名移交 scene/narrativeAction 承载）。三处同改字段 → 必须 bump 版本，否则重跑
   *        命中旧 primarySubject/eyelineDirection/keyProps 掩盖本次改动。
   *  ⚠️ 必须与 VisionExtractStrategy 写入侧引用同一常量，避免查询/写入版本不一致。
   */
  static readonly PROMPT_VERSION = 'v7';

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
