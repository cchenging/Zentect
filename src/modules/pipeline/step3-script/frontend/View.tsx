// Module: pipeline/step3-script - View
// Version: v5 - Modernized Professional Script Studio UI

import React, { useState, useMemo, useCallback, useEffect } from "react";
import {
  RefreshCw,
  Tag,
  Search,
  HelpCircle,
  Lock,
  AlertTriangle,
  SlidersHorizontal,
  Sparkles,
  Gauge,
  Volume2,
  Tv2,
  Smile,
  BookOpen,
  AlignLeft,
  Clock,
  Copy,
  Check,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { SCRIPT_STYLES, STYLE_PRESET_MAP } from "@modules/editor/shell/utils/pipelineConstants";
import { Badge, EmptyState, StatHeader } from "@renderer/components/shared";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { Slider } from "@renderer/components/ui/slider";
import type { PipelineParams } from "../../../../shared/types/entities/editor";
import type { StepScriptGenerationProps } from "../types";

/** 语速选项 */
const SPEECH_RATE_OPTIONS = [
  { value: 5.5, label: "5.5", desc: "紧凑快剪" },
  { value: 5.0, label: "5.0", desc: "轻快流畅" },
  { value: 4.5, label: "4.5", desc: "标准节奏" },
  { value: 4.0, label: "4.0", desc: "舒缓沉浸" },
  { value: 3.5, label: "3.5", desc: "低缓纪录" },
];

/** 叙事视角选项 */
const PERSPECTIVE_OPTIONS: { value: PipelineParams['narrativePerspective']; label: string; hint: string }[] = [
  { value: 'third', label: "上帝视角", hint: "全知叙事" },
  { value: 'first', label: "主角视角", hint: "沉浸代入" },
  { value: 'second', label: "沉浸互动", hint: "直接对话" },
];

/** 解说占比滑杆配置（0%~100%：解说与原声互斥一体，保留原声 = 100% - 解说占比） */
const NARRATION_RATIO_MIN_PCT = 0;
const NARRATION_RATIO_MAX_PCT = 100;
const NARRATION_RATIO_STEP_PCT = 5;

/** 节奏模式选项（hint 携带单句字数上限：与后端 maxSentenceChars SSOT 对齐 12 / 20 / 30 字） */
const RHYTHM_OPTIONS: { value: PipelineParams['rhythmMode']; label: string; hint: string }[] = [
  { value: 'short_fast', label: "短句快切", hint: "≤12字/句" },
  { value: 'mixed', label: "长短交替", hint: "≤20字/句" },
  { value: 'slow_soothing', label: "长句舒缓", hint: "≤30字/句" },
];

/** 情绪基调选项 */
const EMOTION_TONE_OPTIONS: { value: PipelineParams['emotionTone']; label: string; emoji: string; hint: string }[] = [
  { value: 'neutral', label: "客观", emoji: "⚖️", hint: "中立陈述" },
  { value: 'emotional', label: "情感", emoji: "💔", hint: "渲染情绪" },
  { value: 'suspense', label: "悬疑", emoji: "🔍", hint: "制造悬念" },
  { value: 'epic', label: "高燃", emoji: "🔥", hint: "堆叠热血" },
  { value: 'comedy', label: "搞笑", emoji: "🤡", hint: "网感吐槽" },
];

/** 段落级情绪标签 */
const EMOTIONS = ["激昂", "温馨", "幽默", "平静", "紧张", "感慨", "震撼", "庄重"];

/** Tooltips 说明词（具体量化，不模糊） */
const TOOLTIPS: Record<string, string> = {
  style: "决定 AI 语言风格与文案框架；选择后自动填充情绪基调，可再手动微调",
  narrationRatio: "解说与原声互斥一体，一个滑杆统一控制配比：解说占比越高=解说词越多越密、原声保留越少；越低=原声越完整、解说只在关键节点点睛。保留原声 = 100% - 解说占比",
  rhythmMode: "句式节奏=单句字数上限：短句快切≤12字 / 长短交替≤20字 / 长句舒缓≤30字",
  hookIntensity: "强化开场前 3 秒吸引力(0%~100%)，越强越具爆款冲突；≥80% 时自动禁用长句舒缓与 3.5 低语速",
};

/** 冲突自动修正的兜底优先级（按"最不易冲突"排序，取第一个未被禁用的值） */
const TONE_FALLBACK_ORDER: PipelineParams['emotionTone'][] = ['neutral', 'emotional', 'suspense', 'epic', 'comedy'];
const RHYTHM_FALLBACK_ORDER: PipelineParams['rhythmMode'][] = ['mixed', 'short_fast', 'slow_soothing'];
const SPEECH_RATE_FALLBACK_ORDER = [4.5, 5.0, 4.0, 5.5, 3.5];

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
function SegmentedControl<T extends string>({
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
 * Custom Slider — 基于 Radix Slider 的高级滑块
 * 渐变轨道 + 圆角阴影滑块 + 当前值实时显示 + hover/active 态反馈
 */
function CustomSlider({
  value,
  onChange,
  min = 0,
  max = 100,
  step = 1,
  disabled = false,
  unit = "%",
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  unit?: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <Slider
        value={[value]}
        onValueChange={([v]) => onChange(v)}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
      />
      <span className="font-mono text-[12px] text-accent w-10 text-right tabular-nums shrink-0">
        {value}{unit}
      </span>
    </div>
  );
}

export const StepScriptGenerationView: React.FC<StepScriptGenerationProps> = (props) => {
  const {
    scriptParagraphs,
    scriptStyle,
    speechRate,
    pipelineParams,
    vlmFrames,
    isGenerating,
    onSetScriptStyle,
    onSetSpeechRate,
    onSetPipelineParams,
    onUpdateParagraph,
    onUpdateParagraphEmotion,
    onRegenerate,
    onMatchVision,
  } = props;

  const [matchingParagraphId, setMatchingParagraphId] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean>(false);
  const [overviewOpen, setOverviewOpen] = useState<boolean>(false);

  const totalChars = useMemo(() => scriptParagraphs.reduce((s, p) => s + (p.text?.length || 0), 0), [scriptParagraphs]);
  /** 文案总览全文：按段落顺序拼接，供一键总览与复制 */
  const overviewText = useMemo(
    () => scriptParagraphs.map((p) => p.text?.trim()).filter(Boolean).join("\n\n"),
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
  const totalDurationSec = useMemo(
    () => Math.max(0, Math.round(scriptParagraphs.reduce((s, p) => s + (p.duration || 0), 0))),
    [scriptParagraphs]
  );
  const totalDurationMin = Math.ceil(totalDurationSec / 60) || Math.ceil(estimatedDuration / 60);

  /** 解说占比（每段解说词的丰满度，0~1，与目标时长独立互不覆盖） */
  const narrationRatioEff = Math.max(0, Math.min(1, pipelineParams.narrationRatio ?? 0.7));
  /** 目标解说时长（秒）：>0 时作为文案总量预算（秒→字数），不影响每段占比 */
  const targetSecEff = pipelineParams.targetNarrationDurationSec && pipelineParams.targetNarrationDurationSec > 0
    ? pipelineParams.targetNarrationDurationSec
    : 0;

  /**
   * 总字数预算（SSOT 与后端 ScriptGenStrategy 对齐）：
   * - 设置了目标解说时长 → 预算 = 目标时长 × 语速 × 节奏折损（总量控制）
   * - 未设置 → 预算 = 视频总时长 × 语速 × 解说占比 × 节奏折损（按占比每段写满）
   * 🔧 P1-5 语义修正：解说占比与目标时长是两个独立维度，占比不再被目标时长覆盖（旧实现把每段填充率
   *   压到 targetSec/总时长 ≈ 16%，导致文案碎片机械）。占比只管每段密度，目标时长只管总量。
   */
  const totalBudgetChars = useMemo(() => {
    const discountByRhythm: Record<string, number> = { short_fast: 0.85, mixed: 0.90, slow_soothing: 0.93 };
    const discountFactor = discountByRhythm[pipelineParams.rhythmMode] ?? 0.88;
    if (targetSecEff > 0) return Math.floor(targetSecEff * speechRate * discountFactor);
    return Math.floor(totalDurationSec * speechRate * narrationRatioEff * discountFactor);
  }, [totalDurationSec, speechRate, narrationRatioEff, targetSecEff, pipelineParams.rhythmMode]);
  /** 超限百分比（实际字数超出预算的比例，未超限返回 null） */
  const overBudgetPct = useMemo(
    () => totalBudgetChars > 0 && totalChars > totalBudgetChars
      ? Math.round(((totalChars - totalBudgetChars) / totalBudgetChars) * 100)
      : null,
    [totalChars, totalBudgetChars],
  );

  const updateParam = <K extends keyof PipelineParams>(key: K, value: PipelineParams[K]) => {
    onSetPipelineParams({ ...pipelineParams, [key]: value });
  };

  /** 解说占比滑杆变更（v 为 0~1）：解说与原声互斥一体，原声段落标记由后端 SSOT（narrationRatio → 1-n）唯一派生，前端不再维护 */
  const handleNarrationRatioChange = (v: number) => {
    updateParam('narrationRatio', v);
  };

  /**
   * 创作风格预设切换：从 STYLE_PRESET_MAP（pipelineConstants.ts，唯一真源）
   * 读取推荐的 emotionTone，自动填充到 pipelineParams 中
   * 用户仍可手动微调（微调后若产生冲突，冲突选项会被自动禁用并就近修正，不弹告警）
   */
  const handleScriptStyleChange = (v: string) => {
    onSetScriptStyle(v);
    const preset = STYLE_PRESET_MAP[v];
    if (preset) {
      onSetPipelineParams({
        ...pipelineParams,
        emotionTone: preset.emotionTone,
      });
    }
  };

  /**
   * 冲突约束计算：返回各维度被禁用的选项值集合。
   * 有冲突的选项直接禁用置灰（替代原红字告警），规则与后端/原语义冲突一致：
   * - 风格 × 情绪基调、风格/钩子强度 × 节奏、钩子强度 × 语速
   */
  const conflictSets = useMemo(() => {
    const toneDisabled = new Set<PipelineParams['emotionTone']>();
    const rhythmDisabled = new Set<PipelineParams['rhythmMode']>();
    const speedDisabled = new Set<number>();
    const style = scriptStyle;
    const hook = pipelineParams.hookIntensity ?? 0;

    // 风格 → 情绪基调：严肃分析禁止搞笑；悬疑禁止搞笑/高燃；情感叙事禁止客观
    if (style === '深度解说' || style === '硬核科普') toneDisabled.add('comedy');
    if (style === '悬疑推理') { toneDisabled.add('comedy'); toneDisabled.add('epic'); }
    if (style === '情感叙事') toneDisabled.add('neutral');
    // 风格/钩子强度 → 节奏：快剪与强钩子都禁止长句舒缓
    if (style === '爆款短视频') rhythmDisabled.add('slow_soothing');
    if (hook >= 0.8) rhythmDisabled.add('slow_soothing');
    // 钩子强度 → 语速：强钩子禁止 3.5 低缓纪录
    if (hook >= 0.8) speedDisabled.add(3.5);

    return { toneDisabled, rhythmDisabled, speedDisabled };
  }, [scriptStyle, pipelineParams.hookIntensity]);

  /**
   * 冲突自动修正（防呆）：当前值落入禁用集时，自动切换到最近的合法值。
   * 确保 UI 永不出现冲突组合，无需红字告警。
   */
  useEffect(() => {
    const { toneDisabled, rhythmDisabled, speedDisabled } = conflictSets;
    const next: Partial<PipelineParams> = {};
    if (toneDisabled.has(pipelineParams.emotionTone)) {
      next.emotionTone = TONE_FALLBACK_ORDER.find(t => !toneDisabled.has(t)) ?? 'neutral';
    }
    if (rhythmDisabled.has(pipelineParams.rhythmMode)) {
      next.rhythmMode = RHYTHM_FALLBACK_ORDER.find(r => !rhythmDisabled.has(r)) ?? 'mixed';
    }
    if (speedDisabled.has(speechRate)) {
      onSetSpeechRate(SPEECH_RATE_FALLBACK_ORDER.find(s => !speedDisabled.has(s)) ?? 4.5);
    }
    if (Object.keys(next).length > 0) {
      onSetPipelineParams({ ...pipelineParams, ...next });
    }
  }, [conflictSets, pipelineParams, speechRate, onSetPipelineParams, onSetSpeechRate]);

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
              <p className="text-[12px] text-muted-foreground/80">风格 / 语速 / 密度 / 声画 / 节奏 / 情绪全参数精调，冲突选项自动禁用</p>
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
          {/* 1. 风格与语速第一排 Grid */}
          <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
            {/* 风格选择器 */}
            <div className="md:col-span-6 flex flex-col gap-1.5">
              <label className="text-[13px] font-medium text-muted-foreground flex items-center">
                <Tv2 size={12} className="mr-1.5 text-accent" />
                创作风格预设
                <HelpTip text={TOOLTIPS.style + '（选择后会自动填充情绪基调，可手动微调）'} />
              </label>
              <CustomSelect
                value={scriptStyle}
                onChange={handleScriptStyleChange}
                options={SCRIPT_STYLES}
                placeholder="选择风格..."
                disabled={isGenerating}
              />
            </div>

            {/* 语速选择器 */}
            <div className="md:col-span-6 flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <label className="text-[13px] font-medium text-muted-foreground flex items-center">
                  <Gauge size={12} className="mr-1.5 text-accent" />
                  解说语速
                </label>
                <Badge variant="accent" className="text-[12px] font-mono py-0 px-1.5">
                  {speechRate} 字/秒 · 约 {estimatedDuration}s
                </Badge>
              </div>
              <div className="grid grid-cols-5 gap-1 p-1 bg-bg-tertiary/60 rounded-xl border border-border/30">
                {SPEECH_RATE_OPTIONS.map((opt) => {
                  const isSpeedConflict = conflictSets.speedDisabled.has(opt.value);
                  const isSpeedSelected = speechRate === opt.value && !isSpeedConflict;
                  return (
                    <button
                      key={opt.value}
                      onClick={() => !isSpeedConflict && onSetSpeechRate(opt.value)}
                      disabled={isGenerating || isSpeedConflict}
                      title={isSpeedConflict ? "与强钩子强度冲突，已禁用" : undefined}
                      className={`py-1 px-1 text-[12px] font-mono rounded-lg transition-all cursor-pointer text-center
                        flex flex-col items-center leading-tight
                        ${isSpeedSelected
                          ? "bg-accent/20 text-accent font-bold border border-accent/30 shadow-xs"
                          : "text-muted-foreground hover:text-foreground"}
                        ${isSpeedConflict
                          ? "bg-border/10 text-muted-foreground/30 border border-border/20 cursor-not-allowed line-through decoration-muted-foreground/30"
                          : "border border-transparent"}`}
                    >
                      <span>{opt.label}</span>
                      <span className={`text-[9px] font-normal ${isSpeedSelected ? "text-accent/70" : isSpeedConflict ? "text-muted-foreground/25" : "text-muted-foreground/50"}`}>
                        {opt.desc}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="border-t border-border/20" />

          {/* 2. 核心控制组：语义 & 风格 */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            {/* 叙事视角 */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-muted-foreground/90 flex items-center">
                <AlignLeft size={12} className="mr-1 text-accent/80" />
                叙事视角
              </span>
              <SegmentedControl
                options={PERSPECTIVE_OPTIONS}
                value={pipelineParams.narrativePerspective}
                onChange={(v) => updateParam('narrativePerspective', v)}
                disabled={isGenerating}
              />
            </div>

            {/* 解说占比（滑杆，0%~100%：解说与原声互斥一体，合并原"解说密度+保留原声"两个参数） */}
            <div className="md:col-span-2 flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-medium text-muted-foreground/90 flex items-center">
                  <Volume2 size={12} className="mr-1 text-accent/80" />
                  解说占比
                  <HelpTip text={TOOLTIPS.narrationRatio} />
                </span>
                <Badge variant="accent" className="text-[12px] font-mono py-0 px-1.5">
                  解说 {Math.round(narrationRatioEff * 100)}% · 原声 {Math.round((1 - narrationRatioEff) * 100)}%
                </Badge>
              </div>
              <CustomSlider
                value={Math.round(narrationRatioEff * 100)}
                onChange={(v) => handleNarrationRatioChange(v / 100)}
                min={NARRATION_RATIO_MIN_PCT}
                max={NARRATION_RATIO_MAX_PCT}
                step={NARRATION_RATIO_STEP_PCT}
                disabled={isGenerating}
              />
              {/* 档位参考刻度：0=全原声 / 30=原声为主 / 60=解说为主 / 100=全解说 */}
              <div className="flex justify-between text-[10px] text-muted-foreground/60 px-0.5">
                <span>0% 全原声</span>
                <span>30% 原声为主</span>
                <span>60% 解说为主</span>
                <span>100% 全解说</span>
              </div>
              {/* 常驻说明：占比 = 每段解说词的丰满度，与"目标解说时长"（总量）互不覆盖 */}
              <p className="text-[11px] leading-relaxed text-muted-foreground/70 px-0.5">
                解说占比 = 每段解说词的丰满度：越高每段写得越充实连贯（85%=每段写满）；越低越精简（30%=只在关键节点点睛）。与「目标解说时长」独立——那里控制整个文案的总量。
              </p>
            </div>

            {/* 目标解说时长（>0 覆盖解说占比；跨两列独占一行） */}
            <div className="md:col-span-2 flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-muted-foreground/90 flex items-center">
                <Clock size={12} className="mr-1 text-accent/80" />
                目标解说时长
                <HelpTip text="设定整个文案的解说总时长（总量预算，秒）。0 = 不限制，按解说占比自动计算。与解说占比独立：占比管每段解说词的丰满度，这里管整个文案写多少" />
              </span>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={0}
                  step={5}
                  value={pipelineParams.targetNarrationDurationSec ?? 0}
                  onChange={(e) => updateParam('targetNarrationDurationSec', Math.max(0, Number(e.target.value) || 0))}
                  disabled={isGenerating}
                  className="h-9 w-full max-w-[140px] px-3 text-[12.5px] font-medium rounded-xl border border-border/40 bg-bg-tertiary/80 text-foreground hover:border-accent/60 focus:border-accent/60 focus:ring-1 focus:ring-accent/30 outline-none transition-all"
                />
                <span className="text-[12px] text-muted-foreground shrink-0">秒</span>
                <Badge variant="accent" className="text-[12px] font-mono py-0 px-1.5 shrink-0">
                  目标 {pipelineParams.targetNarrationDurationSec ?? 0}s / 预计 {estimatedDuration}s
                </Badge>
              </div>
            </div>
          </div>

          <div className="border-t border-border/20" />

          {/* 3. 节奏模式与情绪基调 */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-muted-foreground/90">句式节奏</span>
              <SegmentedControl
                options={RHYTHM_OPTIONS}
                value={pipelineParams.rhythmMode}
                onChange={(v) => updateParam('rhythmMode', v)}
                disabled={isGenerating}
                disabledValues={Array.from(conflictSets.rhythmDisabled)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-muted-foreground/90 flex items-center">
                <Smile size={12} className="mr-1 text-accent/80" />
                情绪基调
              </span>
              <SegmentedControl
                options={EMOTION_TONE_OPTIONS}
                value={pipelineParams.emotionTone}
                onChange={(v) => updateParam('emotionTone', v)}
                disabled={isGenerating}
                disabledValues={Array.from(conflictSets.toneDisabled)}
              />
            </div>
          </div>

          {/* 4. 微调滑块（原声分配由解说占比 SSOT 派生） */}
          <div className="pt-1">
            <div className="flex flex-col gap-1">
              <div className="flex justify-between items-center text-[12px] text-muted-foreground">
                <span className="flex items-center">
                  黄金 3 秒 Hook 钩子强度
                  <HelpTip text={TOOLTIPS.hookIntensity} />
                </span>
                <span className="font-mono text-accent">{Math.round(pipelineParams.hookIntensity * 100)}%</span>
              </div>
              <CustomSlider
                value={Math.round(pipelineParams.hookIntensity * 100)}
                onChange={(v) => updateParam('hookIntensity', v / 100)}
                disabled={isGenerating}
              />
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
                {totalBudgetChars > 0 && (
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

        {/* 总量超限提示条：仅超预算时显示，引导用户调低密度/目标时长后重新生成（与后端 WARN 一致，不静默截断） */}
        {overBudgetPct !== null && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-500 text-[12px]">
            <AlertTriangle size={14} className="shrink-0" />
            <span>
              文案总量 {totalChars} 字超过预算 {totalBudgetChars} 字（超 {overBudgetPct}%）。
              {targetSecEff > 0 ? '可调大目标解说时长（总量预算）或降低解说占比（每段更精简）后重新生成。' : '建议降低解说占比（每段更精简）后重新生成。'}
            </span>
          </div>
        )}

        {scriptParagraphs.length > 0 ? (
          <div className="flex flex-col gap-3 h-[46vh] overflow-y-auto pr-1.5 visible-scrollbar">
            {scriptParagraphs.map((p, index) => {
              const pId = p.id || p.shotId || `p_${index}`;
              const charCount = p.text?.length || 0;

              return (
                <div
                  key={pId}
                  className="group relative p-3.5 rounded-2xl bg-bg-secondary/60 border border-border/30
                    hover:border-accent/40 focus-within:border-accent/60 focus-within:ring-1 focus-within:ring-accent/20
                    transition-all duration-200 backdrop-blur-sm shadow-xs"
                >
                  {/* Card Header */}
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div className="flex items-center gap-2">
                      <span className="px-2 py-0.5 rounded-md bg-accent/10 border border-accent/20 text-accent font-mono text-[12px] font-semibold">
                        第 {String(index + 1).padStart(2, '0')} 段
                      </span>
                      {p.duration && (
                        <span className="text-[12px] text-muted-foreground font-mono">
                          {Number(p.duration).toFixed(1)}s
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
                          disabled={isGenerating}
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

                  {/* Textarea Area */}
                  <textarea
                    value={p.text}
                    onChange={(e) => onUpdateParagraph(p.id, e.target.value)}
                    placeholder="输入或修改解说词..."
                    className="w-full text-[13px] leading-relaxed text-foreground bg-transparent outline-none
                      resize-none min-h-[56px] placeholder:text-muted-foreground/40 font-normal"
                  />

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