/**
 * 爆破切分器：将超过"字幕安全框容量"的长段落按标点符号自动拆分为短句，
 * 防止 LLM 输出长段落导致 TTS 朗读超时与画面张冠李戴、字幕挤出安全框。
 *
 * 【断句规范 · 按行业行规】
 * - 中文字幕横屏 16:9 每行最多 16 字（Netflix 中文 Timed Text 标准，业界基准）；
 *   竖屏 9:16 每行最多 10 字。此处按横屏 16 字作为安全框容量 SUB_MAX。
 * - 16 字是硬上限：17 字必须断句，否则挤出安全框。
 * - 切分策略：安全框内（≤16 字）的句子整句保留，即使带逗号也不拆；
 *   只有超框（>16 字）的句子才切，断点优先落在标点上（句号级 > 逗号级），
 *   无标点可用的超长堆叠才按 16 字硬截断兜底。
 *
 * 🎭 P1 角色继承：拆分出的子句必须继承父段落的 characters（期望角色名单），
 * 否则步骤5 的 Query 端角色对齐会因前端切分丢失角色信息而失效。
 * 入参无 characters（或空数组）时原样透传空数组，不兜底、不掩盖。
 *
 * @param rawShots LLM 原始返回的分镜数组
 * @returns 拆分后的短句分镜数组（每个子句至少 1.2 秒）
 */
export interface BreakLongParagraphInput {
  id?: string;
  shotId?: string;
  text?: string;
  duration?: number;
  emotion?: string;
  /** 🎭 P1 角色组合匹配：父段落的期望角色名单，子句原样继承 */
  characters?: string[];
  /** 🎯 P3 画面意图：父段落的画面意图描述，子句原样继承 */
  visualIntent?: string;
  /** 🎯 P3 时间轴锚定：父段落对应 chunk 的时间起点/时长（ms），子句原样继承 */
  startMs?: number;
  durationMs?: number;
  /** 父段落原始序号：子句透传此值，供调用方按原始顺序合并（原声/非原声混排时保持顺序） */
  __order?: number;
}

export interface BreakLongParagraphOutput {
  id: string;
  shotId?: string;
  text: string;
  duration: number;
  emotion?: string;
  /** 🎭 P1 角色组合匹配：子句继承父段落的期望角色名单 */
  characters?: string[];
  /** 🎯 P3 画面意图：子句继承父段落的画面意图描述 */
  visualIntent?: string;
  /** 🎯 P3 时间轴锚定：子句继承父段落对应 chunk 的时间起点/时长（ms） */
  startMs?: number;
  durationMs?: number;
  /** 父段落原始序号透传 */
  __order?: number;
}

/**
 * 按标点符号切分文本，并保留落在句尾的标点。
 * @param text 原文
 * @param punct 作为切分点的标点字符集合（如句号级 "。！？；" 或逗号级 "，、")
 * @returns 切分后的句子数组（含句尾标点）
 */
function splitByPunct(text: string, punct: string): string[] {
  return text
    .split(new RegExp(`([${punct}])`))
    .reduce((acc: string[], val, i, arr) => {
      if (i % 2 === 0) {
        const nextPunct = arr[i + 1] || "";
        if (val.trim()) acc.push(val.trim() + nextPunct);
      }
      return acc;
    }, [])
    .filter((s) => s.length > 0);
}

/**
 * 硬截断：无任何标点可用的超长堆叠，按固定长度 max 硬切，作为最后兜底。
 * @param text 待截断文本（已确认无标点可用）
 * @param max 每段最大字数（安全框容量）
 * @returns 截断后的文本数组，每段不超过 max 字
 */
function hardSplit(text: string, max: number): string[] {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += max) {
    parts.push(text.slice(i, i + max));
  }
  return parts;
}

export function breakLongParagraphs(
  rawShots: BreakLongParagraphInput[]
): BreakLongParagraphOutput[] {
  const result: BreakLongParagraphOutput[] = [];

  rawShots.forEach((p, idx) => {
    const rawText = (p.text || "").trim();
    // 小数保护：先把文本中的小数（如 "19.9"）用唯一占位符遮蔽，
    // 防止半角小数点被句号级标点误判，把 "19.9" 硬切成 "19." + "9"。
    // 切分完成后在产物阶段统一还原，既保护小数，又不影响英文句点断句。
    const decimalMap: string[] = [];
    const protectedText = rawText.replace(/\d+\.\d+/g, (m) => {
      decimalMap.push(m);
      return `\u0001D${decimalMap.length}\u0001`;
    });
    const baseDuration = p.duration || 3;
    // 🎭 父段落期望角色名单，子句原样继承（空数组即无角色，合法透传）
    const inheritedCharacters = Array.isArray(p.characters) ? p.characters : undefined;
    // 父段落原始序号，子句透传供调用方按原始顺序合并
    const inheritedOrder = p.__order;
    if (!rawText) {
      // 保留空文本段落：保持与 LLM 输出的 1:1 对齐，下游可识别"占位/无字幕"分镜。
      // 不静默丢弃，避免切分后段落计数与 LLM 输出错位。
      result.push({
        id: p.id || p.shotId || `para_${idx}`,
        shotId: p.shotId,
        text: '',
        duration: Math.max(1.2, baseDuration),
        emotion: p.emotion || '',
        characters: inheritedCharacters,
        visualIntent: p.visualIntent || '',
        startMs: p.startMs,
        durationMs: p.durationMs,
        __order: inheritedOrder,
      });
      return;
    }

    // 字幕安全框容量：中文横屏每行容量放宽到 24 字。
    // 原 16 字硬上限会把"一句通顺的话"在逗号处拦腰切断，导致文案碎成 9~10 字短句、
    // 丢失剧情连贯性。24 字既能容纳通顺句子，又不会在常见播放器安全框内溢出（每行可换行）。
    const SUB_MAX = 24;
    // 句号级结尾标点：句子结束，是最优先的断句点。
    const SENTENCE_END_PUNCT = '。！？；.!?;';
    // 逗号级句中标点：句子超框时才作为断句点。
    const COMMA_PUNCT = '，,、；;';

    // 第一步：先按句号级标点分出完整句子（用已遮蔽小数的 protectedText，避免小数被切）。
    const sentences = splitByPunct(protectedText, SENTENCE_END_PUNCT);

    // 第二步：对每个句子——安全框内整句保留；超框才切，断点优先逗号级标点，无标点则硬截断。
    const pieces: string[] = [];
    for (const sent of sentences) {
      // 安全框内（≤16 字）：整句保留，即使带逗号也不拆（"老舅的货，价廉优"保持一整句）。
      if (sent.length <= SUB_MAX) {
        pieces.push(sent);
        continue;
      }
      // 超框（>16 字）：优先用逗号级标点切分。
      // ⚠️ 必须用字符类 [..] 包裹标点集合：裸 `new RegExp(COMMA_PUNCT)` 对全角标点会匹配失败（实测 regex bug）。
      if (new RegExp(`[${COMMA_PUNCT}]`).test(sent)) {
        const commaParts = splitByPunct(sent, COMMA_PUNCT);
        for (const part of commaParts) {
          // 逗号切出的段仍超框（即该段无逗号可再切）→ 硬按安全框容量截断兜底。
          pieces.push(...(part.length > SUB_MAX ? hardSplit(part, SUB_MAX) : [part]));
        }
      } else {
        // 超框且无任何逗号级标点 → 硬按安全框容量截断兜底。
        pieces.push(...hardSplit(sent, SUB_MAX));
      }
    }

    // 按字数比例分配时长，每个子句至少 1.2 秒
    const totalChars = rawText.length || 1;
    // 未切分（仅 1 片）时保留父段落原始 id，不追加 _sub 后缀，供下游按 id 对齐；
    // 仅真正拆分出多片时才追加 _sub_N，避免"短句被误标为子句"导致 id 错位。
    const pieceId = (p.id || p.shotId || `para_${idx}`) ?? '';
    const subParagraphs = pieces.map((sent, sIdx) => {
      const subDuration = parseFloat(((sent.length / totalChars) * baseDuration).toFixed(1));
      return {
        id: pieces.length > 1 ? `${pieceId}_sub_${sIdx + 1}` : pieceId,
        shotId: p.shotId,
        // 还原被遮蔽的小数占位符，恢复真实文案（如 "\u0001D1\u0001" → "19.9"）
        text: sent.replace(/\u0001D(\d+)\u0001/g, (_, n) => decimalMap[Number(n) - 1]),
        duration: Math.max(1.2, subDuration),
        emotion: p.emotion || "",
        // 🎭 子句继承父段落的期望角色名单
        characters: inheritedCharacters,
        // 🎯 P3 画面意图：子句继承父段落的画面意图描述
        visualIntent: p.visualIntent || "",
        // 🎯 P3 时间轴锚定：子句继承父段落对应 chunk 的时间起点/时长（ms）
        startMs: p.startMs,
        durationMs: p.durationMs,
        // 子句透传父段落原始序号，供调用方按原始顺序合并
        __order: inheritedOrder,
      };
    });
    // 归一化缩放：若 1.2s 保底导致子句总时长 > 父时长，按比例缩放回父时长；
    // ⚠️ 但缩放不得破坏 1.2s 保底（保底优先），否则会出现无法解说/匹配的过短切片
    const rawTotalDuration = subParagraphs.reduce((sum, s) => sum + s.duration, 0);
    if (rawTotalDuration > baseDuration) {
      subParagraphs.forEach((sub) => {
        sub.duration = parseFloat(
          Math.max(1.2, (sub.duration / rawTotalDuration) * baseDuration).toFixed(1),
        );
      });
    }
    result.push(...subParagraphs);
  });

  return result;
}