// Module: media/import - ImportService 单元测试

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { EventEmitter } from 'events';

// === Mock child_process ===

const { mockSpawn } = vi.hoisted(() => {
  const fn = vi.fn();
  return { mockSpawn: fn };
});

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: mockSpawn,
  };
});

// === Mock 外部依赖 ===

const {
  mockInsertMedia,
  mockFindById,
  mockUpdateMedia,
  mockUpdateMediaMeta,
  mockGetByProject,
} = vi.hoisted(() => ({
  mockInsertMedia: vi.fn(),
  mockFindById: vi.fn(),
  mockUpdateMedia: vi.fn(),
  mockUpdateMediaMeta: vi.fn(),
  mockGetByProject: vi.fn(),
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

const { mockGetAllWindows, mockWebContentsSend } = vi.hoisted(() => ({
  mockGetAllWindows: vi.fn(),
  mockWebContentsSend: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: mockGetAllWindows,
  },
}));

// === 测试 ===

import { ImportService } from '../backend/ImportService';

describe('ImportService', () => {
  let service: ImportService;
  let existsSyncSpy: ReturnType<typeof vi.spyOn>;
  let mkdirSyncSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    service = new ImportService();
    vi.clearAllMocks();

    existsSyncSpy = vi.spyOn(fs, 'existsSync');
    mkdirSyncSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);

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

      const results = await service.importMedia(
        'proj_001',
        ['F:/videos/exist.mp4', 'F:/videos/missing.mkv'],
        mockPathManager,
        mockVideoProcessor,
      );

      expect(results).toHaveLength(1);
      expect(results[0].filePath).toBe('F:/videos/exist.mp4');
    });

    // --- HEVC 检测 & 转码 ---

    it('mp4 文件应在后台触发 HEVC 检测', async () => {
      const localPathManager = {
        getProjectMediaDir: vi.fn().mockReturnValue('F:/Zentect/media/proj_001'),
        getProjectThumbnailsDir: vi.fn().mockReturnValue('F:/Zentect/thumbnails/proj_001'),
        getBinPath: vi.fn((name: string) => `F:/Zentect/bin/${name}`),
      };
      existsSyncSpy.mockImplementation((p: fs.PathLike) => {
        const s = String(p);
        return s.includes('Zentect') || s.includes('F:/videos');
      });

      const spawnSpy = mockSpawn.mockImplementation((() => {
        const proc = new EventEmitter() as any;
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        setImmediate(() => {
          proc.stdout.emit('data', Buffer.from('hevc'));
          proc.emit('close', 0);
        });
        return proc;
      }) as any);

      await service.importMedia(
        'proj_001',
        ['F:/videos/hevc.mp4'],
        localPathManager,
        mockVideoProcessor,
      );

      await new Promise((r) => setTimeout(r, 50));

      const ffprobeCalls = spawnSpy.mock.calls.filter(
        (c: any[]) => String(c[0]).includes('ffprobe'),
      );
      expect(ffprobeCalls.length).toBeGreaterThanOrEqual(1);
      spawnSpy.mockRestore();
    });

    it('HEVC 格式（mkv）应在后台触发转码', async () => {
      const localPathManager = {
        getProjectMediaDir: vi.fn().mockReturnValue('F:/Zentect/media/proj_001'),
        getProjectThumbnailsDir: vi.fn().mockReturnValue('F:/Zentect/thumbnails/proj_001'),
        getBinPath: vi.fn((name: string) => `F:/Zentect/bin/${name}`),
      };
      existsSyncSpy.mockImplementation((p: fs.PathLike) => {
        const s = String(p);
        if (s.includes('_transcoded.mp4')) return false;
        return s.includes('Zentect') || s.includes('F:/videos');
      });

      const spawnSpy = mockSpawn.mockImplementation((() => {
        const proc = new EventEmitter() as any;
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        setImmediate(() => proc.emit('close', 0));
        return proc;
      }) as any);

      await service.importMedia(
        'proj_001',
        ['F:/videos/raw.mkv'],
        localPathManager,
        mockVideoProcessor,
      );

      await new Promise((r) => setTimeout(r, 50));

      const ffmpegCalls = spawnSpy.mock.calls.filter(
        (c: any[]) => String(c[0]).includes('ffmpeg'),
      );
      expect(ffmpegCalls.length).toBeGreaterThanOrEqual(1);
      spawnSpy.mockRestore();
    });

    it('avi 格式应在后台触发转码', async () => {
      const localPathManager = {
        getProjectMediaDir: vi.fn().mockReturnValue('F:/Zentect/media/proj_001'),
        getProjectThumbnailsDir: vi.fn().mockReturnValue('F:/Zentect/thumbnails/proj_001'),
        getBinPath: vi.fn((name: string) => `F:/Zentect/bin/${name}`),
      };
      existsSyncSpy.mockImplementation((p: fs.PathLike) => {
        const s = String(p);
        if (s.includes('_transcoded.mp4')) return false;
        return s.includes('Zentect') || s.includes('F:/videos');
      });

      const spawnSpy = mockSpawn.mockImplementation((() => {
        const proc = new EventEmitter() as any;
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        setImmediate(() => proc.emit('close', 0));
        return proc;
      }) as any);

      await service.importMedia(
        'proj_001',
        ['F:/videos/legacy.avi'],
        localPathManager,
        mockVideoProcessor,
      );

      await new Promise((r) => setTimeout(r, 50));

      const ffmpegCalls = spawnSpy.mock.calls.filter(
        (c: any[]) => String(c[0]).includes('ffmpeg'),
      );
      expect(ffmpegCalls.length).toBeGreaterThanOrEqual(1);
      spawnSpy.mockRestore();
    });

    it('h264 MP4 不应触发转码', async () => {
      const localPathManager = {
        getProjectMediaDir: vi.fn().mockReturnValue('F:/Zentect/media/proj_001'),
        getProjectThumbnailsDir: vi.fn().mockReturnValue('F:/Zentect/thumbnails/proj_001'),
        getBinPath: vi.fn((name: string) => `F:/Zentect/bin/${name}`),
      };
      existsSyncSpy.mockImplementation((p: fs.PathLike) => {
        const s = String(p);
        return s.includes('Zentect') || s.includes('F:/videos');
      });

      const spawnSpy = mockSpawn.mockImplementation((() => {
        const proc = new EventEmitter() as any;
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        setImmediate(() => {
          proc.stdout.emit('data', Buffer.from('h264'));
          proc.emit('close', 0);
        });
        return proc;
      }) as any);

      await service.importMedia(
        'proj_001',
        ['F:/videos/normal.mp4'],
        localPathManager,
        mockVideoProcessor,
      );

      await new Promise((r) => setTimeout(r, 50));

      // ffmpeg 不应被调用（h264 不需要转码）
      const ffmpegCalls = spawnSpy.mock.calls.filter(
        (c: any[]) => String(c[0]).includes('ffmpeg'),
      );
      expect(ffmpegCalls).toHaveLength(0);
      spawnSpy.mockRestore();
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
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);

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
      // 两个都应写入数据库
      expect(mockInsertMedia).toHaveBeenCalledTimes(2);
    });
  });

  // ==================== 错误处理 ====================

  describe('错误处理', () => {
    it('insertMedia 抛出异常不应中断其他文件导入', async () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);

      mockInsertMedia
        .mockImplementationOnce(() => {
          throw new Error('DB write failed');
        })
        .mockImplementationOnce(() => {});

      const results = await service.importMedia(
        'proj_001',
        ['F:/videos/bad.mp4', 'F:/videos/good.mp4'],
        { getProjectMediaDir: vi.fn(), getProjectThumbnailsDir: vi.fn(), getBinPath: vi.fn() },
        { extractMetadata: vi.fn(), generateCover: vi.fn() },
      );

      // 异常被捕获，第二个文件仍被处理
      expect(mockLoggerError).toHaveBeenCalled();
      expect(mockInsertMedia).toHaveBeenCalledTimes(2);
    });
  });
});
