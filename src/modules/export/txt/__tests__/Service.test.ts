// Module: export/txt - Service 单元测试

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
import { TxtExportService } from '../backend/Service';
import type { ScriptParagraph } from '../types';

describe('TxtExportService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFsExistsSync.mockReturnValue(true);
    mockFsMkdirSync.mockImplementation(() => undefined);
    mockFsWriteFileSync.mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==================== compile ====================

  describe('compile', () => {
    it('空列表应返回空字符串', () => {
      const result = TxtExportService.compile([]);
      expect(result).toBe('');
    });

    it('单段文案应直接输出文本（无多余空行）', () => {
      const paragraphs: ScriptParagraph[] = [
        { id: 'p1', text: '欢迎使用 Zentect', editing: false },
      ];

      const result = TxtExportService.compile(paragraphs);
      expect(result).toBe('欢迎使用 Zentect');
    });

    it('多段文案应以空行分隔', () => {
      const paragraphs: ScriptParagraph[] = [
        { id: 'p1', text: '第一段', editing: false },
        { id: 'p2', text: '第二段', editing: false },
        { id: 'p3', text: '第三段', editing: false },
      ];

      const result = TxtExportService.compile(paragraphs);
      // 预期：第一段\n\n第二段\n\n第三段（最后一段后无空行）
      expect(result).toBe('第一段\n\n第二段\n\n第三段');
    });

    it('空文本或纯空白段落应跳过', () => {
      const paragraphs: ScriptParagraph[] = [
        { id: 'p1', text: '', editing: false },
        { id: 'p2', text: '   ', editing: false },
        { id: 'p3', text: '有效段落', editing: false },
        { id: 'p4', text: '\t', editing: false },
      ];

      const result = TxtExportService.compile(paragraphs);
      // 只有 "有效段落" 应该输出，但尾部空段导致 trailing newline
      expect(result).toBe('有效段落\n');
    });

    it('带前后空白的文本应被 trim', () => {
      const paragraphs: ScriptParagraph[] = [
        { id: 'p1', text: '  修剪前   ', editing: false },
        { id: 'p2', text: '\t制表符\t', editing: false },
      ];

      const result = TxtExportService.compile(paragraphs);
      expect(result).toBe('修剪前\n\n制表符');
    });

    it('emoji 和特殊字符应正常保留', () => {
      const paragraphs: ScriptParagraph[] = [
        { id: 'p1', text: '🎬 视频开场！', editing: false },
        { id: 'p2', text: 'Hello 你好 こんにちは', editing: false },
      ];

      const result = TxtExportService.compile(paragraphs);
      expect(result).toBe('🎬 视频开场！\n\nHello 你好 こんにちは');
    });

    it('混合空段落和有效段落应正确处理', () => {
      const paragraphs: ScriptParagraph[] = [
        { id: 'p1', text: '第一段', editing: false },
        { id: 'p2', text: '', editing: false },
        { id: 'p3', text: '第三段', editing: false },
      ];

      const result = TxtExportService.compile(paragraphs);
      // 空段 p2 被跳过，p1 和 p3 之间一个空行
      expect(result).toBe('第一段\n\n第三段');
    });

    it('全部为空段落应返回空字符串', () => {
      const paragraphs: ScriptParagraph[] = [
        { id: 'p1', text: '', editing: false },
        { id: 'p2', text: '   ', editing: false },
      ];

      const result = TxtExportService.compile(paragraphs);
      expect(result).toBe('');
    });
  });

  // ==================== export ====================

  describe('export', () => {
    const sampleParagraphs: ScriptParagraph[] = [
      { id: 'p1', text: '测试文案', editing: false },
    ];

    it('应调用 compile 并写入文件（UTF-8 编码）', () => {
      const outputPath = 'C:/output/narration.txt';
      const input = { scriptParagraphs: sampleParagraphs, outputPath };

      const result = TxtExportService.export(input);

      expect(mockFsWriteFileSync).toHaveBeenCalledTimes(1);
      const writeCall = mockFsWriteFileSync.mock.calls[0];
      expect(writeCall[0]).toBe(outputPath);
      expect(writeCall[1]).toBe('测试文案');
      expect(writeCall[2]).toBe('utf-8');
      expect(result).toBe(outputPath);
    });

    it('输出目录不存在时应自动创建（递归）', () => {
      mockFsExistsSync.mockImplementation((p: string) => p !== 'C:/newdir');

      TxtExportService.export({
        scriptParagraphs: sampleParagraphs,
        outputPath: 'C:/newdir/script.txt',
      });

      expect(mockFsMkdirSync).toHaveBeenCalledWith('C:/newdir', { recursive: true });
    });

    it('输出目录已存在时不应重复创建', () => {
      mockFsExistsSync.mockReturnValue(true);

      TxtExportService.export({
        scriptParagraphs: sampleParagraphs,
        outputPath: 'C:/output/script.txt',
      });

      const mkdirCall = mockFsMkdirSync.mock.calls.find(
        (c: any) => String(c[0]) === 'C:/output',
      );
      expect(mkdirCall).toBeUndefined();
    });

    it('多段落应写入完整的编译结果', () => {
      const paragraphs: ScriptParagraph[] = [
        { id: 'p1', text: '第一段', editing: false },
        { id: 'p2', text: '第二段', editing: false },
      ];

      TxtExportService.export({
        scriptParagraphs: paragraphs,
        outputPath: 'C:/output/script.txt',
      });

      const writeCall = mockFsWriteFileSync.mock.calls[0];
      expect(writeCall[1]).toBe('第一段\n\n第二段');
    });
  });
});
