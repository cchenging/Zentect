// 📁 路径: src/main/database/repositories/__tests__/ApiProfileRepository.credentialGuard.test.ts
// 🔧 ADR-004 G2/G4 回归锁定：凭据守卫（解不开的密文绝不外发 / 密文形态输入绝不落库）
//
// 锁死两条不变量：
//   T11（G2）读侧：库内密文解不开 ⇒ `apiKey === ''` + `apiKeyStatus === 'decrypt_failed'`，
//                 密文**绝不**出现在返回对象里（否则会被当 Bearer 外发、被回显到设置页）。
//   T12（G4）写侧：提交形如 `v2:…` 的 Key ⇒ 抛错拒绝，且**库内原值不变**（不发生二次加密）。
//
// 说明：本用例中的「解不开」由 vitest 全局 electron mock 自然产生 —— `setup.ts` 的
//   `safeStorage` 没有 `isEncryptionAvailable` ⇒ `decryptData` 的 v2 分支抛错被内部捕获后
//   **原样返回密文**，正是线上那次事故（profile 重建导致根密钥更换）的等效形态。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

let memDB: Database.Database;

vi.mock('../../core/SQLiteConnection', () => ({
  SQLiteConnection: { getInstance: () => ({ getDB: () => memDB }) },
}));

import { ApiProfileRepository } from '../ApiProfileRepository';

/** 建表：017_api_profiles.sql 基础列 + 024 追加列（alias/enabled/is_preset/preset_type） */
function setupInMemoryDB(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_profiles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL,
      api_key TEXT, base_url TEXT, models TEXT,
      is_active INTEGER DEFAULT 0, sort_order INTEGER DEFAULT 0, extra_config TEXT,
      alias TEXT, enabled INTEGER DEFAULT 1, is_preset INTEGER DEFAULT 0, preset_type TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return db;
}

function insertRow(id: string, provider: string, apiKey: string | null): void {
  memDB.prepare(`INSERT INTO api_profiles (id, name, provider, api_key, base_url, models, is_active, sort_order, alias, enabled, is_preset, preset_type, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, 0, NULL, 1, 0, NULL, '2026-09-25T00:00:00Z', '2026-09-25T00:00:00Z')`)
    .run(id, `alias-${id}`, provider, apiKey, 'https://api.example.com/v1', '["m1"]');
}

function rawApiKey(id: string): string | null {
  const row = memDB.prepare('SELECT api_key FROM api_profiles WHERE id = ?').get(id) as
    | { api_key: string | null }
    | undefined;
  return row?.api_key ?? null;
}

describe('ApiProfileRepository — 凭据守卫（ADR-004 G2/G4）', () => {
  beforeEach(() => {
    memDB = setupInMemoryDB();
  });

  describe('读侧（G2）：解不开的密文绝不外发', () => {
    it('T11 密文解不开 ⇒ apiKey 置空 + decrypt_failed（密文不出现在返回对象里）', () => {
      insertRow('p1', 'proxy', 'v2:djEwLX1wIk8VkYEFIw0Dhu5Dy5W8MpZDK6k6xjCa65u2vt+w2DhNTQ8');

      const profile = ApiProfileRepository.getByProvider('proxy')[0];

      expect(profile.apiKeyStatus).toBe('decrypt_failed');
      expect(profile.apiKey).toBe('');
      expect(JSON.stringify(profile)).not.toContain('v2:djEw');   // 密文绝不出现在任何字段
    });

    it('未配置 Key ⇒ missing（与「解不开」区分，二者处置方式不同）', () => {
      insertRow('p2', 'proxy', null);

      const profile = ApiProfileRepository.getByProvider('proxy')[0];

      expect(profile.apiKeyStatus).toBe('missing');
      expect(profile.apiKey).toBe('');
    });

    it('明文旧数据 ⇒ ok 且原样返回', () => {
      insertRow('p3', 'proxy', 'sk-legacy-plaintext-key');

      const profile = ApiProfileRepository.getByProvider('proxy')[0];

      expect(profile.apiKeyStatus).toBe('ok');
      expect(profile.apiKey).toBe('sk-legacy-plaintext-key');
    });

    it('正常密文可解 ⇒ ok 且返回明文（守卫不误伤可用凭据）', () => {
      const created = ApiProfileRepository.create({
        name: 'n', provider: 'proxy', apiKey: 'sk-real-key-1234567890',
        baseUrl: '', models: [], isActive: false, sortOrder: 0,
      });
      // create 走 encryptData（测试环境回落 v1 格式），落库后应可被自身解密读回
      expect(rawApiKey(created.id)).toMatch(/^v1:/);

      const reread = ApiProfileRepository.getByProvider('proxy').find((p) => p.id === created.id)!;
      expect(reread.apiKeyStatus).toBe('ok');
      expect(reread.apiKey).toBe('sk-real-key-1234567890');
    });

    it('getActive 同样受守卫保护（AI 客户端取 Key 的路径）', () => {
      insertRow('p4', 'proxy', 'v2:BROKENCIPHERTEXTVALUE');
      memDB.prepare('UPDATE api_profiles SET is_active = 1 WHERE id = ?').run('p4');

      const active = ApiProfileRepository.getActive('proxy');

      expect(active?.apiKeyStatus).toBe('decrypt_failed');
      expect(active?.apiKey).toBe('');   // 绝不把密文交给适配器当 Bearer
    });
  });

  describe('写侧（G4）：密文形态输入被拒绝', () => {
    it('T12 update 提交密文 ⇒ 抛错且库内原值不变（不发生二次加密）', () => {
      const cipher = 'v2:djEwLX1wIk8VkYEFIw0Dhu5Dy5W8MpZDK6k6xjCa65u2vt+w2DhNTQ8';
      insertRow('p5', 'proxy', cipher);

      expect(() => ApiProfileRepository.update('p5', { apiKey: cipher })).toThrow(/拒绝保存密文/);
      expect(rawApiKey('p5')).toBe(cipher);   // 未被双重加密
    });

    it('T12 create 提交密文 ⇒ 抛错且不落库', () => {
      expect(() => ApiProfileRepository.create({
        name: 'n', provider: 'proxy', apiKey: 'v2:BROKEN', baseUrl: '', models: [], isActive: false, sortOrder: 0,
      })).toThrow(/拒绝保存密文/);

      expect(memDB.prepare('SELECT COUNT(*) AS c FROM api_profiles').get()).toEqual({ c: 0 });
    });

    it('旧版三段 hex 形态同样被拒绝', () => {
      insertRow('p6', 'proxy', null);

      expect(() => ApiProfileRepository.update('p6', { apiKey: 'aabbccdd:11223344:ffeeddcc' }))
        .toThrow(/拒绝保存密文/);
      expect(rawApiKey('p6')).toBeNull();
    });

    it('明文 Key 不受影响；不带 apiKey 的更新不清空已有值', () => {
      const created = ApiProfileRepository.create({
        name: 'n', provider: 'proxy', apiKey: 'sk-real-key-1234567890',
        baseUrl: '', models: [], isActive: false, sortOrder: 0,
      });
      const stored = rawApiKey(created.id);

      ApiProfileRepository.update(created.id, { alias: '改名' });   // 不带 apiKey

      expect(rawApiKey(created.id)).toBe(stored);
    });
  });
});