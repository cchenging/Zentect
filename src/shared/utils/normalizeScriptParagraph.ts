// 📁 路径：src/shared/utils/normalizeScriptParagraph.ts
// 🚀 解说段落归一化工厂：ScriptParagraph 判别联合契约的唯一净化入口
//
// 设计动机（详见 docs/designs/2026-08-26-step3-script-重构落地实施方案.md §4.1）：
// 历史库中的 scriptParagraphs 产生于三个不同代际——
//   ① 最早期：只有 text/duration(秒)/keepOriginalAudio 布尔标记；
//   ② 中期：补齐 startMs/durationMs 毫秒时间轴；
//   ③ 目标态：type 判别字段 + original_audio 段 audioSource 结构体。
// 所有持久化入口（加载工程 / 接收管线结果）必须经本工厂统一净化，
// 保证入库后的每一段都满足新契约：type 收窄可用、时间轴毫秒非空、原声段可回溯源窗口。

import type {
  NarrationParagraph,
  OriginalAudioParagraph,
  ScriptParagraph,
} from '../types/entities/editor';

/** 原声段缺失音频源结构时的默认说话人占位符 */
const FALLBACK_SPEAKER = '未知角色';
/** 时间轴完全不可得时的默认段长（毫秒）：与历史爆破器的兜底段长保持一致 */
const FALLBACK_DURATION_MS = 3000;

/**
 * 数值守卫：仅当入参是有限数字时返回其本身，否则回退到指定默认值。
 *
 * @param value 待校验的任意值
 * @param fallback 校验失败时的默认值
 * @returns 有效数字或默认值
 */
function numOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * 归一化单条解说段落，产出满足判别联合契约的规范对象。
 *
 * 处理规则：
 * - 判别字段：显式 `type` 优先；legacy 数据无 type 时以 `keepOriginalAudio === true` 回退判定，
 *   二者皆缺视为解说旁白段（多数派安全默认）；
 * - 时间轴：startMs / durationMs 强制非空（durationMs 缺失时依次尝试 legacy 秒级 duration × 1000、
 *   再退 3000ms 兜底），杜绝下游渲染 / 定位读到 NaN 或 undefined；
 * - 解说旁白段：text 以 cleanText 回退兜底（保证 UI 与 TTS 永远有字符串可读）、characters 补空数组；
 * - 原声穿插段：audioSource 缺失时按「源时间窗 = [startMs, startMs+durationMs]」重建，
 *   transcript 从 legacy text 回退，speaker 标注占位提示人工复核，duckingBgm 取 true 保护台词可听性；
 * - 错就错：非对象输入 / 缺失主键 id 直接抛错暴露，绝不静默降级生成假数据污染时间轴。
 *
 * 注意：产出对象刻意【不回写】@deprecated 字段（duration / keepOriginalAudio）——
 * 新契约下读取端一律走 type / durationMs，遗留消费点由编译期与 code review 一并清理。
 *
 * @param raw 库中读出的原始段落（形态不确定的历史 JSON）
 * @returns 满足 ScriptParagraph 判别联合契约的规范化对象
 * @throws 输入不是对象、或缺少有效 id 主键时抛错
 */
export function normalizeScriptParagraph(raw: unknown): ScriptParagraph {
  // ── 边界防御：非对象输入直接暴露（错就错，绝不伪造空壳段落） ──
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(
      `解说段落归一化失败：输入不是合法段落对象（收到 ${raw === null ? 'null' : typeof raw}）`
    );
  }

  const src = raw as Record<string, unknown>;

  // ── 主键断言：id 是时间轴定位与前端编辑更新（updateScriptParagraph 按 id 匹配）的生命线 ──
  if (typeof src.id !== 'string' || !src.id.trim()) {
    throw new Error('解说段落归一化失败：段落缺少有效 id 主键，拒绝入库（发现时间轴失配将无从追溯）');
  }

  // ── 判别：显式 type 优先，legacy 布尔标记回退，均缺按解说旁白处理（多数派安全默认） ──
  const isOriginal =
    src.type === 'original_audio' ||
    (src.type == null && src.keepOriginalAudio === true);

  // ── 公共基座字段：时间轴毫秒强制非空 ──
  const startMs = numOr(src.startMs, 0);
  // durationMs 三级回退：毫秒直读 → legacy 秒级 duration×1000 反推 → 3000ms 兜底
  const directDurationMs =
    typeof src.durationMs === 'number' && Number.isFinite(src.durationMs) && src.durationMs >= 0
      ? src.durationMs
      : undefined;
  const legacyDurationMs =
    typeof src.duration === 'number' && Number.isFinite(src.duration) && src.duration > 0
      ? Math.round(src.duration * 1000)
      : undefined;
  const durationMs = directDurationMs ?? legacyDurationMs ?? FALLBACK_DURATION_MS;

  const base = {
    id: src.id,
    ...(typeof src.shotId === 'string' && src.shotId ? { shotId: src.shotId } : {}),
    startMs,
    durationMs,
    ...(typeof src.emotion === 'string' && src.emotion ? { emotion: src.emotion } : {}),
  } satisfies Pick<NarrationParagraph | OriginalAudioParagraph, 'id' | 'shotId' | 'startMs' | 'durationMs' | 'emotion'>;

  // ── 分支构造 ──
  if (!isOriginal) {
    const paragraph: NarrationParagraph = {
      ...base,
      type: 'narration',
      text: typeof src.text === 'string' ? src.text : String(src.cleanText ?? ''),
      ...(typeof src.editing === 'boolean' ? { editing: src.editing } : {}),
      ...(typeof src.audioSafeText === 'string' && src.audioSafeText ? { audioSafeText: src.audioSafeText } : {}),
      ...(typeof src.cleanText === 'string' && src.cleanText ? { cleanText: src.cleanText } : {}),
      ...(typeof src.visualIntent === 'string' && src.visualIntent ? { visualIntent: src.visualIntent } : {}),
      characters: Array.isArray(src.characters)
        ? src.characters.filter((c): c is string => typeof c === 'string')
        : [],
    };
    return paragraph;
  }

  // 原声段：优先沿用已落库的 audioSource 结构体，逐字段兜底；整体缺失则按源时间窗重建
  const rawAudioSource =
    typeof src.audioSource === 'object' && src.audioSource !== null
      ? (src.audioSource as Record<string, unknown>)
      : undefined;
  const paragraph: OriginalAudioParagraph = {
    ...base,
    type: 'original_audio',
    audioSource: {
      sourceStartMs: numOr(rawAudioSource?.sourceStartMs, startMs),
      sourceEndMs: numOr(rawAudioSource?.sourceEndMs, startMs + durationMs),
      speaker:
        typeof rawAudioSource?.speaker === 'string' && rawAudioSource.speaker.trim()
          ? rawAudioSource.speaker
          : FALLBACK_SPEAKER,
      transcript:
        typeof rawAudioSource?.transcript === 'string'
          ? rawAudioSource.transcript
          : typeof src.text === 'string'
            ? src.text
            : '',
      duckingBgm: rawAudioSource?.duckingBgm !== false,
    },
  };
  return paragraph;
}
