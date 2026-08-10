// 📁 路径：src/modules/export/jianying/backend/core/utils/TextContentFormatter.ts
// 字幕内容格式化：生成符合剪映规范的 content JSON 字符串（§4.5.2）

import type { SubtitleStyle } from '../../../types';
import { DEFAULT_SUBTITLE_STYLE } from '../../../types';

/**
 * 生成符合剪映标准的文本内容 JSON 字符串。
 *
 * 按技术手册 §4.5.2，必须满足（否则剪映打开卡死，坑位 2/3/4）：
 *  - range 必须为 [0, 文本长度] 数组
 *  - fill 必须嵌套 content/solid 结构
 *  - 必须包含 strokes 空数组
 *
 * @param text 字幕文案
 * @param style 字幕样式（缺省用默认样式）
 * @returns 字符串化 JSON
 */
export function formatTextContent(text: string, style: SubtitleStyle = DEFAULT_SUBTITLE_STYLE): string {
  const textObj = {
    text,
    styles: [
      {
        range: [0, text.length],
        fill: {
          alpha: 1.0,
          content: {
            render_type: 'solid',
            solid: { alpha: 1.0, color: style.color },
          },
        },
        size: style.fontSize,
        strokeWidth: style.strokeWidth,
        strokeColor: { alpha: 1.0, color: style.strokeColor },
        alignment: style.alignment,
        letterSpacing: style.letterSpacing,
        lineSpacing: style.lineSpacing,
        lineMaxWidth: style.lineMaxWidth,
        strokes: [] as unknown[],
      },
    ],
  };
  return JSON.stringify(textObj);
}