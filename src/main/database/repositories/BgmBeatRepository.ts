// 📁 路径: src/main/database/repositories/BgmBeatRepository.ts
// BGM 节拍持久化缓存仓库：以 BGM 文件的"路径 + size + mtime"为指纹存取节拍结果
// 目的：detect_beats 对同一首歌每次匹配都会重新跑 STFT 低频重音追踪（3 分钟以上可达 15~20 秒），
//       daemon 进程内缓存重启即失效；写入 SQLite 后同一首 BGM 在任意会话/任意项目中都能秒级复用。
import { SQLiteConnection } from '../core/SQLiteConnection';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '@modules/infra/logger/LogConstants';
import * as fs from 'fs';
import * as path from 'path';

export interface BgmBeatCacheData {
  /** 节拍时间数组，单位：秒（s），与 SemanticAnalyzeStrategy / KM 求解器一致 */
  beatsSec: number[];
  /** 整曲 BPM */
  bpm: number;
  /** 缓存命中时的文件大小（字节），仅供日志/诊断用 */
  fileSize: number;
  /** 缓存命中时的文件 mtime（毫秒），仅供日志/诊断用 */
  mtimeMs: number;
}

export class BgmBeatRepository {
  private get db() { return SQLiteConnection.getInstance().getDB(); }

  /**
   * 基于文件物理元数据（size + mtimeMs）计算内容指纹，用于缓存有效性校验
   * 注：文件覆盖 / 替换 / 重命名后这两个值至少有一个会变，足以保证不会读到过期节拍
   * @param bgmFilePath BGM 文件绝对路径
   * @returns {size, mtimeMs} 文件指纹；文件不存在返回 null
   */
  public static statFingerprint(bgmFilePath: string): { size: number; mtimeMs: number } | null {
    if (!bgmFilePath) return null;
    try {
      const st = fs.statSync(path.normalize(bgmFilePath));
      if (!st.isFile()) return null;
      return { size: Number(st.size) || 0, mtimeMs: Number(st.mtimeMs) || 0 };
    } catch (e: any) {
      return null;
    }
  }

  /**
   * 读取 BGM 节拍缓存（含指纹校验）
   * @param bgmFilePath BGM 文件绝对路径
   * @returns 缓存有效时返回 beatsSec + bpm；文件不存在 / 无缓存 / 指纹不一致时返回 null
   */
  public getValid(bgmFilePath: string): BgmBeatCacheData | null {
    if (!bgmFilePath) return null;
    const fp = BgmBeatRepository.statFingerprint(bgmFilePath);
    if (!fp) return null;
    try {
      const row = this.db.prepare(`
        SELECT file_size, mtime_ms, beats_json, bpm
        FROM bgm_beats
        WHERE file_path = ?
      `).get(bgmFilePath) as {
        file_size: number; mtime_ms: number; beats_json: string; bpm: number;
      } | undefined;
      if (!row || !row.beats_json) return null;
      /** 指纹校验：文件覆盖/重替换后 size 或 mtimeMs 必然变化，此时缓存视为过期 */
      if (row.file_size !== fp.size || row.mtime_ms !== fp.mtimeMs) {
        AppLogger.info(LOG_TAGS.DATABASE,
          `[BgmBeatRepository] BGM 节拍缓存指纹不匹配（${bgmFilePath}），已失效，重新检测`);
        return null;
      }
      const beats = JSON.parse(row.beats_json);
      if (!Array.isArray(beats)) return null;
      return {
        beatsSec: beats,
        bpm: Number(row.bpm) || 0,
        fileSize: fp.size,
        mtimeMs: fp.mtimeMs,
      };
    } catch (e: any) {
      AppLogger.warn(LOG_TAGS.DATABASE, `[BgmBeatRepository] 读取 BGM 节拍缓存失败: ${e.message}`);
      return null;
    }
  }

  /**
   * 保存 BGM 节拍缓存（幂等 upsert：同一路径再次检测时覆盖旧结果）
   * @param bgmFilePath BGM 文件绝对路径
   * @param beatsSec 节拍秒级时间数组（单位 s，必须与 KM 求解器一致）
   * @param bpm 整曲 tempo
   */
  public save(bgmFilePath: string, beatsSec: number[], bpm: number): void {
    if (!bgmFilePath || !Array.isArray(beatsSec) || beatsSec.length === 0) return;
    const fp = BgmBeatRepository.statFingerprint(bgmFilePath);
    if (!fp) {
      AppLogger.warn(LOG_TAGS.DATABASE, `[BgmBeatRepository] BGM 文件不存在，跳过写缓存: ${bgmFilePath}`);
      return;
    }
    const now = Date.now();
    try {
      this.db.prepare(`
        INSERT INTO bgm_beats (
          file_path, file_size, mtime_ms, beats_json, beat_count, bpm, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(file_path) DO UPDATE SET
          file_size  = excluded.file_size,
          mtime_ms   = excluded.mtime_ms,
          beats_json = excluded.beats_json,
          beat_count = excluded.beat_count,
          bpm        = excluded.bpm,
          updated_at = excluded.updated_at
      `).run(
        bgmFilePath,
        fp.size,
        fp.mtimeMs,
        JSON.stringify(beatsSec),
        beatsSec.length,
        Number(bpm) || 0,
        now,
        now,
      );
      AppLogger.info(LOG_TAGS.DATABASE,
        `[BgmBeatRepository] BGM 节拍缓存已写入: ${beatsSec.length} 个节拍，BPM=${bpm}`);
    } catch (e: any) {
      AppLogger.warn(LOG_TAGS.DATABASE, `[BgmBeatRepository] 写入 BGM 节拍缓存失败: ${e.message}`);
    }
  }
}
