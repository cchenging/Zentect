import type Database from 'better-sqlite3';

/**
 * 数据库连接抽象 —— 唯一对外暴露的 DB 句柄获取方式
 */
export interface DatabaseConnection {
  getDB(): Database.Database;
  close(): void;
}

/**
 * 通用 Repository 接口 —— 所有业务模块的 Repository 必须实现
 */
export interface IBaseRepository<T> {
  findById(id: string): T | null;
  findAll(): T[];
  insert(entity: Omit<T, 'createdAt' | 'updatedAt'>): T;
  update(id: string, patch: Partial<T>): boolean;
  delete(id: string): boolean;
  exists(id: string): boolean;
}

/**
 * 迁移状态记录
 */
export interface MigrationStatus {
  filename: string;
  executedAt: string | null;
}

/**
 * 数据库迁移管理器接口
 */
export interface IMigrationManager {
  run(): void;
  getStatus(): MigrationStatus[];
}
