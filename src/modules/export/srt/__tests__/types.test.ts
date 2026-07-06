// Module: export/srt - Types 单元测试

import { describe, it, expect } from 'vitest';
import type { AsrLine, SrtExportInput } from '../types';

describe('SRT Export Types', () => {
  describe('AsrLine', () => {
    it('应包含必填字段 start、text 和 editing', () => {
      const line: AsrLine = {
        start: '00:05',
        text: '这是一条台词',
        editing: false,
      };

      expect(line.start).toBe('00:05');
      expect(line.text).toBe('这是一条台词');
      expect(line.editing).toBe(false);
    });

    it('end 字段可选', () => {
      const withEnd: AsrLine = {
        start: '00:10',
        end: '00:15',
        text: '有结束时间',
        editing: false,
      };
      expect(withEnd.end).toBe('00:15');

      const withoutEnd: AsrLine = {
        start: '00:20',
        text: '无结束时间',
        editing: false,
      };
      expect(withoutEnd.end).toBeUndefined();
    });

    it('支持 HH:MM:SS 格式', () => {
      const line: AsrLine = {
        start: '01:02:30',
        end: '01:02:35',
        text: '长格式时间',
        editing: false,
      };

      expect(line.start).toBe('01:02:30');
      expect(line.end).toBe('01:02:35');
    });

    it('originalText 字段可选', () => {
      const line: AsrLine = {
        start: '00:30',
        text: '修正后文本',
        originalText: '原始识别文本',
        editing: false,
      };

      expect(line.originalText).toBe('原始识别文本');
    });

    it('editing 为 true 表示正在编辑', () => {
      const line: AsrLine = {
        start: '00:45',
        text: '编辑中',
        editing: true,
      };

      expect(line.editing).toBe(true);
    });
  });

  describe('SrtExportInput', () => {
    it('应包含 asrLines 和 outputPath', () => {
      const input: SrtExportInput = {
        asrLines: [
          { start: '00:01', text: '第一句', editing: false },
          { start: '00:03', text: '第二句', editing: false },
        ],
        outputPath: 'C:/output/subtitle.srt',
      };

      expect(input.asrLines).toHaveLength(2);
      expect(input.outputPath).toBe('C:/output/subtitle.srt');
    });

    it('outputPath 应以 .srt 结尾', () => {
      const input: SrtExportInput = {
        asrLines: [],
        outputPath: 'D:/videos/output.srt',
      };

      expect(input.outputPath.endsWith('.srt')).toBe(true);
    });
  });
});
