// 📁 路径：src/shared/utils/subtitleLayout.ts
// 🎬 字幕行宽排版的单一事实源（SSOT）：按"等效显示宽度"把一条字幕拆成多行。
//
// 为什么独立成文件：字幕是**渲染单位**，与 TTS 承载 / 画面匹配单位解耦。
//   步骤3 断句器（step3-script/frontend/breakLongParagraphs）切出的碎片（≤24 字）是
//   TTS 承载与画面匹配的单位；字幕只管"一行放得下多少字"，按行宽独立折行，
//   不因承载单位的边界决定换行位置。
// 消费方：剪映导出（assemblers/MaterialsAssembler → text.content）、
//   MP4 成片烧录（mp4/backend/SubtitleAssembler → SRT / ASS）。
// 注：两个消费方各自的标点清洗口径不同（剪映移除标点、MP4 标点转空格），故清洗不并入本文件。

/** 单行等效宽度上限（横屏 16:9）：中文按 1 字宽、ASCII（字母/数字/空格）按 0.5 计。
 *  16 为 Netflix 中文 Timed Text 安全行宽（横屏业界基准）。 */
export const SUBTITLE_LINE_WIDTH_LIMIT = 16;

/** 单行等效宽度上限（竖屏 9:16）：画布更窄，行宽收紧到 12。
 *  取 12（而非更小的 10）是为了与断句器 24 字承载上限对齐——24 字恰好落成两行，
 *  不突破"一条字幕 ≤2 行"的行规。 */
export const SUBTITLE_LINE_WIDTH_LIMIT_PORTRAIT = 12;

/** 中文字符=1，字母/数字/空格/半角符号=0.5（Netflix 中文宽度近似） */
function charWidth(ch: string): number {
  // 非 ASCII（中文字为主）按 1；ASCII 按 0.5
  return /[\u0000-\u00ff]/.test(ch) ? 0.5 : 1;
}

/** 字符串的等效显示宽度：逐字符累加（中文 1、ASCII 0.5）。
 *  ⚠️ 必须逐字符求和：直接对整串取 charWidth 会让"一个词"的宽度恒为 1，
 *  导致无空格的连续中文（纯中文长句）永远不会折行。 */
function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch);
  return w;
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

/**
 * 🎬 字幕行宽安全框：按"等效显示宽度"把长文案拆成单行不超过 limit 的多行字幕。
 *
 * 遵循 Netflix 中文 Timed Text 标准建议的安全行宽：中文字符宽度算 1，英文/数字/空格算 0.5。
 * 拆行优先在空格处断开（保留词边界），无空格（纯中文连续）则按宽度硬切。
 *
 * @param text 去标点后的文案
 * @param limit 单行等效宽度上限（默认 {@link SUBTITLE_LINE_WIDTH_LIMIT}）
 * @returns 拆分后的多行数组（每行宽度 <= limit）
 */
export function splitSubtitleByWidth(text: string, limit = SUBTITLE_LINE_WIDTH_LIMIT): string[] {
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
      const wW = textWidth(w);
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