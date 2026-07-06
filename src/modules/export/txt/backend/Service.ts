// 📁 路径：src/modules/export/txt/backend/Service.ts
// TXT 文案导出服务：导出完整解说文案为纯文本（§3.6.3）
//
// 输出格式：UTF-8 编码，每段一行，段落间空行分隔

import * as fs from 'fs';
import * as path from 'path';
import type { TxtExportInput, ScriptParagraph } from '../types';

// ──────────────────────────────────────────────
// 服务实现
// ──────────────────────────────────────────────

export class TxtExportService {
  /**
   * 将 ScriptParagraph[] 编译为纯文本字符串
   */
  static compile(paragraphs: ScriptParagraph[]): string {
    const lines: string[] = [];

    for (let i = 0; i < paragraphs.length; i++) {
      const p = paragraphs[i];
      if (p.text && p.text.trim()) {
        lines.push(p.text.trim());
        // 段落间空行
        if (i < paragraphs.length - 1) {
          lines.push('');
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * 完整导出流程：编译文案 → 写入文件
   */
  static export(input: TxtExportInput): string {
    const textContent = TxtExportService.compile(input.scriptParagraphs);

    // 确保输出目录存在
    const dir = path.dirname(input.outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(input.outputPath, textContent, 'utf-8');
    return input.outputPath;
  }
}
