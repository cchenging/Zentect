// 📁 路径: src/main/database/repositories/__tests__/credentialMigration.v3.test.ts
// 🔧 ADR-004 §4.3 ② / §5 P2 回归锁定：v1/v2 → v3 静默迁移（事务性）
//
//   T7  v1 → v3：迁移后库内为 v3，且**读路径能原样读回**（purpose 一读一写必须同源，否则迁移即毁数据）
//   T8  v2 → v3
//   T9  回写失败 ⇒ 整事务回滚，**原值全部保留**（严禁先删旧值再写新值 —— 评审验收项）
//   T10 幂等：已是 v3 ⇒ 不产生新密文
//   另：解不开的旧密文保持原值（不迁移半成品）；v3 通道未就绪 ⇒ 整批跳过；settings 表同口径
//
// 假 OS 钥匙链采用**真钥匙链语义**：只解得出自己产出过的密文，异体密文抛错 ——
// 与线上「Chromium profile 重建 ⇒ DPAPI 换 key ⇒ 旧密文永久不可解」等价（不自造假成功）。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { safeStorage } from 'electron';
import { KeyStore } from '../../../../modules/infra/security/KeyStore';
import { encryptData } from '../../../utils/crypto';
import { CREDENTIAL_PURPOSE } from '../../../../shared/utils/credentialFormat';

let memDB: Database.Database;

vi.mock('../../core/SQLiteConnection', () => ({
  SQLiteConnection: { getInstance: () => ({ getDB: () => memDB }) },
}));

import { ApiProfileRepository } from '../ApiProfileRepository';
import { SettingsRepository } from '../SettingsRepository';

const ss = safeStorage as unknown as Record<string, unknown>;
const PURPOSE = CREDENTIAL_PURPOSE.apiProfileApiKey;
const chain = new Map<string, string>();

/** 装上一把「真钥匙链」：只认自己产出过的密文（异体密文抛错 ⇒ 等价于线上换 key 后的现场） */
function enableKeychain(): void {
  ss.isEncryptionAvailable = vi.fn(() => true);
  ss.encryptString = vi.fn((t: string) => {
    const b = Buffer.concat([Buffer.from([0x5a]), Buffer.from(t, 'utf8')]);
    chain.set(b.toString('base64'), t);
    return b;
  });
  ss.decryptString = vi.fn((b: Buffer) => {
    const t = chain.get(Buffer.from(b).toString('base64'));
    if (t === undefined) throw new Error('DPAPI: 密钥不匹配（模拟 Chromium profile 被重建）');
    return t;
  });
}

function withoutKeychain<T>(fn: () => T): T {
  const saved = { a: ss.isEncryptionAvailable, e: ss.encryptString, d: ss.decryptString };
  ss.isEncryptionAvailable = vi.fn(() => false);
  try {
    return fn();
  } finally {
    ss.isEncryptionAvailable = saved.a;
    ss.encryptString = saved.e;
    ss.decryptString = saved.d;
  }
}

/** 造一条 v1 密文（仅当 OS 通道不可用时 legacy 分支才会产出） */
function legacyV1(plain: string): string {
  const v1 = withoutKeychain(() => encryptData(plain));
  expect(v1).toMatch(/^v1:/);
  return v1;
}

/** 造一条 v2 密文（历史主通道：safeStorage 可用且未传 purpose） */
function legacyV2(plain: string): string {
  const v2 = encryptData(plain);
  expect(v2).toMatch(/^v2:/);
  return v2;
}

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
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  `);
  return db;
}

function insertProfile(id: string, apiKey: string | null): void {
  memDB.prepare(`INSERT INTO api_profiles (id, name, provider, api_key, base_url, models, is_active, sort_order, alias, enabled, is_preset, preset_type, created_at, updated_at)
    VALUES (?, ?, 'proxy', ?, 'https://api.example.com/v1', '["m1"]', 0, 0, NULL, 1, 0, NULL, '2026-09-25T00:00:00Z', '2026-09-25T00:00:00Z')`)
    .run(id, `alias-${id}`, apiKey);
}

function insertSetting(key: string, value: string): void {
  memDB.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

function rawApiKey(id: string): string | null {
  const row = memDB.prepare('SELECT api_key FROM api_profiles WHERE id = ?').get(id) as { api_key: string | null };
  return row.api_key;
}

function rawSetting(key: string): string | undefined {
  const row = memDB.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

describe('v1/v2 → v3 静默迁移（ADR-004 §4.3② / P2）', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zentect-migrate-'));
    enableKeychain();
    KeyStore.getInstance().init(dir);   // 首启生成 master.key（wrap_os 走假钥匙链）
    memDB = setupInMemoryDB();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.ZENTECT_CRED_V3;
  });

  // ---------------------------------------------------------------- T7

  it('T7 v1 → v3：库内改为 v3，读路径能原样读回明文', () => {
    const v1 = legacyV1('sk-legacy-v1');
    insertProfile('p1', v1);

    const report = ApiProfileRepository.migrateCredentialsToV3();

    expect(report.migrated).toBe(1);
    expect(rawApiKey('p1')).toMatch(/^v3:01:/);
    expect(rawApiKey('p1')).not.toBe(v1);
    // 读路径 purpose 与迁移一致 ⇒ 能读回；不一致则这里会是 decrypt_failed（迁移即毁数据）
    const profile = ApiProfileRepository.getByProvider('proxy')[0];
    expect(profile.apiKeyStatus).toBe('ok');
    expect(profile.apiKey).toBe('sk-legacy-v1');
  });

  // ---------------------------------------------------------------- T8

  it('T8 v2 → v3：库内改为 v3，读路径能原样读回明文', () => {
    const v2 = legacyV2('sk-legacy-v2');
    insertProfile('p2', v2);

    const report = ApiProfileRepository.migrateCredentialsToV3();

    expect(report.migrated).toBe(1);
    expect(rawApiKey('p2')).toMatch(/^v3:01:/);
    expect(ApiProfileRepository.getByProvider('proxy')[0].apiKey).toBe('sk-legacy-v2');
  });

  // ---------------------------------------------------------------- T10

  it('T10 幂等：已是 v3 不重复迁移（密文逐字节不变），空值/明文同样跳过', () => {
    const v3 = encryptData('sk-already-v3', PURPOSE);
    insertProfile('p3', v3);
    insertProfile('p4', null);
    insertProfile('p5', 'sk-plaintext-legacy');

    const report = ApiProfileRepository.migrateCredentialsToV3();

    expect(report).toEqual({ migrated: 0, skipped: 2, undecryptable: 0 });
    expect(rawApiKey('p3')).toBe(v3);                       // 不产生新密文
    expect(rawApiKey('p5')).toBe('sk-plaintext-legacy');    // 明文旧数据不被再加密
  });

  // ---------------------------------------------------------------- T9

  it('T9 回写失败 ⇒ 整事务回滚，原值全部保留（绝不先删旧值再写新值）', () => {
    const v1a = legacyV1('sk-a');
    const v1b = legacyV1('sk-b');
    insertProfile('p1', v1a);
    insertProfile('p2', v1b);
    // 用真实 SQL 层错误模拟第二条回写失败（无需 monkey-patch）
    memDB.exec(`CREATE TRIGGER t_fail_migration BEFORE UPDATE ON api_profiles
      WHEN NEW.api_key LIKE 'v3:%' AND OLD.id = 'p2'
      BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;`);

    expect(() => ApiProfileRepository.migrateCredentialsToV3()).toThrow(/simulated write failure/);

    // p1 在事务内已改写也必须一并回滚 —— 「commit 成功才算迁移完成」
    expect(rawApiKey('p1')).toBe(v1a);
    expect(rawApiKey('p2')).toBe(v1b);
    // 原值仍可读（fail-closed 未受影响，数据没有半迁移态）
    expect(ApiProfileRepository.getByProvider('proxy').map((p) => p.apiKey).sort()).toEqual(['sk-a', 'sk-b']);
  });

  it('解不开的旧密文保持原值（不迁移半成品），并计入 undecryptable', () => {
    const broken = `v1:${'00'.repeat(12)}:${'11'.repeat(16)}:${'22'.repeat(16)}`;
    const v2 = legacyV2('sk-good');
    insertProfile('p1', broken);
    insertProfile('p2', v2);

    const report = ApiProfileRepository.migrateCredentialsToV3();

    expect(report).toEqual({ migrated: 1, skipped: 0, undecryptable: 1 });
    expect(rawApiKey('p1')).toBe(broken);   // 原样保留，绝不写坏
    expect(rawApiKey('p2')).toMatch(/^v3:01:/);
  });

  it('v3 通道未就绪（开关 off）⇒ 整批跳过，原值原封不动', () => {
    const v2 = legacyV2('sk-keep');
    insertProfile('p1', v2);
    process.env.ZENTECT_CRED_V3 = '0';

    const report = ApiProfileRepository.migrateCredentialsToV3();

    expect(report).toEqual({ migrated: 0, skipped: 1, undecryptable: 0 });
    expect(rawApiKey('p1')).toBe(v2);
  });

  // ---------------------------------------------------------------- settings 面

  it('settings 敏感项 v2 → v3，且读路径能读回（purpose=settings:<key>）', () => {
    const v2 = legacyV2('sk-deepseek-1234');
    insertSetting('deepseekKey', v2);
    insertSetting('logPath', 'F:\\Tools\\Zentect\\data\\logs');   // 非密文不受影响
    const repo = new SettingsRepository();

    const report = repo.migrateCredentialsToV3();

    expect(report).toEqual({ migrated: 1, skipped: 1, undecryptable: 0 });
    expect(rawSetting('deepseekKey')).toMatch(/^v3:01:/);
    expect(rawSetting('logPath')).toBe('F:\\Tools\\Zentect\\data\\logs');
    expect(repo.get('deepseekKey', '')).toBe('sk-deepseek-1234');
  });
});