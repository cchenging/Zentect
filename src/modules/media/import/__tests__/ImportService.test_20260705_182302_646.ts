// Module: media/import - ImportService 单元测试

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// === Mock 外部依赖 ===

const {
  mockInsertMedia,
  mockFindById,
  mockUpdateMedia,
  mockUpdateMediaMeta,
  mockGetByProject,
  mockExistsSync,
  mockMkdirSync,
  mockSpawn,
  mockLoggerInfo,
  mockLoggerWarn,
  mockLoggerError,
  mockGetAllWindows,
} = vi.hoisted(() => ({
  mockInsertMedia: vi.fn(),
  mockFindById: vi.fn(),
  mockUpdateMedia: vi.fn(),
  mockUpdateMediaMeta: vi.fn(),
  mockGetByProject: vi.fn(),
  mockExistsSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockSpawn: vi.fn(),
  mockLoggerInfo: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockLoggerError: vi.fn(),
  mockGetAllWindows: vi.fn(),
}));

vi.mock('../data/MediaRepository', () => ({
  MediaRepository: vi.fn().mockImplementation(function (this: any) {
    this.insertMedia = mockInsertMedia;
    this.findById = mockFindById;
    this.updateMedia = mockUpdateMedia;
    this.updateMediaMeta = mockUpdateMediaMeta;
    this.getByProject = mockGetByProject;
  }),
}));

vi.mock('fs', () => ({
  default: {
    existsSync: mockExistsSync,
    mkdirSync: mockMkdirSync,
  },
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
}));

vi.mock('child_process', () => ({
  spawn: mockSpawn,
}));

vi.mock('../../../../infra/logger/AppLogger', () => ({
  AppLogger: {
    info: (...args: any[]) => mockLoggerInfo(...args),
    warn: (...args: any[]) => mockLoggerWarn(...args),
    error: (...args: any[]) => mockLoggerError(...args),
  },
}));

vi.mock('../../../../infra/logger/LogConstants', () => ({
  LOG_TAGS: { MEDIA: 'MEDIA', DATABASE: 'DATABASE' },
}));

vi.mock('../../../../infra/i18n/dictionary', () => ({
  DICT: {},
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: mockGetAllWindows,
  },
}));

vi.mock('path', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    default: { ...actual.default, ...actual },
  };
});

// === 辅助函数 ===

interface MockChildProcess extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
}

function createMockSpawnProc(stdoutData: string = ''): MockChildProcess {
  const proc = new EventEmitter() as MockChildProcess;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  setImmediate(() => {
    if (stdoutData) {
      proc.stdout.emit('data', Buffer.from(stdoutData));
    }
    proc.emit('close', 0);
  });
  return proc;
}

function setupSpawn(stdoutData: string = '') {
  mockSpawn.mockImplementation(() => createMockSpawnProc(stdoutData));
}

// === 测试 ===

import { ImportService } from '../backend/ImportService';

describe('ImportService', () => {
  let service: ImportService;

  beforeEach(() => {
    service = new ImportService();
    vi.clearAllMocks();

    mockExistsSync.mockReturnValue(true);
    mockMkdirSync.mockImplementation(() => undefined);
    mockGetAllWindows.mockReturnValue([]);
    setupSpawn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==================== importMedia ====================

  describe('importMedia', () => {
    const mockPathManager = {
      getProjectMediaDir: vi.fn().mockReturnValue('F:/Zentect/media/proj_001'),
      getProjectThumbnailsDir: vi.fn().mockReturnValue('F:/Zentect/thumbnails/proj_001'),
      getBinPath: vi.fn().mockReturnValue('F:/Zentect/bin/ffprobe.exe'),
    };
    const mockVideoProcessor = {
      extractMetadata: vi.fn().mockResolvedValue({
        formattedTime: '00:01:30',
        duration: 90,
        width: 1920,
        height: 1080,
        fps: 30,
      }),
      generateCover: vi.fn().mockResolvedValue('cover_media_xxx.jpg'),
    };

    it('空文件列表应返回空数组', async () => {
      const results = await service.importMedia(
        'proj_001', [], mockPathManager, mockVideoProcessor,
      );
      expect(results).toHaveLength(0);
    });

    it('不存在的文件应跳过', async () => {
      mockExistsSync.mockReturnValue(false);

      const results = await service.importMedia(
        'proj_001',
        ['F:/nonexistent/video.mp4'],
        mockPathManager,
        mockVideoProcessor,
      );

      expect(results).toHaveLength(0);
      expect(mockLoggerWarn).toHaveBeenCalled();
      const warnCall = mockLoggerWarn.mock.calls[0];
      expect(warnCall[1]).toContain('File not found');
    });

    it('mp4 文件应识别为 video 类型', async () => {
      mockExistsSync.mockReturnValue(true);
      setupSpawn('h264');

      const results = await service.importMedia(
        'proj_001',
        ['F:/videos/clip.mp4'],
        mockPathManager,
        mockVideoProcessor,
      );

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('video');
      expect(results[0].status).toBe('importing');
      expect(results[0].filePath).toBe('F:/videos/clip.mp4');
    });

    it('mp3 文件应识别为 audio 类型', async () => {
      const results = await service.importMedia(
        'proj_001',
        ['F:/audio/bgm.mp3'],
        mockPathManager,
        mockVideoProcessor,
      );

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('audio');
    });

    it('mov 文件应识别为 video 类型', async () => {
      setupSpawn('prores');
      const results = await service.importMedia(
        'proj_001',
        ['F:/videos/raw.mov'],
        mockPathManager,
        mockVideoProcessor,
      );

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('video');
    });

    it('未知扩展名应识别为 frame 类型', async () => {
      const results = await service.importMedia(
        'proj_001',
        ['F:/docs/readme.txt'],
        mockPathManager,
        mockVideoProcessor,
      );

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('frame');
    });

    it('无扩展名文件应识别为 frame 类型', async () => {
      const results = await service.importMedia(
        'proj_001',
        ['F:/misc/noext'],
        mockPathManager,
        mockVideoProcessor,
      );

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('frame');
    });

    it('每个导入文件应调用 insertMedia', async () => {
      setupSpawn('h264');
      await service.importMedia(
        'proj_001',
        ['F:/videos/a.mp4', 'F:/audio/b.mp3'],
        mockPathManager,
        mockVideoProcessor,
      );

      expect(mockInsertMedia).toHaveBeenCalledTimes(2);
    });

    it('返回的 MediaItem 应包含生成的 id', async () => {
      const results = await service.importMedia(
        'proj_001',
        ['F:/videos/test.mp4'],
        mockPathManager,
        mockVideoProcessor,
      );

      expect(results[0].id).toMatch(/^media_\d+_/);
    });

    it('多个文件混合类型应正确分类', async () => {
      setupSpawn('h264');

      const results = await service.importMedia(
        'proj_001',
        ['F:/media/v.mp4', 'F:/media/a.wav', 'F:/media/i.png'],
        mockPathManager,
        mockVideoProcessor,
      );

      expect(results).toHaveLength(3);
      expect(results[0].type).toBe('video');
      expect(results[1].type).toBe('audio');
      expect(results[2].type).toBe('frame');
    });

    it('insertMedia 应接收包含 projectId 的完整参数', async () => {
      setupSpawn('h264');
      await service.importMedia(
        'proj_test',
        ['F:/videos/v.mp4'],
        mockPathManager,
        mockVideoProcessor,
      );

      const insertArg = mockInsertMedia.mock.calls[0][0];
      expect(insertArg.projectId).toBe('proj_test');
      expect(insertArg.type).toBe('video');
      expect(insertArg.status).toBe('importing');
    });

    it('部分文件不存在时仅处理存在的文件', async () => {
      mockExistsSync.mockImplementation((p: any) => {
        const pathStr = String(p);
        return pathStr.includes('exist.mp4');
      });
      setupSpawn('h264');

      const results = await service.importMedia(
        'proj_001',
        ['F:/videos/exist.mp4', 'F:/videos/missing.mkv'],
        mockPathManager,
        mockVideoProcessor,
      );

      expect(results).toHaveLength(1);
      expect(results[0].filePath).toBe('F:/videos/exist.mp4');
    });

    // --- HEVC 检测 ---

    it('mp4 文件应在后台触发 HEVC 检测（ffprobe 调用）', async () => {
      mockExistsSync.mockImplementation((p: any) => {
        const pathStr = String(p);
        return pathStr.includes('ffprobe') ? true : true;
      });
      setupSpawn('hevc');

      await service.importMedia(
        'proj_001',
        ['F:/videos/hevc.mp4'],
        mockPathManager,
        mockVideoProcessor,
      );

      expect(mockSpawn).toHaveBeenCalled();
      const firstCall = mockSpawn.mock.calls[0];
      expect(firstCall[0]).toContain('ffprobe');
    });

    it('HEVC 格式（mkv）应在后台触发转码（ffmpeg 调用）', async () => {
      mockExistsSync.mockImplementation((p: any) => {
        const pathStr = String(p);
        return pathStr.includes('ffmpeg') ? true : true;
      });
      setupSpawn('');

      await service.importMedia(
        'proj_001',
        ['F:/videos/raw.mkv'],
        mockPathManager,
        mockVideoProcessor,
      );

      // 等待后台异步完成
      await vi.waitFor(
        () => {
          return mockSpawn.mock.calls.some(
            (c: any) => String(c[0]).includes('ffmpeg'),
          );
        },
        { timeout: 3000 },
      );
    });

    it('avi 格式应在后台触发转码', async () => {
      mockExistsSync.mockImplementation((p: any) => {
        const pathStr = String(p);
        return pathStr.includes('ffmpeg') ? true : true;
      });
      setupSpawn('');

      await service.importMedia(
        'proj_001',
        ['F:/videos/legacy.avi'],
        mockPathManager,
        mockVideoProcessor,
      );

      await vi.waitFor(
        () => {
          return mockSpawn.mock.calls.some(
            (c: any) => String(c[0]).includes('ffmpeg'),
          );
        },
        { timeout: 3000 },
      );
    });

    it('h264 MP4 不应触发转码', async () => {
      mockExistsSync.mockImplementation((p: any) => {
        const pathStr = String(p);
        return pathStr.includes('ffprobe') ? true : true;
      });
      setupSpawn('h264');

      await service.importMedia(
        'proj_001',
        ['F:/videos/normal.mp4'],
        mockPathManager,
        mockVideoProcessor,
      );

      // 等待后台异步完成
      await vi.waitFor(
        () => mockInsertMedia.mock.calls.length > 0,
        { timeout: 3000 },
      );
      await vi.waitFor(
        () => mockSpawn.mock.calls.length >= 1,
        { timeout: 3000 },
      );

      // ffmpeg 不应被调用（h264 不需要转码）
      const ffmpegCalls = mockSpawn.mock.calls.filter(
        (c: any) => String(c[0]).includes('ffmpeg'),
      );
      expect(ffmpegCalls).toHaveLength(0);
    });
  });

  // ==================== getMediaById ====================

  describe('getMediaById', () => {
    it('应调用 repo.findById 并返回结果', () => {
      const mockRow = {
        id: 'media_test',
        projectId: 'proj_001',
        type: 'video',
        filePath: '/v.mp4',
        status: 'parsed',
        name: 'test',
        coverPath: '',
        duration: 90,
        width: 1920,
        height: 1080,
        fps: 30,
        frames: null,
        narrationScript: null,
      };
      mockFindById.mockReturnValue(mockRow);

      const result = service.getMediaById('media_test');

      expect(mockFindById).toHaveBeenCalledWith('media_test');
      expect(result.id).toBe('media_test');
    });

    it('不存在的媒体应返回 null', () => {
      mockFindById.mockReturnValue(null);

      const result = service.getMediaById('nonexistent');

      expect(result).toBeNull();
    });
  });

  // ==================== getMediaByProject ====================

  describe('getMediaByProject', () => {
    it('应调用 repo.getByProject 并返回结果数组', () => {
      mockGetByProject.mockReturnValue([
        { id: 'm1', type: 'video', name: 'clip1' },
        { id: 'm2', type: 'audio', name: 'bgm' },
      ]);

      const results = service.getMediaByProject('proj_001');

      expect(mockGetByProject).toHaveBeenCalledWith('proj_001');
      expect(results).toHaveLength(2);
    });

    it('空项目应返回空数组', () => {
      mockGetByProject.mockReturnValue([]);

      const results = service.getMediaByProject('proj_empty');

      expect(results).toHaveLength(0);
    });
  });

  // ==================== updateMedia ====================

  describe('updateMedia', () => {
    it('应调用 repo.updateMedia 传递参数', () => {
      const updateData = { name: 'new name', status: 'parsed' };

      service.updateMedia('media_001', updateData);

      expect(mockUpdateMedia).toHaveBeenCalledWith('media_001', updateData);
    });
  });

  // ==================== 重复导入 ====================

  describe('重复导入', () => {
    const mockPathManager = {
      getProjectMediaDir: vi.fn().mockReturnValue('F:/Zentect/media/proj_001'),
      getProjectThumbnailsDir: vi.fn().mockReturnValue('F:/Zentect/thumbnails/proj_001'),
      getBinPath: vi.fn().mockReturnValue('F:/test/ffprobe.exe'),
    };
    const mockVideoProcessor = {
      extractMetadata: vi.fn().mockResolvedValue({
        formattedTime: '00:00:00', duration: 0, width: 0, height: 0, fps: 0,
      }),
      generateCover: vi.fn().mockResolvedValue('cover.jpg'),
    };

    it('同一文件两次导入应生成不同 mediaId', async () => {
      mockExistsSync.mockReturnValue(true);
      setupSpawn('h264');

      const results1 = await service.importMedia(
        'proj_001',
        ['F:/videos/same.mp4'],
        mockPathManager,
        mockVideoProcessor,
      );
      const results2 = await service.importMedia(
        'proj_001',
        ['F:/videos/same.mp4'],
        mockPathManager,
        mockVideoProcessor,
      );

      expect(results1[0].id).not.toBe(results2[0].id);
      expect(mockInsertMedia).toHaveBeenCalledTimes(2);
    });
  });

  // ==================== 错误处理 ====================

  describe('错误处理', () => {
    it('insertMedia 抛出异常不应中断其他文件导入', async () => {
      mockExistsSync.mockReturnValue(true);
      setupSpawn('h264');

      let callCount = 0;
      mockInsertMedia.mockImplementation(() => {
        callCount++;
        if (callCount === 1) throw new Error('DB write failed');
      });

      await service.importMedia(
        'proj_001',
        ['F:/videos/bad.mp4', 'F:/videos/good.mp4'],
        {
          getProjectMediaDir: vi.fn(),
          getProjectThumbnailsDir: vi.fn(),
          getBinPath: vi.fn().mockReturnValue('F:/test/ffprobe.exe'),
        },
        {
          extractMetadata: vi.fn().mockResolvedValue({
            formattedTime: '00:00:00', duration: 0, width: 0, height: 0, fps: 0,
          }),
          generateCover: vi.fn().mockResolvedValue('cover.jpg'),
        },
      );

      // 异常被捕获，两个文件都被尝试
      expect(mockInsertMedia).toHaveBeenCalledTimes(2);
      expect(mockLoggerError).toHaveBeenCalled();
    });
  });
});
