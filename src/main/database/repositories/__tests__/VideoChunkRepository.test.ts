/**
 * VideoChunkRepository 阶段 B 缓存契约单元测试
 * 覆盖:
 *   1. v2 结构 { version:2, chunks, matchSegments } 写入 → 读取往返
 *   2. 兼容 v1 老缓存(裸数组) → 读端包装为 { version:1, chunks, matchSegments:[] }
 *   3. buildMatchSegmentsFromChunks 兜底: >6s 物理镜头按 3s 拆段、短镜头 seg0、
 *      parentChunkId 指向物理镜头(id 语义与 Python 侧 scene_xxx_segN 一致)
 *   4. 未命中(null)与解析失败(null)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../../core/AppLogger', () => ({
  AppLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@modules/infra/logger/LogConstants', () => ({
  LOG_TAGS: { DATABASE: 'database' },
}));

let memDB: Database.Database;

vi.mock('../../core/SQLiteConnection', () => ({
  SQLiteConnection: {
    getInstance: () => ({
      getDB: () => memDB,
    }),
  },
}));

import { VideoChunkRepository } from '../VideoChunkRepository';
import { SemanticAnalyzeStrategy } from '../../../engine/strategies/SemanticAnalyzeStrategy';

function setupInMemoryDB(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = MEMORY');
  db.exec(`
    CREATE TABLE IF NOT EXISTS video_chunks (
      media_id TEXT PRIMARY KEY,
      chunks_json TEXT NOT NULL,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS video_chunk_parts (
      media_id     TEXT NOT NULL,
      part_index   INTEGER NOT NULL,
      kind         TEXT NOT NULL,
      items_json   TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      PRIMARY KEY (media_id, part_index)
    );
    CREATE INDEX IF NOT EXISTS idx_video_chunk_parts_media ON video_chunk_parts(media_id);
  `);
  return db;
}

/** 构造镜头级 chunks: 前两个为 <6s 物理镜头, 后一个为 10s 长镜头 */
function buildChunks() {
  return [
    { id: 'chunk_001', parentChunkId: 'scene_001', parentStartMs: 0, startMs: 0, endMs: 2999, durationMs: 2999, description: '开场', emotion: '平静', shotType: 'wide', characters: ['A'], keywords: ['开场'] },
    { id: 'chunk_002', parentChunkId: 'scene_002', parentStartMs: 3000, startMs: 3000, endMs: 5999, durationMs: 2999, description: '对话', emotion: '中性', shotType: 'medium', characters: ['B'], keywords: ['对话'] },
    { id: 'chunk_003', parentChunkId: 'scene_003', parentStartMs: 6000, startMs: 6000, endMs: 15999, durationMs: 9999, description: '长镜头', emotion: '激昂', shotType: 'tracking', characters: ['C'], keywords: ['长镜头'] },
  ];
}

describe('VideoChunkRepository 阶段 B 缓存契约', () => {
  beforeEach(() => {
    memDB = setupInMemoryDB();
  });

  it('save(v2) 后 getByMediaId 应往返返回 {version:2, chunks, matchSegments}', () => {
    const repo = new VideoChunkRepository();
    const chunks = buildChunks();
    const matchSegments = [
      { id: 'scene_003_seg0', parentChunkId: 'scene_003', startMs: 6000, endMs: 8999 },
      { id: 'scene_003_seg1', parentChunkId: 'scene_003', startMs: 9000, endMs: 11999 },
      { id: 'scene_003_seg2', parentChunkId: 'scene_003', startMs: 12000, endMs: 15999 },
    ];
    repo.save('C:/v.mp4', chunks, matchSegments);

    const got = repo.getByMediaId('C:/v.mp4');
    expect(got).not.toBeNull();
    expect(got!.version).toBe(2);
    expect(got!.chunks).toHaveLength(3);
    expect(got!.matchSegments).toHaveLength(3);
    expect(got!.chunks[0].id).toBe('chunk_001');
    expect(got!.matchSegments[0].parentChunkId).toBe('scene_003');
  });

  it('兼容 v1 老缓存(裸数组): 读端包装为 version:1 + 空 matchSegments', () => {
    const chunks = buildChunks();
    memDB.prepare(
      'INSERT INTO video_chunks (media_id, chunks_json, chunk_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('C:/old.mp4', JSON.stringify(chunks), chunks.length, Date.now(), Date.now());

    const repo = new VideoChunkRepository();
    const got = repo.getByMediaId('C:/old.mp4');
    expect(got).not.toBeNull();
    expect(got!.version).toBe(1);
    expect(got!.chunks).toHaveLength(3);
    expect(got!.matchSegments).toEqual([]);
  });

  it('无缓存 / 空数组 / 非法 JSON 均返回 null', () => {
    const repo = new VideoChunkRepository();
    expect(repo.getByMediaId('C:/missing.mp4')).toBeNull();
    expect(repo.getByMediaId('')).toBeNull();
    expect(repo.getByMediaId(null as any)).toBeNull();

    memDB.prepare(
      'INSERT INTO video_chunks (media_id, chunks_json, chunk_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('C:/bad.mp4', '{not-json', 0, Date.now(), Date.now());
    expect(repo.getByMediaId('C:/bad.mp4')).toBeNull();
  });

  it('save 省略 matchSegments 时仅存 v2 空段(兼容调用方未传)', () => {
    const repo = new VideoChunkRepository();
    repo.save('C:/v3.mp4', buildChunks());
    const got = repo.getByMediaId('C:/v3.mp4');
    expect(got!.version).toBe(2);
    expect(got!.matchSegments).toEqual([]);
  });

  it('R7 分片写: >200 条按 ≤200 片落库, 读端合并完整往返, 旧表不留整行', () => {
    const repo = new VideoChunkRepository();
    const chunks = Array.from({ length: 450 }, (_, i) => ({ id: `chunk_${String(i).padStart(3, '0')}`, parentChunkId: `scene_${i}`, startMs: i * 1000, endMs: i * 1000 + 999, description: `镜头${i}` }));
    const segs = Array.from({ length: 250 }, (_, i) => ({ id: `scene_${i}_seg0`, parentChunkId: `scene_${i}`, startMs: i * 1000, endMs: i * 1000 + 999 }));
    repo.save('C:/big.mp4', chunks, segs);

    // 分片落库: 450→3 片 chunks + 250→2 片 segs = 5 片; 旧表无整行
    const partCount = memDB.prepare('SELECT COUNT(*) AS c FROM video_chunk_parts WHERE media_id = ?').get('C:/big.mp4') as any;
    expect(partCount.c).toBe(5);
    const legacyCount = memDB.prepare('SELECT COUNT(*) AS c FROM video_chunks WHERE media_id = ?').get('C:/big.mp4') as any;
    expect(legacyCount.c).toBe(0);

    // 读端合并完整往返且顺序保持
    const got = repo.getByMediaId('C:/big.mp4');
    expect(got).not.toBeNull();
    expect(got!.version).toBe(2);
    expect(got!.chunks).toHaveLength(450);
    expect(got!.matchSegments).toHaveLength(250);
    expect(got!.chunks[0].id).toBe('chunk_000');
    expect(got!.chunks[449].id).toBe('chunk_449');
    expect(got!.matchSegments[249].id).toBe('scene_249_seg0');
  });
});

describe('SemanticAnalyzeStrategy.buildMatchSegmentsFromChunks 兜底', () => {
  it('短镜头(≤6s)原样保留为 seg0, parentChunkId 指向物理镜头', () => {
    const chunks = buildChunks();
    const segs = SemanticAnalyzeStrategy.buildMatchSegmentsFromChunks(chunks);
    // chunk_001 (2.999s) → 1 段 seg0
    const s1 = segs.filter((s: any) => s.parentChunkId === 'scene_001');
    expect(s1).toHaveLength(1);
    expect(s1[0].id).toBe('scene_001_seg0');
    expect(s1[0].segmentIndexInParent).toBe(0);
    expect(s1[0].startMs).toBe(0);
    expect(s1[0].endMs).toBe(2999);
  });

  it('长镜头(>6s)按 3s 均匀拆分, 段覆盖物理镜头全区间且不越界', () => {
    const chunks = buildChunks();
    const segs = SemanticAnalyzeStrategy.buildMatchSegmentsFromChunks(chunks);
    const long = segs.filter((s: any) => s.parentChunkId === 'scene_003');
    // 9999ms → 3s/3s/3s/0.999s → 4 段
    expect(long.length).toBe(4);
    expect(long[0].id).toBe('scene_003_seg0');
    expect(long[3].id).toBe('scene_003_seg3');
    expect(long[0].startMs).toBe(6000);
    expect(long[0].endMs).toBe(9000);
    expect(long[3].startMs).toBe(15000);
    expect(long[3].endMs).toBe(15999);
    // 区间连续且不越界
    for (let i = 1; i < long.length; i++) {
      expect(long[i].startMs).toBe(long[i - 1].endMs);
    }
    expect(long[long.length - 1].endMs).toBe(15999);
    // 语义字段从物理镜头继承(展开 {...c} 保留)
    expect(long[0].description).toBe('长镜头');
    expect(long[0].characters).toEqual(['C']);
  });
});
