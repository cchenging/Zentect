import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// === Mock crypto for deterministic IDs ===
const { mockRandomBytes } = vi.hoisted(() => ({
  mockRandomBytes: vi.fn(),
}));

let idCounter = 0;
mockRandomBytes.mockImplementation((n: number) => {
  // Return deterministic bytes based on counter
  const buf = Buffer.alloc(n);
  idCounter++;
  buf.writeUInt32BE(idCounter, 0);
  return buf;
});

vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  return {
    ...actual,
    randomBytes: mockRandomBytes,
    randomUUID: () => '00000000-0000-4000-8000-000000000001',
  };
});

// === Mock fs ===
const { mockFsExistsSync, mockFsMkdirSync, mockFsWriteFileSync, mockFsStatSync } = vi.hoisted(() => ({
  mockFsExistsSync: vi.fn(),
  mockFsMkdirSync: vi.fn(),
  mockFsWriteFileSync: vi.fn(),
  mockFsStatSync: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: mockFsExistsSync,
    mkdirSync: mockFsMkdirSync,
    writeFileSync: mockFsWriteFileSync,
    statSync: mockFsStatSync,
  };
});

// === Mock child_process: ffprobe 返回假 1920x1080 结果 + spawn 封面生成模拟 ===
const { mockExecFileSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
}));

/** 构造假 ffprobe JSON：1920x1080 h264 + aac + 30fps，时长入参透传 */
function buildFakeFfprobeOutput(durationSec = 100): string {
  return JSON.stringify({
    streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, r_frame_rate: '30/1' },
      { index: 1, codec_type: 'audio', codec_name: 'aac' },
    ],
    format: {
      duration: String(durationSec),
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      size: '7000000000',
    },
  });
}

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: mockExecFileSync,
    spawn: vi.fn(() => ({
      on: vi.fn((event: string, cb: Function) => {
        if (event === 'close') cb(1); // simulate cover generation failure (non-blocking)
        if (event === 'error') {}
      }),
    })),
  };
});

import { JianyingExportService } from '../backend/Service';
import type { JianyingExportInput } from '../types';

// === Load real test data from Aug 6 fixtures ===
const FIXTURE_DIR = path.resolve(process.cwd(), 'test/fixtures/aug6_test_data');

function loadFixture(): JianyingExportInput {
  const meta = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'project_meta.json'), 'utf-8'));
  const matchResults = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'matchResults.json'), 'utf-8'));
  const ttsResults = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'ttsResults.json'), 'utf-8'));
  const scriptParagraphs = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'scriptParagraphs.json'), 'utf-8'));

  return {
    projectId: meta.id,
    shots: [],
    matchResults,
    ttsResults,
    scriptParagraphs,
    bgmPath: meta.mediaItems?.find((m: any) => m.extractedBgm)?.extractedBgm || undefined,
    mediaPath: meta.mediaItems?.[0]?.filePath || '',
    outputDir: meta.mediaItems?.[0]?.filePath || '',
  };
}

describe('JianyingExportService - Aug 6 Real Data Integration Test', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    idCounter = 0;
    mockFsExistsSync.mockReturnValue(true);
    mockFsMkdirSync.mockImplementation(() => undefined);
    mockFsWriteFileSync.mockImplementation(() => undefined);
    mockFsStatSync.mockImplementation(() => ({ size: 1_000_000 }));
    // ffprobe 默认返回 1920x1080 + 有音频
    mockExecFileSync.mockImplementation(() => buildFakeFfprobeOutput(100));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==================== buildCompileShots ====================

  describe('buildCompileShots - real data mapping', () => {
    it('应将 26 段文案全部映射为 compileShot', () => {
      const input = loadFixture();
      const shots = JianyingExportService.buildCompileShots(input);

      expect(shots).toHaveLength(26);
    });

    it('前 21 段应关联到 matchResults（有视频切片）', () => {
      const input = loadFixture();
      const shots = JianyingExportService.buildCompileShots(input);

      // 前 21 段有 matchResult
      for (let i = 0; i < 21; i++) {
        expect(shots[i].id).toBe(`s_${String(i + 1).padStart(2, '0')}`);
        expect(shots[i].chunkData).toBeTruthy();
        expect(shots[i].videoTimelineStartMs).toBeDefined();
      }
    });

    it('后 5 段（s_22 ~ s_26）无 matchResult 但仍保留文案和 TTS', () => {
      const input = loadFixture();
      const shots = JianyingExportService.buildCompileShots(input);

      for (let i = 21; i < 26; i++) {
        expect(shots[i].id).toBe(`s_${String(i + 1).padStart(2, '0')}`);
        expect(shots[i].text).toBeTruthy();
        // 无视频切片
        expect(shots[i].chunkData).toBeNull();
      }
    });

    it('所有 26 段都应关联到 TTS 音频（无失败）', () => {
      const input = loadFixture();
      const shots = JianyingExportService.buildCompileShots(input);

      for (const shot of shots) {
        expect(shot.audioPath).toBeTruthy();
        expect(shot.audioPath).toContain('magic://local/');
      }
    });

    it('duration 应优先使用 TTS 真实时长', () => {
      const input = loadFixture();
      const shots = JianyingExportService.buildCompileShots(input);

      // s_01: tts duration = 3
      expect(shots[0].duration).toBe(3);
      // s_02: tts duration = 2.112
      expect(shots[1].duration).toBeCloseTo(2.112, 2);
    });

    it('有 chunkData 的段应包含正确的视频源路径', () => {
      const input = loadFixture();
      const shots = JianyingExportService.buildCompileShots(input);

      // s_01 的 chunkData.filePath 是源视频路径
      const cd = shots[0].chunkData as { filePath: string; startMs: number; endMs: number };
      expect(cd.filePath).toContain('8月6日无字幕测试视频.mp4');
      expect(cd.startMs).toBe(212966.7);
      expect(cd.endMs).toBe(216933.3);
    });
  });

  // ==================== compileDraft ====================

  describe('compileDraft - real data draft structure', () => {
    it('应生成 4 条轨道（video / audio-bgm / audio-tts / text）', () => {
      const input = loadFixture();
      const shots = JianyingExportService.buildCompileShots(input);
      const draft = JianyingExportService.compileDraft(
        shots,
        input.mediaPath!,
        input.bgmPath,
      ) as any;

      expect(draft.tracks).toHaveLength(4);
      expect(draft.tracks[0].type).toBe('video');
      expect(draft.tracks[1].type).toBe('audio'); // BGM
      expect(draft.tracks[2].type).toBe('audio'); // TTS
      expect(draft.tracks[3].type).toBe('text');
    });

    it('video 轨道应有 26 个 segment（每段文案一个视频切片）', () => {
      const input = loadFixture();
      const shots = JianyingExportService.buildCompileShots(input);
      const draft = JianyingExportService.compileDraft(shots, input.mediaPath!, input.bgmPath) as any;

      const videoSegments = draft.tracks[0].segments;
      expect(videoSegments).toHaveLength(26);
    });

    it('TTS 轨道应有 26 个 segment（全部 TTS 成功）', () => {
      const input = loadFixture();
      const shots = JianyingExportService.buildCompileShots(input);
      const draft = JianyingExportService.compileDraft(shots, input.mediaPath!, input.bgmPath) as any;

      const ttsSegments = draft.tracks[2].segments;
      expect(ttsSegments).toHaveLength(26);
    });

    it('text 轨道应有 26 个 segment', () => {
      const input = loadFixture();
      const shots = JianyingExportService.buildCompileShots(input);
      const draft = JianyingExportService.compileDraft(shots, input.mediaPath!, input.bgmPath) as any;

      const textSegments = draft.tracks[3].segments;
      expect(textSegments).toHaveLength(26);
    });

    it('BGM 轨道应有 1 个整片铺设的 segment', () => {
      const input = loadFixture();
      const shots = JianyingExportService.buildCompileShots(input);
      const draft = JianyingExportService.compileDraft(shots, input.mediaPath!, input.bgmPath) as any;

      const bgmSegments = draft.tracks[1].segments;
      expect(bgmSegments).toHaveLength(1);
      expect(bgmSegments[0].target_timerange.start).toBe(0);
      expect(bgmSegments[0].volume).toBe(0.3);
    });

    it('总时长应等于所有段 TTS duration 之和（微秒）', () => {
      const input = loadFixture();
      const shots = JianyingExportService.buildCompileShots(input);
      const draft = JianyingExportService.compileDraft(shots, input.mediaPath!) as any;

      // 计算预期总时长
      const expectedSec = shots.reduce((sum, s) => sum + (s.audioDuration || (s.end - s.start)), 0);
      const expectedUs = Math.round(expectedSec * 1_000_000);

      expect(draft.duration).toBe(expectedUs);
    });

    it('每个 video segment 的 target_timerange 应连续无间隙', () => {
      const input = loadFixture();
      const shots = JianyingExportService.buildCompileShots(input);
      const draft = JianyingExportService.compileDraft(shots, input.mediaPath!) as any;

      const videoSegments = draft.tracks[0].segments;
      let expectedStart = 0;

      for (let i = 0; i < videoSegments.length; i++) {
        expect(videoSegments[i].target_timerange.start).toBe(expectedStart);
        expectedStart += videoSegments[i].target_timerange.duration;
      }
    });

    it('每个 segment 必须包含剪映必需字段', () => {
      const input = loadFixture();
      const shots = JianyingExportService.buildCompileShots(input);
      const draft = JianyingExportService.compileDraft(shots, input.mediaPath!, input.bgmPath) as any;

      // 检查所有轨道的所有 segment
      for (const track of draft.tracks) {
        for (const seg of track.segments) {
          // 剪映必需字段
          expect(seg).toHaveProperty('id');
          expect(seg).toHaveProperty('material_id');
          expect(seg).toHaveProperty('target_timerange');
          expect(seg.target_timerange).toHaveProperty('start');
          expect(seg.target_timerange).toHaveProperty('duration');
          expect(seg).toHaveProperty('clip');
          // 手册 §4.7：audio segment 的 clip/hdr_settings 必须为 null，其余轨为对象
          if (seg.clip !== null) {
            expect(seg.clip).toHaveProperty('alpha');
            expect(seg.clip).toHaveProperty('scale');
          }
          expect(seg).toHaveProperty('speed');
          expect(seg).toHaveProperty('volume');
          expect(seg).toHaveProperty('visible');
          expect(seg).toHaveProperty('render_index');
        }
      }
    });

    it('materials.videos 应有 26 个素材', () => {
      const input = loadFixture();
      const shots = JianyingExportService.buildCompileShots(input);
      const draft = JianyingExportService.compileDraft(shots, input.mediaPath!, input.bgmPath) as any;

      expect(draft.materials.videos).toHaveLength(26);
    });

    it('materials.audios 应包含 BGM + 26 个 TTS = 27 个', () => {
      const input = loadFixture();
      const shots = JianyingExportService.buildCompileShots(input);
      const draft = JianyingExportService.compileDraft(shots, input.mediaPath!, input.bgmPath) as any;

      expect(draft.materials.audios).toHaveLength(27); // 1 BGM + 26 TTS
    });

    it('materials.texts 应有 26 个', () => {
      const input = loadFixture();
      const shots = JianyingExportService.buildCompileShots(input);
      const draft = JianyingExportService.compileDraft(shots, input.mediaPath!) as any;

      expect(draft.materials.texts).toHaveLength(26);
    });

    it('所有 material id 应与 segment material_id 对应', () => {
      const input = loadFixture();
      const shots = JianyingExportService.buildCompileShots(input);
      const draft = JianyingExportService.compileDraft(shots, input.mediaPath!, input.bgmPath) as any;

      // 收集所有 material ids
      const videoMatIds = new Set(draft.materials.videos.map((m: any) => m.id));
      const audioMatIds = new Set(draft.materials.audios.map((m: any) => m.id));
      const textMatIds = new Set(draft.materials.texts.map((m: any) => m.id));

      // 检查 video segments
      for (const seg of draft.tracks[0].segments) {
        expect(videoMatIds.has(seg.material_id)).toBe(true);
      }
      // 检查 BGM segments
      for (const seg of draft.tracks[1].segments) {
        expect(audioMatIds.has(seg.material_id)).toBe(true);
      }
      // 检查 TTS segments
      for (const seg of draft.tracks[2].segments) {
        expect(audioMatIds.has(seg.material_id)).toBe(true);
      }
      // 检查 text segments
      for (const seg of draft.tracks[3].segments) {
        expect(textMatIds.has(seg.material_id)).toBe(true);
      }
    });

    it('video segment 的 source_timerange 应使用 chunkData 的毫秒时间戳', () => {
      const input = loadFixture();
      const shots = JianyingExportService.buildCompileShots(input);
      const draft = JianyingExportService.compileDraft(shots, input.mediaPath!) as any;

      const seg0 = draft.tracks[0].segments[0];
      // s_01: chunkData.startMs = 212966.7 → 212966700 us
      expect(seg0.source_timerange.start).toBe(Math.round(212966.7 * 1000));
    });

    it('前 21 段 video segment 的 source 路径应为源视频', () => {
      const input = loadFixture();
      const shots = JianyingExportService.buildCompileShots(input);
      const draft = JianyingExportService.compileDraft(shots, input.mediaPath!) as any;

      for (let i = 0; i < 21; i++) {
        const mat = draft.materials.videos[i];
        expect(mat.path).toContain('8月6日无字幕测试视频.mp4');
      }
    });

    it('后 5 段 video segment 的 source 路径应回退到主 mediaPath', () => {
      const input = loadFixture();
      const shots = JianyingExportService.buildCompileShots(input);
      const draft = JianyingExportService.compileDraft(shots, input.mediaPath!) as any;

      // s_22 ~ s_26 无 chunkData，回退到 mediaPath
      for (let i = 21; i < 26; i++) {
        const mat = draft.materials.videos[i];
        expect(mat.path).toBe(input.mediaPath!.replace(/\\/g, '/'));
      }
    });

    it('TTS 音频路径应正确脱去 magic:// 协议', () => {
      const input = loadFixture();
      const shots = JianyingExportService.buildCompileShots(input);
      const draft = JianyingExportService.compileDraft(shots, input.mediaPath!) as any;

      for (const audioMat of draft.materials.audios) {
        // BGM 和 TTS 的 path 都不应包含 magic://
        expect(audioMat.path).not.toContain('magic://');
      }
    });

    it('text material content 应为合法 JSON 字符串', () => {
      const input = loadFixture();
      const shots = JianyingExportService.buildCompileShots(input);
      const draft = JianyingExportService.compileDraft(shots, input.mediaPath!) as any;

      for (const textMat of draft.materials.texts) {
        expect(typeof textMat.content).toBe('string');
        const parsed = JSON.parse(textMat.content);
        expect(parsed).toHaveProperty('text');
        expect(parsed).toHaveProperty('styles');
        expect(parsed.styles[0]).toHaveProperty('fill');
        expect(parsed.styles[0]).toHaveProperty('range');
      }
    });

    it('draft version 应为 360000', () => {
      const input = loadFixture();
      const shots = JianyingExportService.buildCompileShots(input);
      const draft = JianyingExportService.compileDraft(shots, input.mediaPath!) as any;

      expect(draft.version).toBe(360000);
    });

    it('canvas_config 应为 1920x1080', () => {
      const input = loadFixture();
      const shots = JianyingExportService.buildCompileShots(input);
      const draft = JianyingExportService.compileDraft(shots, input.mediaPath!) as any;

      expect(draft.canvas_config.width).toBe(1920);
      expect(draft.canvas_config.height).toBe(1080);
    });

    it('platform 信息应标记为 5.9.0', () => {
      const input = loadFixture();
      const shots = JianyingExportService.buildCompileShots(input);
      const draft = JianyingExportService.compileDraft(shots, input.mediaPath!) as any;

      expect(draft.platform.app_version).toBe('5.9.0');
      expect(draft.platform.os).toBe('windows');
    });

    // ==================== 三修复新增断言：canvases 非空、video width>0、素材字段齐全 ====================

    it('materials 四个支撑容器（canvases/speeds/sound_channel_mappings/vocal_separations）应全部非空', () => {
      const input = loadFixture();
      const shots = JianyingExportService.buildCompileShots(input);
      const draft = JianyingExportService.compileDraft(shots, input.mediaPath!, input.bgmPath) as any;
      const m = draft.materials;

      // 手册 §4.2：全部 7 个"非空"键不能是空数组
      expect(Array.isArray(m.canvases)).toBe(true);
      expect(m.canvases.length).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(m.speeds)).toBe(true);
      expect(m.speeds.length).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(m.sound_channel_mappings)).toBe(true);
      expect(m.sound_channel_mappings.length).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(m.vocal_separations)).toBe(true);
      expect(m.vocal_separations.length).toBeGreaterThanOrEqual(1);
    });

    it('video material 的 width/height 应为 ffprobe 真实值（>0，非硬编码 0）', () => {
      const input = loadFixture();
      const shots = JianyingExportService.buildCompileShots(input);
      const draft = JianyingExportService.compileDraft(shots, input.mediaPath!) as any;

      for (const videoMat of draft.materials.videos) {
        expect(typeof videoMat.width).toBe('number');
        expect(typeof videoMat.height).toBe('number');
        // 修复前：width=0 / height=0 → 素材面板空白
        expect(videoMat.width).toBeGreaterThan(0);
        expect(videoMat.height).toBeGreaterThan(0);
        // mock ffprobe 返回 1920x1080
        expect(videoMat.width).toBe(1920);
        expect(videoMat.height).toBe(1080);
      }
    });

    it('video/audio/text 三类素材应包含手册要求的 check_flag / crop / type 等核心字段', () => {
      const input = loadFixture();
      const shots = JianyingExportService.buildCompileShots(input);
      const draft = JianyingExportService.compileDraft(shots, input.mediaPath!, input.bgmPath) as any;

      // Video：§4.3 共 54 字段，核心字段不能缺
      for (const vm of draft.materials.videos) {
        expect(vm).toHaveProperty('id');
        expect(vm).toHaveProperty('material_id');
        expect(vm).toHaveProperty('type', 'video');
        expect(vm).toHaveProperty('category_name', 'local');
        expect(vm).toHaveProperty('check_flag', 63487);
        expect(vm).toHaveProperty('path');
        expect(vm).toHaveProperty('duration');
        expect(vm).toHaveProperty('has_audio');
        expect(vm).toHaveProperty('crop');
        expect(vm.crop).toHaveProperty('upper_left_x');
        expect(vm).toHaveProperty('matting');
        expect(vm).toHaveProperty('stable');
        expect(vm).toHaveProperty('video_algorithm');
      }

      // Audio：§4.4 check_flag=3，三 ID 对齐
      for (const am of draft.materials.audios) {
        expect(am).toHaveProperty('id');
        expect(am).toHaveProperty('local_material_id');
        expect(am).toHaveProperty('music_id');
        expect(am.id).toBe(am.local_material_id); // §4.4 三 ID 一致
        expect(am.id).toBe(am.music_id);
        expect(am).toHaveProperty('check_flag', 3);
        expect(am).toHaveProperty('type');
        expect(['music', 'extract_music']).toContain(am.type);
        expect(am).toHaveProperty('path');
        expect(am).toHaveProperty('duration');
      }

      // Text：§4.5 check_flag=7 + caption_template_info
      for (const tm of draft.materials.texts) {
        expect(tm).toHaveProperty('id');
        expect(tm).toHaveProperty('local_material_id');
        expect(tm).toHaveProperty('type', 'text');
        expect(tm).toHaveProperty('check_flag', 7);
        expect(tm).toHaveProperty('content');
        expect(tm).toHaveProperty('font_size');
        expect(tm).toHaveProperty('alignment');
        expect(tm).toHaveProperty('words');
        expect(tm).toHaveProperty('caption_template_info');
        expect(tm.words).toHaveProperty('start_time');
        expect(tm.words).toHaveProperty('end_time');
        expect(tm.words).toHaveProperty('text');
      }
    });

    it('canvas material 的尺寸应为 1920x1080（画布占位）', () => {
      const input = loadFixture();
      const shots = JianyingExportService.buildCompileShots(input);
      const draft = JianyingExportService.compileDraft(shots, input.mediaPath!) as any;

      const canvas = draft.materials.canvases[0];
      expect(canvas.type).toBe('canvas');
      expect(canvas.width).toBe(1920);
      expect(canvas.height).toBe(1080);
      expect(canvas.check_flag).toBe(63487);
    });

    it('speed material 的数量应与 video segment 数一致（每段一条，speed=1.0 也有）', () => {
      const input = loadFixture();
      const shots = JianyingExportService.buildCompileShots(input);
      const draft = JianyingExportService.compileDraft(shots, input.mediaPath!) as any;

      // 26 段视频 → 26 条 speed 素材，保证 speeds 容器非空
      expect(draft.materials.speeds).toHaveLength(26);
      for (const sp of draft.materials.speeds) {
        expect(sp).toHaveProperty('material_id');
        expect(sp).toHaveProperty('speed');
        expect(sp).toHaveProperty('duration');
      }
    });

    it('video material 的 has_audio 应为 ffprobe 返回值（true）', () => {
      const input = loadFixture();
      const shots = JianyingExportService.buildCompileShots(input);
      const draft = JianyingExportService.compileDraft(shots, input.mediaPath!) as any;

      for (const vm of draft.materials.videos) {
        expect(typeof vm.has_audio).toBe('boolean');
        expect(vm.has_audio).toBe(true); // mock ffprobe 返回有 aac 音轨
      }
    });
  });

  // ==================== export (full flow) ====================

  describe('export - full flow with real data', () => {
    it('应成功导出并写入 5 个文件', async () => {
      const input = loadFixture();

      const result = await JianyingExportService.export(
        input,
        'C:/fake/jianying/drafts',
      );

      expect(result.filePath).toContain('Z_');
      // 5 个文件：draft_content + meta_info + meta + key_value + virtual_store
      expect(mockFsWriteFileSync).toHaveBeenCalledTimes(5);

      const writePaths = mockFsWriteFileSync.mock.calls.map((c: any) => c[0] as string);
      expect(writePaths.some(p => p.endsWith('draft_content.json'))).toBe(true);
      expect(writePaths.some(p => p.endsWith('draft_meta_info.json'))).toBe(true);
      expect(writePaths.some(p => p.endsWith('draft_meta.json'))).toBe(true);
      expect(writePaths.some(p => p.endsWith('key_value.json'))).toBe(true);
      expect(writePaths.some(p => p.endsWith('draft_virtual_store.json'))).toBe(true);
    });

    it('draft_content.json 应包含 26 个 video segment 和 26 个 TTS segment', async () => {
      const input = loadFixture();

      await JianyingExportService.export(input, 'C:/fake/jianying/drafts');

      const contentCall = mockFsWriteFileSync.mock.calls.find(
        (c: any) => String(c[0]).endsWith('draft_content.json'),
      );
      expect(contentCall).toBeDefined();
      const draft = JSON.parse(contentCall![1] as string);

      expect(draft.tracks[0].segments).toHaveLength(26); // video
      expect(draft.tracks[2].segments).toHaveLength(26); // TTS
      expect(draft.tracks[3].segments).toHaveLength(26); // text
    });

    it('draft_meta_info.json 应包含正确的 draft_fold_path 和 draft_root_path', async () => {
      const input = loadFixture();

      await JianyingExportService.export(input, 'C:/fake/jianying/drafts');

      const metaCall = mockFsWriteFileSync.mock.calls.find(
        (c: any) => String(c[0]).endsWith('draft_meta_info.json'),
      );
      expect(metaCall).toBeDefined();
      const meta = JSON.parse(metaCall![1] as string);

      expect(meta.draft_fold_path).toContain('Z_');
      expect(meta.draft_root_path).toBe('C:/fake/jianying/drafts');
      expect(meta).toHaveProperty('draft_id');
      expect(meta).toHaveProperty('draft_name');
    });
  });

  // ==================== 边界情况 ====================

  describe('edge cases with real data', () => {
    it('无 BGM 时应生成 4 轨道但 BGM 轨道无 segment', () => {
      const input = loadFixture();
      const shots = JianyingExportService.buildCompileShots(input);
      const draft = JianyingExportService.compileDraft(shots, input.mediaPath!) as any;

      expect(draft.tracks).toHaveLength(4);
      expect(draft.tracks[1].segments).toHaveLength(0); // BGM 为空
    });

    it('scriptParagraphs 比 matchResults 多时，多出段仍正常编译', () => {
      const input = loadFixture();
      const shots = JianyingExportService.buildCompileShots(input);

      // 26 段文案，21 个 matchResult → 5 段无视频切片
      const noChunkShots = shots.filter(s => !s.chunkData);
      expect(noChunkShots).toHaveLength(5);

      // 无切片的段仍应有文本和音频
      for (const s of noChunkShots) {
        expect(s.text).toBeTruthy();
        expect(s.audioPath).toBeTruthy();
      }
    });

    it('所有 segment id 应为 32 位十六进制', () => {
      const input = loadFixture();
      const shots = JianyingExportService.buildCompileShots(input);
      const draft = JianyingExportService.compileDraft(shots, input.mediaPath!) as any;

      const allSegs = draft.tracks.flatMap((t: any) => t.segments);
      for (const seg of allSegs) {
        expect(seg.id).toMatch(/^[0-9a-f]{32}$/);
      }
    });

    it('所有 track id 应为 32 位十六进制', () => {
      const input = loadFixture();
      const shots = JianyingExportService.buildCompileShots(input);
      const draft = JianyingExportService.compileDraft(shots, input.mediaPath!) as any;

      for (const track of draft.tracks) {
        expect(track.id).toMatch(/^[0-9a-f]{32}$/);
      }
    });

    it('draft 顶层 id 应为 UUID 大写格式', () => {
      const input = loadFixture();
      const shots = JianyingExportService.buildCompileShots(input);
      const draft = JianyingExportService.compileDraft(shots, input.mediaPath!) as any;

      expect(draft.id).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
    });
  });
});


