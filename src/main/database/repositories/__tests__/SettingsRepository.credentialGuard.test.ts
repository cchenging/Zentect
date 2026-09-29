// 📁 路径: src/main/database/repositories/__tests__/SettingsRepository.credentialGuard.test.ts
// 🔧 ADR-004 G2 回归锁定：密文守卫 + 失败可感知（fail-closed）
//
// 锁死三条不变量：
//   T21 读侧 `get()`：解不开 ⇒ 抛 `CredentialDecryptError`（不再静默降级为空串 ——
//      空串会被上层当「未配置」继续外发，本次 429 事故的形态）。
//   T22 读侧 `getAllSettings()`：单键坏凭据不炸整页，置空 + error 级日志（可感知）。
//   T23 迁移：`decrypt_failed` 才清空，`ok` / `missing` 保持原样。
//
// 「解不开」由 mock 的 CredentialManager 注入（decrypt 返回 decrypt_failed）。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

let memDB: Database.Database;

vi.mock('../../core/SQLiteConnection', () => ({
  SQLiteConnection: { getInstance: () => ({ getDB: () => memDB }) },
}));

vi.mock('@modules/infra/security/CredentialManager', () => ({
  CredentialManager: {
    getInstance: () => ({
      encrypt: (v: string) => `v2:${v}`,
      // 可感知的模拟：对 BROKEN 前缀返回 decrypt_failed，其余按形态归类
      decrypt: (v: string) =>
        v.startsWith('v2:BROKEN:')
          ? { status: 'decrypt_failed', reason: 'key_mismatch' }
          : v.startsWith('v2:')
            ? { status: 'ok', value: v.slice(3) }
            : { status: 'ok', value: v },
    }),
  },
}));

import { AppLogger } from '@modules/infra/logger/AppLogger';
import { CredentialDecryptError } from '../../../../shared/utils/credentialFormat';
import { SettingsRepository } from '../SettingsRepository';

function setupInMemoryDB(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);');
  return db;
}

function insertRow(key: string, value: string): void {
  memDB.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

describe('SettingsRepository — 凭据守卫（ADR-004 G2）', () => {
  let repo: SettingsRepository;

  beforeEach(() => {
    memDB = setupInMemoryDB();
    repo = new SettingsRepository();
  });

  describe('读侧 get()：fail-closed', () => {
    it('T21 解不开 ⇒ 抛 CredentialDecryptError（含键名与 reason）', () => {
      insertRow('deepseekKey', 'v2:BROKEN:xxx');

      try {
        repo.get('deepseekKey', '');
        expect.unreachable('应当抛错而不是静默返回');
      } catch (err) {
        expect(err).toBeInstanceOf(CredentialDecryptError);
        expect((err as CredentialDecryptError).key).toBe('deepseekKey');
        expect((err as CredentialDecryptError).reason).toBe('key_mismatch');
      }
    });

    it('空值 / 明文保持原行为（不误伤）', () => {
      insertRow('logPath', 'F:\\logs');
      insertRow('emptyKey', '');

      expect(repo.get('logPath', 'DEFAULT')).toBe('F:\\logs');
      expect(repo.get('emptyKey', 'DEFAULT')).toBe('');
    });

    it('敏感 key 正常加密数据 ⇒ 解密为明文', () => {
      insertRow('deepseekKey', 'v2:sk-real-key-1234567890');

      expect(repo.get('deepseekKey', '')).toBe('sk-real-key-1234567890');
    });
  });

  describe('读侧 getAllSettings()：单键失败不炸整页', () => {
    it('T22 坏键置空 + 其他键不受影响 + error 日志点名', () => {
      insertRow('deepseekKey', 'v2:BROKEN:xxx');
      insertRow('logPath', 'F:\\logs');
      const errorSpy = vi.spyOn(AppLogger, 'error').mockImplementation(() => {});

      const all = repo.getAllSettings();

      expect(all['deepseekKey']).toBe('');
      expect(all['logPath']).toBe('F:\\logs');
      // error 级日志显式列出键名（失败可感知，不再是静默降级）
      expect(errorSpy).toHaveBeenCalled();
      expect(JSON.stringify(errorSpy.mock.calls)).toContain('deepseekKey');
      errorSpy.mockRestore();
    });

    it('坏键值不是密文形态的普通数据 ⇒ 原样返回', () => {
      insertRow('normalKey', 'plain-value');

      expect(repo.getAllSettings()['normalKey']).toBe('plain-value');
    });
  });

  describe('迁移 migrateStaleEncryptedData()：按 CredentialResult 判定', () => {
    it('T23 仅 decrypt_failed 被清空并登记', () => {
      insertRow('brokenKey', 'v2:BROKEN:xxx');        // 解不开 ⇒ 清空
      insertRow('goodKey', 'v2:sk-real-key-1234567890'); // 可解 ⇒ 保留
      insertRow('plainKey', 'plain-value');            // 明文 ⇒ 保留

      const stale = repo.migrateStaleEncryptedData();

      expect(stale).toEqual(['brokenKey']);
      expect(memDB.prepare('SELECT value FROM settings WHERE key = ?').get('brokenKey')).toEqual({ value: '' });
      expect(memDB.prepare('SELECT value FROM settings WHERE key = ?').get('goodKey')).toEqual({ value: 'v2:sk-real-key-1234567890' });
      expect(memDB.prepare('SELECT value FROM settings WHERE key = ?').get('plainKey')).toEqual({ value: 'plain-value' });
    });

    it('空行不参与判定（跳过）', () => {
      insertRow('emptyKey', '');
      insertRow('brokenKey', 'v2:BROKEN:xxx');

      const stale = repo.migrateStaleEncryptedData();

      expect(stale).toEqual(['brokenKey']);
    });
  });
});