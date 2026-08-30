/**
 * useStep3Store — 步骤3「解说文案」局部 Store
 *
 * 融合方案参数：枚举按钮组 + 连续值协同，替代旧版 R/S/T/P 滑块
 */

import { create } from 'zustand';
import type { AudioStrategy, ScriptParagraph, PipelineParams } from '../../../shared/types/entities/editor';
import { DENSITY_RATIO_BY_AUDIO_STRATEGY } from '../../../shared/types/entities/editor';

export type { PipelineParams } from '../../../shared/types/entities/editor';

/**
 * 默认参数：爆款短视频导向（智能保留原声/解说占比70%/长短交替/客观基调）。
 * SSOT 红线：audioStrategy 三档与 narrationRatio 数值绑定同源（smart_keep ⇔ 0.70），
 * 用户切换三档按钮时由 View 层一次性整体改写二者并 setPipelineParams 提交。
 */
export const DEFAULT_PIPELINE_PARAMS: PipelineParams = {
  narrativePerspective: 'third',
  audioStrategy: 'smart_keep',
  vibePreset: 'viral',
  narrationRatio: 0.7,
  rhythmMode: 'mixed',
  emotionTone: 'neutral',
  hookIntensity: 0.7,
  targetNarrationDurationSec: 0,
  // 🎯 目标成片篇幅：0 = 自动（沿用视频总长推导），预设档 180/600/1200 由前端三选一驱动
  targetDurationSec: 0,
};

/**
 * 章粒度流式元数据：当前推演到第几章 / 共几章（§五 5.3-C 前端"正在推演第k/N章"进度显示）。
 * null 表示尚未收到任何流式推送（生成未开始）。
 */
export interface Step3StreamMeta {
  /** 当前已推演到的章序号（1 起） */
  chapterIndex: number;
  /** 本次生成总章数 */
  totalChapters: number;
}

export interface Step3Store {
  scriptParagraphs: ScriptParagraph[];
  scriptStyle: string;
  speechRate: number;
  pipelineParams: PipelineParams;
  /** 章粒度流式元数据：驱动"正在推演第k/N章"与骨架卡旁的章节进度条 */
  streamMeta: Step3StreamMeta | null;

  setScriptParagraphs: (paragraphs: ScriptParagraph[]) => void;
  /** 章粒度流式增量追加（§五 5.3-B）：仅用于即时渲染，落库仍以全量 Pipeline Result 覆写收敛 */
  appendParagraphs: (paragraphs: ScriptParagraph[]) => void;
  /** 更新章粒度流式元数据（生成开始/每章推送时写入，生成结束或重置时置 null） */
  setStreamMeta: (meta: Step3StreamMeta | null) => void;
  updateScriptParagraph: (id: string, text: string) => void;
  setScriptStyle: (style: string) => void;
  setSpeechRate: (rate: number) => void;
  setPipelineParams: (params: PipelineParams) => void;

  reset: () => void;
}

export const useStep3Store = create<Step3Store>()((set) => ({
  scriptParagraphs: [],
  scriptStyle: '爆款短视频',
  speechRate: 4.5,
  pipelineParams: { ...DEFAULT_PIPELINE_PARAMS },
  streamMeta: null,

  setScriptParagraphs: (paragraphs) => set({ scriptParagraphs: paragraphs }),
  /**
   * 章粒度流式增量追加：按段落唯一特征（shotId + text）去重，跳过已追加项，
   * 与 usePipelineExecutor 的 idMap 局部防重双保险，杜绝"上一轮 18 章 + 新一轮第 1 章"翻倍膨胀
   */
  appendParagraphs: (paragraphs) =>
    set((s) => {
      if (!Array.isArray(paragraphs) || paragraphs.length === 0) return s;
      // 判别联合收窄：表述去重特征统一用段落主键 id（出生处全局唯一），原声段亦以其 id 标识
      const keyOf = (p: ScriptParagraph) =>
        `${p.id}|${p.type}:${p.type === 'narration' ? p.text : ''}`;
      const existing = new Set(s.scriptParagraphs.map(keyOf));
      const fresh = paragraphs.filter((p) => !existing.has(keyOf(p)));
      if (fresh.length === 0) return s;
      return { scriptParagraphs: [...s.scriptParagraphs, ...fresh] };
    }),
  // 章粒度流式元数据：每章推送时覆盖写入最新章序号（生成结束或重置时由调用方置 null 复位）
  setStreamMeta: (meta) => set({ streamMeta: meta }),
  // 行内编辑只允许写解说旁白段（narration）的 text；原声段台词以 audioSource.transcript
  // 承载且来自 ASR 真实源，判别联合编译期即拒绝向联合整体误写 text
  updateScriptParagraph: (id, text) =>
    set((s) => ({
      scriptParagraphs: s.scriptParagraphs.map((p) =>
        p.id === id && p.type === 'narration' ? { ...p, text } : p
      ),
    })),
  setScriptStyle: (style) => set({ scriptStyle: style }),
  // 语速（字/秒）写入，与 Step3Store 接口一致；缺失时由调用方提供 Number 兜底
  setSpeechRate: (rate) => set({ speechRate: rate }),
  /**
   * SSOT 兼容迁移：audioStrategy 缺失（legacy 老工程无此字段）时回填默认档 smart_keep，
   * 并强制将 narrationRatio 同步为契约层映射表镜像值（智能保留⇔0.70 / 纯解说⇔0.85 / 原声主打⇔0.35）。
   * 根治"档位按钮显示解说70%、右上角徽标显示85%"的数据分叉：audioStrategy 存在时同样锁定镜像，
   * 保证展示徽标、前端预估看板与主进程 DR 折减三处口径永不发散。
   */
  setPipelineParams: (params) => {
    // 类型收窄：DEFAULT_PIPELINE_PARAMS.audioStrategy 在 PipelineParams 中为可选字段，
    // TS 无法据此推断非空索引，此处显式回退 smart_keep 保证 DENSITY_RATIO_BY_AUDIO_STRATEGY 索引安全
    const audioStrategy: AudioStrategy = params.audioStrategy ?? DEFAULT_PIPELINE_PARAMS.audioStrategy ?? 'smart_keep';
    return set({
      pipelineParams: {
        ...params,
        audioStrategy,
        narrationRatio: DENSITY_RATIO_BY_AUDIO_STRATEGY[audioStrategy],
      },
    });
  },

  reset: () => set({
    scriptParagraphs: [],
    scriptStyle: '爆款短视频',
    speechRate: 4.5,
    pipelineParams: { ...DEFAULT_PIPELINE_PARAMS },
    streamMeta: null,
  }),
}));
