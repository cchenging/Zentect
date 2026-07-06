/**
 * infra-database 模块入口
 *
 * 模块间通信规则：外部只能 import types.ts 和 index.ts，禁止 import 内部实现文件。
 */

// 接口类型
export type { DatabaseConnection, IBaseRepository, MigrationStatus, IMigrationManager } from './types';

// 实现（通过接口暴露）
export { SQLiteConnection } from './SQLiteConnection';
export { MigrationManager } from './MigrationManager';
