// 集成测试 2：删除链路完整性 + 数据库安全性验证
// 验证：1) 删除 Profile 后 DB 中数据是否彻底清除
//      2) apiKey 加密后 DB 中是否可读
//      3) 外键 ON DELETE SET NULL 行为
import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// ========== 1. 构造内存 DB + 执行真实 migration SQL ==========
const db = new Database(':memory:');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const migrationsDir = resolve(__dirname, '../../migrations');
const sqlFiles = [
  '017_api_profiles.sql',
  '019_ai_profile_bindings.sql',
  '024_api_profiles_ext.sql',
  '025_ai_bindings_ext.sql',
];
for (const f of sqlFiles) {
  const sql = readFileSync(resolve(migrationsDir, f), 'utf-8');
  db.exec(sql);
}

// ========== 2. mock ==========
vi.doMock('../../core/SQLiteConnection', () => ({
  SQLiteConnection: { getInstance: () => ({ getDB: () => db }) },
}));

vi.doMock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    // 模拟「无法解密」场景：返回乱码，验证 DB 中数据是否真的加密
    encryptString: (s: string) => Buffer.from(`ENCRYPTED::${s}`, 'utf-8'),
    decryptString: (b: Buffer) => {
      const str = b.toString('utf-8');
      if (str.startsWith('ENCRYPTED::')) return str.slice(11);
      throw new Error('decrypt failed');
    },
  },
}));

const { ApiProfileRepository } = await import('../ApiProfileRepository');
const { ProfileBindingRepository } = await import('../ProfileBindingRepository');
const { encryptData } = await import('../../../utils/crypto');

describe('删除链路完整性', () => {
  it('D1 仅调 ApiProfileRepository.delete → api_profiles 行被删除', () => {
    const profile = ApiProfileRepository.create({
      name: 'TestDoubao', provider: 'doubao',
      apiKey: 'sk-delete-test-123456', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      models: ['m1'], isActive: false, sortOrder: 0,
      alias: '删除测试', enabled: 1, isPreset: 1, presetType: 'doubao',
    });
    const before = db.prepare('SELECT COUNT(*) as c FROM api_profiles WHERE id = ?').get(profile.id) as any;
    expect(before.c).toBe(1);

    ApiProfileRepository.delete(profile.id);

    const after = db.prepare('SELECT COUNT(*) as c FROM api_profiles WHERE id = ?').get(profile.id) as any;
    expect(after.c).toBe(0);
  });

  it('D2 仅调 delete → 绑定行残留（DB 外键 SET NULL 只清 profile_id）', () => {
    const profile = ApiProfileRepository.create({
      name: 'TestDS', provider: 'deepseek',
      apiKey: 'sk-ds-delete-test', baseUrl: 'https://api.deepseek.com',
      models: ['deepseek-v4-pro'], isActive: false, sortOrder: 1,
      alias: 'DS删除', enabled: 1, isPreset: 1, presetType: 'deepseek',
    });
    ProfileBindingRepository.upsert('visual', profile.id, 'deepseek-v4-pro');

    ApiProfileRepository.delete(profile.id);

    // api_profiles 已删除
    expect((db.prepare('SELECT COUNT(*) as c FROM api_profiles WHERE id = ?').get(profile.id) as any).c).toBe(0);

    // 但 ai_profile_bindings 行还在，profile_id 为 NULL，model_name 残留
    const binding = db.prepare('SELECT * FROM ai_profile_bindings WHERE task_type = ?').get('visual') as any;
    expect(binding).not.toBeUndefined();
    expect(binding.profile_id).toBeNull();
    expect(binding.model_name).toBe('deepseek-v4-pro');
  });

  it('D3 controller 正确流程（clearByProfileId + delete）→ 绑定行彻底删除', () => {
    const profile = ApiProfileRepository.create({
      name: 'TestQwen', provider: 'qwen',
      apiKey: 'sk-qwen-delete-test', baseUrl: 'https://dashscope.aliyuncs.com',
      models: ['qwen3.7-max'], isActive: false, sortOrder: 2,
      alias: '千问删除', enabled: 1, isPreset: 1, presetType: 'qwen',
    });
    ProfileBindingRepository.upsert('script', profile.id, 'qwen3.7-max');

    // 模拟 controller 的 delete handler（已修复版）
    ProfileBindingRepository.clearByProfileId(profile.id);
    ApiProfileRepository.delete(profile.id);

    // api_profiles 已删除
    expect((db.prepare('SELECT COUNT(*) as c FROM api_profiles WHERE id = ?').get(profile.id) as any).c).toBe(0);

    // ai_profile_bindings 行也被删除（无残留）
    const binding = db.prepare('SELECT * FROM ai_profile_bindings WHERE task_type = ?').get('script') as any;
    expect(binding).toBeUndefined();
  });

  it('D4 删除 Profile → 多个绑定同时清理', () => {
    const profile = ApiProfileRepository.create({
      name: 'MultiBind', provider: 'hunyuan',
      apiKey: 'sk-multi-delete-test', baseUrl: 'https://api.hunyuan.cloud.tencent.com',
      models: ['hunyuan-turbos-latest'], isActive: false, sortOrder: 3,
      alias: '多绑定删除', enabled: 1, isPreset: 1, presetType: 'hunyuan',
    });
    // 同一 Profile 被多个任务绑定
    ProfileBindingRepository.upsert('translate', profile.id, 'hunyuan-turbos-latest');
    ProfileBindingRepository.upsert('helper', profile.id, 'hunyuan-turbos-latest');
    ProfileBindingRepository.upsert('chat', profile.id, 'hunyuan-turbos-latest');

    const removed = ProfileBindingRepository.clearByProfileId(profile.id);
    expect(removed).toBe(3);
    ApiProfileRepository.delete(profile.id);

    // 3 个绑定全部清理
    for (const task of ['translate', 'helper', 'chat']) {
      const b = db.prepare('SELECT * FROM ai_profile_bindings WHERE task_type = ?').get(task) as any;
      expect(b).toBeUndefined();
    }
  });

  it('D5 删除不存在的 Profile → 返回 false', () => {
    const result = ApiProfileRepository.delete('non-existent-id');
    expect(result).toBe(false);
  });
});

describe('数据库安全性验证', () => {
  it('S1 apiKey 在 DB 中是加密存储（非明文）', () => {
    const profile = ApiProfileRepository.create({
      name: 'SecurityTest', provider: 'doubao',
      apiKey: 'sk-secret-key-1234567890', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      models: ['m1'], isActive: false, sortOrder: 10,
      alias: '安全测试', enabled: 1, isPreset: 1, presetType: 'doubao',
    });

    // 直接查 DB 原始数据（绕过 Repository 的解密）
    const raw = db.prepare('SELECT api_key FROM api_profiles WHERE id = ?').get(profile.id) as any;

    // DB 中不应是明文
    expect(raw.api_key).not.toBe('sk-secret-key-1234567890');
    expect(raw.api_key).not.toContain('sk-secret');
    // 应包含加密前缀（v1 或 ENCRYPTED::）
    expect(raw.api_key.length).toBeGreaterThan(10);
  });

  it('S2 通过 Repository 读取时能正确解密', () => {
    const all = ApiProfileRepository.getAll();
    const found = all.find((p) => p.alias === '安全测试');
    expect(found).toBeDefined();
    expect(found!.apiKey).toBe('sk-secret-key-1234567890');
  });

  it('S3 数据库文件本身可被直接打开（无密码）', () => {
    // SQLite 数据库文件没有密码保护，任何能访问文件系统的人都能读取
    // 这里验证：better-sqlite3 不需要任何密码即可查询
    const users = db.prepare('SELECT name FROM sqlite_master WHERE type = ?').all('table') as any[];
    expect(users.length).toBeGreaterThan(0);

    // 能直接读到加密后的 api_key
    const rows = db.prepare('SELECT id, api_key, alias FROM api_profiles').all() as any[];
    expect(rows.length).toBeGreaterThan(0);
    // 但读到的是密文，不是明文
    for (const row of rows) {
      if (row.api_key) {
        expect(row.api_key).not.toMatch(/^sk-[a-zA-Z0-9]+$/);
      }
    }
  });

  it('S4 safeStorage 不可用时回退到 AES-256-GCM 加密', () => {
    // 当前 mock 的 safeStorage.isEncryptionAvailable() === false
    // encryptData 应使用 v1: 格式（AES-256-GCM）
    const encrypted = encryptData('sk-test-fallback-123');
    expect(encrypted).toMatch(/^v1:/);
    expect(encrypted).not.toBe('sk-test-fallback-123');
  });

  it('S5 解密失败时返回原值（不抛异常）', () => {
    // 直接往 DB 插入一段无法解密的字符串
    db.prepare('INSERT INTO api_profiles (id, name, provider, api_key, base_url, models, is_active, sort_order, extra_config, alias, enabled, is_preset, preset_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'test-corrupt', 'Corrupt', 'doubao', 'corrupt-data-not-encrypted', '', '[]', 0, 0, null, '损坏测试', 1, 0, null, new Date().toISOString(), new Date().toISOString()
    );
    // 读取不应抛异常
    const all = ApiProfileRepository.getAll();
    const corrupt = all.find((p) => p.id === 'test-corrupt');
    expect(corrupt).toBeDefined();
    // 解密失败时返回原值
    expect(corrupt!.apiKey).toBe('corrupt-data-not-encrypted');
  });
});

describe('绑定数据隔离性', () => {
  it('B1 Profile 删除后，upsert 同 taskType 会重建绑定（不残留旧数据）', () => {
    const p1 = ApiProfileRepository.create({
      name: 'P1', provider: 'doubao',
      apiKey: 'sk-p1-key-12345678', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      models: ['m1'], isActive: false, sortOrder: 20,
      alias: 'P1', enabled: 1, isPreset: 1, presetType: 'doubao',
    });
    ProfileBindingRepository.upsert('sentiment', p1.id, 'm1');

    // 删除 P1（先清绑定）
    ProfileBindingRepository.clearByProfileId(p1.id);
    ApiProfileRepository.delete(p1.id);

    // sentiment 现在应为空
    expect(ProfileBindingRepository.getByTaskType('sentiment')).toBeNull();

    // 用 P2 重新绑定
    const p2 = ApiProfileRepository.create({
      name: 'P2', provider: 'deepseek',
      apiKey: 'sk-p2-key-12345678', baseUrl: 'https://api.deepseek.com',
      models: ['m2'], isActive: false, sortOrder: 21,
      alias: 'P2', enabled: 1, isPreset: 1, presetType: 'deepseek',
    });
    ProfileBindingRepository.upsert('sentiment', p2.id, 'm2');

    const b = ProfileBindingRepository.getByTaskType('sentiment');
    expect(b).not.toBeNull();
    expect(b!.profileId).toBe(p2.id);
    expect(b!.modelName).toBe('m2');
  });
});
