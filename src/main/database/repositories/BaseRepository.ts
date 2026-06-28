/**
 * BaseRepository - 通用 Repository 基类
 * 封装公共 CRUD 操作和事务管理，所有 Repository 继承此类
 */
import { SQLiteConnection } from '../core/SQLiteConnection';

export interface IEntity {
  id: string;
  createdAt?: string;
  updatedAt?: string;
}

export abstract class BaseRepository<T extends IEntity> {
  protected abstract tableName: string;
  protected abstract primaryKey: string = 'id';

  protected get db() {
    return SQLiteConnection.getInstance().getDatabase();
  }

  findById(id: string): T | null {
    const row = this.db.prepare(`SELECT * FROM ${this.tableName} WHERE ${this.primaryKey} = ?`).get(id);
    return row ? this.mapRow(row as Record<string, unknown>) : null;
  }

  findAll(): T[] {
    const rows = this.db.prepare(`SELECT * FROM ${this.tableName}`).all();
    return rows.map(r => this.mapRow(r as Record<string, unknown>));
  }

  exists(id: string): boolean {
    const row = this.db.prepare(`SELECT 1 FROM ${this.tableName} WHERE ${this.primaryKey} = ? LIMIT 1`).get(id);
    return !!row;
  }

  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM ${this.tableName}`).get() as { cnt: number };
    return row.cnt;
  }

  softDelete(id: string): boolean {
    return this.db.prepare(`UPDATE ${this.tableName} SET is_deleted = 1, updated_at = ? WHERE ${this.primaryKey} = ?`)
      .run(new Date().toISOString(), id).changes > 0;
  }

  hardDelete(id: string): boolean {
    return this.db.prepare(`DELETE FROM ${this.tableName} WHERE ${this.primaryKey} = ?`).run(id).changes > 0;
  }

  transaction<R>(fn: () => R): R {
    return this.db.transaction(fn)();
  }

  /** 子类实现：数据库行 → 实体对象 */
  protected abstract mapRow(row: Record<string, unknown>): T;
}