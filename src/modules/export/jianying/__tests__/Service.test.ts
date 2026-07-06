// Module: export/jianying - Service 单元测试

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// === Mock crypto ===
const { mockRandomUUID } = vi.hoisted(() => ({
  mockRandomUUID: vi.fn(),
}));

let uuidCounter = 0;
mockRandomUUID.mockImplementation(() => {
  uuidCounter++;
  return `mock-uuid-${String(uuidCounter).padStart(4, '0')}`;
});

vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  return {
    ...actual,
    randomUUID: mockRandomUUID,
  };
});

// === Mock fs ===
const { mockFsExistsSync, mockFsMkdirSync, mockFsWriteFileSync } = vi.hoisted(() => ({
  mockFsExistsSync: vi.fn(),
  mockFsMkdirSync: vi.fn(),
  mockFsWriteFileSync: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: mockFsExistsSync,
    mkdirSync: mockFsMkdirSync,
    writeFileSync: mockFsWriteFileSync,
  };
});

// === 测试 ===
import { JianyingExportService } from '../backend/Service';

describe('JianyingExportService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uuidCounter = 0;
    mockFsExistsSync.mockReturnValue(true);
    mockFsMkdirSync.mockImplementation(() => undefined);
    mockFsWriteFileSync.mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==================== compileDraft ====================

  describe('compileDraft', () => {
    const baseShots = [
      {
        id: 'shot-1',
        mediaId: 'media-1',
        imagePath: '/media/shot1.jpg',
        text: '第一段解说',
        originalText: '第一段',
        start: 0,
        end: 5,
        duration: 5,
        audioDuration: 5,
        aiText: 'AI修正第一段',
        audioPath: 'C:/audio/shot-1.mp3',
      },
      {
        id: 'shot-2',
        mediaId: 'media-2',
        imagePath: '/media/shot2.jpg',
        text: '第二段解说',
        originalText: '第二段',
        start: 0,
        end: 3,
        duration: 3,
        audioDuration: 3,
      },
    ];

    it('应返回 version 6 的草稿结构', () => {
      const draft = JianyingExportService.compileDraft(baseShots, 'C:/media/video.mp4');

      expect(draft).toHaveProperty('version', 6);
      expect(draft).toHaveProperty('id');
      expect(draft).toHaveProperty('fps', 30);
      expect(draft).toHaveProperty('duration');
      expect(draft).toHaveProperty('materials');
      expect(draft).toHaveProperty('tracks');
      expect(draft).toHaveProperty('canvas_config');
    });

    it('canvas_config 应为 1080x1920 16:9', () => {
      const draft = JianyingExportService.compileDraft(baseShots, 'C:/media/video.mp4');

      const cc = (draft as any).canvas_config;
      expect(cc).toEqual({ height: 1080, width: 1920, ratio: '16:9' });
    });

    it('应生成 4 条轨道（video / audio-bgm / audio-tts / text）', () => {
      const draft = JianyingExportService.compileDraft(baseShots, 'C:/media/video.mp4', 'C:/music/bgm.mp3');

      const tracks = (draft as any).tracks as any[];
      expect(tracks).toHaveLength(4);
      expect(tracks[0].type).toBe('video');
      expect(tracks[1].type).toBe('audio');
      expect(tracks[2].type).toBe('audio');
      expect(tracks[3].type).toBe('text');
    });

    it('应正确计算 total duration（微秒单位）', () => {
      // shot-1: 5s = 5_000_000us, shot-2: 3s = 3_000_000us → total: 8_000_000us
      const draft = JianyingExportService.compileDraft(baseShots, 'C:/media/video.mp4');

      expect((draft as any).duration).toBe(8_000_000);
    });

    it('视频轨道应为每个 shot 生成 segment', () => {
      const shots3 = [...baseShots, {
        id: 'shot-3',
        mediaId: 'media-3',
        imagePath: '/media/shot3.jpg',
        text: '第三段',
        start: 0,
        end: 2,
        duration: 2,
        audioDuration: 2,
      }];

      const draft = JianyingExportService.compileDraft(shots3, 'C:/media/video.mp4');
      const tracks = (draft as any).tracks as any[];
      const videoSegments = tracks[0].segments as any[];

      expect(videoSegments).toHaveLength(3);
      expect(videoSegments[0].target_timerange.start).toBe(0);
      expect(videoSegments[0].target_timerange.duration).toBe(5_000_000);
      expect(videoSegments[1].target_timerange.start).toBe(5_000_000);
      expect(videoSegments[1].target_timerange.duration).toBe(3_000_000);
      expect(videoSegments[2].target_timerange.start).toBe(8_000_000);
    });

    it('有 audioPath 的 shot 应生成 TTS 轨道 segment', () => {
      const draft = JianyingExportService.compileDraft(baseShots, 'C:/media/video.mp4');
      const tracks = (draft as any).tracks as any[];
      const ttsSegments = (tracks[2] as any).segments as any[];

      // shot-1 有 audioPath，shot-2 没有
      expect(ttsSegments).toHaveLength(1);
    });

    it('有 aiText 或 originalText 的 shot 应生成字幕轨道 segment', () => {
      const draft = JianyingExportService.compileDraft(baseShots, 'C:/media/video.mp4');
      const tracks = (draft as any).tracks as any[];
      const textSegments = (tracks[3] as any).segments as any[];

      // shot-1 有 aiText，shot-2 有 originalText
      expect(textSegments).toHaveLength(2);
    });

    it('不应生成 BGM 轨道（仅 bgmPath 为空时应有 4 个轨道但 bgm 无 segment）', () => {
      const draft = JianyingExportService.compileDraft(baseShots, 'C:/media/video.mp4');

      const tracks = (draft as any).tracks as any[];
      const bgmSegments = (tracks[1] as any).segments as any[];
      expect(bgmSegments).toHaveLength(0);
    });

    it('提供 bgmPath 时应生成 BGM segment（音量 0.3）', () => {
      const draft = JianyingExportService.compileDraft(
        baseShots,
        'C:/media/video.mp4',
        'C:/music/bgm.mp3',
      );

      const tracks = (draft as any).tracks as any[];
      const bgmSegments = (tracks[1] as any).segments as any[];

      expect(bgmSegments).toHaveLength(1);
      const bgmSeg = bgmSegments[0];
      expect(bgmSeg.target_timerange.start).toBe(0);
      expect(bgmSeg.target_timerange.duration).toBe(8_000_000);
      expect(bgmSeg.volume).toBe(0.3);
    });

    it('materials 应包含 videos / audios / texts 三类', () => {
      const draft = JianyingExportService.compileDraft(baseShots, 'C:/media/video.mp4', 'C:/music/bgm.mp3');

      const materials = (draft as any).materials;
      expect(materials.videos).toHaveLength(2);
      expect(materials.audios).toHaveLength(2); // bgm + tts
      expect(materials.texts).toHaveLength(2);  // shot-1 aiText + shot-2 originalText
    });

    it('audioDuration 缺失时使用 end - start 计算', () => {
      const shotsNoAudioDur = [
        {
          id: 's1',
          mediaId: 'm1',
          imagePath: '/img.jpg',
          text: 'test',
          start: 2,
          end: 7,
          duration: 5,
        },
      ];

      const draft = JianyingExportService.compileDraft(shotsNoAudioDur, 'C:/media/video.mp4');
      expect((draft as any).duration).toBe(5_000_000); // (7 - 2) * 1e6
    });

    it('mediaPath 中的反斜杠应转为正斜杠', () => {
      const draft = JianyingExportService.compileDraft(baseShots, 'C:\\media\\video.mp4');

      const materials = (draft as any).materials;
      expect(materials.videos[0].path).toBe('C:/media/video.mp4');
    });
  });

  // ==================== export ====================

  describe('export', () => {
    const validInput = {
      projectId: 'proj-test',
      matchResults: [],
      ttsResults: [],
      scriptParagraphs: [
        {
          id: 'para-1',
          shotId: 'shot-1',
          text: '测试文案',
          duration: 10,
          editing: false,
        },
      ],
      bgmPath: 'C:/music/bgm.mp3',
      outputDir: 'C:/output',
    };

    it('应创建草稿文件夹并写入 draft_content.json 和 draft_meta.json', () => {
      const result = JianyingExportService.export(validInput, 'C:/jianying/drafts');

      expect(mockFsExistsSync).toHaveBeenCalledWith('C:/jianying/drafts');
      expect(mockFsMkdirSync).toHaveBeenCalledTimes(1);
      expect(mockFsWriteFileSync).toHaveBeenCalledTimes(2);

      const writeCalls = mockFsWriteFileSync.mock.calls;
      const paths = writeCalls.map((c: any) => c[0] as string);
      expect(paths.some((p: string) => p.endsWith('draft_content.json'))).toBe(true);
      expect(paths.some((p: string) => p.endsWith('draft_meta.json'))).toBe(true);
    });

    it('返回的 filePath 应包含 Zentect_ 前缀', () => {
      const result = JianyingExportService.export(validInput, 'C:/jianying/drafts');

      expect(result.filePath).toContain('Zentect_');
      expect(result.fileName).toContain('Zentect_');
    });

    it('jiangingRoot 不存在时应抛出 AppError', () => {
      mockFsExistsSync.mockReturnValue(false);

      expect(() => {
        JianyingExportService.export(validInput, 'C:/nonexistent');
      }).toThrow();
    });

    it('写入的 draft_content.json 应为有效 JSON', () => {
      JianyingExportService.export(validInput, 'C:/jianying/drafts');

      const writeCall = mockFsWriteFileSync.mock.calls.find(
        (c: any) => String(c[0]).endsWith('draft_content.json'),
      );
      const content = writeCall[1] as string;
      const parsed = JSON.parse(content);
      expect(parsed.version).toBe(6);
      expect(parsed.tracks).toHaveLength(4);
    });

    it('写入的 draft_meta.json 应包含 draft_name 和 draft_id', () => {
      JianyingExportService.export(validInput, 'C:/jianying/drafts');

      const writeCall = mockFsWriteFileSync.mock.calls.find(
        (c: any) => String(c[0]).endsWith('draft_meta.json'),
      );
      const content = writeCall[1] as string;
      const parsed = JSON.parse(content);
      expect(parsed).toHaveProperty('draft_name');
      expect(parsed).toHaveProperty('draft_id');
      expect(parsed.draft_type).toBe('short_video');
    });
  });
});
