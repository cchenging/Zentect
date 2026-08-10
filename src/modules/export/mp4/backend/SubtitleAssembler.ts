// 📁 路径：src/modules/export/mp4/backend/SubtitleAssembler.ts
// 字幕装配：将 ExportProject.shots 编译为 SRT 文件，供成片烧录或单独导出
//
// 职责：只负责「字幕文件」的生成，不涉及渲染（渲染由 Mp4Exporter 协调）。

import * as fs from 'fs';
import * as path from 'path';
import type { ExportProject } from '../../contracts/ExportProject';
import type { SubtitleStyle } from '../../jianying/types';

/** SRT 时间戳格式：毫秒 → "HH:MM:SS,mmm" */
function formatTimestampMs(ms: number): string {
  const totalMs = Math.max(0, Math.floor(ms));
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const mm = totalMs % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(mm).padStart(3, '0')}`;
}

/**
 * 将 ExportProject.shots 编译为 SRT 字符串。
 *
 * 每个 shot 的起止时间（秒）作为字幕时间窗口，字幕文案优先取 aiText，其次 text。
 *
 * @param project 装配好的中间数据模型
 * @returns SRT 字符串
 */
export function compileSrt(project: ExportProject): string {
  const blocks: string[] = [];
  let index = 1;

  for (const shot of project.shots) {
    const text = shot.aiText || shot.text || '';
    if (!text) continue;

    const startMs = Math.round(shot.start * 1000);
    const endMs = Math.round(shot.end * 1000);

    blocks.push(
      String(index),
      `${formatTimestampMs(startMs)} --> ${formatTimestampMs(endMs)}`,
      text,
      '',
    );
    index++;
  }

  return blocks.join('\n');
}

/**
 * 生成 SRT 字幕文件（用于烧录或单独导出）。
 *
 * @param project 装配好的中间数据模型
 * @param outputDir 输出目录
 * @param fileName 文件名（不含扩展名）
 * @returns SRT 文件绝对路径
 */
export function writeSrtFile(project: ExportProject, outputDir: string, fileName: string): string {
  const srtPath = path.join(outputDir, `${fileName}.srt`);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  fs.writeFileSync(srtPath, compileSrt(project), 'utf-8');
  return srtPath;
}

// ============================================================
// ASS 烧录（应用共享 subtitleStyle）
// ============================================================

/** ASS 渲染画布宽度（烧录时不随成片画幅变化，字幕按此比例布局） */
const ASS_PLAYRES_X = 1920;
/** ASS 渲染画布高度 */
const ASS_PLAYRES_Y = 1080;

/**
 * 将剪映字幕样式的 RGB（0~1）转换为 ASS 颜色格式（&HAABBGGRR）。
 *
 * @param rgb 归一化 RGB 三元组
 * @returns ASS 颜色字符串
 */
function toAssColor(rgb: [number, number, number]): string {
  const r = Math.max(0, Math.min(255, Math.round((rgb[0] ?? 1) * 255)));
  const g = Math.max(0, Math.min(255, Math.round((rgb[1] ?? 1) * 255)));
  const b = Math.max(0, Math.min(255, Math.round((rgb[2] ?? 1) * 255)));
  // ASS 颜色为 AABBGGRR（alpha 在前，通道顺序 BGR），十六进制统一大写（符合 ASS 惯例）
  return `&H00${b.toString(16).toUpperCase().padStart(2, '0')}${g.toString(16).toUpperCase().padStart(2, '0')}${r.toString(16).toUpperCase().padStart(2, '0')}`;
}

/**
 * 将剪映对齐方式（0 左 / 1 中 / 2 右）映射为 ASS 底部对齐编号（1/2/3）。
 *
 * @param alignment 剪映对齐方式
 * @returns ASS Alignment 值
 */
function toAssAlignment(alignment: number): number {
  // ASS Alignment：1=底左 / 2=底中 / 3=底右
  if (alignment === 0) return 1;
  if (alignment === 2) return 3;
  return 2;
}

/**
 * 将剪映字幕样式编译为 ASS 样式行（Style 定义）。
 *
 * 映射规则：
 * - fontSize 为相对字号（默认 3.5），换算为 ASS 像素字号，基准 1080p 下约 90px
 * - strokeWidth 为相对描边（默认 0.02），换算为 ASS 描边像素
 * - letterSpacing 换算为 ASS 字间距（像素）
 * - lineSpacing 不再单独映射（ASS 无行距属性，由垂直偏移统一控制）
 * - verticalOffset 为相对画布高度偏移（正数向上），换算为 ASS MarginV
 *
 * @param style 剪映字幕样式
 * @returns ASS Style 行内容
 */
export function buildAssStyle(style: SubtitleStyle): string {
  const fontSizePx = Math.round((style.fontSize ?? 3.5) * 26); // 3.5 → 91px
  const outlinePx = Math.max(0, Math.round((style.strokeWidth ?? 0) * 1200)); // 0.02 → 24px
  const spacingPx = Math.round((style.letterSpacing ?? 0) * 100);
  const marginV = Math.round((style.verticalOffset ?? 0) * ASS_PLAYRES_Y);
  const alignment = toAssAlignment(style.alignment ?? 1);

  const primary = toAssColor(style.color ?? [1, 1, 1]);
  const outline = toAssColor(style.strokeColor ?? [0, 0, 0]);

  return (
    `Style: Default,Microsoft YaHei,${fontSizePx},${primary},${primary},${outline},&H80000000,` +
    `-1,0,0,0,100,100,${spacingPx},0,1,${outlinePx},0,${alignment},10,10,${marginV},1`
  );
}

/**
 * 将 ExportProject.shots 编译为 ASS 字符串（应用剪映字幕样式）。
 *
 * 每个 shot 的起止时间作为字幕时间窗口，文案优先取 aiText，其次 text。
 *
 * @param project 装配好的中间数据模型
 * @param style 剪映字幕样式
 * @returns ASS 字符串
 */
export function compileAss(project: ExportProject, style: SubtitleStyle): string {
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    `PlayResX: ${ASS_PLAYRES_X}`,
    `PlayResY: ${ASS_PLAYRES_Y}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    buildAssStyle(style),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');

  const dialogues: string[] = [];
  for (const shot of project.shots) {
    const text = shot.aiText || shot.text || '';
    if (!text) continue;

    const startMs = Math.round(shot.start * 1000);
    const endMs = Math.round(shot.end * 1000);
    const textLine = text.replace(/\n/g, '\\N');
    dialogues.push(`Dialogue: 0,${formatAssTime(startMs)},${formatAssTime(endMs)},Default,,0,0,0,,${textLine}`);
  }

  return dialogues.length ? `${header}\n${dialogues.join('\n')}` : header;
}

/** ASS 时间戳格式：毫秒 → "H:MM:SS.cc" */
function formatAssTime(ms: number): string {
  const totalMs = Math.max(0, Math.floor(ms));
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const cs = Math.floor((totalMs % 1000) / 10);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/**
 * 生成 ASS 字幕文件（用于烧录，应用剪映字幕样式）。
 *
 * @param project 装配好的中间数据模型
 * @param style 剪映字幕样式
 * @param outputDir 输出目录
 * @param fileName 文件名（不含扩展名）
 * @returns ASS 文件绝对路径
 */
export function writeAssFile(project: ExportProject, style: SubtitleStyle, outputDir: string, fileName: string): string {
  const assPath = path.join(outputDir, `${fileName}.ass`);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  fs.writeFileSync(assPath, compileAss(project, style), 'utf-8');
  return assPath;
}