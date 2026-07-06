// Module: export/jianying - Types 单元测试

import { describe, it, expect } from 'vitest';
import type { JianyingExportInput, JianyingExportOutput, CompileShot } from '../types';

describe('Jianying Export Types', () => {
  describe('JianyingExportInput', () => {
    it('应包含所有必填字段', () => {
      const input: JianyingExportInput = {
        projectId: 'proj-001',
        matchResults: [
          {
            shotId: 'shot-1',
            mediaId: 'media-1',
            score: 0.95,
            confirmed: true,
          },
        ],
        ttsResults: [
          {
            shotId: 'shot-1',
            audioUrl: 'C:/output/shot-1.mp3',
          },
        ],
        scriptParagraphs: [
          {
            id: 'para-1',
            shotId: 'shot-1',
            text: '欢迎来到Zentect',
            editing: false,
          },
        ],
        bgmPath: 'C:/music/bgm.mp3',
        outputDir: 'C:/output',
      };

      expect(input.projectId).toBe('proj-001');
      expect(input.matchResults).toHaveLength(1);
      expect(input.ttsResults).toHaveLength(1);
      expect(input.scriptParagraphs).toHaveLength(1);
      expect(input.bgmPath).toBe('C:/music/bgm.mp3');
      expect(input.outputDir).toBe('C:/output');
    });

    it('matchResults 支持完整的 MatchResultItem 字段', () => {
      const input: JianyingExportInput = {
        projectId: 'proj-002',
        matchResults: [
          {
            shotId: 'shot-2',
            mediaId: 'media-2',
            thumbnail: 'C:/thumbs/shot-2.jpg',
            score: 0.88,
            confirmed: true,
            appliedSpeedFactor: 1.2,
            audioDurationMs: 5000,
            chunkData: { startMs: 0, endMs: 10000 },
          },
        ],
        ttsResults: [],
        scriptParagraphs: [],
        outputDir: 'C:/output',
      };

      const mr = input.matchResults[0];
      expect(mr.thumbnail).toBe('C:/thumbs/shot-2.jpg');
      expect(mr.appliedSpeedFactor).toBe(1.2);
      expect(mr.audioDurationMs).toBe(5000);
      expect(mr.chunkData).toBeDefined();
    });

    it('ttsResults 支持 _failed 和 _error 字段', () => {
      const input: JianyingExportInput = {
        projectId: 'proj-003',
        matchResults: [],
        ttsResults: [
          { shotId: 'shot-3', _failed: true, _error: 'TTS服务超时' },
          { shotId: 'shot-4', audioUrl: 'C:/output/shot-4.mp3' },
        ],
        scriptParagraphs: [],
        outputDir: 'C:/output',
      };

      expect(input.ttsResults[0]._failed).toBe(true);
      expect(input.ttsResults[0]._error).toBe('TTS服务超时');
      expect(input.ttsResults[1]._failed).toBeUndefined();
    });

    it('bgmPath 可以为 undefined', () => {
      const input: JianyingExportInput = {
        projectId: 'proj-004',
        matchResults: [],
        ttsResults: [],
        scriptParagraphs: [],
        outputDir: 'C:/output',
      };

      expect(input.bgmPath).toBeUndefined();
    });
  });

  describe('JianyingExportOutput', () => {
    it('应包含 filePath 和 fileName', () => {
      const output: JianyingExportOutput = {
        filePath: 'C:/Jianying/JianyingPro Drafts/Zentect_123456',
        fileName: 'Zentect_123456',
      };

      expect(output.filePath).toContain('Zentect_');
      expect(output.fileName).toContain('Zentect_');
    });
  });

  describe('CompileShot', () => {
    it('应兼容基础 Shot 结构', () => {
      const shot: CompileShot = {
        id: 'shot-a',
        mediaId: 'media-a',
        imagePath: 'C:/media/img.jpg',
        text: '测试文案',
        originalText: '原始识别文本',
        start: 0,
        end: 5,
        duration: 5,
        audioDuration: 5,
        aiText: 'AI修正文本',
        audioPath: 'C:/audio/shot-a.mp3',
      };

      expect(shot.id).toBe('shot-a');
      expect(shot.start).toBe(0);
      expect(shot.end).toBe(5);
      expect(shot.duration).toBe(5);
      expect(shot.aiText).toBe('AI修正文本');
      expect(shot.audioPath).toContain('.mp3');
    });
  });
});
