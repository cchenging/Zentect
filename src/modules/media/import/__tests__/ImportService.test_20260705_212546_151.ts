// Module: media/import - ImportService 单元测试

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { EventEmitter } from 'events';

// === Mock 外部依赖 ===

const {
  mockInsertMedia,
  mockFindById,
  mockUpdateMedia,
  mockUpdateMediaMeta,
  mockGetByProject,
  mockSpawn: _mockSpawn,
} = vi.hoisted(() => ({
  mockInsertMedia: vi.fn(),
  mockFindById: vi.fn(),
  mockUpdateMedia: vi.fn(),
  mockUpdateMediaMeta: vi.fn(),
  mockGetByProject: vi.fn(),
  mockSpawn: vi.fn(),
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

vi.mock('child_process', () => ({
  spawn: _mockSpawn,
}));

const { mockLoggerInfo, mockLoggerWarn, mockLoggerError } = vi.hoisted(() => ({
  mockLoggerInfo: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockLoggerError: vi.fn(),
}));

vi.mock('../../../../infra/logger/AppLogger', () => ({
  AppLogger: {
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
    error: mockLoggerError,
  },
}));

vi.mock('../../../../infra/logger/LogConstants', () => ({
  LOG_TAGS: { MEDIA: 'MEDIA', DATABASE: 'DATABASE' },
}));

vi.mock('../../../../infra/i18n/dictionary', () => ({
  DICT: {},
}));

const { mockGetAllWindows } = vi.hoisted(() => ({
  mockGetAllWindows: vi.fn(),
  mockWebContentsSend: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: mockGetAllWindows,
  },
}));

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

function setupSpawnMock(stdoutData: string = '') {
  _mockSpawn.mockImplementation((_cmd: string, _args?: readonly string[], _opts?: any) => {
    return createMockSpawnProc(stdoutData) as any;
  });
  return _mockSpawn;
}

// === 测试 ===

import { ImportService } from '../backend/ImportService';

describe('ImportService', () => {
  let service: ImportService;
  let existsSyncSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    service = new ImportService();
    vi.clearAllMocks();

    existsSyncSpy = vi.spyOn(fs, 'existsSync');
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);

    mockGetAllWindows.mockReturnValue([]);
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
      const results = await service.importMedia('proj_001', [], mockPathManager, mockVideoProcessor);
      expect(results).toHaveLength(0);
    });

    it('不存在的文件应跳过', async () => {
      existsSyncSpy.mockReturnValue(false);

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
      existsSyncSpy.mockReturnValue(true);
      setupSpawnMock('h264');

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
      existsSyncSpy.mockReturnValue(true);

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
      existsSyncSpy.mockReturnValue(true);
      setupSpawnMock('prores');

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
      existsSyncSpy.mockReturnValue(true);

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
      existsSyncSpy.mockReturnValue(true);

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
      existsSyncSpy.mockReturnValue(true);
      setupSpawnMock('h264');

      await service.importMedia(
        'proj_001',
        ['F:/videos/a.mp4', 'F:/audio/b.mp3'],
        mockPathManager,
        mockVideoProcessor,
      );

      expect(mockInsertMedia).toHaveBeenCalledTimes(2);
    });

    it('返回的 MediaItem 应包含生成的 id', async () => {
      existsSyncSpy.mockReturnValue(true);

      const results = await service.importMedia(
        'proj_001',
        ['F:/videos/test.mp4'],
        mockPathManager,
        mockVideoProcessor,
      );

      expect(results[0].id).toMatch(/^media_\d+_/);
    });

    it('多个文件混合类型应正确分类', async () => {
      existsSyncSpy.mockReturnValue(true);
      setupSpawnMock('h264');

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
      existsSyncSpy.mockReturnValue(true);
      setupSpawnMock('h264');

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
      existsSyncSpy.mockImplementation((p: fs.PathLike) => {
        const pathStr = String(p);
        return pathStr.includes('exist.mp4');
      });
      setupSpawnMock('h264');

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

    it('mp4 文件应在后台触发 HEVC 检测', async () => {
      existsSyncSpy.mockImplementation((p: fs.PathLike) => {
        const pathStr = String(p);
        return pathStr.includes('ffprobe') || pathStr.includes('hevc');
      });

      setupSpawnMock('hevc');

      await service.importMedia(
        'proj_001',
        ['F:/videos/hevc.mp4'],
        mockPathManager,
        mockVideoProcessor,
      );

      // 等待后台异步完成 (detectHevcCodec 是异步的)
      await vi.waitFor(
        () => _mockSpawn.mock.calls.length > 0,
        { timeout: 5000 },
      );

      const spawnArgs = _mockSpawn.mock.calls[0];
      expect(spawnArgs[0]).toContain('ffprobe');
    });

    it('HEVC 格式（mkv）应在后台触发转码', async () => {
      existsSyncSpy.mockImplementation((p: fs.PathLike) => {
        const pathStr = String(p);
        return pathStr.includes('ffmpeg') || pathStr.includes('mkv');
      });

      setupSpawnMock('');

      await service.importMedia(
        'proj_001',
        ['F:/videos/raw.mkv'],
        mockPathManager,
        mockVideoProcessor,
      );

      await vi.waitFor(
        () => {
          return _mockSpawn.mock.calls.some(
            (c: any[]) => String(c[0]).includes('ffmpeg'),
          );
        },
        { timeout: 5000 },
      );

      const ffmpegCall = _mockSpawn.mock.calls.find(
        (c: any[]) => String(c[0]).includes('ffmpeg'),
      );
      expect(ffmpegCall).toBeDefined();
    });

    it('avi 格式应在后台触发转码', async () => {
      existsSyncSpy.mockImplementation((p: fs.PathLike) => {
        const pathStr = String(p);
        return pathStr.includes('ffmpeg') || pathStr.includes('avi');
      });

      setupSpawnMock('');

      await service.importMedia(
        'proj_001',
        ['F:/videos/legacy.avi'],
        mockPathManager,
        mockVideoProcessor,
      );

      await vi.waitFor(
        () => {
          return _mockSpawn.mock.calls.some(
            (c: any[]) => String(c[0]).includes('ffmpeg'),
          );
        },
        { timeout: 5000 },
      );
    });

    it('h264 MP4 不应触发转码', async () => {
      existsSyncSpy.mockImplementation((p: fs.PathLike) => {
        const pathStr = String(p);
        return pathStr.includes('ffprobe') || pathStr.includes('normal');
      });

      setupSpawnMock('h264');

      await service.importMedia(
        'proj_001',
        ['F:/videos/normal.mp4'],
        mockPathManager,
        mockVideoProcessor,
      );

      // 等待 detectHevcCodec 完成
      await vi.waitFor(
        () => _mockSpawn.mock.calls.length >= 1,
        { timeout: 5000 },
      );

      // ffmpeg 不应被调用（h264 不需要转码）
      const ffmpegCalls = _mockSpawn.mock.calls.filter(
        (c: any[]) => String(c[0]).includes('ffmpeg'),
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
      extractMetadata: vi.fn().mockResolvedValue({ formattedTime: '00:00:00', duration: 0, width: 0, height: 0, fps: 0 }),
      generateCover: vi.fn().mockResolvedValue('cover.jpg'),
    };

    it('同一文件两次导入应生成不同 mediaId', async () => {
      existsSyncSpy.mockReturnValue(true);
      setupSpawnMock('h264');

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
      existsSyncSpy.mockReturnValue(true);
      setupSpawnMock('h264');

      mockInsertMedia
        .mockImplementationOnce(() => {
          throw new Error('DB write failed');
        })
        .mockImplementationOnce(() => {});

      await service.importMedia(
        'proj_001',
        ['F:/videos/bad.mp4', 'F:/videos/good.mp4'],
        { getProjectMediaDir: vi.fn(), getProjectThumbnailsDir: vi.fn(), getBinPath: vi.fn() },
        { extractMetadata: vi.fn(), generateCover: vi.fn() },
      );

      // 异常被捕获，记录错误
      expect(mockLoggerError).toHaveBeenCalled();
      // insertMedia 仍然被调用了两次（第二个文件在 try 块外继续处理）
      // 注意：第一个文件的 insertMedia 抛异常，但 try-catch 捕获后继续循环
      expect(mockInsertMedia).toHaveBeenCalledTimes(2);
    });
  });

  // ==================== 边界条件 ====================

  describe('边界条件', () => {
    it('ffprobe 不存在时不应调用 spawn', async () => {
      existsSyncSpy.mockImplementation((p: fs.PathLike) => {
        const pathStr = String(p);
        // ffprobe 不存在，但视频文件存在
        if (pathStr.includes('ffprobe')) return false;
        return pathStr.includes('video');
      });

      const results = await service.importMedia(
        'proj_001',
        ['F:/videos/video.mp4'],
        {
          getProjectMediaDir: vi.fn().mockReturnValue('F:/Zentect/media/proj_001'),
          getProjectThumbnailsDir: vi.fn().mockReturnValue('F:/Zentect/thumbnails/proj_001'),
          getBinPath: vi.fn().mockReturnValue('F:/Zentect/bin/ffprobe.exe'),
        },
        {
          extractMetadata: vi.fn().mockResolvedValue({ formattedTime: '00:00:00', duration: 0, width: 0, height: 0, fps: 0 }),
          generateCover: vi.fn().mockResolvedValue('cover.jpg'),
        },
      );

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('video');

      // 等后台处理完成
      await vi.waitFor(
        () => mockUpdateMediaMeta.mock.calls.length > 0,
        { timeout: 5000 },
      );

      // spawn 不应被调用（ffprobe 不存在，detectHevcCodec 直接返回 false）
      expect(_mockSpawn).not.toHaveBeenCalled();
    });

    it('空文件路径字符串不应崩溃', async () => {
      existsSyncSpy.mockReturnValue(true);

      const results = await service.importMedia(
        'proj_001',
        [''],
        {
          getProjectMediaDir: vi.fn().mockReturnValue('F:/Zentect/media/proj_001'),
          getProjectThumbnailsDir: vi.fn().mockReturnValue('F:/Zentect/thumbnails/proj_001'),
          getBinPath: vi.fn().mockReturnValue('F:/Zentect/bin/ffprobe.exe'),
        },
        {
          extractMetadata: vi.fn().mockResolvedValue({ formattedTime: '00:00:00', duration: 0, width: 0, height: 0, fps: 0 }),
          generateCover: vi.fn().mockResolvedValue('cover.jpg'),
        },
      );

      // 空路径也应返回结果（ext 为空，类型为 frame）
      expect(results).toHaveLength(1);
    });

    it('大驼峰扩展名（.MP4）应识别为 video', async () => {
      existsSyncSpy.mockReturnValue(true);
      setupSpawnMock('h264');

      const results = await service.importMedia(
        'proj_001',
        ['F:/videos/CLIP.MP4'],
        {
          getProjectMediaDir: vi.fn().mockReturnValue('F:/Zentect/media/proj_001'),
          getProjectThumbnailsDir: vi.fn().mockReturnValue('F:/Zentect/thumbnails/proj_001'),
          getBinPath: vi.fn().mockReturnValue('F:/Zentect/bin/ffprobe.exe'),
        },
        {
          extractMetadata: vi.fn().mockResolvedValue({ formattedTime: '00:00:00', duration: 0, width: 0, height: 0, fps: 0 }),
          generateCover: vi.fn().mockResolvedValue('cover.jpg'),
        },
      );

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('video');
    });

    it('带有深层路径的文件应正确提取文件名', async () => {
      existsSyncSpy.mockReturnValue(true);

      const results = await service.importMedia(
        'proj_001',
        ['F:/deep/nested/path/to/video.mp4'],
        {
          getProjectMediaDir: vi.fn().mockReturnValue('F:/Zentect/media/proj_001'),
          getProjectThumbnailsDir: vi.fn().mockReturnValue('F:/Zentect/thumbnails/proj_001'),
          getBinPath: vi.fn().mockReturnValue('F:/Zentect/bin/ffprobe.exe'),
        },
        {
          extractMetadata: vi.fn().mockResolvedValue({ formattedTime: '00:00:00', duration: 0, width: 0, height: 0, fps: 0 }),
          generateCover: vi.fn().mockResolvedValue('cover.jpg'),
        },
      );

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('video.mp4');
    });
  });
});
