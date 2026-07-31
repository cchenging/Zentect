// 集成测试：用真实内存 SQLite 验证 ApiProfile / ProfileBinding 全链路
// 覆盖：建表、CRUD、字段持久化、加密、删除联动、绑定 upsert
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

// ========== 2. 用 vi.doMock（非 hoisted）注入内存 DB ==========
// doMock 不会提升，可安全引用外部 db；配合动态 import 让 mock 生效
vi.doMock('../../core/SQLiteConnection', () => ({
  SQLiteConnection: {
    getInstance: () => ({ getDB: () => db }),
  },
}));

// ========== 3. mock electron safeStorage（crypto.ts 依赖）==========
vi.doMock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, 'utf-8'),
    decryptString: (b: Buffer) => b.toString('utf-8'),
  },
}));

// ========== 4. 动态导入被测模块（在 doMock 生效后）==========
const { ApiProfileRepository } = await import('../ApiProfileRepository');
const { ProfileBindingRepository } = await import('../ProfileBindingRepository');

// 辅助：直接查 DB 验证原始存储（非解密）
function rawRow(id: string) {
  return db.prepare('SELECT * FROM api_profiles WHERE id = ?').get(id) as any;
}

describe('集成测试：ApiProfileRepository', () => {
  it('T1 getAll 空表返回空数组', () => {
    expect(ApiProfileRepository.getAll()).toEqual([]);
  });

  it('T2 create 应写入 alias/enabled/isPreset/presetType', () => {
    const profile = ApiProfileRepository.create({
      name: '火山方舟', provider: 'doubao',
      apiKey: 'sk-test-key-123456', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      models: ['doubao-seed-1-6-251015', 'doubao-seed-1-6-flash-250828'],
      isActive: false, sortOrder: 0,
      alias: '我的豆包', enabled: 1, isPreset: 1, presetType: 'doubao',
    });
    expect(profile.id).toBeDefined();
    const raw = rawRow(profile.id);
    expect(raw.alias).toBe('我的豆包');
    expect(raw.enabled).toBe(1);
    expect(raw.is_preset).toBe(1);
    expect(raw.preset_type).toBe('doubao');
  });

  it('T3 getAll 应返回 camelCase 字段', () => {
    const all = ApiProfileRepository.getAll();
    expect(all).toHaveLength(1);
    const p = all[0];
    expect(p.alias).toBe('我的豆包');
    expect(p.enabled).toBe(1);
    expect(p.isPreset).toBe(1); // number 类型，非 boolean
    expect(p.presetType).toBe('doubao');
    expect(p.baseUrl).toBe('https://ark.cn-beijing.volces.com/api/v3');
    expect(p.models).toEqual(['doubao-seed-1-6-251015', 'doubao-seed-1-6-flash-250828']);
  });

  it('T4 create 后 DB 中 api_key 不应是明文', () => {
    const all = ApiProfileRepository.getAll();
    const raw = rawRow(all[0].id);
    expect(raw.api_key).not.toBe('sk-test-key-123456');
    expect(raw.api_key.length).toBeGreaterThan(0);
  });

  it('T5 getAll 读回的 apiKey 应为解密明文', () => {
    expect(ApiProfileRepository.getAll()[0].apiKey).toBe('sk-test-key-123456');
  });

  it('T6 update 应修改 alias', () => {
    const id = ApiProfileRepository.getAll()[0].id;
    ApiProfileRepository.update(id, { alias: '改后的别名' });
    expect(rawRow(id).alias).toBe('改后的别名');
  });

  it('T7 update apiKey 后 DB 中应加密存储', () => {
    const id = ApiProfileRepository.getAll()[0].id;
    ApiProfileRepository.update(id, { apiKey: 'sk-new-key-987654' });
    expect(rawRow(id).api_key).not.toBe('sk-new-key-987654');
    expect(ApiProfileRepository.getAll()[0].apiKey).toBe('sk-new-key-987654');
  });

  it('T8 update 应修改 enabled', () => {
    const id = ApiProfileRepository.getAll()[0].id;
    ApiProfileRepository.update(id, { enabled: 0 });
    expect(rawRow(id).enabled).toBe(0);
  });

  it('T9 update models 应以 JSON 字符串存储', () => {
    const id = ApiProfileRepository.getAll()[0].id;
    ApiProfileRepository.update(id, { models: ['m1', 'm2', 'm3'] });
    expect(rawRow(id).models).toBe('["m1","m2","m3"]');
  });

  it('T10 toggleEnabled 应切换 enabled', () => {
    const id = ApiProfileRepository.getAll()[0].id;
    ApiProfileRepository.toggleEnabled(id, true);
    expect(rawRow(id).enabled).toBe(1);
    ApiProfileRepository.toggleEnabled(id, false);
    expect(rawRow(id).enabled).toBe(0);
  });

  it('T11 getByProvider 应按供应商过滤', () => {
    ApiProfileRepository.create({
      name: 'DeepSeek', provider: 'deepseek',
      apiKey: 'sk-ds-123', baseUrl: 'https://api.deepseek.com',
      models: ['deepseek-v4-pro'], isActive: false, sortOrder: 1,
      alias: '我的DS', enabled: 1, isPreset: 1, presetType: 'deepseek',
    });
    expect(ApiProfileRepository.getByProvider('deepseek')).toHaveLength(1);
    expect(ApiProfileRepository.getByProvider('doubao')).toHaveLength(1);
  });

  it('T12 activate 应设置 is_active=1', () => {
    const ds = ApiProfileRepository.getByProvider('deepseek')[0];
    ApiProfileRepository.activate(ds.id, 'deepseek');
    const active = ApiProfileRepository.getActive('deepseek');
    expect(active).not.toBeNull();
    expect(active!.id).toBe(ds.id);
  });
});

describe('集成测试：ProfileBindingRepository', () => {
  it('T13 getAll 应返回 migration 写入的默认绑定', () => {
    const all = ProfileBindingRepository.getAll();
    expect(all.length).toBeGreaterThanOrEqual(9);
    const taskTypes = all.map((b) => b.taskType);
    expect(taskTypes).toContain('visual');
    expect(taskTypes).toContain('script');
    expect(taskTypes).toContain('asr');
  });

  it('T14 upsert 应写入 profileId 和 modelName', () => {
    const ds = ApiProfileRepository.getByProvider('deepseek')[0];
    ProfileBindingRepository.upsert('visual', ds.id, 'deepseek-v4-pro');
    const binding = ProfileBindingRepository.getByTaskType('visual');
    expect(binding).not.toBeNull();
    expect(binding!.profileId).toBe(ds.id);
    expect(binding!.modelName).toBe('deepseek-v4-pro');
  });

  it('T15 upsert 重复 taskType 应更新而非插入新行', () => {
    const before = ProfileBindingRepository.getByTaskType('visual');
    ProfileBindingRepository.upsert('visual', before!.profileId, 'deepseek-v4-flash');
    expect(ProfileBindingRepository.getByTaskType('visual')!.modelName).toBe('deepseek-v4-flash');
    const count = ProfileBindingRepository.getAll().length;
    ProfileBindingRepository.upsert('visual', before!.profileId, '再次改');
    expect(ProfileBindingRepository.getAll().length).toBe(count);
  });

  it('T16 clearByProfileId 应删除引用该 profile 的绑定', () => {
    const ds = ApiProfileRepository.getByProvider('deepseek')[0];
    ProfileBindingRepository.upsert('visual', ds.id, 'deepseek-v4-pro');
    expect(ProfileBindingRepository.getByTaskType('visual')!.profileId).toBe(ds.id);
    const removed = ProfileBindingRepository.clearByProfileId(ds.id);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(ProfileBindingRepository.getByTaskType('visual')).toBeNull();
  });
});

describe('集成测试：删除 Profile 联动清理绑定', () => {
  it('T17 仅调 delete（无联动）→ binding 残留 model_name', () => {
    const profile = ApiProfileRepository.create({
      name: 'Qwen', provider: 'qwen',
      apiKey: 'sk-qwen-123', baseUrl: 'https://dashscope.aliyuncs.com',
      models: ['qwen3.7-max'], isActive: false, sortOrder: 2,
      alias: '我的千问', enabled: 1, isPreset: 1, presetType: 'qwen',
    });
    ProfileBindingRepository.upsert('script', profile.id, 'qwen3.7-max');

    // 仅调 delete（模拟未联动清理的旧逻辑）
    ApiProfileRepository.delete(profile.id);
    expect(ApiProfileRepository.getByProvider('qwen')).toHaveLength(0);

    // DB 层 ON DELETE SET NULL 只清 profile_id，model_name 残留
    const rawBinding = db.prepare('SELECT * FROM ai_profile_bindings WHERE task_type = ?').get('script') as any;
    expect(rawBinding).not.toBeNull();
    expect(rawBinding.profile_id).toBeNull();
    expect(rawBinding.model_name).toBe('qwen3.7-max');
  });

  it('T18 clearByProfileId + delete → 彻底清理', () => {
    const profile = ApiProfileRepository.create({
      name: 'Hunyuan', provider: 'hunyuan',
      apiKey: 'sk-hy-123', baseUrl: 'https://api.hunyuan.cloud.tencent.com',
      models: ['hunyuan-turbos-latest'], isActive: false, sortOrder: 3,
      alias: '我的混元', enabled: 1, isPreset: 1, presetType: 'hunyuan',
    });
    ProfileBindingRepository.upsert('translate', profile.id, 'hunyuan-turbos-latest');

    // 正确流程：先清绑定，再删 profile（controller 已实现此逻辑）
    ProfileBindingRepository.clearByProfileId(profile.id);
    ApiProfileRepository.delete(profile.id);

    const rawBinding = db.prepare('SELECT * FROM ai_profile_bindings WHERE task_type = ?').get('translate') as any;
    expect(rawBinding).toBeUndefined();
  });
});
