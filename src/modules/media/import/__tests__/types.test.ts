// Module: media/import - Types 单元测试

import { describe, it, expect } from 'vitest';
import type { ImportInput, ImportOutput, MediaItem, MediaRow } from '../types';

describe('Media Import Types', () => {
  describe('MediaItem', () => {
    it('视频类型 MediaItem 应包含所有必填字段', () => {
      const item: MediaItem = {
        id: 'media_001',
        type: 'video',
        filePath: 'C:/media/video.mp4',
        status: 'importing',
      };
      expect(item.id).toBe('media_001');
      expect(item.type).toBe('video');
      expect(item.filePath).toBeTruthy();
      expect(item.status).toBe('importing');
    });

    it('音频类型 MediaItem 应为合法结构', () => {
      const item: MediaItem = {
        id: 'media_002',
        type: 'audio',
        filePath: 'C:/media/bgm.mp3',
        name: '背景音乐',
        duration: '00:03:45',
        status: 'parsed',
      };
      expect(item.type).toBe('audio');
      expect(item.name).toBe('背景音乐');
      expect(item.duration).toBe('00:03:45');
    });

    it('frame 类型 MediaItem 应为合法结构', () => {
      const item: MediaItem = {
        id: 'media_003',
        type: 'frame',
        filePath: 'C:/media/frame.png',
        width: 1920,
        height: 1080,
        fps: 30,
        status: 'parsed',
      };
      expect(item.type).toBe('frame');
      expect(item.width).toBe(1920);
      expect(item.height).toBe(1080);
      expect(item.fps).toBe(30);
    });

    it('status 仅接受 importing / parsed / transcoding', () => {
      const statuses: MediaItem['status'][] = ['importing', 'parsed', 'transcoding'];
      expect(statuses).toHaveLength(3);
      expect(new Set(statuses).size).toBe(3);
    });

    it('type 仅接受 video / audio / frame / video_chunk', () => {
      const types: MediaItem['type'][] = ['video', 'audio', 'frame', 'video_chunk'];
      expect(types).toHaveLength(4);
    });

    it('可选字段缺失时类型系统应接受', () => {
      const item: MediaItem = {
        id: 'minimal',
        type: 'video',
        filePath: '/path/to/file.mp4',
        status: 'importing',
      };
      expect(item.fileName).toBeUndefined();
      expect(item.name).toBeUndefined();
      expect(item.coverPath).toBeUndefined();
      expect(item.duration).toBeUndefined();
      expect(item.width).toBeUndefined();
      expect(item.height).toBeUndefined();
      expect(item.fps).toBeUndefined();
    });
  });

  describe('ImportInput', () => {
    it('应包含 projectId 和 filePaths', () => {
      const input: ImportInput = {
        projectId: 'proj_001',
        filePaths: ['C:/videos/a.mp4', 'C:/audio/b.mp3'],
      };
      expect(input.projectId).toBe('proj_001');
      expect(input.filePaths).toHaveLength(2);
    });

    it('空 filePaths 数组应为合法输入', () => {
      const input: ImportInput = {
        projectId: 'proj_empty',
        filePaths: [],
      };
      expect(input.filePaths).toHaveLength(0);
    });
  });

  describe('ImportOutput', () => {
    it('应包含 mediaItems 数组', () => {
      const output: ImportOutput = {
        mediaItems: [
          { id: 'm1', type: 'video', filePath: '/v.mp4', status: 'importing' },
        ],
      };
      expect(output.mediaItems).toHaveLength(1);
    });

    it('空导入结果 mediaItems 可为空数组', () => {
      const output: ImportOutput = {
        mediaItems: [],
      };
      expect(output.mediaItems).toHaveLength(0);
    });
  });

  describe('MediaRow', () => {
    it('应扩展 MediaItem，包含 projectId 和扩展字段', () => {
      const row: MediaRow = {
        id: 'media_row_001',
        projectId: 'proj_xyz',
        type: 'video',
        filePath: 'C:/media/clip.mp4',
        status: 'parsed',
        coverPath: 'thumbnails/cover.jpg',
        duration: '00:05:30',
        width: 1920,
        height: 1080,
        frames: ['frame_001', 'frame_002'],
        extractedAudio: 'audio/extracted.wav',
        extractedVocals: 'audio/vocals.wav',
        extractedBgm: 'audio/bgm.wav',
        extractedText: '字幕文本...',
        extractDuration: 15.5,
        narrationScript: { paragraphs: [] },
        createTime: '2026-07-05 10:00:00',
        updateTime: '2026-07-05 12:00:00',
      };
      expect(row.projectId).toBe('proj_xyz');
      expect(row.frames).toHaveLength(2);
      expect(row.extractDuration).toBe(15.5);
      expect(row.narrationScript).toEqual({ paragraphs: [] });
    });

    it('所有扩展字段可为 null/undefined', () => {
      const row: MediaRow = {
        id: 'min_row',
        projectId: 'p1',
        type: 'audio',
        filePath: '/a.mp3',
        status: 'importing',
      };
      expect(row.frames).toBeUndefined();
      expect(row.extractedAudio).toBeUndefined();
    });
  });
});
