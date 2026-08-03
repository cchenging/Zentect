// Module: pipeline/step3-script - View
// Version: v5 - Modernized Professional Script Studio UI

import React, { useState, useMemo } from "react";
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
  Zap,
  BookOpen,
  AlignLeft,
} from "lucide-react";
import { SCRIPT_STYLES } from "@modules/editor/shell/utils/pipelineConstants";
import { Badge, EmptyState, StatHeader } from "@renderer/components/shared";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { Slider } from "@renderer/components/ui/slider";
import type { PipelineParams } from "../../../shared/types/entities/editor";
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
const PERSPECTIVE_OPTIONS: { value: PipelineParams['narrativePerspective']; label: string }[] = [
  { value: 'third', label: "上帝视角 (第三人称)" },
  { value: 'first', label: "主角视角 (第一人称)" },
  { value: 'second', label: "沉浸互动 (第二人称)" },
];

/** 信息层次选项 */
const INFO_LEVEL_OPTIONS: { value: PipelineParams['informationLevel']; label: string; icon: any }[] = [
  { value: 'plot', label: "剧情复述", icon: BookOpen },
  { value: 'deep', label: "深度解读", icon: Sparkles },
  { value: 'roast', label: "吐槽点评", icon: Zap },
];

/** 解说密度选项 */
const DENSITY_OPTIONS: { value: PipelineParams['narrationDensity']; label: string; fill: string }[] = [
  { value: 'full', label: "满配 (100%)", fill: "w-full" },
  { value: 'standard', label: "标准 (65%)", fill: "w-2/3" },
  { value: 'sparse', label: "留白 (50%)", fill: "w-1/3" },
];

/** 原声策略选项 */
const AUDIO_STRATEGY_OPTIONS: { value: PipelineParams['originalAudioStrategy']; label: string }[] = [
  { value: 'cover', label: "全量覆盖" },
  { value: 'keep_key', label: "关键保留" },
  { value: 'original_main', label: "原声为主" },
];

/** 节奏模式选项 */
const RHYTHM_OPTIONS: { value: PipelineParams['rhythmMode']; label: string }[] = [
  { value: 'short_fast', label: "短句快切" },
  { value: 'mixed', label: "长短交替" },
  { value: 'slow_soothing', label: "长句舒缓" },
];

/** 情绪基调选项 */
const EMOTION_TONE_OPTIONS: { value: PipelineParams['emotionTone']; label: string; emoji: string }[] = [
  { value: 'neutral', label: "客观", emoji: "⚖️" },
  { value: 'emotional', label: "情感", emoji: "💔" },
  { value: 'suspense', label: "悬疑", emoji: "🔍" },
  { value: 'epic', label: "高燃", emoji: "🔥" },
  { value: 'comedy', label: "搞笑", emoji: "🤡" },
];

/** 段落级情绪标签 */
const EMOTIONS = ["激昂", "温馨", "幽默", "平静", "紧张", "感慨", "震撼", "庄重"];

/** Tooltips 说明词 */
const TOOLTIPS: Record<string, string> = {
  style: "决定 AI 语言风格与文案框架",
  infoLevel: "复述=讲事实 | 解读=分析隐喻 | 吐槽=主观热梗",
  narrationDensity: "控制解说占视频总长比例，低密度给 BGM 与画面留白",
  originalAudioStrategy: "原声为主时，解说词将自动降级为辅助串场",
  hookIntensity: "强化开场前 3 秒吸引力，越强越具有爆款冲突",
  audioVisualWeight: "偏向画面描写还是提炼 ASR 文本冲突",
};

/**
 * 质感 Hover Tooltip
 */
const HelpTip: React.FC<{ text: string }> = ({ text }) => (
  <span className="relative inline-flex items-center group cursor-help shrink-0 ml-1">
    <HelpCircle size={13} className="text-muted-foreground/50 hover:text-accent transition-colors" />
    <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 whitespace-nowrap px-2.5 py-1.5 rounded-lg
      bg-bg-tertiary/95 border border-border/60 text-[11px] text-foreground shadow-2xl z-50 backdrop-blur-md
      opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all pointer-events-none
      translate-y-1 group-hover:translate-y-0">
      {text}
    </span>
  </span>
);

/**
 * Pro 级 Segmented Control 胶囊切片选择器
 */
function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  disabled,
  lockedValue,
}: {
  options: { value: T; label: string; icon?: any; emoji?: string; fill?: string }[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
  lockedValue?: T;
}) {
  return (
    <div className="flex p-1 rounded-xl bg-bg-tertiary/60 border border-border/30 gap-1 w-full overflow-x-auto no-scrollbar">
      {options.map((opt) => {
        const isLocked = lockedValue !== undefined && lockedValue === opt.value;
        const isSelected = value === opt.value && !isLocked;
        const Icon = opt.icon;

        return (
          <button
            key={opt.value}
            onClick={() => !disabled && !isLocked && onChange(opt.value)}
            disabled={disabled || isLocked}
            className={`flex-1 min-w-[70px] py-1.5 px-2 rounded-lg text-[12px] font-medium transition-all duration-200
              flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap select-none
              ${isSelected
                ? "bg-accent/15 text-accent border border-accent/30 shadow-sm font-semibold"
                : "text-muted-foreground hover:text-foreground hover:bg-bg-secondary/50 border border-transparent"
              }
              ${isLocked ? "bg-amber-500/10 text-amber-500/70 border-amber-500/20 cursor-not-allowed" : ""}
              ${disabled && !isLocked ? "opacity-40 cursor-not-allowed" : ""}`}
          >
            {isLocked && <Lock size={11} className="shrink-0 text-amber-500" />}
            {Icon && <Icon size={12} className={isSelected ? "text-accent" : "text-muted-foreground"} />}
            {opt.emoji && <span className="text-[11px]">{opt.emoji}</span>}
            <span>{opt.label}</span>
            {opt.fill && (
              <div className="w-8 h-1 bg-border/40 rounded-full overflow-hidden ml-1 hidden sm:block">
                <div className={`h-full bg-accent ${opt.fill}`} />
              </div>
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
          size === "sm" ? "h-7 text-[11px] px-2" : "h-9 text-[12.5px] font-medium px-3"
        } border-border/40 bg-bg-tertiary/80 text-foreground hover:border-accent/60 data-[state=open]:border-accent/60 focus:ring-1 focus:ring-accent/30 rounded-xl transition-all`}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="z-50 border-border/60 bg-bg-secondary/95 backdrop-blur-xl text-foreground shadow-2xl rounded-xl">
        {items.map((opt) => (
          <SelectItem
            key={opt.value}
            value={opt.value}
            className="text-[12px] cursor-pointer focus:bg-accent/15 focus:text-accent data-[highlighted]:bg-accent/15 data-[highlighted]:text-accent rounded-lg transition-colors"
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
      <span className="font-mono text-[11px] text-accent w-10 text-right tabular-nums shrink-0">
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

  const totalChars = useMemo(() => scriptParagraphs.reduce((s, p) => s + (p.text?.length || 0), 0), [scriptParagraphs]);
  const estimatedDuration = useMemo(() => Math.ceil(totalChars / speechRate), [totalChars, speechRate]);
  const totalDurationSec = useMemo(
    () => Math.max(0, Math.round(scriptParagraphs.reduce((s, p) => s + (p.duration || 0), 0))),
    [scriptParagraphs]
  );
  const totalDurationMin = Math.ceil(totalDurationSec / 60) || Math.ceil(estimatedDuration / 60);

  /** 冲突防呆：原声为主时降级 */
  const isDensityLocked = pipelineParams.originalAudioStrategy === 'original_main';
  const effectiveDensity = isDensityLocked && pipelineParams.narrationDensity === 'full' ? 'standard' : pipelineParams.narrationDensity;

  const updateParam = <K extends keyof PipelineParams>(key: K, value: PipelineParams[K]) => {
    onSetPipelineParams({ ...pipelineParams, [key]: value });
  };

  const handleAudioStrategyChange = (v: PipelineParams['originalAudioStrategy']) => {
    const next = { ...pipelineParams, originalAudioStrategy: v };
    if (v === 'original_main' && pipelineParams.narrationDensity === 'full') {
      next.narrationDensity = 'standard';
    }
    onSetPipelineParams(next);
  };

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
              <p className="text-[11px] text-muted-foreground/80">精细化调控解说语气、声画比率与网感节奏</p>
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
              <label className="text-[12px] font-medium text-muted-foreground flex items-center">
                <Tv2 size={12} className="mr-1.5 text-accent" />
                创作风格预设
                <HelpTip text={TOOLTIPS.style} />
              </label>
              <CustomSelect
                value={scriptStyle}
                onChange={onSetScriptStyle}
                options={SCRIPT_STYLES}
                placeholder="选择风格..."
                disabled={isGenerating}
              />
            </div>

            {/* 语速选择器 */}
            <div className="md:col-span-6 flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <label className="text-[12px] font-medium text-muted-foreground flex items-center">
                  <Gauge size={12} className="mr-1.5 text-accent" />
                  解说语速
                </label>
                <Badge variant="accent" className="text-[10px] font-mono py-0 px-1.5">
                  {speechRate} 字/秒 · 约 {estimatedDuration}s
                </Badge>
              </div>
              <div className="grid grid-cols-5 gap-1 p-1 bg-bg-tertiary/60 rounded-xl border border-border/30">
                {SPEECH_RATE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => onSetSpeechRate(opt.value)}
                    disabled={isGenerating}
                    className={`py-1 text-[11px] font-mono rounded-lg transition-all cursor-pointer text-center
                      ${speechRate === opt.value
                        ? "bg-accent/20 text-accent font-bold border border-accent/30 shadow-xs"
                        : "text-muted-foreground hover:text-foreground"}`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="border-t border-border/20" />

          {/* 2. 核心控制组：语义 & 风格 */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            {/* 叙事视角 */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-muted-foreground/90 flex items-center">
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

            {/* 信息层次 */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-muted-foreground/90 flex items-center">
                信息层次
                <HelpTip text={TOOLTIPS.infoLevel} />
              </span>
              <SegmentedControl
                options={INFO_LEVEL_OPTIONS}
                value={pipelineParams.informationLevel}
                onChange={(v) => updateParam('informationLevel', v)}
                disabled={isGenerating}
              />
            </div>

            {/* 解说密度 */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-muted-foreground/90 flex items-center">
                解说密度 (时长填充)
                <HelpTip text={TOOLTIPS.narrationDensity} />
              </span>
              <SegmentedControl
                options={DENSITY_OPTIONS}
                value={effectiveDensity}
                onChange={(v) => !isDensityLocked && updateParam('narrationDensity', v)}
                disabled={isGenerating}
                lockedValue={isDensityLocked ? 'full' : undefined}
              />
            </div>

            {/* 原声策略 */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-muted-foreground/90 flex items-center">
                <Volume2 size={12} className="mr-1 text-accent/80" />
                原声保留策略
                <HelpTip text={TOOLTIPS.originalAudioStrategy} />
              </span>
              <SegmentedControl
                options={AUDIO_STRATEGY_OPTIONS}
                value={pipelineParams.originalAudioStrategy}
                onChange={handleAudioStrategyChange}
                disabled={isGenerating}
              />
            </div>
          </div>

          {/* 冲突提示 */}
          {isDensityLocked && (
            <div className="inline-flex items-center gap-2 text-[11px] text-amber-500/90 px-3 py-1.5 rounded-xl bg-amber-500/10 border border-amber-500/20 animate-fade-in">
              <AlertTriangle size={13} className="shrink-0" />
              <span>原声为主策略生效中：解说密度已锁定为标准模式，避免音轨冲突。</span>
            </div>
          )}

          <div className="border-t border-border/20" />

          {/* 3. 节奏模式与情绪基调 */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-muted-foreground/90">句式节奏</span>
              <SegmentedControl
                options={RHYTHM_OPTIONS}
                value={pipelineParams.rhythmMode}
                onChange={(v) => updateParam('rhythmMode', v)}
                disabled={isGenerating}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-muted-foreground/90 flex items-center">
                <Smile size={12} className="mr-1 text-accent/80" />
                情绪基调
              </span>
              <SegmentedControl
                options={EMOTION_TONE_OPTIONS}
                value={pipelineParams.emotionTone}
                onChange={(v) => updateParam('emotionTone', v)}
                disabled={isGenerating}
              />
            </div>
          </div>

          {/* 4. 微调滑块 */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
            <div className="flex flex-col gap-1">
              <div className="flex justify-between items-center text-[11px] text-muted-foreground">
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

            <div className="flex flex-col gap-1">
              <div className="flex justify-between items-center text-[11px] text-muted-foreground">
                <span className="flex items-center">
                  声画权重 (画面 vs 台词)
                  <HelpTip text={TOOLTIPS.audioVisualWeight} />
                </span>
                <span className="font-mono text-accent">{Math.round(pipelineParams.audioVisualWeight * 100)}%</span>
              </div>
              <CustomSlider
                value={Math.round(pipelineParams.audioVisualWeight * 100)}
                onChange={(v) => updateParam('audioVisualWeight', v / 100)}
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
            <h4 className="text-[13px] font-semibold text-foreground">解说文案流 (Script Paragraphs)</h4>
          </div>
          {scriptParagraphs.length > 0 && (
            <span className="text-[11px] text-muted-foreground">
              共计 <span className="font-mono text-accent font-semibold">{totalChars}</span> 字
            </span>
          )}
        </div>

        {scriptParagraphs.length > 0 ? (
          <div className="flex flex-col gap-3">
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
                      <span className="px-2 py-0.5 rounded-md bg-accent/10 border border-accent/20 text-accent font-mono text-[11px] font-semibold">
                        第 {String(index + 1).padStart(2, '0')} 段
                      </span>
                      {p.duration && (
                        <span className="text-[11px] text-muted-foreground font-mono">
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
                        <Badge variant="accent" className="text-[10px] px-2 py-0.5 rounded-md">
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
                  <div className="flex items-center justify-between mt-2 pt-2 border-t border-border/15 text-[11px]">
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