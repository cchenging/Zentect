// 📁 路径：src/modules/export/mp4/backend/SubtitleAssembler.ts
// 字幕装配：将 ExportProject.shots 编译为 SRT 文件，供成片烧录或单独导出
//
// 职责：只负责「字幕文件」的生成，不涉及渲染（渲染由 Mp4Exporter 协调）。

import * as fs from 'fs';
import * as path from 'path';
import type { ExportProject } from '../../contracts/ExportProject';
import type { SubtitleStyle } from '../../jianying/types';

/**
 * 🔤 字幕标点清洗：字幕文本不保留标点符号，标点统一转为空格。
 *
 * 目的：烧录/导出的字幕干净利落，符合短视频字幕习惯；标点表现为句/断句分隔，
 * 转换为空格既清除符号又保留天然断词位置，便于后续按行宽拆行。
 *
 * @param raw 原始字幕文案（含标点）
 * @returns 标点已替换为空格的文案（连续空格合并为单个）
 */
export function sanitizeSubtitlePunctuation(raw: string): string {
  if (!raw) return '';
  // 覆盖中英文标点：，。！？；：、""''《》「」（）【】…—·,.!?;:"'()[]{}<>~`*&^%$#@+=|、等
  const replaced = raw.replace(/[，。！？；：、,\.!?;:""''`「」『』《》〈〉（）【】\[\]{}<>…—·～~=|…]/g, ' ');
  // 合并连续空格为单个（含全角空格），避免间距堆积
  return replaced.replace(/[ \u3000]+/g, ' ');
}

/**
 * 🎬 字幕行宽安全框：按"等效显示宽度"把长文案拆成单行不超过 limit 的多行字幕。
 *
 * 遵循 Netflix 中文 Timed Text 标准建议的安全行宽：中文字符宽度算 1，英文/数字/空格算 0.5。
 * 拆行优先在空格处断开（保留词边界），无空格（纯中文连续）则按宽度硬切。
 *
 * @param text 去标点后的文案
 * @param limit 单行等效宽度上限（默认 16，Netflix 中文安全框）
 * @returns 拆分后的多行数组（每行宽度 <= limit）
 */
export function splitSubtitleByWidth(text: string, limit = 16): string[] {
  if (!text) return [''];
  // 先按显式换行分段，再对每段按宽度拆
  const segments = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const lines: string[] = [];
  for (const seg of segments) {
    // 从空白处预拆成长度受控的候选块，再逐块转字符宽度校验
    const words = seg.split(/(\s+)/);
    let current = '';
    let currentW = 0;
    const flush = () => {
      if (current) lines.push(current.trim());
      current = '';
      currentW = 0;
    };
    for (const w of words) {
      const wW = charWidth(w);
      if (currentW + wW > limit) {
        flush();
        // 单个词/无空白块也超宽时，按可显示字符强行截断
        if (wW > limit) {
          const chunks = hardChunk(w, limit);
          for (const c of chunks) lines.push(c);
          continue;
        }
      }
      current += w;
      currentW += wW;
    }
    flush();
  }
  return lines.length ? lines : [text];
}

/** 中文字符=1，字母/数字/空格/半角符号=0.5（Netflix 中文宽度近似） */
function charWidth(ch: string): number {
  // 非 ASCII（中文字为主）按 1；ASCII 按 0.5
  return /[\u0000-\u00ff]/.test(ch) ? 0.5 : 1;
}

/** 对明显超宽的连续无空白段按可显示宽度强行切块 */
function hardChunk(text: string, limit: number): string[] {
  const out: string[] = [];
  let cur = '';
  let curW = 0;
  for (const ch of text) {
    const w = charWidth(ch);
    if (curW + w > limit && cur) {
      out.push(cur);
      cur = '';
      curW = 0;
    }
    cur += ch;
    curW += w;
  }
  if (cur) out.push(cur);
  return out;
}

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
 * 文案先做标点清洗（标点转空格），再按显示宽度拆成单行不超过 16 的干净行，
 * 单行之间用换行分隔（SRT 支持 Cue 内换行），避免"一个镜头对应一大段文案"导致整屏挤压。
 *
 * @param project 装配好的中间数据模型
 * @returns SRT 字符串
 */
export function compileSrt(project: ExportProject): string {
  const blocks: string[] = [];
  let index = 1;

  for (const shot of project.shots) {
    const raw = shot.aiText || shot.text || '';
    if (!raw) continue;

    const startMs = Math.round(shot.start * 1000);
    const endMs = Math.round(shot.end * 1000);
    // 标点清洗 → 按宽拆行 → SRT Cue 内换行
    const cleanText = sanitizeSubtitlePunctuation(raw);
    const lines = splitSubtitleByWidth(cleanText);
    const cueText = lines.join('\n');

    blocks.push(
      String(index),
      `${formatTimestampMs(startMs)} --> ${formatTimestampMs(endMs)}`,
      cueText,
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
 * 与 SRT 一致：先做标点清洗（标点转空格），再按显示宽度拆成单行不超过 16 的干净行，
 * 行间用 ASS 换行符 \N 分隔，避免"一个镜头对应一大段文案"。
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
    const raw = shot.aiText || shot.text || '';
    if (!raw) continue;

    const startMs = Math.round(shot.start * 1000);
    const endMs = Math.round(shot.end * 1000);
    // 标点清洗 → 按宽拆行 → ASS 换行符
    const cleanText = sanitizeSubtitlePunctuation(raw);
    const lines = splitSubtitleByWidth(cleanText);
    const textLine = lines.join('\\N');
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