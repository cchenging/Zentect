// 📁 路径: src/main/database/repositories/ShowRepository.ts
// 🎬 P2-A 剧集语义层 — 跨集人物复用的语义基础数据访问层
// 核心能力：
//   1. CRUD：创建/查询/更新/删除剧集
//   2. 项目关联：把项目绑定到某剧集（设置 show_id + episode_number），解除绑定
//   3. 剧集统计：统计剧集下项目数，重算 episode_count 缓存字段
//   4. 按剧集查询：列出某剧集下所有项目（按 episode_number 排序）

import { SQLiteConnection } from '../core/SQLiteConnection';

/** DB 行结构（下划线列名） */
interface ShowRow {
  id: string;
  name: string;
  cover_path: string | null;
  description: string | null;
  episode_count: number;
  create_time: string;
  update_time: string;
  is_deleted: number;
}

/** 剧集实体（前端友好命名） */
export interface Show {
  id: string;
  name: string;
  coverPath?: string;
  description?: string;
  episodeCount: number;
  createTime?: string;
  updateTime?: string;
}

/** 剧集下的项目摘要（轻量结构，用于剧集详情页） */
export interface ShowProjectSummary {
  id: string;
  name: string;
  episodeNumber: number | null;
  coverPath: string | null;
  duration: string | null;
  status: string;
  updateTime: string;
}

/**
 * 剧集仓储
 * 处理 shows 表的 CRUD 与 projects 表的 show_id 关联
 */
export class ShowRepository {
  private get db() {
    return SQLiteConnection.getInstance().getDB();
  }

  /**
   * 查询所有未删除的剧集（按更新时间降序）
   */
  findAll(): Show[] {
    const rows = this.db.prepare(`
      SELECT * FROM shows WHERE is_deleted = 0
      ORDER BY update_time DESC, create_time DESC
    `).all() as ShowRow[];
    return rows.map((r) => this.mapRow(r));
  }

  /**
   * 按 ID 查单个剧集
   */
  findById(id: string): Show | null {
    const row = this.db.prepare(`
      SELECT * FROM shows WHERE id = @id AND is_deleted = 0
    `).get({ id }) as ShowRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  /**
   * 创建新剧集
   * @param payload 初始字段（id/name 必填）
   * @returns 创建后的 Show
   */
  create(payload: { id: string; name: string; coverPath?: string; description?: string }): Show {
    this.db.prepare(`
      INSERT INTO shows
        (id, name, cover_path, description, episode_count, create_time, update_time, is_deleted)
      VALUES
        (@id, @name, @coverPath, @description, 0, datetime('now', 'localtime'), datetime('now', 'localtime'), 0)
    `).run({
      id: payload.id,
      name: payload.name,
      coverPath: payload.coverPath ?? null,
      description: payload.description ?? null,
    });
    return this.findById(payload.id)!;
  }

  /**
   * 更新剧集基本信息（名称/封面/描述）
   */
  update(id: string, fields: { name?: string; coverPath?: string; description?: string }): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };

    if (fields.name !== undefined) { sets.push('name = @name'); params.name = fields.name; }
    if (fields.coverPath !== undefined) { sets.push('cover_path = @coverPath'); params.coverPath = fields.coverPath; }
    if (fields.description !== undefined) { sets.push('description = @description'); params.description = fields.description; }

    if (sets.length === 0) return;
    sets.push("update_time = datetime('now', 'localtime')");
    this.db.prepare(`UPDATE shows SET ${sets.join(', ')} WHERE id = @id`).run(params);
  }

  /**
   * 软删除剧集（同时解除其下所有项目的 show_id 关联）
   * 事务保证：projects 解绑与 shows 软删原子性
   */
  delete(id: string): { unbindCount: number } {
    const transaction = this.db.transaction(() => {
      // 先解绑该剧集下所有项目（show_id 置 NULL，episode_number 置 NULL）
      const result = this.db.prepare(`
        UPDATE projects SET show_id = NULL, episode_number = NULL, update_time = datetime('now', 'localtime')
        WHERE show_id = @id AND is_deleted = 0
      `).run({ id });
      const unbindCount = result.changes;

      // 再软删剧集
      this.db.prepare(`
        UPDATE shows SET is_deleted = 1, update_time = datetime('now', 'localtime')
        WHERE id = @id
      `).run({ id });

      return { unbindCount };
    });
    return transaction();
  }

  /**
   * 🎯 把项目绑定到剧集（设置 show_id + episode_number）
   * 如果 episodeNumber 未提供，自动取当前剧集最大集数 + 1
   * 事务保证：projects 更新与 shows.episode_count 重算原子性
   * @param projectId 项目 ID
   * @param showId 剧集 ID
   * @param episodeNumber 集数（可选，未提供则自动递增）
   */
  bindProject(projectId: string, showId: string, episodeNumber?: number): void {
    const transaction = this.db.transaction(() => {
      // 自动计算集数：取当前剧集最大 episode_number + 1
      let epNum = episodeNumber;
      if (epNum === undefined || epNum === null) {
        const row = this.db.prepare(`
          SELECT COALESCE(MAX(episode_number), 0) as maxEp
          FROM projects WHERE show_id = @showId AND is_deleted = 0
        `).get({ showId }) as { maxEp: number } | undefined;
        epNum = (row?.maxEp ?? 0) + 1;
      }

      // 绑定项目到剧集
      this.db.prepare(`
        UPDATE projects SET show_id = @showId, episode_number = @epNum, update_time = datetime('now', 'localtime')
        WHERE id = @projectId AND is_deleted = 0
      `).run({ projectId, showId, epNum });

      // 重算剧集 episode_count 缓存
      this.recalcEpisodeCount(showId);
    });
    transaction();
  }

  /**
   * 解除项目与剧集的绑定（show_id + episode_number 置 NULL）
   * 事务保证：projects 解绑与 shows.episode_count 重算原子性
   */
  unbindProject(projectId: string): void {
    const transaction = this.db.transaction(() => {
      // 先查出原 show_id（用于后续重算计数）
      const row = this.db.prepare(`
        SELECT show_id FROM projects WHERE id = @projectId AND is_deleted = 0
      `).get({ projectId }) as { show_id: string | null } | undefined;
      const oldShowId = row?.show_id ?? null;

      // 解绑
      this.db.prepare(`
        UPDATE projects SET show_id = NULL, episode_number = NULL, update_time = datetime('now', 'localtime')
        WHERE id = @projectId AND is_deleted = 0
      `).run({ projectId });

      // 重算原剧集 episode_count
      if (oldShowId) {
        this.recalcEpisodeCount(oldShowId);
      }
    });
    transaction();
  }

  /**
   * 查询某剧集下所有项目（按 episode_number 升序，NULL 排最后）
   * 返回轻量摘要结构，避免加载完整项目数据
   */
  findProjectsByShowId(showId: string): ShowProjectSummary[] {
    const rows = this.db.prepare(`
      SELECT id, name, episode_number, cover_path, duration, status, update_time
      FROM projects
      WHERE show_id = @showId AND is_deleted = 0
      ORDER BY
        CASE WHEN episode_number IS NULL THEN 1 ELSE 0 END,
        episode_number ASC,
        update_time ASC
    `).all({ showId }) as any[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      episodeNumber: r.episode_number ?? null,
      coverPath: r.cover_path ?? null,
      duration: r.duration ?? null,
      status: r.status ?? 'active',
      updateTime: r.update_time,
    }));
  }

  /**
   * 统计某剧集下项目数
   */
  countProjectsByShowId(showId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM projects WHERE show_id = @showId AND is_deleted = 0
    `).get({ showId }) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }

  /**
   * 重算剧集 episode_count 缓存字段（绑定/解绑/删除项目后调用）
   */
  private recalcEpisodeCount(showId: string): void {
    const count = this.countProjectsByShowId(showId);
    this.db.prepare(`
      UPDATE shows SET episode_count = @count, update_time = datetime('now', 'localtime')
      WHERE id = @showId
    `).run({ count, showId });
  }

  /**
   * 生成剧集 ID：show_ 前缀 + 时间戳 + 随机后缀
   */
  static generateId(): string {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).substring(2, 8);
    return `show_${ts}${rand}`;
  }

  /**
   * DB 行映射为 Show（前端友好命名）
   */
  private mapRow(r: ShowRow): Show {
    return {
      id: r.id,
      name: r.name,
      coverPath: r.cover_path ?? undefined,
      description: r.description ?? undefined,
      episodeCount: r.episode_count,
      createTime: r.create_time,
      updateTime: r.update_time,
    };
  }
}
