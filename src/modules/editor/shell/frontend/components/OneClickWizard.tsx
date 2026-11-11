// Module: editor/shell/frontend/components/OneClickWizard
// 一键成片浮层：三步配置 → 生成后进入现有 StepPanel 流水线
// 复用现有：TopBar 项目名、useStepRunner.handleVideoImport、mediaItems、handleStart

import React, { useMemo, useState } from 'react';
import { Check, ChevronLeft, Film, Sparkles, Upload, X } from 'lucide-react';

interface MediaLike {
  id: string;
  type?: string;
  name?: string;
  fileName?: string;
  duration?: number;
  width?: number;
  height?: number;
}

interface OneClickWizardProps {
  open: boolean;
  projectName: string;
  mediaItems: MediaLike[];
  onImport: () => void | Promise<void>;
  onClose: () => void;
  onStart: () => void | Promise<void>;
}

const RECIPES = [
  { key: 'talk', name: '口播解说', kind: '第一人称讲述', desc: '用第一人称讲清楚画面里发生了什么，适合知识、测评、旅行记录。', tags: '3~5 分钟 · 旁白解说 · 标准密度' },
  { key: 'mix', name: '混剪卡点', kind: '节奏优先', desc: '按节奏点切换，保留原声与氛围，适合混剪、产品展示与旅拍。', tags: '1~2 分钟 · 保留原声 · 高密度' },
  { key: 'story', name: '影视解说', kind: '长叙事', desc: '跟随剧情讲完整故事，适合影视、综艺二创与长叙事内容。', tags: '5~8 分钟 · 长文本 · 段落更多' },
];

const DURATIONS = ['1 分钟', '3 分钟', '5 分钟'];
const RATIOS = ['9:16', '16:9', '1:1'];
const VOICES = ['小美 · 温柔女声', '阿哲 · 沉稳男声', '晓晓 · 活泼女声'];

const STEP_LABELS = ['新建项目', '选择配方', '开始前检查'];

export const OneClickWizard: React.FC<OneClickWizardProps> = ({
  open, projectName, mediaItems, onImport, onClose, onStart,
}) => {
  const [step, setStep] = useState(0);
  const [recipe, setRecipe] = useState('talk');
  const [duration, setDuration] = useState(DURATIONS[1]);
  const [ratio, setRatio] = useState(RATIOS[0]);
  const [voice, setVoice] = useState(VOICES[0]);
  const [subtitle, setSubtitle] = useState(true);
  const [starting, setStarting] = useState(false);

  const videos = useMemo(() => (mediaItems || []).filter((m) => m.type === 'video'), [mediaItems]);
  const currentRecipe = RECIPES.find((r) => r.key === recipe) || RECIPES[0];

  if (!open) return null;

  const canNext = step > 0 || videos.length > 0;

  const handleNext = async () => {
    if (step < 2) {
      setStep(step + 1);
      return;
    }
    if (starting) return;
    setStarting(true);
    try {
      await onStart();
      onClose();
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-3 bg-black/70 backdrop-blur-md">
      <section className="w-[760px] max-w-full h-[500px] max-h-full glass-card rounded-2xl border border-border/60 flex flex-col overflow-hidden shadow-2xl">
        {/* 头部 */}
        <header className="flex items-center justify-between px-5 pt-4 shrink-0">
          <div className="flex items-center gap-2">
            <h2 className="text-[16px] font-semibold">一键成片</h2>
            <span className="text-[10px] px-1.5 py-0.5 rounded border border-accent/35 bg-accent/10 text-accent">AI</span>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer outline-none"
            title="稍后再做"
          >
            <X size={14} />
          </button>
        </header>

        {/* 三步序号条 */}
        <div className="flex items-center gap-2 px-5 py-3.5 shrink-0">
          {STEP_LABELS.map((label, i) => (
            <React.Fragment key={label}>
              {i > 0 && <i className="w-3.5 h-px bg-border shrink-0" />}
              <button
                onClick={() => i <= step && setStep(i)}
                className={`flex-1 h-8 min-w-0 flex items-center gap-1.5 px-2.5 rounded-lg border text-[11px] transition-colors outline-none ${
                  i === step
                    ? 'border-accent/50 bg-accent/12 text-accent'
                    : i < step
                      ? 'border-border/50 bg-bg-secondary/40 text-muted-foreground'
                      : 'border-border/40 text-muted-foreground/60'
                } ${i < step ? 'cursor-pointer' : ''}`}
              >
                <em className={`w-[15px] h-[15px] rounded-full grid place-items-center text-[9px] not-italic shrink-0 ${
                  i === step ? 'bg-accent text-white' : 'border border-border/70'
                }`}>{i < step ? <Check size={9} /> : i + 1}</em>
                <span className="truncate">{label}</span>
              </button>
            </React.Fragment>
          ))}
        </div>

        {/* 内容 */}
        <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-1">
          {step === 0 && (
            <div>
              <div className="flex items-baseline gap-2.5 mb-3">
                <b className="text-[13.5px] font-semibold">新建项目</b>
                <span className="text-[11px] text-muted-foreground">素材只在本地处理，不上传云端</span>
              </div>

              <div className="text-[10.5px] text-muted-foreground mb-1.5 flex items-center justify-between">
                <span>项目名称</span><span className="font-mono text-muted-foreground/70">自动生成</span>
              </div>
              <div className="h-8 px-2.5 flex items-center rounded-lg border border-border/60 bg-bg-secondary/40 text-[12px]">
                <span className="truncate">{projectName}</span>
                <span className="ml-auto pl-2 text-[10px] text-muted-foreground/70 shrink-0">可稍后重命名</span>
              </div>

              <div className="mt-3 text-[10.5px] text-muted-foreground mb-1.5 flex items-center justify-between">
                <span>素材</span><span className="font-mono text-muted-foreground/70">{videos.length} 个</span>
              </div>
              <div className="space-y-1.5 max-h-[168px] overflow-y-auto">
                {videos.length === 0 ? (
                  <div className="h-[74px] rounded-lg border border-dashed border-border/60 flex flex-col items-center justify-center gap-1 text-[11px] text-muted-foreground">
                    <Film size={15} className="opacity-40" />
                    还没有素材，先导入一个视频
                  </div>
                ) : (
                  videos.map((v) => (
                    <div key={v.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg border border-border/50 bg-bg-secondary/30">
                      <div className="w-11 h-7 rounded bg-bg-secondary flex items-center justify-center shrink-0">
                        <Film size={12} className="text-muted-foreground/60" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-[11px] truncate">{v.fileName || v.name || '未命名素材'}</div>
                        <div className="text-[9.5px] text-muted-foreground font-mono">
                          {v.width && v.height ? `${v.width}×${v.height}` : '—'}
                          {v.duration ? ` · ${Math.round(v.duration)}s` : ''}
                        </div>
                      </div>
                      <span className="text-[9.5px] px-1.5 py-0.5 rounded border border-accent-green/30 bg-accent-green/10 text-accent-green shrink-0">已导入</span>
                    </div>
                  ))
                )}
              </div>

              <button
                onClick={() => onImport()}
                className="mt-2.5 w-full h-8 rounded-lg border border-dashed border-border/70 text-[11.5px] text-accent hover:bg-accent/5 flex items-center justify-center gap-1.5 transition-colors cursor-pointer outline-none"
              >
                <Upload size={13} /> 导入素材
                <span className="text-muted-foreground">或拖入视频</span>
              </button>
            </div>
          )}

          {step === 1 && (
            <div>
              <div className="flex items-baseline gap-2.5 mb-3">
                <b className="text-[13.5px] font-semibold">选择配方</b>
                <span className="text-[11px] text-muted-foreground">配方决定文案、配音与剪辑策略</span>
              </div>

              <div className="grid grid-cols-3 gap-2.5">
                {RECIPES.map((r) => {
                  const on = r.key === recipe;
                  return (
                    <button
                      key={r.key}
                      onClick={() => setRecipe(r.key)}
                      className={`relative text-left p-2.5 rounded-xl border transition-colors cursor-pointer outline-none ${
                        on ? 'border-accent/50 bg-accent/10' : 'border-border/50 bg-bg-secondary/25 hover:border-border'
                      }`}
                    >
                      <span className={`absolute top-2 right-2 w-[15px] h-[15px] rounded-full grid place-items-center text-[9px] ${
                        on ? 'bg-accent text-white' : 'border border-border/70 text-transparent'
                      }`}><Check size={9} /></span>
                      <div className="flex items-center gap-1.5 text-[11.5px] font-semibold">
                        <Sparkles size={12} className="text-accent" />
                        {r.name}
                      </div>
                      <div className="text-[9.5px] text-muted-foreground mt-0.5">{r.kind}</div>
                      <p className="text-[10.5px] leading-[1.5] text-muted-foreground/90 mt-1.5 h-[46px]">{r.desc}</p>
                      <div className="text-[9.5px] text-muted-foreground/70 mt-1 truncate">{r.tags}</div>
                    </button>
                  );
                })}
              </div>

              <div className="mt-4 flex items-center justify-between">
                <b className="text-[11px] font-semibold">核心选项</b>
                <span className="text-[10px] text-muted-foreground/70">高级设置稍后可在步骤中调整</span>
              </div>
              <div className="grid grid-cols-4 gap-2.5 mt-1.5">
                <div>
                  <div className="text-[9.5px] text-muted-foreground mb-1">成片时长</div>
                  <div className="flex gap-1">
                    {DURATIONS.map((d) => (
                      <button key={d} onClick={() => setDuration(d)}
                        className={`flex-1 h-7 rounded-md border text-[10px] transition-colors cursor-pointer outline-none ${
                          d === duration ? 'border-accent/50 bg-accent/12 text-accent' : 'border-border/50 text-muted-foreground hover:border-border'
                        }`}>{d.replace(' 分钟', '分')}</button>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="text-[9.5px] text-muted-foreground mb-1">画面比例</div>
                  <div className="flex gap-1">
                    {RATIOS.map((r) => (
                      <button key={r} onClick={() => setRatio(r)}
                        className={`flex-1 h-7 rounded-md border text-[10px] transition-colors cursor-pointer outline-none ${
                          r === ratio ? 'border-accent/50 bg-accent/12 text-accent' : 'border-border/50 text-muted-foreground hover:border-border'
                        }`}>{r}</button>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="text-[9.5px] text-muted-foreground mb-1">配音音色</div>
                  <select value={voice} onChange={(e) => setVoice(e.target.value)}
                    className="w-full h-7 px-1.5 rounded-md border border-border/50 bg-bg-secondary/60 text-[10px] outline-none cursor-pointer">
                    {VOICES.map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                </div>
                <div>
                  <div className="text-[9.5px] text-muted-foreground mb-1">字幕</div>
                  <button onClick={() => setSubtitle(!subtitle)}
                    className="w-full h-7 px-1.5 rounded-md border border-border/50 flex items-center gap-1.5 text-[10px] text-muted-foreground cursor-pointer outline-none">
                    <span className={`relative w-6 h-3 rounded-full transition-colors ${subtitle ? 'bg-accent' : 'bg-border'}`}>
                      <i className={`absolute top-[2px] w-2 h-2 rounded-full bg-white transition-all ${subtitle ? 'left-[13px]' : 'left-[2px]'}`} />
                    </span>
                    {subtitle ? '自动烧录' : '不烧录'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div>
              <div className="flex items-baseline gap-2.5 mb-3">
                <b className="text-[13.5px] font-semibold">开始前检查</b>
                <span className="text-[11px] text-muted-foreground">只列出会阻断或明显拖慢生成的项目</span>
              </div>

              <div className="rounded-xl border border-border/50 overflow-hidden">
                {[
                  { ok: videos.length > 0, label: '素材', text: videos.length > 0 ? `已就绪 ${videos.length} 个视频` : '还没有导入视频' },
                  { ok: true, label: '配方', text: `${currentRecipe.name} · ${currentRecipe.kind}` },
                  { ok: true, label: '输出', text: `${ratio} · ${duration} · ${subtitle ? '自动字幕' : '不烧录字幕'}` },
                  { ok: true, label: '配音', text: voice },
                ].map((row) => (
                  <div key={row.label} className="flex items-center gap-2.5 h-[38px] px-3 border-b border-border/40 last:border-b-0 text-[11px]">
                    <span className={`w-[15px] h-[15px] rounded-full grid place-items-center shrink-0 ${
                      row.ok ? 'bg-accent-green/15 text-accent-green' : 'bg-accent-warm/15 text-accent-warm'
                    }`}>{row.ok ? <Check size={9} /> : '!'}</span>
                    <span className="text-muted-foreground w-8 shrink-0">{row.label}</span>
                    <span className="truncate">{row.text}</span>
                  </div>
                ))}
              </div>

              <div className="mt-2.5 flex items-center gap-3 px-3 py-2.5 rounded-xl border border-border/50 bg-bg-secondary/30 text-[11px]">
                <span className="truncate">{currentRecipe.name} · {duration} · {ratio}</span>
                <span className="text-muted-foreground truncate">{voice} · {subtitle ? '自动字幕' : '无字幕'}</span>
                <span className="ml-auto text-[10px] font-mono text-muted-foreground shrink-0">预计 8~12 分钟</span>
              </div>
            </div>
          )}
        </div>

        {/* 底部 */}
        <footer className="flex items-center gap-3 px-5 py-3 border-t border-border/40 shrink-0">
          <button
            onClick={() => setStep(Math.max(0, step - 1))}
            className={`h-8 px-3 rounded-lg text-[11.5px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer outline-none ${step === 0 ? 'invisible' : ''}`}
          >
            <ChevronLeft size={13} className="inline -mt-px" /> 上一步
          </button>
          <span className="text-[10px] text-muted-foreground/70">
            第 {step + 1} / 3 步 · 生成会停在检查点，等你确认
          </span>
          <button
            onClick={handleNext}
            disabled={!canNext || starting}
            className="ml-auto h-8 min-w-[150px] px-4 rounded-lg text-[12px] font-medium text-white bg-gradient-to-r from-accent to-accent-purple hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer outline-none"
          >
            {step === 2 ? (starting ? '正在开始...' : '开始生成') : `下一步：${STEP_LABELS[step + 1]}`}
          </button>
        </footer>
      </section>
    </div>
  );
};

export default OneClickWizard;
