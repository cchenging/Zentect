/**
 * 爆破切分器：将超过 18 字的长段落按标点符号自动拆分为爆款微短句
 * 防止 LLM 偶发输出长段落导致 TTS 朗读超时与画面张冠李戴
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
}

export interface BreakLongParagraphOutput {
  id: string;
  shotId?: string;
  text: string;
  duration: number;
  emotion?: string;
  /** 🎭 P1 角色组合匹配：子句继承父段落的期望角色名单 */
  characters?: string[];
}

export function breakLongParagraphs(
  rawShots: BreakLongParagraphInput[]
): BreakLongParagraphOutput[] {
  const result: BreakLongParagraphOutput[] = [];

  rawShots.forEach((p, idx) => {
    const rawText = (p.text || "").trim();
    const baseDuration = p.duration || 3;
    // 🎭 父段落期望角色名单，子句原样继承（空数组即无角色，合法透传）
    const inheritedCharacters = Array.isArray(p.characters) ? p.characters : undefined;

    // 字数 <= 18 已是短句，直接保留
    if (rawText.length <= 18) {
      result.push({
        id: p.id || p.shotId || `para_${idx}`,
        shotId: p.shotId,
        text: rawText,
        duration: baseDuration,
        emotion: p.emotion || "",
        characters: inheritedCharacters,
      });
      return;
    }

    // 字数 > 18，按标点（逗号/句号/感叹号/问号/分号）微拆分
    const sentences = rawText
      .split(/([，,！!？?；;。])/)
      .reduce((acc: string[], val, i, arr) => {
        if (i % 2 === 0) {
          const nextPunct = arr[i + 1] || "";
          if (val.trim()) acc.push(val.trim() + nextPunct);
        }
        return acc;
      }, [])
      .filter((s) => s.length > 0);

    // 按字数比例分配时长，每个子句至少 1.2 秒
    const totalChars = rawText.length || 1;
    const subParagraphs = sentences.map((sent, sIdx) => {
      const subDuration = parseFloat(((sent.length / totalChars) * baseDuration).toFixed(1));
      return {
        id: `${p.id || p.shotId || `para_${idx}`}_sub_${sIdx + 1}`,
        shotId: p.shotId,
        text: sent,
        duration: Math.max(1.2, subDuration),
        emotion: p.emotion || "",
        // 🎭 子句继承父段落的期望角色名单
        characters: inheritedCharacters,
      };
    });
    // 归一化缩放：若 1.2s 保底导致子句总时长 > 父时长，按比例缩放回父时长
    const rawTotalDuration = subParagraphs.reduce((sum, s) => sum + s.duration, 0);
    if (rawTotalDuration > baseDuration) {
      subParagraphs.forEach((sub) => {
        sub.duration = parseFloat(((sub.duration / rawTotalDuration) * baseDuration).toFixed(1));
      });
    }
    result.push(...subParagraphs);
  });

  return result;
}