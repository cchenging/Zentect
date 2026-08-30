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
const {
  mockFsExistsSync, mockFsMkdirSync, mockFsWriteFileSync, mockFsRmSync, mockFsStatSync,
} = vi.hoisted(() => ({
  mockFsExistsSync: vi.fn(),
  mockFsMkdirSync: vi.fn(),
  mockFsWriteFileSync: vi.fn(),
  mockFsRmSync: vi.fn(),
  mockFsStatSync: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: mockFsExistsSync,
    mkdirSync: mockFsMkdirSync,
    writeFileSync: mockFsWriteFileSync,
    rmSync: mockFsRmSync,
    statSync: mockFsStatSync,
  };
});

// === Mock child_process (ffprobe 探针返回假 1920x1080 结果) ===
const { mockExecFileSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
}));

/**
 * 构造假 ffprobe JSON 输出（1920x1080 h264 + aac 音频，30fps，时长走 input 透传）
 * probeVideoSync 会解析 stdout 为 {width,height,hasAudio,durationSec}
 */
function buildFakeFfprobeOutput(durationSec = 10, width = 1920, height = 1080): string {
  return JSON.stringify({
    streams: [
      {
        index: 0,
        codec_type: 'video',
        codec_name: 'h264',
        width,
        height,
        r_frame_rate: '30/1',
      },
      {
        index: 1,
        codec_type: 'audio',
        codec_name: 'aac',
      },
    ],
    format: {
      duration: String(durationSec),
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      size: '1024000',
    },
  });
}

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: mockExecFileSync,
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
    mockFsRmSync.mockImplementation(() => undefined);
    mockFsStatSync.mockImplementation(() => ({ size: 1_000_000 }));
    // ffprobe 默认返回 1920x1080 + 10 秒 + 有音频
    mockExecFileSync.mockImplementation(() => buildFakeFfprobeOutput(10));
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

    it('应返回 version 360000 的草稿结构', () => {
      const draft = JianyingExportService.compileDraft(baseShots, 'C:/media/video.mp4');

      expect(draft).toHaveProperty('version', 360000);
      expect(draft).toHaveProperty('id');
      expect(draft).toHaveProperty('fps', 30);
      expect(draft).toHaveProperty('duration');
      expect(draft).toHaveProperty('materials');
      expect(draft).toHaveProperty('tracks');
      expect(draft).toHaveProperty('canvas_config');
    });

    it('canvas_config 应为 1080x1920 original（与剪映原生草稿一致）', () => {
      const draft = JianyingExportService.compileDraft(baseShots, 'C:/media/video.mp4');

      const cc = (draft as any).canvas_config;
      expect(cc).toEqual({ height: 1080, width: 1920, ratio: 'original' });
    });

    it('横屏源视频（默认 1920x1080）：字幕字号用横屏专用值放大且位置贴近底部', () => {
      // 默认 mock 即 1920x1080 横屏
      const draft = JianyingExportService.compileDraft(baseShots, 'C:/media/video.mp4');
      const cc = (draft as any).canvas_config as any;
      expect(cc.width).toBe(1920);
      // 横屏字号用 fontSizeLandscape（缺省 5.0）放大，不再保持过小的 3.5
      const texts = (draft as any).materials?.texts as any[];
      expect(Number(texts[0].font_size)).toBeCloseTo(5.0, 3);
      // 横屏位置贴近底部：verticalOffset=0.12（往上抬一点不透底），clip.transform.y = -0.73
      const tracks = (draft as any).tracks as any[];
      const seg = tracks.find((t: any) => t.type === 'text').segments[0];
      expect(seg.clip.transform.y).toBeCloseTo(-0.73, 3);
    });

    it('竖屏源视频：画布应为 1080x1920 且字幕字号按宽比自适应放大', () => {
      // mock ffprobe 返回竖屏 1080x1920
      mockExecFileSync.mockImplementation(() => buildFakeFfprobeOutput(10, 1080, 1920));
      const draft = JianyingExportService.compileDraft(baseShots, 'C:/media/video.mp4');

      // 画布跟随竖屏分辨率
      const cc = (draft as any).canvas_config as any;
      expect(cc).toEqual({ width: 1080, height: 1920, ratio: 'original' });
      // 画布占位素材同步为竖屏
      const canvases = (draft as any).materials?.canvases as any[];
      expect(canvases[0].width).toBe(1080);
      expect(canvases[0].height).toBe(1920);
      // 字幕字号相对 1920 宽基准放大：3.5 * 1920/1080 ≈ 6.222，保证观感一致
      const texts = (draft as any).materials?.texts as any[];
      expect(texts.length).toBeGreaterThan(0);
      expect(Number(texts[0].font_size)).toBeCloseTo(3.5 * (1920 / 1080), 3);
      // 字幕位置：竖屏画布更高，verticalOffset 单独换算（0.3 * 1080/1920）保持距底部视觉一致
      const tracks = (draft as any).tracks as any[];
      const textTrack = tracks.find((t: any) => t.type === 'text');
      const seg = textTrack.segments[0];
      // 默认 verticalOffset=0.3，竖屏换算下的 clip.transform.y = -0.85 + verticalOffsetPortrait
      const expectedVertical = 0.3 * (1080 / 1920);
      expect((seg.clip.transform.y as number) - (-0.85)).toBeCloseTo(expectedVertical, 3);
    });

    it('relationships 应为数组（剪映原生草稿为数组，非对象）', () => {
      const draft = JianyingExportService.compileDraft(baseShots, 'C:/media/video.mp4');

      expect(Array.isArray((draft as any).relationships)).toBe(true);
    });

    it('轨道名应与剪映一致（video→main / audio-bgm / audio-tts / text→subs）', () => {
      const draft = JianyingExportService.compileDraft(baseShots, 'C:/media/video.mp4', 'C:/music/bgm.mp3');

      const tracks = (draft as any).tracks as any[];
      expect(tracks[0].name).toBe('main');
      expect(tracks[1].name).toBe('bgm');
      expect(tracks[2].name).toBe('audio');
      expect(tracks[3].name).toBe('subs');
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

    it('buildCompileShots 应以 scriptParagraphs 为主数据源，matchResults/ttsResults 按 id 补充切片与配音', () => {
      const input = {
        projectId: 'p',
        scriptParagraphs: [
          { id: 's1', shotId: 's1', text: '第一段解说', duration: 4 },
          { id: 's2', shotId: 's2', text: '第二段解说', duration: 3 },
        ] as any[],
        matchResults: [
          { id: 's1', shotId: 's1', mediaId: 'm1', thumbnail: '/thumb1.jpg', audioDurationMs: 4000, chunkData: { filePath: 'C:/chunk/s1.mp4', startMs: 1000, endMs: 5000 }, appliedSpeedFactor: 1.1 },
        ] as any[],
        ttsResults: [
          { id: 's1', shotId: 's1', audioUrl: 'C:/tts/s1.mp3', duration: 4.2 },
        ] as any[],
        shots: [] as any[],
        outputDir: 'C:/out',
      };

      const shots = JianyingExportService.buildCompileShots(input as any);

      expect(shots).toHaveLength(2);
      // s1：主数据源段落字段 + 切片补充 + 配音取 TTS
      expect(shots[0].id).toBe('s1');
      expect(shots[0].text).toBe('第一段解说');
      expect(shots[0].aiText).toBe('第一段解说');
      expect(shots[0].originalText).toBe('第一段解说');
      expect(shots[0].audioPath).toBe('C:/tts/s1.mp3'); // TTS 配音路径
      expect(shots[0].chunkData).toEqual({ filePath: 'C:/chunk/s1.mp4', startMs: 1000, endMs: 5000 });
      expect(shots[0].mediaId).toBe('m1');
      expect(shots[0].imagePath).toBe('/thumb1.jpg');
      expect(shots[0].duration).toBe(4.2); // TTS duration 优先
      expect(shots[0].start).toBe(1); // chunk.startMs 1000ms → 1s
      // s2：无 match/tts，回落段落 duration 且无配音
      expect(shots[1].id).toBe('s2');
      expect(shots[1].text).toBe('第二段解说');
      expect(shots[1].audioPath).toBeUndefined();
      expect(shots[1].duration).toBe(3);
    });

    it('buildCompileShots 无 TTS/匹配时，返回空数组（主循环为 scriptParagraphs，非 shots）', () => {
      const input = {
        projectId: 'p',
        scriptParagraphs: [] as any[],
        shots: [{ id: 's1', start: 2, end: 7, duration: 5 }] as any[],
        matchResults: [] as any[],
        ttsResults: [] as any[],
        outputDir: 'C:/out',
      };

      const shots = JianyingExportService.buildCompileShots(input as any);
      expect(shots).toHaveLength(0);
    });

    it('buildCompileShots breakLongParagraphs 切分后子句 id!=shotId，配音应按唯一 id 匹配（回归：配音轨缺失）', () => {
      const input = {
        projectId: 'p',
        // 长句被切分成两个子句：id 唯一，shotId 共享父级 s1
        scriptParagraphs: [
          { id: 's1_sub_1', shotId: 's1', text: '第一句解说', duration: 2 },
          { id: 's1_sub_2', shotId: 's1', text: '第二句解说', duration: 2 },
        ] as any[],
        matchResults: [
          { id: 's1', shotId: 's1', mediaId: 'm1', chunkData: { filePath: 'C:/chunk/s1.mp4', startMs: 0, endMs: 4000 }, audioDurationMs: 4000 },
        ] as any[],
        // TTS 结果以 s.id 作为唯一 id（= 子句唯一 id），与共享的父级 shotId 不同
        ttsResults: [
          { id: 's1_sub_1', shotId: 's1_sub_1', audioUrl: 'C:/tts/s1_sub_1.mp3', duration: 2.1 },
          { id: 's1_sub_2', shotId: 's1_sub_2', audioUrl: 'C:/tts/s1_sub_2.mp3', duration: 1.9 },
        ] as any[],
        shots: [] as any[],
        outputDir: 'C:/out',
      };

      const shots = JianyingExportService.buildCompileShots(input as any);

      // 两个子句都应取到各自配音，而非因 shotId 不匹配而丢失配音轨
      expect(shots).toHaveLength(2);
      expect(shots[0].audioPath).toBe('C:/tts/s1_sub_1.mp3');
      expect(shots[1].audioPath).toBe('C:/tts/s1_sub_2.mp3');
    });

    it('buildCompileShots 段落无 shotId 时回退 id，且无配音返回 undefined', () => {
      const input = {
        projectId: 'p',
        scriptParagraphs: [{ id: 's1', text: '解说', duration: 5 }] as any[],
        matchResults: [] as any[],
        ttsResults: [] as any[],
        shots: [] as any[],
        outputDir: 'C:/out',
      };

      const shots = JianyingExportService.buildCompileShots(input as any);
      expect(shots).toHaveLength(1);
      expect(shots[0].id).toBe('s1');
      expect(shots[0].duration).toBe(5);
      expect(shots[0].audioPath).toBeUndefined();
    });
  });

  // ==================== export ====================

  describe('export', () => {
    const validInput = {
      projectId: 'proj-test',
      shots: [
        {
          id: 'shot-1',
          mediaId: 'media-1',
          text: '测试文案',
          originalText: '测试文案',
          start: 0,
          end: 10,
          duration: 10,
          audioPath: 'C:/audio/shot-1.mp3',
        },
      ],
      matchResults: [],
      ttsResults: [],
      scriptParagraphs: [],
      bgmPath: 'C:/music/bgm.mp3',
      outputDir: 'C:/output',
    };

    it('应创建草稿文件夹并写入 5 个文件（draft_content/meta_info/meta + key_value/virtual_store）', async () => {
      await JianyingExportService.export(validInput, 'C:/jianying/drafts');

      expect(mockFsExistsSync).toHaveBeenCalledWith('C:/jianying/drafts');
      expect(mockFsMkdirSync).toHaveBeenCalledTimes(1);
      // 5 个文件：draft_content.json + draft_meta_info.json + draft_meta.json + key_value.json + draft_virtual_store.json
      expect(mockFsWriteFileSync).toHaveBeenCalledTimes(5);

      const writeCalls = mockFsWriteFileSync.mock.calls;
      const paths = writeCalls.map((c: any) => c[0] as string);
      expect(paths.some((p: string) => p.endsWith('draft_content.json'))).toBe(true);
      expect(paths.some((p: string) => p.endsWith('draft_meta_info.json'))).toBe(true);
      expect(paths.some((p: string) => p.endsWith('draft_meta.json'))).toBe(true);
      // 剪映 8.9.0+ "本地"素材面板显示依赖（手册坑位 7/8）
      expect(paths.some((p: string) => p.endsWith('key_value.json'))).toBe(true);
      expect(paths.some((p: string) => p.endsWith('draft_virtual_store.json'))).toBe(true);
    });

    it('返回的 filePath 应包含 Z_ 前缀（默认项目名 Zentect）', async () => {
      const result = await JianyingExportService.export(validInput, 'C:/jianying/drafts');

      expect(result.filePath).toContain('Z_');
      expect(result.fileName).toContain('Z_');
    });

    it('传入 projectName 时草稿名以 Z_ 前缀 + 项目名 + (自增序号) 命名', async () => {
      const result = await JianyingExportService.export(
        { ...validInput, projectName: '我的项目' },
        'C:/jianying/drafts',
      );

      // 草稿名形如 Z_我的项目 (1)，自增序号保证唯一，避免剪映将同名草稿移入回收站
      expect(result.fileName).toMatch(/^Z_我的项目 \(\d+\)$/);
    });

    it('projectName 含非法文件名字符时应替换为下划线', async () => {
      const result = await JianyingExportService.export(
        { ...validInput, projectName: 'a/b:c*d' },
        'C:/jianying/drafts',
      );

      expect(result.fileName).toMatch(/^Z_a_b_c_d \(\d+\)$/);
    });

    it('jianyingRoot 不存在时应抛出 AppError', () => {
      mockFsExistsSync.mockReturnValue(false);

      // export 为同步方法，使用同步断言
      expect(() => JianyingExportService.export(validInput, 'C:/nonexistent')).toThrow();
    });

    it('写入的 draft_content.json 应为有效 JSON', async () => {
      await JianyingExportService.export(validInput, 'C:/jianying/drafts');

      const writeCall = mockFsWriteFileSync.mock.calls.find(
        (c: any) => String(c[0]).endsWith('draft_content.json'),
      );
      // 🔧 修复 TS18048：find 可能返回 undefined，需显式断言
      expect(writeCall).toBeDefined();
      const content = writeCall![1] as string;
      const parsed = JSON.parse(content);
      expect(parsed.version).toBe(360000);
      expect(parsed.tracks).toHaveLength(4);
    });

    it('写入的 draft_meta.json 应包含 draft_name 和 draft_id', async () => {
      await JianyingExportService.export(validInput, 'C:/jianying/drafts');

      const writeCall = mockFsWriteFileSync.mock.calls.find(
        (c: any) => String(c[0]).endsWith('draft_meta.json'),
      );
      // 🔧 修复 TS18048：find 可能返回 undefined，需显式断言
      expect(writeCall).toBeDefined();
      const content = writeCall![1] as string;
      const parsed = JSON.parse(content);
      expect(parsed).toHaveProperty('draft_name');
      expect(parsed).toHaveProperty('draft_id');
      expect(parsed.draft_type).toBe('short_video');
    });

    it('每次导出使用唯一草稿名（含时间戳），不清空旧文件夹，避免剪映将草稿移入回收站', async () => {
      // 即使目标根目录存在，也不应调用 rmSync：唯一命名保证每次为全新文件夹，
      // 剪映走 copy_draft_external 识别；若复用固定名并清空，会触发 move_draft_to_trash
      mockFsExistsSync.mockReturnValue(true);
      mockFsRmSync.mockClear();

      await JianyingExportService.export(validInput, 'C:/jianying/drafts');

      expect(mockFsRmSync).not.toHaveBeenCalled();
    });

    it('导出创建的草稿文件夹名应包含自增序号', async () => {
      mockFsExistsSync.mockReturnValue(true);
      mockFsMkdirSync.mockClear();

      await JianyingExportService.export(validInput, 'C:/jianying/drafts');

      const mkdirCall = mockFsMkdirSync.mock.calls.find((c: any) =>
        String(c[0]).includes('Z_'),
      );
      expect(mkdirCall).toBeDefined();
      // 文件夹名形如 Z_项目名 (1)，自增序号保证唯一性
      expect(String(mkdirCall![0])).toMatch(/\s\(\d+\)$/);
    });
  });
});
