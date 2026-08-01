// 📁 路径: src/main/database/repositories/__tests__/GlobalCharacterRepository.test.ts
// 🎭 P1 全局人物注册中心 — 比对/CRUD/吸收逻辑单元测试
// 使用内存 SQLite 验证：
//   1. create/findAll/findById/delete CRUD
//   2. findBestMatch 余弦相似度匹配（命中/未命中/阈值边界）
//   3. matchOrCreate 自动新建 vs 绑定现有
//   4. absorbEmbedding 增量中心向量更新 + 项目 ID 追加
//   5. cosineSimilarity 纯函数边界（空向量/不同维度/归一化）

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

// === Mock 依赖 ===

vi.mock('../../../core/AppLogger', () => ({
  AppLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../../../modules/infra/logger/LogConstants', () => ({
  LOG_TAGS: { BOOTSTRAP: 'bootstrap', DB: 'db' },
}));

/** 内存 SQLite 实例 */
let memDB: Database.Database;

vi.mock('../../../../modules/infra/database/SQLiteConnection', () => ({
  SQLiteConnection: {
    getInstance: () => ({
      getDB: () => memDB,
    }),
  },
}));

import { GlobalCharacterRepository, cosineSimilarity, DEFAULT_MATCH_THRESHOLD } from '../GlobalCharacterRepository';

/**
 * 初始化内存 DB 并创建 global_characters 表（与迁移 027 一致）
 */
function setupInMemoryDB(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = MEMORY');
  db.exec(`
    CREATE TABLE IF NOT EXISTS global_characters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      avatar TEXT,
      embedding_center TEXT NOT NULL,
      embedding_version TEXT NOT NULL DEFAULT 'arcface_v1',
      voice_id TEXT,
      pronoun TEXT,
      description TEXT,
      appearance_count INTEGER NOT NULL DEFAULT 1,
      source_project_ids TEXT,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_deleted INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

/**
 * 生成 512 维归一化向量（用种子保证测试可重现）
 * @param seed 种子（不同种子生成不同向量）
 */
function makeEmbedding(seed: number): number[] {
  const dim = 512;
  const vec: number[] = new Array(dim);
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    // 简单线性同余生成器
    seed = (seed * 9301 + 49297) % 233280;
    vec[i] = seed / 233280 - 0.5;
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);
  return vec.map((v) => v / norm); // 归一化
}

/**
 * 生成与基准向量"接近"的向量（每个元素加微小扰动后重新归一化）
 * @param base 基准向量
 * @param noise 噪声幅度（0~1，越小越相似）
 */
function makeSimilarEmbedding(base: number[], noise: number): number[] {
  const vec = base.map((v) => v + (Math.random() - 0.5) * noise);
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return norm > 0 ? vec.map((v) => v / norm) : vec;
}

describe('🎭 P1 GlobalCharacterRepository', () => {
  let repo: GlobalCharacterRepository;

  beforeEach(() => {
    memDB = setupInMemoryDB();
    repo = new GlobalCharacterRepository();
  });

  describe('cosineSimilarity 纯函数', () => {
    it('相同向量相似度为 1', () => {
      const v = makeEmbedding(42);
      expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
    });

    it('正交向量相似度为 0', () => {
      const a = [1, 0, 0, 0];
      const b = [0, 1, 0, 0];
      expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
    });

    it('空向量返回 0', () => {
      expect(cosineSimilarity([], [])).toBe(0);
    });

    it('不同维度取最小维度计算', () => {
      const a = [1, 0, 0, 0];
      const b = [1, 0]; // 只比前 2 维
      expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);
    });

    it('零向量返回 0（避免除零）', () => {
      expect(cosineSimilarity([0, 0, 0], [1, 0, 0])).toBe(0);
    });
  });

  describe('create / findAll / findById / delete', () => {
    it('create 应写入并返回 GlobalCharacter', () => {
      const emb = makeEmbedding(1);
      const created = repo.create({
        id: 'gc_test1',
        name: '张三',
        embeddingCenter: emb,
        avatar: '/avatars/zhangsan.jpg',
        voiceId: 'zh-CN-XiaoxiaoNeural',
        sourceProjectId: 'proj_1',
      });

      expect(created.id).toBe('gc_test1');
      expect(created.name).toBe('张三');
      expect(created.appearanceCount).toBe(1);
      expect(Array.isArray(created.embeddingCenter)).toBe(true);
      expect((created.embeddingCenter as number[]).length).toBe(512);
      expect(Array.isArray(created.sourceProjectIds)).toBe(true);
      expect((created.sourceProjectIds as string[])).toContain('proj_1');
    });

    it('findAll 返回所有未删除人物（按出现次数降序）', () => {
      repo.create({ id: 'gc_1', name: 'A', embeddingCenter: makeEmbedding(1), sourceProjectId: 'p1' });
      repo.create({ id: 'gc_2', name: 'B', embeddingCenter: makeEmbedding(2), sourceProjectId: 'p1' });
      // gc_1 吸收一次 → appearance_count=2
      repo.absorbEmbedding('gc_1', makeEmbedding(1));

      const all = repo.findAll();
      expect(all).toHaveLength(2);
      expect(all[0].id).toBe('gc_1'); // 出现 2 次排前面
      expect(all[1].id).toBe('gc_2');
    });

    it('findById 未命中返回 null', () => {
      expect(repo.findById('non_existent')).toBeNull();
    });

    it('delete 软删除后 findAll 查不到', () => {
      repo.create({ id: 'gc_1', name: 'A', embeddingCenter: makeEmbedding(1) });
      repo.delete('gc_1');
      expect(repo.findAll()).toHaveLength(0);
      expect(repo.findById('gc_1')).toBeNull();
    });
  });

  describe('findBestMatch', () => {
    it('空库时返回 null', () => {
      const result = repo.findBestMatch(makeEmbedding(1));
      expect(result.character).toBeNull();
      expect(result.similarity).toBe(0);
    });

    it('相似度 > 阈值时命中', () => {
      const baseEmb = makeEmbedding(100);
      repo.create({ id: 'gc_zhang', name: '张三', embeddingCenter: baseEmb });

      // 构造一个与 baseEmb 非常接近的向量（微小噪声）
      const queryEmb = baseEmb.slice(); // 完全相同 → 相似度 = 1
      const result = repo.findBestMatch(queryEmb, DEFAULT_MATCH_THRESHOLD);

      expect(result.character).not.toBeNull();
      expect(result.character!.id).toBe('gc_zhang');
      expect(result.similarity).toBeGreaterThan(0.99);
    });

    it('相似度 < 阈值时未命中（返回 similarity 但 character=null）', () => {
      repo.create({ id: 'gc_li', name: '李四', embeddingCenter: makeEmbedding(200) });

      // 用完全不同的种子生成向量
      const queryEmb = makeEmbedding(999);
      const result = repo.findBestMatch(queryEmb, DEFAULT_MATCH_THRESHOLD);

      expect(result.character).toBeNull();
      expect(result.similarity).toBeLessThan(DEFAULT_MATCH_THRESHOLD);
    });

    it('多人物库中返回最佳匹配', () => {
      const zhangEmb = makeEmbedding(100);
      const liEmb = makeEmbedding(200);
      const wangEmb = makeEmbedding(300);
      repo.create({ id: 'gc_zhang', name: '张三', embeddingCenter: zhangEmb });
      repo.create({ id: 'gc_li', name: '李四', embeddingCenter: liEmb });
      repo.create({ id: 'gc_wang', name: '王五', embeddingCenter: wangEmb });

      // 查询向量与 liEmb 完全相同
      const result = repo.findBestMatch(liEmb);
      expect(result.character!.id).toBe('gc_li');
      expect(result.similarity).toBeGreaterThan(0.99);
    });

    it('自定义阈值生效（高阈值导致漏匹配）', () => {
      const baseEmb = makeEmbedding(100);
      repo.create({ id: 'gc_zhang', name: '张三', embeddingCenter: baseEmb });

      // 加微小噪声：低阈值能命中，高阈值（0.99）会漏匹配
      const queryEmb = makeSimilarEmbedding(baseEmb, 0.05);
      const lowThresholdResult = repo.findBestMatch(queryEmb, 0.5);
      const highThresholdResult = repo.findBestMatch(queryEmb, 0.99);

      // 低阈值应命中
      expect(lowThresholdResult.character).not.toBeNull();
      expect(lowThresholdResult.similarity).toBeGreaterThan(0.5);
      // 高阈值（0.99）几乎必然漏匹配（微小噪声也会让相似度 < 0.99）
      expect(highThresholdResult.similarity).toBeLessThan(0.99);
      expect(highThresholdResult.character).toBeNull();
    });
  });

  describe('matchOrCreate', () => {
    it('未匹配时创建新全局人物', () => {
      const emb = makeEmbedding(500);
      const result = repo.matchOrCreate(emb, '新人物', '/avatars/new.jpg', 'proj_1');

      expect(result.created).toBe(true);
      expect(result.character).not.toBeNull();
      expect(result.character!.name).toBe('新人物');
      expect(result.character!.avatar).toBe('/avatars/new.jpg');
      expect(result.character!.appearanceCount).toBe(1);
      expect((result.character!.sourceProjectIds as string[])).toContain('proj_1');
    });

    it('匹配时返回现有人物（不新建）', () => {
      const baseEmb = makeEmbedding(100);
      // 第一次创建
      const first = repo.matchOrCreate(baseEmb, '张三', null, 'proj_1');
      expect(first.created).toBe(true);

      // 第二次用相同向量应匹配到现有
      const second = repo.matchOrCreate(baseEmb, '别名', null, 'proj_2');
      expect(second.created).toBe(false);
      expect(second.character!.id).toBe(first.character!.id);
      expect(second.character!.name).toBe('张三'); // 名字保持原样
      expect(second.similarity).toBeGreaterThan(0.99);
    });

    it('新建的人物 ID 以 gc_ 前缀开头', () => {
      const result = repo.matchOrCreate(makeEmbedding(1), 'test', null, 'p1');
      expect(result.character!.id).toMatch(/^gc_/);
    });
  });

  describe('absorbEmbedding', () => {
    it('吸收新向量后中心更新 + appearance_count +1', () => {
      const baseEmb = makeEmbedding(100);
      repo.create({ id: 'gc_1', name: 'A', embeddingCenter: baseEmb, sourceProjectId: 'p1' });

      const newEmb = makeEmbedding(101);
      repo.absorbEmbedding('gc_1', newEmb, 'p2');

      const updated = repo.findById('gc_1')!;
      expect(updated.appearanceCount).toBe(2);
      const center = updated.embeddingCenter as number[];
      expect(center.length).toBe(512);
      // 中心应该仍是归一化的
      const norm = Math.sqrt(center.reduce((s, v) => s + v * v, 0));
      expect(norm).toBeCloseTo(1, 4);
    });

    it('吸收时新项目 ID 自动追加到 source_project_ids', () => {
      repo.create({ id: 'gc_1', name: 'A', embeddingCenter: makeEmbedding(1), sourceProjectId: 'p1' });

      repo.absorbEmbedding('gc_1', makeEmbedding(2), 'p2');
      repo.absorbEmbedding('gc_1', makeEmbedding(3), 'p3');

      const updated = repo.findById('gc_1')!;
      const projectIds = updated.sourceProjectIds as string[];
      expect(projectIds).toContain('p1');
      expect(projectIds).toContain('p2');
      expect(projectIds).toContain('p3');
      expect(projectIds).toHaveLength(3);
    });

    it('吸收相同项目 ID 不重复追加', () => {
      repo.create({ id: 'gc_1', name: 'A', embeddingCenter: makeEmbedding(1), sourceProjectId: 'p1' });
      repo.absorbEmbedding('gc_1', makeEmbedding(2), 'p1'); // 相同项目

      const updated = repo.findById('gc_1')!;
      expect((updated.sourceProjectIds as string[])).toEqual(['p1']);
      expect(updated.appearanceCount).toBe(2); // 但次数仍累加
    });

    it('不存在的 ID 静默返回（不抛异常）', () => {
      expect(() => repo.absorbEmbedding('non_existent', makeEmbedding(1))).not.toThrow();
    });
  });

  describe('update', () => {
    it('更新名称和音色', () => {
      repo.create({ id: 'gc_1', name: '旧名', embeddingCenter: makeEmbedding(1) });
      repo.update('gc_1', { name: '新名', voiceId: 'zh-CN-XiaoyiNeural' });

      const updated = repo.findById('gc_1')!;
      expect(updated.name).toBe('新名');
      expect(updated.voiceId).toBe('zh-CN-XiaoyiNeural');
    });

    it('空字段对象时无操作', () => {
      repo.create({ id: 'gc_1', name: 'A', embeddingCenter: makeEmbedding(1) });
      repo.update('gc_1', {});

      const updated = repo.findById('gc_1')!;
      expect(updated.name).toBe('A');
    });
  });

  describe('端到端：聚类后自动匹配流程', () => {
    it('模拟 step1 聚类后多个角色匹配全局人物库', () => {
      // 项目1 的角色们
      const proj1Role1Emb = makeEmbedding(100); // 张三
      const proj1Role2Emb = makeEmbedding(200); // 李四

      // 项目1 聚类完成 → 自动匹配
      const r1 = repo.matchOrCreate(proj1Role1Emb, '角色1', '/p1/r1.jpg', 'proj_1');
      const r2 = repo.matchOrCreate(proj1Role2Emb, '角色2', '/p1/r2.jpg', 'proj_1');
      expect(r1.created).toBe(true);
      expect(r2.created).toBe(true);
      expect(repo.findAll()).toHaveLength(2);

      // 项目2 出现相同人物（用相同 embedding 模拟）
      const proj2Role1Emb = proj1Role1Emb.slice(); // 与张三相同
      const r3 = repo.matchOrCreate(proj2Role1Emb, '男一号', '/p2/r1.jpg', 'proj_2');
      expect(r3.created).toBe(false);
      expect(r3.character!.id).toBe(r1.character!.id); // 绑定到张三

      // 项目2 还出现新人物
      const proj2Role2Emb = makeEmbedding(300); // 王五
      const r4 = repo.matchOrCreate(proj2Role2Emb, '配角', '/p2/r2.jpg', 'proj_2');
      expect(r4.created).toBe(true);

      // 最终全局库有 3 个人物
      expect(repo.findAll()).toHaveLength(3);

      // 张三（r1）应该出现在 proj_1 和 proj_2 两个项目
      // 但注意：matchOrCreate 不自动 absorb，所以 source_project_ids 只有 proj_1
      // 调用方需要在匹配后主动调用 absorbEmbedding
      const zhang = repo.findById(r1.character!.id)!;
      expect((zhang.sourceProjectIds as string[])).toEqual(['proj_1']);

      // 调用方主动吸收
      repo.absorbEmbedding(zhang.id, proj2Role1Emb, 'proj_2');
      const zhangAfter = repo.findById(zhang.id)!;
      expect(zhangAfter.appearanceCount).toBe(2);
      expect((zhangAfter.sourceProjectIds as string[])).toContain('proj_1');
      expect((zhangAfter.sourceProjectIds as string[])).toContain('proj_2');
    });
  });
});
