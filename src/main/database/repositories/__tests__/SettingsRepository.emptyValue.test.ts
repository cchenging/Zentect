// 📁 路径: src/main/database/repositories/__tests__/SettingsRepository.emptyValue.test.ts
// 🔧 回归锁定：空串必须落库（「显式清空」语义）
//
// 背景：saveSettings 曾用 `if (valToSave.trim() === '') continue;` 跳过空值。
//   该兜底是为旧版 saveConfig「把整份 Schema 逐键全量写回」（含大量未填写字段的空值）防误清而加；
//   全量写回废弃后（UI 改由 useSettingsManager 防抖即时落盘，只写用户实际改动的键），
//   这条兜底不再需要，且会让「清空 API Key」「日志目录留空=回退默认位置」静默失效 ⇒ 已移除。
//
// 本用例锁死新语义：'' 落库；undefined / null 仍跳过（不能误清）。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

/** 内存 SQLite 实例（vi.mock 工厂只闭包存引用，取值发生在 beforeEach 之后） */
let memDB: Database.Database;

vi.mock('../../core/SQLiteConnection', () => ({
  SQLiteConnection: { getInstance: () => ({ getDB: () => memDB }) },
}));

vi.mock('@modules/infra/security/CredentialManager', () => ({
  CredentialManager: {
    getInstance: () => ({
      // 与生产同构：敏感值落库前被加密（此处用可辨识前缀代替真实密文）
      encrypt: (v: string) => `v2:${v}`,
      decrypt: (v: string) => v,
    }),
  },
}));

import { SettingsRepository } from '../SettingsRepository';

/** 初始化内存 DB（表结构与 001_initial_schema.sql 一致） */
function setupInMemoryDB(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = MEMORY');
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);');
  return db;
}

/** 直接读原始行，绕过 get() 的解密与类型转换 */
function rawValue(key: string): string | undefined {
  const row = memDB.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

describe('🔧 SettingsRepository.saveSettings — 空值语义', () => {
  let repo: SettingsRepository;

  beforeEach(() => {
    memDB = setupInMemoryDB();
    repo = new SettingsRepository();
  });

  it('空串必须落库（清空 logPath ⇒ 走默认日志目录分支）', () => {
    repo.saveSettings({ logPath: '' });

    expect(rawValue('logPath')).toBe('');
    expect(repo.get('logPath', 'DEFAULT')).toBe('');
  });

  it('空串能覆盖已有非空值（先有后清空）', () => {
    repo.saveSettings({ logPath: 'F:\\Tools\\Zentect\\data\\logs' });
    expect(rawValue('logPath')).toBe('F:\\Tools\\Zentect\\data\\logs');

    repo.saveSettings({ logPath: '' });
    expect(rawValue('logPath')).toBe('');
  });

  it('敏感 key 的空串同样落库（走加密分支，不中断事务）', () => {
    repo.saveSettings({ deepseekKey: 'sk-abc' });
    expect(rawValue('deepseekKey')).toBe('v2:sk-abc');

    repo.saveSettings({ deepseekKey: '' });
    expect(rawValue('deepseekKey')).toBe('v2:');
  });

  it('undefined / null 仍被跳过（不写入、不误清已有值）', () => {
    repo.saveSettings({ logPath: 'X' });

    repo.saveSettings({ logPath: undefined, otherKey: null });

    expect(rawValue('logPath')).toBe('X');
    expect(rawValue('otherKey')).toBeUndefined();
  });

  it('对象 / 数组仍序列化为 JSON 后落库', () => {
    repo.saveSettings({ modelPool: ['a', 'b'] });
    expect(rawValue('modelPool')).toBe('["a","b"]');
  });
});