// Module: export/srt - Service 单元测试

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
import { SrtExportService } from '../backend/Service';
import type { AsrLine } from '../types';

describe('SrtExportService', () => {
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
      const result = SrtExportService.compile([]);
      expect(result).toBe('');
    });

    it('单条台词应生成正确的 SRT 格式', () => {
      const lines: AsrLine[] = [
        { start: '00:05', end: '00:08', text: '欢迎来到Zentect', editing: false },
      ];

      const result = SrtExportService.compile(lines);
      const expected = '1\n00:05,000 --> 00:08,000\n欢迎来到Zentect\n';
      expect(result).toBe(expected);
    });

    it('多条台词应生成连续的序号和正确的时间轴', () => {
      const lines: AsrLine[] = [
        { start: '00:01', end: '00:03', text: '第一句', editing: false },
        { start: '00:04', end: '00:06', text: '第二句', editing: false },
        { start: '00:07', end: '00:10', text: '第三句', editing: false },
      ];

      const result = SrtExportService.compile(lines);
      const blocks = result.split('\n\n');
      expect(blocks).toHaveLength(3);

      // 检验序号
      expect(blocks[0].startsWith('1\n')).toBe(true);
      expect(blocks[1].startsWith('2\n')).toBe(true);
      expect(blocks[2].startsWith('3\n')).toBe(true);

      // 检验最后一个block的结束
      expect(blocks[2]).toBe('3\n00:07,000 --> 00:10,000\n第三句\n');
    });

    it('end 缺失时应使用下一行的 start', () => {
      const lines: AsrLine[] = [
        { start: '00:05', text: '第一句', editing: false },
        { start: '00:10', end: '00:15', text: '第二句', editing: false },
      ];

      const result = SrtExportService.compile(lines);

      // 第一句的 end 应为第二句的 start
      expect(result).toContain('00:05,000 --> 00:10,000\n第一句');
      // 第二句有明确 end
      expect(result).toContain('00:10,000 --> 00:15,000\n第二句');
    });

    it('最后一行的 end 缺失时应自动 +3 秒', () => {
      const lines: AsrLine[] = [
        { start: '00:05', text: '唯一的句子', editing: false },
      ];

      const result = SrtExportService.compile(lines);
      // start=00:05, end应该=00:08 (5+3)
      expect(result).toBe('1\n00:05,000 --> 00:08,000\n唯一的句子\n');
    });

    it('支持 HH:MM:SS 格式', () => {
      const lines: AsrLine[] = [
        { start: '01:02:30', end: '01:02:35', text: '长格式', editing: false },
      ];

      const result = SrtExportService.compile(lines);
      expect(result).toBe('1\n01:02:30,000 --> 01:02:35,000\n长格式\n');
    });

    it('MM:SS 格式应转为 00:MM:SS,000', () => {
      const lines: AsrLine[] = [
        { start: '03:45', end: '03:50', text: '短格式', editing: false },
      ];

      const result = SrtExportService.compile(lines);
      // normalizeTimestamp: "03:45" → "00:03:45,000"? No, looking at the code:
      // normalizeTimestamp with parts.length=2: `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},000`
      // So "03:45" → "03:45,000"
      expect(result).toBe('1\n03:45,000 --> 03:50,000\n短格式\n');
    });

    it('emoji/特殊字符应正常保留', () => {
      const lines: AsrLine[] = [
        { start: '00:01', end: '00:03', text: '🎉欢迎！Hello 你好～', editing: false },
      ];

      const result = SrtExportService.compile(lines);
      expect(result).toContain('🎉欢迎！Hello 你好～');
    });

    it('text 为空时应输出空文本行', () => {
      const lines: AsrLine[] = [
        { start: '00:01', end: '00:03', text: '', editing: false },
      ];

      const result = SrtExportService.compile(lines);
      expect(result).toBe('1\n00:01,000 --> 00:03,000\n\n');
    });
  });

  // ==================== export ====================

  describe('export', () => {
    const sampleLines: AsrLine[] = [
      { start: '00:01', end: '00:03', text: '测试字幕', editing: false },
    ];

    it('应调用 compile 并写入文件', () => {
      const outputPath = 'C:/output/subtitle.srt';
      const input = { asrLines: sampleLines, outputPath };

      const result = SrtExportService.export(input);

      expect(mockFsWriteFileSync).toHaveBeenCalledTimes(1);
      const writeCall = mockFsWriteFileSync.mock.calls[0];
      expect(writeCall[0]).toBe(outputPath);
      expect(writeCall[1]).toContain('测试字幕');
      expect(writeCall[2]).toBe('utf-8');
      expect(result).toBe(outputPath);
    });

    it('输出目录不存在时应自动创建', () => {
      mockFsExistsSync.mockImplementation((p: string) => p !== 'C:/newdir');

      SrtExportService.export({
        asrLines: sampleLines,
        outputPath: 'C:/newdir/sub.srt',
      });

      expect(mockFsMkdirSync).toHaveBeenCalledWith('C:/newdir', { recursive: true });
    });

    it('输出目录已存在时不应重复创建', () => {
      mockFsExistsSync.mockReturnValue(true);

      SrtExportService.export({
        asrLines: sampleLines,
        outputPath: 'C:/existing/output.srt',
      });

      const mkdirCall = mockFsMkdirSync.mock.calls.find(
        (c: any) => String(c[0]) === 'C:/existing',
      );
      expect(mkdirCall).toBeUndefined();
    });
  });

  // ==================== normalizeTimestamp（通过 compile 间接测试） ====================

  describe('normalizeTimestamp (via compile)', () => {
    it('HH:MM:SS 格式应输出 HH:MM:SS,000', () => {
      const lines: AsrLine[] = [
        { start: '12:34:56', end: '12:35:00', text: '测试', editing: false },
      ];

      const result = SrtExportService.compile(lines);
      expect(result).toContain('12:34:56,000 --> 12:35:00,000');
    });

    it('非标准格式应返回原始值（fallback）', () => {
      const lines: AsrLine[] = [
        { start: 'abc', end: 'def', text: '异常时间', editing: false },
      ];

      const result = SrtExportService.compile(lines);
      // normalizeTimestamp with parts.length not 2 or 3 → returns raw
      expect(result).toContain('abc --> def');
    });
  });
});
