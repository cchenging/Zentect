// Module: export/txt - Types 单元测试

import { describe, it, expect } from 'vitest';
import type { ScriptParagraph, TxtExportInput } from '../types';

describe('TXT Export Types', () => {
  describe('ScriptParagraph', () => {
    it('应包含必填字段 id、text 和 editing', () => {
      const p: ScriptParagraph = {
        id: 'para-001',
        text: '欢迎使用 Zentect',
        editing: false,
      };

      expect(p.id).toBe('para-001');
      expect(p.text).toBe('欢迎使用 Zentect');
      expect(p.editing).toBe(false);
    });

    it('shotId 字段可选', () => {
      const withShot: ScriptParagraph = {
        id: 'para-002',
        shotId: 'shot-a',
        text: '关联镜头',
        editing: false,
      };
      expect(withShot.shotId).toBe('shot-a');

      const withoutShot: ScriptParagraph = {
        id: 'para-003',
        text: '无关联镜头',
        editing: false,
      };
      expect(withoutShot.shotId).toBeUndefined();
    });

    it('支持 duration 和 emotion 字段', () => {
      const p: ScriptParagraph = {
        id: 'para-004',
        text: '充满激情的解说',
        duration: 8.5,
        emotion: '激情',
        editing: false,
      };

      expect(p.duration).toBe(8.5);
      expect(p.emotion).toBe('激情');
    });

    it('editing 为 true 表示正在编辑', () => {
      const p: ScriptParagraph = {
        id: 'para-005',
        text: '编辑中',
        editing: true,
      };

      expect(p.editing).toBe(true);
    });
  });

  describe('TxtExportInput', () => {
    it('应包含 scriptParagraphs 和 outputPath', () => {
      const input: TxtExportInput = {
        scriptParagraphs: [
          { id: 'p1', text: '第一段', editing: false },
          { id: 'p2', text: '第二段', editing: false },
          { id: 'p3', text: '第三段', editing: false },
        ],
        outputPath: 'C:/output/script.txt',
      };

      expect(input.scriptParagraphs).toHaveLength(3);
      expect(input.outputPath).toBe('C:/output/script.txt');
    });

    it('outputPath 应以 .txt 结尾', () => {
      const input: TxtExportInput = {
        scriptParagraphs: [],
        outputPath: 'D:/docs/narration.txt',
      };

      expect(input.outputPath.endsWith('.txt')).toBe(true);
    });
  });
});
