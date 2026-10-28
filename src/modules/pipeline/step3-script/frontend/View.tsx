// Module: pipeline/step3-script - View
// Version: v5 - Modernized Professional Script Studio UI

import React, { useState, useMemo, useCallback } from "react";
import {
  RefreshCw,
  Tag,
  Search,
  HelpCircle,
  Lock,
  AlertTriangle,
  SlidersHorizontal,
  Sparkles,
  Volume2,
  User,
  BookOpen,
  Clock,
  Copy,
  Check,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Badge, EmptyState, StatHeader } from "@renderer/components/shared";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
// SSOT 契约层单源：原声三档取值元组 + 人称三档取值元组 + 密度折减系数映射（DR 表禁止在前端复写数值）
import {
  AUDIO_STRATEGY_VALUES,
  DENSITY_RATIO_BY_AUDIO_STRATEGY,
  NARRATIVE_PERSPECTIVE_VALUES,
} from "../../../../shared/types/entities/editor";
import type { AudioStrategy, NarrativePerspective, PipelineParams } from "../../../../shared/types/entities/editor";
// 📐 文案风格六选一（SSOT：与后端 STYLE_PROMPTS 词库同源，禁止在前端另起中文风格名）
import { SCRIPT_STYLES } from "@modules/editor/shell/utils/pipelineConstants";
import type { StepScriptGenerationProps } from "../types";
// 章粒度流式元数据类型：骨架卡旁的"正在推演第k/N章"进度条入参
import type { Step3StreamMeta } from "../../stores/useStep3Store";

/**
 * 🎯 目标成片篇幅档位（定律一 T_target 输入，value=秒）：0 = 自动（跟随原片时长推导预算）；
 * 非预设秒数经旁边自定义输入框写入，写入后各预设档自动取消高亮。
 */
const TARGET_DURATION_OPTIONS = [
  { value: 0, label: "自动", hint: "跟随原片时长" },
  { value: 180, label: "180s", hint: "3min 快剪" },
  { value: 600, label: "600s", hint: "10min 精讲·推荐" },
  { value: 1200, label: "1200s", hint: "20min 大片" },
];

/**
 * 🗣️ 解说人称三档（取值顺序取自契约层 NARRATIVE_PERSPECTIVE_VALUES 单源）：
 * 直接暴露离散参数，后端 ScriptGenStrategy 按此写入 prompt 的视角指令（vibePreset 打包层已拆除）。
 */
const NARRATIVE_PERSPECTIVE_META: Record<NarrativePerspective, { emoji: string; label: string; hint: string }> = {
  third: { emoji: "🌌", label: "第三人称", hint: "上帝视角" },
  first: { emoji: "👤", label: "第一人称", hint: "入戏“我”" },
  second: { emoji: "💬", label: "第二人称", hint: "观众互动“你”" },
};
const NARRATIVE_PERSPECTIVE_OPTIONS = NARRATIVE_PERSPECTIVE_VALUES.map((v) => ({ value: v, ...NARRATIVE_PERSPECTIVE_META[v] }));

/** 🎭 情绪基调五档（取值域 = PipelineParams.emotionTone，后端用于 prompt 情绪指令 + 步骤5 BGM 选型） */
const EMOTION_TONE_META: Record<PipelineParams["emotionTone"], { label: string; hint: string }> = {
  neutral: { label: "平静客观", hint: "克制陈述" },
  emotional: { label: "细腻共情", hint: "情绪共鸣" },
  epic: { label: "高燃热血", hint: "强情绪卡点" },
  suspense: { label: "层层悬疑", hint: "设问·伏笔" },
  comedy: { label: "轻快诙谐", hint: "吐槽·反差" },
};
const EMOTION_TONE_OPTIONS = (["neutral", "emotional", "epic", "suspense", "comedy"] as const).map((v) => ({
  value: v,
  label: `${EMOTION_TONE_META[v].label} · ${EMOTION_TONE_META[v].hint}`,
}));

/** 🥁 叙事节奏三档（取值域 = PipelineParams.rhythmMode，决定单句字数上限与节奏折损口径） */
const RHYTHM_MODE_META: Record<PipelineParams["rhythmMode"], { label: string; hint: string }> = {
  short_fast: { label: "短句快切", hint: "≤18字/句" },
  mixed: { label: "长短交替", hint: "默认" },
  slow_soothing: { label: "舒缓长句", hint: "≤40字/句" },
};
const RHYTHM_MODE_OPTIONS = (["short_fast", "mixed", "slow_soothing"] as const).map((v) => ({ value: v, ...RHYTHM_MODE_META[v] }));

/** 🪝 钩子强度三档（后端 hookIntensity ∈ [0,1]，>=0.8 强钩子 / <0.8 常规） */
const HOOK_LEVELS: { value: number; label: string; hint: string }[] = [
  { value: 0.3, label: "低", hint: "平铺直叙" },
  { value: 0.6, label: "中", hint: "适度设问" },
  { value: 0.8, label: "高", hint: "黄金3秒强钩" },
];

/**
 * 🎚️ 原声策略三档展示文案（取值与配比数值均来自契约层单源 AUDIO_STRATEGY_VALUES /
 * DENSITY_RATIO_BY_AUDIO_STRATEGY，此处仅承载 emoji / label / hint，禁止复写 DR 数值）
 */
const ratioPct = (s: AudioStrategy) => Math.round(DENSITY_RATIO_BY_AUDIO_STRATEGY[s] * 100);
/** 段落时长双源换算（秒）：Normalizer 净化后段落仅有 durationMs 毫秒轴，老项目段落退化为秒制 duration 兜底 */
const paragraphDurationSec = (p: { durationMs?: number; duration?: number }) =>
  (p.durationMs ?? (p.duration ?? 0) * 1000) / 1000;
const AUDIO_STRATEGY_META: Record<AudioStrategy, { emoji: string; label: string; hint: string }> = {
  smart_keep: { emoji: "🔀", label: "智能保留", hint: `解说${ratioPct("smart_keep")}%·原声${100 - ratioPct("smart_keep")}%` },
  pure_narration: { emoji: "🎙️", label: "纯解说", hint: `解说${ratioPct("pure_narration")}%·原声${100 - ratioPct("pure_narration")}%` },
  original_focus: { emoji: "🎬", label: "原声主打", hint: `解说${ratioPct("original_focus")}%·原声${100 - ratioPct("original_focus")}%` },
};
/** 三选一按钮选项：档位顺序取自契约层元组，文案查 META（Record 键穷尽性由编译期保证） */
const AUDIO_STRATEGY_OPTIONS = AUDIO_STRATEGY_VALUES.map((v) => ({ value: v, ...AUDIO_STRATEGY_META[v] }));

/** 段落级情绪标签 */
const EMOTIONS = ["激昂", "温馨", "幽默", "平静", "紧张", "感慨", "震撼", "庄重"];

/** Tooltips 说明词（具体量化，不模糊） */
const TOOLTIPS: Record<string, string> = {
  targetDuration: "目标成片篇幅（定律一 T_target，秒）：写作预算 = 篇幅 × 语速 × 解说密度 × 标点停顿折损 0.85。自动 = 跟随原片时长推导；180s 快剪 / 600s 精讲（推荐）/ 1200s 大片，也可输入任意秒数；基准语速在「高级设置」中调整",
  scriptStyle: "文案风格（六选一）：切换 system prompt 的风格词库与句式模板（爆款短视频/深度解说/评述视角/情感叙事/悬疑推理/硬核科普），只改写法，不改人称/情绪/钩子",
  audioStrategy: "解说与原声的配比策略三选一：智能保留=重点节点解说+完整原声叙事（默认）/ 纯解说=高密度解说覆盖全程 / 原声主打=名场面原声完整保留、解说只在缝隙点睛。选中档位按密度定律统一折减全文写作预算",
  narrativePerspective: "解说人称三选一，直接写入后端 prompt 视角指令：第三人称=上帝视角（他/她）/ 第一人称=主角自述（我）/ 第二人称=对观众对话（你）",
  emotionTone: "情绪基调五选一：平静客观 / 细腻共情 / 高燃热血 / 层层悬疑 / 轻快诙谐。影响步骤3 写作情绪指令，并作为步骤5 BGM 选型依据",
  rhythmMode: "叙事节奏三选一：短句快切（单句 ≤18 字）/ 长短交替（默认，混排）/ 舒缓长句（单句 ≤40 字，适合长视频）",
  hookIntensity: "开头钩子强度三档：低=平铺直叙 / 中=适度设问 / 高=黄金3秒强钩（后端阈值为 0.8，用于切换钩子指令）",
  speechRate: "基准语速（字/秒）：解说写作总预算 = 目标篇幅 × 语速 × 解说密度 × 0.85。中文字幕旁白常速约 4~5 字/秒，语速越高同样篇幅可容纳越多字",
};


/**
 * 质感 Hover Tooltip
 */
const HelpTip: React.FC<{ text: string }> = ({ text }) => (
  <span className="relative inline-flex items-center group cursor-help shrink-0 ml-1">
    <HelpCircle size={13} className="text-muted-foreground/50 hover:text-accent transition-colors" />
    <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 whitespace-nowrap px-2.5 py-1.5 rounded-lg
      bg-bg-tertiary/95 border border-border/60 text-[12px] text-foreground shadow-2xl z-50 backdrop-blur-md
      opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all pointer-events-none
      translate-y-1 group-hover:translate-y-0">
      {text}
    </span>
  </span>
);

/**
 * Pro 级 Segmented Control 胶囊切片选择器
 * - hint：选项下方的量化说明（如 "≤12字/句" / "画面主导 80%"）
 * - disabledValues：因与其它参数冲突而需禁用的选项值（置灰不可点，替代红字告警）
 */
function SegmentedControl<T extends string | number>({
  options,
  value,
  onChange,
  disabled,
  lockedValue,
  disabledValues,
}: {
  options: { value: T; label: string; icon?: any; emoji?: string; fill?: string; hint?: string }[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
  lockedValue?: T;
  disabledValues?: T[];
}) {
  const disabledSet = new Set(disabledValues || []);
  return (
    <div className="flex p-1 rounded-xl bg-bg-tertiary/60 border border-border/30 gap-1 w-full overflow-x-auto no-scrollbar">
      {options.map((opt) => {
        const isLocked = lockedValue !== undefined && lockedValue === opt.value;
        const isConflictDisabled = disabledSet.has(opt.value);
        const isSelected = value === opt.value && !isLocked;
        const isOptionDisabled = disabled || isLocked || isConflictDisabled;
        const Icon = opt.icon;

        return (
          <button
            key={opt.value}
            onClick={() => !isOptionDisabled && onChange(opt.value)}
            disabled={isOptionDisabled}
            title={isConflictDisabled ? "与当前配置冲突，已禁用" : undefined}
            className={`flex-1 min-w-[70px] py-1.5 px-2 rounded-lg text-[13px] font-medium transition-all duration-200
              flex flex-col items-center justify-center gap-0.5 cursor-pointer whitespace-nowrap select-none
              ${isSelected
                ? "bg-accent/15 text-accent border border-accent/30 shadow-sm font-semibold"
                : "text-muted-foreground hover:text-foreground hover:bg-bg-secondary/50 border border-transparent"
              }
              ${isLocked ? "bg-amber-500/10 text-amber-500/70 border-amber-500/20 cursor-not-allowed" : ""}
              ${isConflictDisabled ? "bg-border/10 text-muted-foreground/30 border-border/20 cursor-not-allowed line-through decoration-muted-foreground/30" : ""}
              ${disabled && !isLocked && !isConflictDisabled ? "opacity-40 cursor-not-allowed" : ""}`}
          >
            <span className="flex items-center justify-center gap-1.5">
              {isLocked && <Lock size={11} className="shrink-0 text-amber-500" />}
              {isConflictDisabled && <Lock size={11} className="shrink-0 text-muted-foreground/40" />}
              {Icon && <Icon size={12} className={isSelected ? "text-accent" : "text-muted-foreground"} />}
              {opt.emoji && <span className="text-[12px]">{opt.emoji}</span>}
              <span>{opt.label}</span>
              {opt.fill && (
                <div className="w-8 h-1 bg-border/40 rounded-full overflow-hidden ml-1 hidden sm:block">
                  <div className={`h-full bg-accent ${opt.fill}`} />
                </div>
              )}
            </span>
            {opt.hint && (
              <span className={`text-[10px] leading-none font-normal ${isConflictDisabled ? "text-muted-foreground/25" : isSelected ? "text-accent/70" : "text-muted-foreground/50"}`}>
                {opt.hint}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Custom Select — 基于 Radix Select 的高级下拉框
 * 选项弹出带 scale+opacity 过渡动画，选中项高亮，hover 态，深色主题匹配 Zentect V3
 */
function CustomSelect({
  value,
  onChange,
  options,
  placeholder = "选择...",
  disabled = false,
  size = "default",
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[] | string[];
  placeholder?: string;
  disabled?: boolean;
  size?: "default" | "sm";
}) {
  const items: { value: string; label: string }[] =
    typeof options[0] === "string"
      ? (options as string[]).map((s) => ({ value: s, label: s }))
      : (options as { value: string; label: string }[]);

  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger
        className={`${
          size === "sm" ? "h-7 text-[12px] px-2" : "h-9 text-[12.5px] font-medium px-3"
        } border-border/40 bg-bg-tertiary/80 text-foreground hover:border-accent/60 data-[state=open]:border-accent/60 focus:ring-1 focus:ring-accent/30 rounded-xl transition-all`}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="z-50 border-border/60 bg-bg-secondary/95 backdrop-blur-xl text-foreground shadow-2xl rounded-xl">
        {items.map((opt) => (
          <SelectItem
            key={opt.value}
            value={opt.value}
            className="text-[13px] cursor-pointer focus:bg-accent/15 focus:text-accent data-[highlighted]:bg-accent/15 data-[highlighted]:text-accent rounded-lg transition-colors"
          >
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}


/**
 * Pulse 骨架卡：生成中尚未有完整章节落定时的占位卡片，
 * 用微光/呼吸动画缓解"等待白屏焦虑"（§五 5.3-C）。
 */
const SkeletonCard: React.FC = () => (
  <div className="p-3.5 rounded-2xl bg-bg-secondary/40 border border-border/20 overflow-hidden relative">
    <div className="absolute inset-0 animate-shimmer pointer-events-none" />
    {/* 头部：序号徽标 + 时长 */}
    <div className="flex items-center justify-between gap-2 mb-2.5">
      <div className="flex items-center gap-2">
        <div className="w-12 h-5 rounded-md bg-bg-tertiary/70 animate-pulse" />
        <div className="w-16 h-3 rounded bg-bg-tertiary/50 animate-pulse" />
      </div>
      <div className="w-20 h-5 rounded-md bg-bg-tertiary/40 animate-pulse" />
    </div>
    {/* 正文占位三行 */}
    <div className="space-y-2">
      <div className="h-3 rounded bg-bg-tertiary/60 animate-pulse w-full" />
      <div className="h-3 rounded bg-bg-tertiary/45 animate-pulse w-4/5" />
      <div className="h-3 rounded bg-bg-tertiary/45 animate-pulse w-3/5" />
    </div>
    {/* 底部占位 */}
    <div className="flex items-center justify-between mt-2.5 pt-2 border-t border-border/15">
      <div className="w-24 h-3 rounded bg-bg-tertiary/30 animate-pulse" />
      <div className="w-8 h-3 rounded bg-bg-tertiary/30 animate-pulse" />
    </div>
  </div>
);

/**
 * 生成中章节进度条：显示"正在推演第k/N章" + 章节进度条（§五 5.3-C）。
 * 单阶段模式 totalChapters=1 时不渲染（无逐章概念，避免无意义闪烁）。
 */
const ChapterStreamProgress: React.FC<{ meta: Step3StreamMeta }> = ({ meta }) => {
  if (meta.totalChapters <= 1) return null;
  const pct = Math.round((meta.chapterIndex / meta.totalChapters) * 100);
  return (
    <div className="flex items-center gap-2.5 px-1">
      <Sparkles size={13} className="text-accent shrink-0 animate-pulse" />
      <span className="text-[12px] font-medium text-accent shrink-0">
        正在推演第 <span className="font-mono font-semibold">{meta.chapterIndex}</span>/{meta.totalChapters} 章
      </span>
      <div className="flex-1 h-1.5 rounded-full bg-bg-tertiary/60 overflow-hidden">
        <div
          className="h-full bg-accent rounded-full transition-all duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[11px] font-mono text-muted-foreground/70 shrink-0">{pct}%</span>
    </div>
  );
};

export const StepScriptGenerationView: React.FC<StepScriptGenerationProps> = (props) => {
  const {
    scriptParagraphs,
    scriptStyle,
    speechRate,
    pipelineParams,
    vlmFrames,
    isGenerating,
    streamMeta,
    onSetSpeechRate,
    onSetScriptStyle,
    onSetPipelineParams,
    onUpdateParagraph,
    onUpdateParagraphEmotion,
    onRegenerate,
    onMatchVision,
  } = props;

  const [matchingParagraphId, setMatchingParagraphId] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean>(false);
  const [overviewOpen, setOverviewOpen] = useState<boolean>(false);
  /** 🎛️ 高级设置折叠态（节奏 / 钩子强度 / 基准语速；常驻控件只保留篇幅·原声配比·人称·情绪·风格） */
  const [showAdvanced, setShowAdvanced] = useState<boolean>(false);

  /** 字数聚合双口径收窄：text 仅存在于解说段（原声段以 audioSource.transcript 承载语义），聚合口径只统计 type='narration' */
  const totalChars = useMemo(
    () => scriptParagraphs.reduce((s, p) => s + (p.type === "narration" ? p.text.length : 0), 0),
    [scriptParagraphs],
  );
  /** 文案总览全文：按段落顺序拼接解说段全文（原声保留段无解说词，不参与总览与复制），供一键总览与复制 */
  const overviewText = useMemo(
    () => scriptParagraphs.map((p) => (p.type === "narration" ? p.text.trim() : "")).filter(Boolean).join("\n\n"),
    [scriptParagraphs],
  );

  /** 一键复制全部文案到剪贴板（带成功反馈） */
  const handleCopyAll = useCallback(async () => {
    if (!overviewText) return;
    try {
      await navigator.clipboard.writeText(overviewText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      // 剪贴板 API 不可用时回退到 textarea 选择复制
      const ta = document.createElement("textarea");
      ta.value = overviewText;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
      document.body.removeChild(ta);
    }
  }, [overviewText]);
  const estimatedDuration = useMemo(() => Math.ceil(totalChars / speechRate), [totalChars, speechRate]);
  /** 剧本时间轴总时长（秒）：经由双源换算函数统一口径 */
  const totalDurationSec = useMemo(
    () => Math.max(0, Math.round(scriptParagraphs.reduce((s, p) => s + paragraphDurationSec(p), 0))),
    [scriptParagraphs]
  );
  const totalDurationMin = Math.ceil(totalDurationSec / 60) || Math.ceil(estimatedDuration / 60);

  /**
   * 解说占比有效值（0~1）：与 audioStrategy 三档绑定同源（smart_keep ⇔ 0.70 等），
   * 由契约层 DENSITY_RATIO_BY_AUDIO_STRATEGY 映射表单源推导（与主进程 DR 折减口径一致）。
   * 档位按钮与右上角徽标共用同一取值源，杜绝 legacy narrationRatio 残留旧值（如 0.85）
   * 导致的"按钮显示智能保留70%、徽标显示85%"分叉；audioStrategy 缺失（legacy）时
   * 与分段控件同款默认 smart_keep 推导，两处永远一致。
   */
  const narrationRatioEff = Math.max(0, Math.min(1,
    DENSITY_RATIO_BY_AUDIO_STRATEGY[pipelineParams.audioStrategy ?? "smart_keep"]
  ));
  /** 🎯 目标成片篇幅有效值（秒，定律一 T_target）：0 = 自动档（跟随原片时长推导预算），与后端取值链①③对齐 */
  const targetDurationEff = pipelineParams.targetDurationSec ?? 0;

  /**
   * 总字数预算（SSOT 与后端 ScriptGenStrategy 定律一取值链对齐）：
   * N = ⌊T_target × v × DR × α⌋，T_target=targetDurationSec（成片篇幅，自动档取原片总时长推导）、
   * v=speechRate（高级设置直调）、DR=narrationRatio（audioStrategy 三档同源）、α=0.85 标点停顿折损单乘。
   * ⛔ 与后端同款红线：新定律一路径不再叠加 rhythmMode 节奏折损表；源片时间轴缺失时返回 null（看板隐藏）。
   */
  const totalBudgetChars = useMemo(() => {
    const t = targetDurationEff > 0 ? targetDurationEff : totalDurationSec;
    return t > 0 ? Math.floor(t * speechRate * narrationRatioEff * 0.85) : null;
  }, [targetDurationEff, totalDurationSec, speechRate, narrationRatioEff]);
  /** 超限百分比（实际字数超出预算的比例，预算缺失或未超限返回 null） */
  const overBudgetPct = useMemo(
    () => totalBudgetChars !== null && totalBudgetChars > 0 && totalChars > totalBudgetChars
      ? Math.round(((totalChars - totalBudgetChars) / totalBudgetChars) * 100)
      : null,
    [totalChars, totalBudgetChars],
  );

  const updateParam = <K extends keyof PipelineParams>(key: K, value: PipelineParams[K]) => {
    onSetPipelineParams({ ...pipelineParams, [key]: value });
  };

  /**
   * 🎚️ 原声策略切档：一次性整体提交 audioStrategy + 同源写回 narrationRatio。
   * SSOT 红线：写回值即契约层 DENSITY_RATIO_BY_AUDIO_STRATEGY 映射表取值，
   * 保证 legacy narrationRatio 口径与主进程 DR 折减口径永不发散。
   */
  const handleAudioStrategyChange = (v: AudioStrategy) => {
    onSetPipelineParams({
      ...pipelineParams,
      audioStrategy: v,
      narrationRatio: DENSITY_RATIO_BY_AUDIO_STRATEGY[v],
    });
  };

  /**
   * 🪝 钩子强度切档：直接写离散值（后端阈值 0.8 决定是否切「强钩子」指令），
   * 与节奏/语速同属高级设置，不再经由预设打包层。
   */
  const handleHookChange = (v: number) => updateParam("hookIntensity", v);




  return (
    <div className="flex flex-col gap-4 pb-6">
      {/* 顶部总体看板卡片 */}
      <div className="glass-card p-4 border border-border/40 rounded-2xl bg-gradient-to-br from-bg-secondary/80 to-bg-tertiary/40 backdrop-blur-md shadow-lg">
        <div className="flex items-center justify-between pb-3 border-b border-border/30">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-xl bg-accent/10 border border-accent/20 text-accent">
              <Sparkles size={16} />
            </div>
            <div>
              <h3 className="text-[14px] font-semibold text-foreground tracking-wide">AI 脚本控制台</h3>
              <p className="text-[12px] text-muted-foreground/80">篇幅 / 声画配比 / 写法与调性三控制器，写作预算按密度定律自动核算</p>
            </div>
          </div>
          {scriptParagraphs.length > 0 && (
            <StatHeader
              value={scriptParagraphs.length}
              unit="段落"
              secondary={`约 ${totalDurationMin} 分钟`}
            />
          )}
        </div>

        <div className="flex flex-col gap-3.5 pt-3.5">
          {/* 1. 🎯 目标成片篇幅（定律一 T_target 输入）：自动 + 三预设档 + 自定义秒数 */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-medium text-muted-foreground/90 flex items-center">
                <Clock size={12} className="mr-1 text-accent/80" />
                目标成片篇幅
                <HelpTip text={TOOLTIPS.targetDuration} />
              </span>
              {totalBudgetChars !== null && (
                <Badge variant="accent" className="text-[12px] font-mono py-0 px-1.5">
                  ≈ {totalBudgetChars} 字解说
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <SegmentedControl<number>
                  options={TARGET_DURATION_OPTIONS}
                  value={targetDurationEff}
                  onChange={(v) => updateParam('targetDurationSec', v)}
                  disabled={isGenerating}
                />
              </div>
              <input
                type="number"
                min={0}
                step={30}
                value={targetDurationEff > 0 ? targetDurationEff : ""}
                placeholder="自定义"
                onChange={(e) => updateParam('targetDurationSec', Math.max(0, Number(e.target.value) || 0))}
                disabled={isGenerating}
                className="h-9 w-[92px] px-2.5 text-[12.5px] font-mono rounded-xl border border-border/40 bg-bg-tertiary/80 text-foreground hover:border-accent/60 focus:border-accent/60 focus:ring-1 focus:ring-accent/30 outline-none transition-all"
              />
              <span className="text-[12px] text-muted-foreground shrink-0">秒</span>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground/70 px-0.5">
              预算 = 篇幅 × 语速 × 解说密度 × 标点停顿折损（0.85）。自动 = 跟随原片时长推导；输入非预设秒数后四档自动取消高亮，基准语速见「高级设置」。
            </p>
          </div>

          <div className="border-t border-border/20" />

          {/* 2. 核心控制组：语义 & 风格 */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            {/* 🎚️ 原声策略三选一：配比与密度折减由契约层 DR 单源驱动（替代旧连续滑杆） */}
            <div className="md:col-span-2 flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-medium text-muted-foreground/90 flex items-center">
                  <Volume2 size={12} className="mr-1 text-accent/80" />
                  原声策略
                  <HelpTip text={TOOLTIPS.audioStrategy} />
                </span>
                <Badge variant="accent" className="text-[12px] font-mono py-0 px-1.5">
                  解说 {Math.round(narrationRatioEff * 100)}% · 原声 {Math.round((1 - narrationRatioEff) * 100)}%
                </Badge>
              </div>
              <SegmentedControl
                options={AUDIO_STRATEGY_OPTIONS}
                value={pipelineParams.audioStrategy ?? "smart_keep"}
                onChange={handleAudioStrategyChange}
                disabled={isGenerating}
              />
              {/* 常驻说明：档位联动总字数预算（密度定律折减）；legacy 无档位工程暂显示默认档，点按任一档即收敛 */}
              <p className="text-[11px] leading-relaxed text-muted-foreground/70 px-0.5">
                配比策略直接决定 AI 写多少字，切档即按解说密度定律统一折减全文预算。智能保留 = 重点节点解说 + 完整原声叙事（短视频推荐）；纯解说 = 高密度覆盖、适合无对白空镜；原声主打 = 名场面原声完整保留、解说缝隙点睛。
              </p>
            </div>

            {/* 🗣️ 解说人称（直接暴露离散参数）：写入 prompt 视角指令 */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-muted-foreground/90 flex items-center">
                <User size={12} className="mr-1 text-accent/80" />
                解说人称
                <HelpTip text={TOOLTIPS.narrativePerspective} />
              </span>
              <SegmentedControl<NarrativePerspective>
                options={NARRATIVE_PERSPECTIVE_OPTIONS}
                value={pipelineParams.narrativePerspective ?? "third"}
                onChange={(v) => updateParam("narrativePerspective", v)}
                disabled={isGenerating}
              />
            </div>

            {/* 🎭 情绪基调（直接暴露离散参数）：prompt 情绪指令 + 步骤5 BGM 选型 */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-muted-foreground/90 flex items-center">
                <Sparkles size={12} className="mr-1 text-accent/80" />
                情绪基调
                <HelpTip text={TOOLTIPS.emotionTone} />
              </span>
              <CustomSelect
                value={pipelineParams.emotionTone ?? "epic"}
                onChange={(v) => updateParam("emotionTone", v as PipelineParams["emotionTone"])}
                options={EMOTION_TONE_OPTIONS}
                placeholder="选择情绪基调"
                disabled={isGenerating}
              />
            </div>

            {/* 📐 文案风格六选一：直接决定 system prompt 的风格词库/句式模板（只改写法，不改人称/情绪） */}
            <div className="md:col-span-2 flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-muted-foreground/90 flex items-center">
                <BookOpen size={12} className="mr-1 text-accent/80" />
                文案风格
                <HelpTip text={TOOLTIPS.scriptStyle} />
              </span>
              <CustomSelect
                value={scriptStyle || "爆款短视频"}
                onChange={onSetScriptStyle}
                options={SCRIPT_STYLES}
                placeholder="选择文案风格"
                disabled={isGenerating}
              />
              <p className="text-[11px] leading-relaxed text-muted-foreground/70 px-0.5">
                风格只影响写法（词汇库 / 句式模板 / 叙事手法）；人称与情绪在上方直接选，节奏·钩子·语速在下方高级设置。
              </p>
            </div>

            {/* 🎛️ 高级设置（折叠）：节奏 / 钩子强度 / 基准语速 —— 低频调参不占首屏 */}
            <div className="md:col-span-2 flex flex-col gap-2">
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className="self-start inline-flex items-center gap-1.5 text-[12.5px] font-medium text-muted-foreground hover:text-accent transition-colors cursor-pointer px-2 py-1 rounded-lg bg-bg-secondary/60 border border-border/30 hover:border-accent/40"
              >
                <SlidersHorizontal size={12} />
                高级设置
                {showAdvanced ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              </button>
              {showAdvanced && (
                <div className="flex flex-col gap-3.5 p-3.5 rounded-xl border border-border/30 bg-bg-tertiary/40">
                  {/* 🥁 叙事节奏 */}
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[12.5px] font-medium text-muted-foreground/90 flex items-center">
                      叙事节奏
                      <HelpTip text={TOOLTIPS.rhythmMode} />
                    </span>
                    <SegmentedControl<PipelineParams["rhythmMode"]>
                      options={RHYTHM_MODE_OPTIONS}
                      value={pipelineParams.rhythmMode ?? "mixed"}
                      onChange={(v) => updateParam("rhythmMode", v)}
                      disabled={isGenerating}
                    />
                  </div>

                  {/* 🪝 钩子强度 */}
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[12.5px] font-medium text-muted-foreground/90 flex items-center">
                        开头钩子强度
                        <HelpTip text={TOOLTIPS.hookIntensity} />
                      </span>
                      <Badge variant="accent" className="text-[12px] font-mono py-0 px-1.5">
                        {(pipelineParams.hookIntensity ?? 0.8).toFixed(1)}
                      </Badge>
                    </div>
                    <SegmentedControl<number>
                      options={HOOK_LEVELS}
                      value={pipelineParams.hookIntensity ?? 0.8}
                      onChange={handleHookChange}
                      disabled={isGenerating}
                    />
                  </div>

                  {/* 🗣️ 基准语速（写作预算的 v 项） */}
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[12.5px] font-medium text-muted-foreground/90 flex items-center">
                      基准语速
                      <HelpTip text={TOOLTIPS.speechRate} />
                    </span>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min={2}
                        max={8}
                        step={0.1}
                        value={speechRate}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (Number.isFinite(v)) onSetSpeechRate(Math.max(2, Math.min(8, v)));
                        }}
                        disabled={isGenerating}
                        className="h-9 w-[92px] px-2.5 text-[12.5px] font-mono rounded-xl border border-border/40 bg-bg-tertiary/80 text-foreground hover:border-accent/60 focus:border-accent/60 focus:ring-1 focus:ring-accent/30 outline-none transition-all"
                      />
                      <span className="text-[12px] text-muted-foreground">字/秒</span>
                      {totalBudgetChars !== null && (
                        <span className="text-[11.5px] text-muted-foreground/70">
                          ⇒ 预算约 {totalBudgetChars} 字
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>

          </div>

        </div>
      </div>

      {/* 解说文案段落工作区 */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between px-1">
          <div className="flex items-center gap-2">
            <SlidersHorizontal size={14} className="text-accent" />
            <h4 className="text-[14px] font-semibold text-foreground">解说文案流 (Script Paragraphs)</h4>
          </div>
          {scriptParagraphs.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-muted-foreground">
                共计 <span className="font-mono text-accent font-semibold">{totalChars}</span> 字
                {totalBudgetChars !== null && totalBudgetChars > 0 && (
                  <span className={`ml-1.5 font-mono ${totalChars > totalBudgetChars ? 'text-red-500' : 'text-green-500'}`}>
                    / 预算 {totalBudgetChars} 字
                    {overBudgetPct !== null && ` (超 ${overBudgetPct}%)`}
                  </span>
                )}
              </span>
              {/* 文案总览折叠按钮 */}
              <button
                onClick={() => setOverviewOpen((v) => !v)}
                className="inline-flex items-center gap-1 text-[12px] font-medium text-muted-foreground hover:text-accent transition-colors cursor-pointer px-2 py-1 rounded-lg bg-bg-secondary/60 border border-border/30 hover:border-accent/40"
              >
                <BookOpen size={12} />
                总览
                {overviewOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              </button>
              {/* 一键复制全部文案 */}
              <button
                onClick={handleCopyAll}
                className="inline-flex items-center gap-1 text-[12px] font-medium text-accent hover:text-accent/80 transition-colors cursor-pointer px-2 py-1 rounded-lg bg-accent/10 border border-accent/30 hover:bg-accent/20"
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
                {copied ? "已复制" : "复制全部"}
              </button>
            </div>
          )}
        </div>

        {/* 文案总览面板：仿步骤2 故事脉络，折叠展开通览全文 */}
        {overviewOpen && overviewText && (
          <div className="p-3.5 rounded-lg shrink-0 bg-gradient-to-br from-accent-purple/10 via-accent/5 to-transparent border border-accent-purple/20">
            <div className="text-[13px] font-semibold mb-2 flex items-center gap-2 text-accent-purple">
              <BookOpen size={13} /> 文案总览
              <span className="text-[11px] font-normal text-muted-foreground/70">
                {scriptParagraphs.length} 段 · {totalChars} 字
              </span>
            </div>
            <div className="text-[13px] text-foreground leading-relaxed whitespace-pre-wrap max-h-[38vh] overflow-y-auto pr-1">
              {overviewText}
            </div>
          </div>
        )}

        {/* 总量超限提示条：仅超预算时显示，引导用户调大篇幅/调低密度后重新生成（与后端 WARN 一致，不静默截断） */}
        {overBudgetPct !== null && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-500 text-[12px]">
            <AlertTriangle size={14} className="shrink-0" />
            <span>
              文案总量 {totalChars} 字超过预算 {totalBudgetChars} 字（超 {overBudgetPct}%）。
              可调大目标成片篇幅或降低原声策略档位（解说密度）后重新生成。
            </span>
          </div>
        )}

        {scriptParagraphs.length > 0 ? (
          <div className="flex flex-col gap-3 h-[46vh] overflow-y-auto pr-1.5 visible-scrollbar">
            {/* 生成中章节进度条：正在推演第k/N章 + 章节进度条（§五 5.3-C） */}
            {isGenerating && streamMeta && <ChapterStreamProgress meta={streamMeta} />}
            {scriptParagraphs.map((p, index) => {
              const pId = p.id;
              // 字数统计按判别联合收窄：解说段计 text.length，原声保留段无解说词计 0
              const charCount = p.type === 'narration' ? p.text.length : 0;

              return (
                <div
                  key={pId || `idx_${index}`}
                  className="group relative p-3.5 rounded-2xl bg-bg-secondary/60 border border-border/30
                    hover:border-accent/40 focus-within:border-accent/60 focus-within:ring-1 focus-within:ring-accent/20
                    transition-all duration-200 backdrop-blur-sm shadow-xs animate-fade-in-up"
                >
                  {/* Card Header */}
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div className="flex items-center gap-2">
                      <span className="px-2 py-0.5 rounded-md bg-accent/10 border border-accent/20 text-accent font-mono text-[12px] font-semibold">
                        第 {String(index + 1).padStart(2, '0')} 段
                      </span>
                      {p.type === 'original_audio' && (
                        <span
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-500/10 border border-amber-500/30 text-amber-600 dark:text-amber-400 text-[12px] font-medium"
                          title="原声保留段：此段保留影片原声台词，不生成解说词，故锁定不可编辑"
                        >
                          <Lock size={11} />
                          原声保留
                        </span>
                      )}
                      {paragraphDurationSec(p) > 0 && (
                        <span className="text-[12px] text-muted-foreground font-mono">
                          {paragraphDurationSec(p).toFixed(1)}s
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      {/* 情绪标签 Selector */}
                      <div className="flex items-center gap-1.5">
                        <Tag size={12} className="text-muted-foreground/60" />
                        <CustomSelect
                          value={p.emotion || ""}
                          onChange={(v) => onUpdateParagraphEmotion(p.id, v)}
                          options={[{ value: "", label: "无氛围标签" }, ...EMOTIONS.map((em) => ({ value: em, label: em }))]}
                          placeholder="无氛围标签"
                          disabled={isGenerating || p.type === 'original_audio'}
                          size="sm"
                        />
                      </div>

                      {p.emotion && (
                        <Badge variant="accent" className="text-[12px] px-2 py-0.5 rounded-md">
                          {p.emotion}
                        </Badge>
                      )}
                    </div>
                  </div>

                  {/* Text Area：解说段渲染可编辑 textarea；原声保留段为锁定展示条（语义文本取 audioSource.transcript，不可编辑） */}
                  {p.type === 'narration' ? (
                    <textarea
                      value={p.text}
                      onChange={(e) => onUpdateParagraph(p.id, e.target.value)}
                      placeholder="输入或修改解说词..."
                      className="w-full text-[13px] leading-relaxed text-foreground bg-transparent outline-none
                        resize-none min-h-[56px] placeholder:text-muted-foreground/40 font-normal"
                    />
                  ) : (
                    <div
                      className="w-full rounded-lg bg-accent/5 border border-border/20 select-none"
                      title="原声保留段：此段保留影片原声，无需生成解说词，故锁定不可编辑"
                    >
                      <div className="flex items-center gap-1.5 px-2 pt-1.5 text-[11px] text-muted-foreground/70">
                        <Volume2 size={11} />
                        原声台词 · 此段保留影片原声，不生成解说词
                      </div>
                      <div className="px-2 pb-1.5 min-h-[40px] text-[13px] leading-relaxed text-muted-foreground italic">
                        {p.audioSource.transcript || '（保留原片声音）'}
                      </div>
                    </div>
                  )}

                  {/* Card Footer */}
                  <div className="flex items-center justify-between mt-2 pt-2 border-t border-border/15 text-[12px]">
                    <button
                      onClick={() => { setMatchingParagraphId(pId); onMatchVision(pId); }}
                      disabled={!vlmFrames.length || matchingParagraphId === pId}
                      className="inline-flex items-center gap-1 text-muted-foreground hover:text-accent transition-colors
                        cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      <Search size={11} />
                      <span>{matchingParagraphId === pId ? "匹配切片中..." : "匹配画面帧"}</span>
                    </button>

                    <span className="text-muted-foreground/60 font-mono">
                      {charCount} 字
                    </span>
                  </div>
                </div>
              );
            })}

            {/* 生成中尾部骨架卡：下一章仍在推演，用脉冲卡占位消除等待焦虑 */}
            {isGenerating && <SkeletonCard />}

            {/* 重新生成 / 重新编排 Trigger */}
            <button
              onClick={onRegenerate}
              disabled={isGenerating}
              className="mt-2 py-3 px-4 rounded-2xl text-[13px] font-semibold text-accent bg-accent/10 border border-accent/30
                hover:bg-accent/20 hover:border-accent/50 active:scale-[0.99] disabled:opacity-50
                transition-all duration-200 flex items-center justify-center gap-2 cursor-pointer shadow-md"
            >
              <RefreshCw size={15} className={isGenerating ? "animate-spin" : ""} />
              <span>{isGenerating ? "正在重构解说文案..." : "应用当前参数重新生成"}</span>
            </button>
          </div>
        ) : isGenerating ? (
          /* 生成中且尚无章节落定：显示骨架卡组 + 章节进度条（替代空态，缓解等待焦虑） */
          <div className="flex flex-col gap-3 h-[46vh] overflow-y-auto pr-1.5 visible-scrollbar">
            {streamMeta && <ChapterStreamProgress meta={streamMeta} />}
            {[0, 1, 2].map((i) => <SkeletonCard key={i} />)}
          </div>
        ) : (
          <EmptyState
            title="解说文案待生成"
            description="在上方配置语气与解说参数后，点击生成即可获得精准声画对齐的解说词"
            iconType="media"
            size="md"
            className="glass-card p-8 rounded-2xl border border-border/30"
          />
        )}
      </div>
    </div>
  );
};