// 📁 路径：src/modules/export/srt/backend/Service.ts
// SRT 字幕导出服务：根据台词时间戳生成标准 SRT 格式字幕（§3.6.2）
//
// SRT 格式规范：
//   序号
//   HH:MM:SS,mmm --> HH:MM:SS,mmm
//   台词文本
//   （空行）
//
// 编码：UTF-8

import * as fs from 'fs';
import type { SrtExportInput, AsrLine } from '../types';

// ──────────────────────────────────────────────
// 服务实现
// ──────────────────────────────────────────────

export class SrtExportService {
  /**
   * 将 "MM:SS" 或 "HH:MM:SS" 格式转为 "HH:MM:SS,000"
   */
  private static normalizeTimestamp(raw: string): string {
    const parts = raw.trim().split(':').map(Number);

    if (parts.length === 2) {
      // "MM:SS" → "00:MM:SS,000"
      const [m, s] = parts;
      return `${String(Math.floor(m)).padStart(2, '0')}:${String(Math.floor(s)).padStart(2, '0')},000`;
    }

    if (parts.length === 3) {
      // "HH:MM:SS" → "HH:MM:SS,000"
      const [h, m, s] = parts;
      return `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor(m)).padStart(2, '0')}:${String(Math.floor(s)).padStart(2, '0')},000`;
    }

    // fallback: 无法解析时返回原始值
    return raw;
  }

  /**
   * 将 AsrLine[] 编译为 SRT 字符串
   */
  static compile(asrLines: AsrLine[]): string {
    const blocks: string[] = [];

    for (let i = 0; i < asrLines.length; i++) {
      const line = asrLines[i];
      const start = SrtExportService.normalizeTimestamp(line.start);

      // end 为空时，使用下一行的 start，最后一行默认 +3 秒
      let end: string;
      if (line.end) {
        end = SrtExportService.normalizeTimestamp(line.end);
      } else if (i + 1 < asrLines.length) {
        end = SrtExportService.normalizeTimestamp(asrLines[i + 1].start);
      } else {
        // 最后一行：start + 3 秒
        end = SrtExportService.normalizeTimestamp(
          this.addSeconds(line.start, 3),
        );
      }

      blocks.push(
        `${i + 1}`,
        `${start} --> ${end}`,
        line.text || '',
        '', // 空行分隔
      );
    }

    return blocks.join('\n');
  }

  /**
   * "MM:SS" 格式加 N 秒
   */
  private static addSeconds(timestamp: string, seconds: number): string {
    const parts = timestamp.trim().split(':').map(Number);
    if (parts.length === 2) {
      const totalSec = parts[0] * 60 + parts[1] + seconds;
      const m = Math.floor(totalSec / 60);
      const s = totalSec % 60;
      return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    if (parts.length === 3) {
      const totalSec =
        parts[0] * 3600 + parts[1] * 60 + parts[2] + seconds;
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const s = totalSec % 60;
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return timestamp;
  }

  /**
   * 完整导出流程：编译 SRT → 写入文件
   */
  static export(input: SrtExportInput): string {
    const srtContent = SrtExportService.compile(input.asrLines);

    // 确保输出目录存在
    const dir = require('path').dirname(input.outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(input.outputPath, srtContent, 'utf-8');
    return input.outputPath;
  }
}
