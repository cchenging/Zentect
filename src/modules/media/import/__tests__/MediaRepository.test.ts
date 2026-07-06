// Module: media/import - MediaRepository 单元测试

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// === Mock 数据库 ===

const mockPrepare = vi.fn();
const mockDB = {
  prepare: mockPrepare,
};

const { mockGetInstance } = vi.hoisted(() => ({
  mockGetInstance: vi.fn(),
}));

vi.mock('../../../../infra/database/core/SQLiteConnection', () => ({
  SQLiteConnection: {
    getInstance: mockGetInstance,
  },
}));

vi.mock('../../../../infra/logger/AppLogger', () => ({
  AppLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../../infra/logger/LogConstants', () => ({
  LOG_TAGS: { MEDIA: 'MEDIA', DATABASE: 'DATABASE' },
}));

vi.mock('../../../../infra/error/AppError', () => ({
  AppError: class AppError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
  ErrorCode: { DATABASE_ERROR: 'DATABASE_ERROR' },
}));

// === 辅助函数 ===

interface StatementMock {
  run: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  all: ReturnType<typeof vi.fn>;
}

function setupMockDB(): StatementMock {
  const stmt: StatementMock = {
    run: vi.fn().mockReturnValue({ changes: 1, lastInsertRowid: 1 }),
    get: vi.fn().mockReturnValue(null),
    all: vi.fn().mockReturnValue([]),
  };

  mockPrepare.mockReturnValue(stmt);
  mockGetInstance.mockReturnValue({ getDB: () => mockDB });

  return stmt;
}

// === 测试 ===

import { MediaRepository } from '../data/MediaRepository';

describe('MediaRepository', () => {
  let repo: MediaRepository;

  beforeEach(() => {
    repo = new MediaRepository();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==================== insertMedia ====================

  describe('insertMedia', () => {
    it('应调用 prepare(INSERT).run', () => {
      const stmt = setupMockDB();

      repo.insertMedia({
        id: 'media_001',
        projectId: 'proj_001',
        type: 'video',
        name: 'test.mp4',
        filePath: 'F:/media/test.mp4',
        coverPath: '',
        duration: 90,
        width: 1920,
        height: 1080,
        fps: 30,
        status: 'importing',
      });

      expect(mockPrepare).toHaveBeenCalled();
      const sqlArg = mockPrepare.mock.calls[0][0];
      expect(sqlArg).toContain('INSERT INTO media_assets');

      expect(stmt.run).toHaveBeenCalled();
      const runArg = stmt.run.mock.calls[0][0];
      expect(runArg.id).toBe('media_001');
      expect(runArg.projectId).toBe('proj_001');
      expect(runArg.type).toBe('video');
    });

    it('应序列化 frames 为 JSON', () => {
      const stmt = setupMockDB();

      repo.insertMedia({
        id: 'media_002',
        projectId: 'proj_001',
        type: 'video',
        filePath: 'F:/media/test.mp4',
        coverPath: '',
        duration: 0,
        width: 0,
        height: 0,
        fps: 0,
        status: 'ready',
        frames: ['f1', 'f2', 'f3'],
      } as any);

      const runArg = stmt.run.mock.calls[0][0];
      expect(runArg.frames).toBe('["f1","f2","f3"]');
    });

    it('应序列化 narrationScript 为 JSON', () => {
      const stmt = setupMockDB();

      const script = { paragraphs: [{ id: 'p1', text: 'hello' }] };
      repo.insertMedia({
        id: 'media_003',
        projectId: 'proj_001',
        type: 'audio',
        filePath: 'F:/audio/test.mp3',
        coverPath: '',
        duration: 0,
        width: 0,
        height: 0,
        fps: 0,
        status: 'ready',
        narrationScript: script,
      } as any);

      const runArg = stmt.run.mock.calls[0][0];
      expect(runArg.narrationScript).toBe(JSON.stringify(script));
    });

    it('frames 为 undefined 时应传 null', () => {
      const stmt = setupMockDB();

      repo.insertMedia({
        id: 'media_004',
        projectId: 'proj_001',
        type: 'frame',
        filePath: 'F:/img.png',
        coverPath: '',
        duration: 0,
        width: 0,
        height: 0,
        fps: 0,
        status: 'ready',
      } as any);

      const runArg = stmt.run.mock.calls[0][0];
      expect(runArg.frames).toBeNull();
    });

    it('status 未传时应默认为 ready', () => {
      const stmt = setupMockDB();

      repo.insertMedia({
        id: 'media_005',
        projectId: 'proj_001',
        type: 'video',
        filePath: 'F:/v.mp4',
        coverPath: '',
        duration: 0,
        width: 0,
        height: 0,
        fps: 0,
      } as any);

      const runArg = stmt.run.mock.calls[0][0];
      expect(runArg.status).toBe('ready');
    });
  });

  // ==================== findById ====================

  describe('findById', () => {
    it('找到记录时应解析 JSON 字段', () => {
      setupMockDB();

      const row = {
        id: 'media_001',
        projectId: 'proj_001',
        type: 'video',
        name: 'test',
        filePath: '/v.mp4',
        coverPath: '',
        duration: 90,
        status: 'parsed',
        width: 1920,
        height: 1080,
        fps: 30,
        frames: '["f1","f2"]',
        narrationScript: '{"p":1}',
      };

      mockPrepare.mockReturnValue({
        run: vi.fn(),
        get: vi.fn().mockReturnValue(row),
        all: vi.fn(),
      });

      const result = repo.findById('media_001');

      expect(result).toBeDefined();
      expect(result.frames).toEqual(['f1', 'f2']);
      expect(result.narrationScript).toEqual({ p: 1 });
    });

    it('找不到记录时应返回 null', () => {
      setupMockDB();
      mockPrepare.mockReturnValue({
        run: vi.fn(),
        get: vi.fn().mockReturnValue(undefined),
        all: vi.fn(),
      });

      const result = repo.findById('nonexistent');

      expect(result).toBeNull();
    });

    it('frames 为 null 时应返回 undefined', () => {
      setupMockDB();
      const row = {
        id: 'm1',
        projectId: 'p1',
        type: 'video',
        name: 'test',
        filePath: '/v.mp4',
        coverPath: '',
        duration: 0,
        status: 'parsed',
        width: 0,
        height: 0,
        fps: 0,
        frames: null,
        narrationScript: null,
      };
      mockPrepare.mockReturnValue({
        run: vi.fn(),
        get: vi.fn().mockReturnValue(row),
        all: vi.fn(),
      });

      const result = repo.findById('media_001');

      expect(result.frames).toBeUndefined();
      expect(result.narrationScript).toBeUndefined();
    });
  });

  // ==================== updateMedia ====================

  describe('updateMedia', () => {
    it('应调用 prepare(UPDATE).run 传递字段', () => {
      const stmt = setupMockDB();

      repo.updateMedia('media_001', {
        name: 'renamed.mp4',
        status: 'parsed',
      });

      expect(mockPrepare).toHaveBeenCalled();
      const sqlArg = mockPrepare.mock.calls[0][0];
      expect(sqlArg).toContain('UPDATE media_assets');

      const runArg = stmt.run.mock.calls[0][0];
      expect(runArg.id).toBe('media_001');
      expect(runArg.name).toBe('renamed.mp4');
      expect(runArg.status).toBe('parsed');
    });

    it('应序列化 frames 字段', () => {
      const stmt = setupMockDB();

      repo.updateMedia('media_002', {
        frames: ['a', 'b', 'c'],
      });

      const runArg = stmt.run.mock.calls[0][0];
      expect(runArg.frames).toBe('["a","b","c"]');
    });

    it('应序列化 narrationScript 字段', () => {
      const stmt = setupMockDB();

      repo.updateMedia('media_003', {
        narrationScript: { data: [1, 2, 3] },
      });

      const runArg = stmt.run.mock.calls[0][0];
      expect(runArg.narrationScript).toBe('{"data":[1,2,3]}');
    });

    it('未传 frames 时应传 null', () => {
      const stmt = setupMockDB();

      repo.updateMedia('media_004', {
        name: 'no_frames.mp4',
      });

      const runArg = stmt.run.mock.calls[0][0];
      expect(runArg.frames).toBeNull();
    });
  });

  // ==================== updateMediaMeta ====================

  describe('updateMediaMeta', () => {
    it('应使用 UPDATE_FULL SQL 更新元数据', () => {
      const stmt = setupMockDB();

      repo.updateMediaMeta('media_001', {
        coverPath: 'thumbnails/cover.jpg',
        status: 'parsed',
        duration: 120,
        width: 1920,
        height: 1080,
        fps: 60,
      });

      expect(mockPrepare).toHaveBeenCalled();
      const sqlArg = mockPrepare.mock.calls[0][0];
      expect(sqlArg).toContain('UPDATE media_assets');
      expect(sqlArg).toContain('cover_path');

      const runArg = stmt.run.mock.calls[0][0];
      expect(runArg.id).toBe('media_001');
      expect(runArg.coverPath).toBe('thumbnails/cover.jpg');
      expect(runArg.duration).toBe(120);
      expect(runArg.fps).toBe(60);
    });

    it('可选字段未传时应传 null', () => {
      const stmt = setupMockDB();

      repo.updateMediaMeta('media_002', {
        status: 'transcoding',
      });

      const runArg = stmt.run.mock.calls[0][0];
      expect(runArg.status).toBe('transcoding');
      expect(runArg.coverPath).toBeNull();
      expect(runArg.duration).toBeNull();
    });

    it('filePath 更新应传递到 SQL', () => {
      const stmt = setupMockDB();

      repo.updateMediaMeta('media_003', {
        filePath: 'F:/transcoded/new.mp4',
      });

      const runArg = stmt.run.mock.calls[0][0];
      expect(runArg.filePath).toBe('F:/transcoded/new.mp4');
    });
  });

  // ==================== deleteMediaById ====================

  describe('deleteMediaById', () => {
    it('应调用 PHYSICAL_DELETE SQL', () => {
      const stmt = setupMockDB();

      repo.deleteMediaById('proj_001', 'media_001');

      expect(mockPrepare).toHaveBeenCalled();
      const sqlArg = mockPrepare.mock.calls[0][0];
      expect(sqlArg).toContain('DELETE FROM media_assets');

      const runArg = stmt.run.mock.calls[0][0];
      expect(runArg.id).toBe('media_001');
      expect(runArg.projectId).toBe('proj_001');
    });
  });

  // ==================== getCoverPath ====================

  describe('getCoverPath', () => {
    it('应返回 cover_path', () => {
      setupMockDB();
      mockPrepare.mockReturnValue({
        run: vi.fn(),
        get: vi.fn().mockReturnValue({ cover_path: 'thumbnails/c.jpg' }),
        all: vi.fn(),
      });

      const result = repo.getCoverPath('proj_001', 'media_001');

      expect(result).toBe('thumbnails/c.jpg');
    });

    it('无封面时应返回 null', () => {
      setupMockDB();
      mockPrepare.mockReturnValue({
        run: vi.fn(),
        get: vi.fn().mockReturnValue(undefined),
        all: vi.fn(),
      });

      const result = repo.getCoverPath('proj_001', 'media_no_cover');

      expect(result).toBeNull();
    });
  });

  // ==================== getByProject ====================

  describe('getByProject', () => {
    it('应返回解析后的媒体列表', () => {
      setupMockDB();
      const rows = [
        {
          id: 'm1',
          name: 'clip1',
          type: 'video',
          filePath: '/v1.mp4',
          coverPath: 'thumb/c1.jpg',
          duration: 120,
          status: 'parsed',
          width: 1920,
          height: 1080,
          fps: 30,
          frames: '["f1","f2"]',
          extractedAudio: null,
          extractedVocals: null,
          extractedBgm: null,
          extractedText: null,
          extractDuration: null,
          narrationScript: null,
        },
        {
          id: 'm2',
          name: 'bgm',
          type: 'audio',
          filePath: '/a1.mp3',
          coverPath: '',
          duration: 0,
          status: 'importing',
          width: 0,
          height: 0,
          fps: 0,
          frames: null,
          extractedAudio: 'audio/ext.wav',
          extractedVocals: null,
          extractedBgm: null,
          extractedText: null,
          extractDuration: '15.5',
          narrationScript: null,
        },
      ];
      mockPrepare.mockReturnValue({
        run: vi.fn(),
        get: vi.fn(),
        all: vi.fn().mockReturnValue(rows),
      });

      const results = repo.getByProject('proj_001');

      expect(results).toHaveLength(2);
      expect(results[0].frames).toEqual(['f1', 'f2']);
      expect(results[1].extractedAudio).toBe('audio/ext.wav');
      expect(results[1].extractDuration).toBe(15.5);
    });

    it('空结果应返回空数组', () => {
      setupMockDB();
      mockPrepare.mockReturnValue({
        run: vi.fn(),
        get: vi.fn(),
        all: vi.fn().mockReturnValue([]),
      });

      const results = repo.getByProject('proj_empty');

      expect(results).toHaveLength(0);
    });

    it('status 缺失时应默认 parsed', () => {
      setupMockDB();
      const row = {
        id: 'm1',
        name: 'test',
        type: 'video',
        filePath: '/v.mp4',
        coverPath: '',
        duration: 0,
        status: null,
        width: 0,
        height: 0,
        fps: 0,
        frames: null,
        extractedAudio: null,
        extractedVocals: null,
        extractedBgm: null,
        extractedText: null,
        extractDuration: null,
        narrationScript: null,
      };
      mockPrepare.mockReturnValue({
        run: vi.fn(),
        get: vi.fn(),
        all: vi.fn().mockReturnValue([row]),
      });

      const results = repo.getByProject('proj_001');

      expect(results[0].status).toBe('parsed');
    });
  });

  // ==================== getAgentContextData ====================

  describe('getAgentContextData', () => {
    it('应返回 medias 和 shots', () => {
      setupMockDB();
      mockPrepare
        .mockReturnValueOnce({
          run: vi.fn(),
          get: vi.fn(),
          all: vi.fn().mockReturnValue([{ id: 'm1', name: 'clip' }]),
        })
        .mockReturnValueOnce({
          run: vi.fn(),
          get: vi.fn(),
          all: vi.fn().mockReturnValue([
            { id: 's1', start: 0, end: 5, text: 'hello', visionText: 'scene' },
          ]),
        });

      const result = repo.getAgentContextData('proj_001');

      expect(result.medias).toHaveLength(1);
      expect(result.medias[0].id).toBe('m1');
      expect(result.shots).toHaveLength(1);
      expect(result.shots[0].text).toBe('hello');
    });

    it('空数据应返回空数组', () => {
      setupMockDB();
      mockPrepare
        .mockReturnValueOnce({
          run: vi.fn(),
          get: vi.fn(),
          all: vi.fn().mockReturnValue([]),
        })
        .mockReturnValueOnce({
          run: vi.fn(),
          get: vi.fn(),
          all: vi.fn().mockReturnValue([]),
        });

      const result = repo.getAgentContextData('proj_empty');

      expect(result.medias).toHaveLength(0);
      expect(result.shots).toHaveLength(0);
    });
  });
});
