// 📁 路径: src/main/database/repositories/__tests__/ProjectRepository.vlmFrames.test.ts
// vlmFrames 持久化往返集成测试
// 验证 saveFullProjectData 写入 vlmFrames 到 metadata，loadFullProjectData 正确读回
// 覆盖：非空写入、空数组保护、undefined 保护、完整往返

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

// === Mock 依赖 ===

/** Mock AppLogger — ProjectRepository 内部日志调用 */
vi.mock('../../../core/AppLogger', () => ({
  AppLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

/** Mock LogConstants — AppLogger 依赖 */
vi.mock('../../../../modules/infra/logger/LogConstants', () => ({
  LOG_TAGS: { BOOTSTRAP: 'bootstrap', DB: 'db' },
}));

/**
 * 内存 SQLite 数据库实例
 * 全局共享，每个测试前重置表数据
 */
let memDB: Database.Database;

/**
 * Mock SQLiteConnection 单例，返回内存 DB
 * 这样 ProjectRepository 的 `private get db()` 会拿到内存 DB
 */
vi.mock('../../../../modules/infra/database/SQLiteConnection', () => ({
  SQLiteConnection: {
    getInstance: () => ({
      getDB: () => memDB,
    }),
  },
}));

import { ProjectRepository } from '../ProjectRepository';

/**
 * 初始化内存 DB 并创建必要表结构
 * 包含 projects/media_assets/roles/shots 表 + metadata 列
 */
function setupInMemoryDB(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = MEMORY');

  // 创建 projects 表（参考 001_initial_schema.sql）
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT DEFAULT 'video',
      path TEXT,
      category TEXT DEFAULT 'short',
      cover_path TEXT,
      duration TEXT,
      disk_size REAL DEFAULT 0,
      status TEXT DEFAULT 'active',
      canvas_data TEXT,
      metadata TEXT,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_deleted INTEGER DEFAULT 0
    );
  `);

  // 创建 media_assets 表
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_assets (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      episode_num INTEGER,
      type TEXT,
      name TEXT,
      file_path TEXT,
      cover_path TEXT,
      duration REAL,
      status TEXT DEFAULT 'ready',
      width INTEGER,
      height INTEGER,
      fps REAL,
      frames TEXT,
      extracted_audio TEXT,
      extracted_vocals TEXT,
      extracted_bgm TEXT,
      extracted_text TEXT,
      extract_duration TEXT,
      narration_script TEXT,
      faces_json TEXT,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_deleted INTEGER DEFAULT 0
    );
  `);

  // 创建 roles 表（含 faces_json 列）
  db.exec(`
    CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      system_id TEXT,
      name TEXT,
      pronoun TEXT,
      avatar TEXT,
      description TEXT,
      voice_id TEXT,
      merged_roles TEXT,
      faces_json TEXT,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_deleted INTEGER DEFAULT 0
    );
  `);

  // 创建 shots 表
  db.exec(`
    CREATE TABLE IF NOT EXISTS shots (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      episode_num INTEGER,
      time_code TEXT,
      duration TEXT,
      ai_text TEXT,
      original_text TEXT,
      role_id TEXT,
      original_role_id TEXT,
      cover_path TEXT,
      reasoning TEXT,
      characters TEXT,
      camera TEXT,
      audio_path TEXT,
      audio_duration REAL,
      align_strategy TEXT,
      start_time REAL,
      end_time REAL,
      audio_emotion TEXT,
      vision_text TEXT,
      context_frames TEXT,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_deleted INTEGER DEFAULT 0
    );
  `);

  return db;
}

/**
 * 向 projects 表插入一条测试项目记录
 * @param projectId 项目 ID
 * @param metadata 初始 metadata（可选，默认空对象）
 */
function insertTestProject(projectId: string, metadata: any = {}): void {
  memDB.prepare(
    `INSERT INTO projects (id, name, metadata, is_deleted) VALUES (?, ?, ?, 0)`
  ).run(projectId, '测试项目', JSON.stringify(metadata));
}

/**
 * 读取 projects 表中某项目的 metadata（JSON 解析后返回）
 * @param projectId 项目 ID
 */
function readProjectMetadata(projectId: string): any {
  const row = memDB.prepare('SELECT metadata FROM projects WHERE id = ?').get(projectId) as any;
  if (!row || !row.metadata) return {};
  try {
    return typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
  } catch {
    return {};
  }
}

/**
 * 构造标准 vlmFrames 测试数据（3 帧画面描述）
 */
function buildTestVlmFrames(): any[] {
  return [
    {
      url: 'magic://proj_test/frame1.jpg',
      description: '男子走入画面，暖色调室内场景',
      editing: false,
      confirmed: true,
    },
    {
      url: 'magic://proj_test/frame2.jpg',
      description: '男子拿起杯子，近景特写',
      editing: false,
      confirmed: true,
    },
    {
      url: 'magic://proj_test/frame3.jpg',
      description: '男子微笑饮茶，面部特写',
      editing: false,
      confirmed: true,
    },
  ];
}

describe('ProjectRepository - vlmFrames 持久化往返', () => {
  let repo: ProjectRepository;
  const PROJECT_ID = 'test_proj_vlm_001';

  beforeEach(() => {
    memDB = setupInMemoryDB();
    repo = new ProjectRepository();
    insertTestProject(PROJECT_ID);
  });

  afterEach(() => {
    if (memDB) memDB.close();
  });

  // ══════════════════════════════════════════
  // 场景1：非空 vlmFrames 正确写入并读回
  // ══════════════════════════════════════════

  it('非空 vlmFrames 写入 metadata 后可被 loadFullProjectData 读回', () => {
    const vlmFrames = buildTestVlmFrames();

    // 执行保存
    repo.saveFullProjectData(PROJECT_ID, {
      vlmFrames,
      mediaItems: [],
      roles: [],
      shots: [],
    });

    // 验证 DB 中 metadata.vlmFrames 已写入
    const meta = readProjectMetadata(PROJECT_ID);
    expect(meta.vlmFrames).toBeDefined();
    expect(Array.isArray(meta.vlmFrames)).toBe(true);
    expect(meta.vlmFrames).toHaveLength(3);
    expect(meta.vlmFrames[0].description).toContain('男子走入画面');

    // 执行加载，验证 loadFullProjectData 返回的数据包含 vlmFrames
    const loaded = repo.loadFullProjectData(PROJECT_ID);
    expect(loaded).not.toBeNull();
    expect(loaded.vlmFrames).toBeDefined();
    expect(Array.isArray(loaded.vlmFrames)).toBe(true);
    expect(loaded.vlmFrames).toHaveLength(3);
    expect(loaded.vlmFrames[0].description).toContain('男子走入画面');
    expect(loaded.vlmFrames[2].description).toContain('男子微笑饮茶');
  });

  // ══════════════════════════════════════════
  // 场景2：空数组 vlmFrames 不覆盖已有数据
  // ══════════════════════════════════════════

  it('空数组 vlmFrames 不覆盖已有数据（保护机制）', () => {
    // 先写入非空 vlmFrames
    repo.saveFullProjectData(PROJECT_ID, {
      vlmFrames: buildTestVlmFrames(),
      mediaItems: [],
      roles: [],
      shots: [],
    });
    expect(readProjectMetadata(PROJECT_ID).vlmFrames).toHaveLength(3);

    // 再次保存，传入空数组 vlmFrames（模拟 IPCBridge 清空 store 后的保存）
    repo.saveFullProjectData(PROJECT_ID, {
      vlmFrames: [],
      mediaItems: [],
      roles: [],
      shots: [],
    });

    // 验证 DB 中 vlmFrames 仍为 3 帧（未被空数组覆盖）
    const meta = readProjectMetadata(PROJECT_ID);
    expect(meta.vlmFrames).toHaveLength(3);
    expect(meta.vlmFrames[0].description).toContain('男子走入画面');
  });

  // ══════════════════════════════════════════
  // 场景3：undefined vlmFrames 不影响已有数据
  // ══════════════════════════════════════════

  it('undefined vlmFrames 不影响已有数据（partial hydration 安全）', () => {
    // 先写入非空 vlmFrames
    repo.saveFullProjectData(PROJECT_ID, {
      vlmFrames: buildTestVlmFrames(),
      mediaItems: [],
      roles: [],
      shots: [],
    });

    // 再次保存，不传 vlmFrames（模拟 partial hydration 只传部分字段）
    repo.saveFullProjectData(PROJECT_ID, {
      // vlmFrames 字段缺失
      mediaItems: [],
      roles: [],
      shots: [],
    });

    // 验证 DB 中 vlmFrames 仍为 3 帧
    const meta = readProjectMetadata(PROJECT_ID);
    expect(meta.vlmFrames).toHaveLength(3);
  });

  // ══════════════════════════════════════════
  // 场景4：完整往返 — save → load → 验证一致性
  // ══════════════════════════════════════════

  it('完整往返：save vlmFrames → load → 数据完全一致', () => {
    const originalFrames = buildTestVlmFrames();

    // 保存
    repo.saveFullProjectData(PROJECT_ID, {
      vlmFrames: originalFrames,
      mediaItems: [],
      roles: [],
      shots: [],
    });

    // 加载
    const loaded = repo.loadFullProjectData(PROJECT_ID);

    // 逐字段验证一致性
    expect(loaded.vlmFrames).toHaveLength(originalFrames.length);
    for (let i = 0; i < originalFrames.length; i++) {
      expect(loaded.vlmFrames[i].url).toBe(originalFrames[i].url);
      expect(loaded.vlmFrames[i].description).toBe(originalFrames[i].description);
      expect(loaded.vlmFrames[i].editing).toBe(originalFrames[i].editing);
      expect(loaded.vlmFrames[i].confirmed).toBe(originalFrames[i].confirmed);
    }
  });

  // ══════════════════════════════════════════
  // 场景5：多次保存累加场景 — vlmFrames 更新后覆盖旧值
  // ══════════════════════════════════════════

  it('vlmFrames 更新后非空值覆盖旧值', () => {
    // 第一次保存 3 帧
    repo.saveFullProjectData(PROJECT_ID, {
      vlmFrames: buildTestVlmFrames(),
      mediaItems: [],
      roles: [],
      shots: [],
    });
    expect(readProjectMetadata(PROJECT_ID).vlmFrames).toHaveLength(3);

    // 第二次保存 2 帧（用户重新执行 step2，帧数变化）
    const newFrames = buildTestVlmFrames().slice(0, 2);
    repo.saveFullProjectData(PROJECT_ID, {
      vlmFrames: newFrames,
      mediaItems: [],
      roles: [],
      shots: [],
    });

    // 验证 DB 中 vlmFrames 已更新为 2 帧
    const meta = readProjectMetadata(PROJECT_ID);
    expect(meta.vlmFrames).toHaveLength(2);
  });

  // ══════════════════════════════════════════
  // 场景6：canvas_data 中的 vlmFrames 不覆盖 metadata（CANVAS_SKIP_KEYS 保护）
  // ══════════════════════════════════════════

  it('canvas_data 中的 vlmFrames 不覆盖 metadata（CANVAS_SKIP_KEYS 保护）', () => {
    // 先在 metadata 中写入 vlmFrames
    repo.saveFullProjectData(PROJECT_ID, {
      vlmFrames: buildTestVlmFrames(),
      mediaItems: [],
      roles: [],
      shots: [],
    });

    // 模拟 SyncDaemon 写入 canvas_data，其中包含空的 vlmFrames（瞬态快照）
    const staleCanvasData = JSON.stringify({
      vlmFrames: [], // 瞬态空快照
      nodes: [],
      edges: [],
    });
    memDB.prepare('UPDATE projects SET canvas_data = ? WHERE id = ?').run(staleCanvasData, PROJECT_ID);

    // 加载，验证 metadata 中的 vlmFrames 未被 canvas_data 覆盖
    const loaded = repo.loadFullProjectData(PROJECT_ID);
    expect(loaded.vlmFrames).toHaveLength(3);
    expect(loaded.vlmFrames[0].description).toContain('男子走入画面');
  });

  // ══════════════════════════════════════════
  // 场景7：loadFullProjectData 返回的 vlmFrames 在 ...metadata 展开路径中
  // ══════════════════════════════════════════

  it('loadFullProjectData 返回的对象顶层包含 vlmFrames 字段', () => {
    repo.saveFullProjectData(PROJECT_ID, {
      vlmFrames: buildTestVlmFrames(),
      mediaItems: [],
      roles: [],
      shots: [],
    });

    const loaded = repo.loadFullProjectData(PROJECT_ID);

    // 验证 vlmFrames 在顶层（非嵌套在 metadata 中）
    expect(Object.prototype.hasOwnProperty.call(loaded, 'vlmFrames')).toBe(true);
    expect(loaded.metadata).toBeUndefined(); // metadata 已被展开到顶层
  });

  // ═══════════════════════════════════════════════════════════════════
  // 场景8-11：roles + facesJson 持久化（修复 Missing named parameter "facesJson"）
  // 这是导致"重新进项目数据丢失"的真正根因：saveData 因缺 facesJson 抛异常 →
  // 事务回滚 → vlmFrames/shots 全部没落盘
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 构造测试 roles 数据（含 representative/faces 人脸信息）
   */
  function buildTestRoles(): any[] {
    return [
      {
        id: 'role_001',
        systemId: 'sys_001',
        name: '男主角',
        pronoun: '他',
        avatar: 'avatars/role_001.jpg',
        description: '故事主角',
        voiceId: 'zh-CN-XiaoxiaoNeural',
        mergedRoles: ['role_002'],
        representative: { facePath: 'avatars/role_001.jpg', gender: 'male', age: 30 },
        faces: [
          { facePath: 'avatars/role_001_face1.jpg', gender: 'male', age: 30 },
          { facePath: 'avatars/role_001_face2.jpg', gender: 'male', age: 30 },
        ],
        faceCount: 2,
      },
      {
        id: 'role_002',
        systemId: 'sys_002',
        name: '女主角',
        pronoun: '她',
        avatar: 'avatars/role_002.jpg',
        description: '故事女主',
        voiceId: 'zh-CN-XiaoyiNeural',
        mergedRoles: [],
        // 无 representative/faces（模拟未做人脸检测的角色）
      },
    ];
  }

  it('带 roles 的 saveFullProjectData 不再抛 Missing named parameter "facesJson"', () => {
    // 旧版 bug：此调用会抛 "Missing named parameter "facesJson"" → 整个事务回滚
    // 修复后：facesJson 参数被正确传递
    expect(() => {
      repo.saveFullProjectData(PROJECT_ID, {
        vlmFrames: buildTestVlmFrames(),
        roles: buildTestRoles(),
        mediaItems: [],
        shots: [],
      });
    }).not.toThrow();
  });

  it('带 roles + vlmFrames 同时保存 → 两者都正确落盘（事务不回滚）', () => {
    // 这是用户实际场景：step2 完成后 saveData 同时传 roles 和 vlmFrames
    repo.saveFullProjectData(PROJECT_ID, {
      vlmFrames: buildTestVlmFrames(),
      roles: buildTestRoles(),
      mediaItems: [],
      shots: [],
    });

    const loaded = repo.loadFullProjectData(PROJECT_ID);

    // 验证 vlmFrames 落盘成功（旧版会因 facesJson 异常回滚，vlmFrames 丢失）
    expect(loaded.vlmFrames).toHaveLength(3);
    expect(loaded.vlmFrames[0].description).toContain('男子走入画面');

    // 验证 roles 落盘成功
    expect(loaded.roles).toHaveLength(2);
    expect(loaded.roles[0].name).toBe('男主角');
    expect(loaded.roles[1].name).toBe('女主角');
  });

  it('roles 的 facesJson 正确序列化和反序列化（representative/faces/faceCount）', () => {
    repo.saveFullProjectData(PROJECT_ID, {
      roles: buildTestRoles(),
      mediaItems: [],
      shots: [],
    });

    const loaded = repo.loadFullProjectData(PROJECT_ID);

    // 验证 role_001 的人脸详细信息被正确恢复
    const maleRole = loaded.roles.find((r: any) => r.id === 'role_001');
    expect(maleRole.representative).toBeDefined();
    expect(maleRole.representative.gender).toBe('male');
    expect(maleRole.representative.age).toBe(30);
    expect(maleRole.faces).toHaveLength(2);
    expect(maleRole.faceCount).toBe(2);

    // 验证 role_002（无人脸信息）安全降级
    const femaleRole = loaded.roles.find((r: any) => r.id === 'role_002');
    expect(femaleRole.representative).toBeNull();
    expect(femaleRole.faces).toEqual([]);
    expect(femaleRole.faceCount).toBe(0);
  });

  it('roles 无 faces 字段时 facesJson 安全降级为空结构（不抛异常）', () => {
    // 模拟前端 store 中的 role 对象没有 representative/faces 字段
    const minimalRoles = [
      { id: 'role_min', name: '最小角色', voiceId: 'v1' },
    ];

    expect(() => {
      repo.saveFullProjectData(PROJECT_ID, {
        roles: minimalRoles,
        mediaItems: [],
        shots: [],
      });
    }).not.toThrow();

    const loaded = repo.loadFullProjectData(PROJECT_ID);
    expect(loaded.roles).toHaveLength(1);
    expect(loaded.roles[0].name).toBe('最小角色');
    expect(loaded.roles[0].faces).toEqual([]);
  });
});
