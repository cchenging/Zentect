// Module: pipeline/step1-material - ASRConfig
// ASR 引擎 + faster-whisper 模型大小配置面板
// 🔧 去硬编码：faster-whisper 模型大小不再固定 large-v3，改为前端可配置透传

import React from 'react';
import { Zap, Cpu } from 'lucide-react';
import { useStep1Store } from '@modules/pipeline/stores/useStep1Store';
// 从 store 的 ExtractionConfig 派生 whisper 配置类型（含 modelSize）
// 🔧 去掉 auto：ASR 引擎二选一，要么中文(SenseVoice)要么英文(Faster-Whisper)
type WhisperConfig = { enabled: boolean; engine: 'sensevoice' | 'faster-whisper'; language?: string; modelSize?: string };

interface ASRConfigProps {
  isRunning?: boolean;
}

/** ASR 引擎选项：2 选 1 单控件（中文 / 英文） */
const ENGINE_OPTIONS = [
  {
    value: 'sensevoice' as const,
    label: '中文',
    desc: 'SenseVoice',
    Icon: Zap,
    hint: '基于 FunASR + fsmn-vad，中文识别又快又稳。默认推荐，电视剧场景首选。',
  },
  {
    value: 'faster-whisper' as const,
    label: '英文',
    desc: 'Faster-Whisper',
    Icon: Cpu,
    hint: '基于 CTranslate2，英文识别率高（WER 约 5%）。模型大小可在下方选择。',
  },
] as const;

type EngineValue = typeof ENGINE_OPTIONS[number]['value'];

/** faster-whisper 模型大小：效果与效率权衡 */
const MODEL_SIZE_OPTIONS = [
  { value: 'tiny', label: 'tiny', hint: '最快，精度最低（英文 WER 偏高）' },
  { value: 'base', label: 'base', hint: '较快，精度一般' },
  { value: 'small', label: 'small', hint: '速度与精度均衡' },
  { value: 'medium', label: 'medium', hint: '较慢，精度高' },
  { value: 'large-v3', label: 'large-v3', hint: '最慢，精度最高（默认）' },
] as const;

export const ASRConfig: React.FC<ASRConfigProps> = ({ isRunning }) => {
  const extractionConfig = useStep1Store((s) => s.extractionConfig);
  const updateExtractionConfig = useStep1Store((s) => s.updateExtractionConfig);

  const whisper: WhisperConfig = extractionConfig?.whisper || { enabled: true, engine: 'sensevoice' };
  // 默认选中中文：仅当显式为 faster-whisper 才选中英文，其余（含旧数据 auto/undefined）一律回退中文
  const currentEngine = whisper.engine === 'faster-whisper' ? 'faster-whisper' : 'sensevoice';
  const currentModelSize = whisper.modelSize || 'large-v3';

  /** 切换引擎：同时联动语言（中文→SenseVoice + zh，英文→Faster-Whisper + en） */
  const handleEngineChange = (engine: EngineValue) => {
    if (isRunning) return;
    const language = engine === 'faster-whisper' ? 'en' : 'zh';
    updateExtractionConfig({ whisper: { ...whisper, engine, language } });
  };

  /** 切换 faster-whisper 模型大小 */
  const handleModelSizeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    if (isRunning) return;
    updateExtractionConfig({ whisper: { ...whisper, modelSize: e.target.value } });
  };

  const activeHint = ENGINE_OPTIONS.find((o) => o.value === currentEngine)?.hint || '';
  const modelSizeHint = MODEL_SIZE_OPTIONS.find((o) => o.value === currentModelSize)?.hint || '';

  return (
    <div className={`flex flex-col gap-2.5 ${isRunning ? 'opacity-60 pointer-events-none' : ''}`}>
      {/* 引擎选择：中文 / 英文 2 选 1 单选按钮组（二等分占满整行） */}
      <div className="grid grid-cols-2 gap-1.5 w-full">
        {ENGINE_OPTIONS.map((opt) => {
          const isSelected = currentEngine === opt.value;
          return (
            <button
              key={opt.value}
              onClick={() => handleEngineChange(opt.value)}
              disabled={isRunning}
              className={`
                flex flex-row items-center gap-1.5 px-2.5 py-2 rounded-lg border transition-all cursor-pointer outline-none select-none w-full min-w-0
                ${isSelected
                  ? 'bg-accent/15 border-accent text-accent shadow-sm shadow-accent/10'
                  : `bg-muted/30 border-border/50 text-muted-foreground ${isRunning ? '' : 'hover:bg-muted/50 hover:border-border'}`}
                ${isRunning ? 'opacity-50 cursor-not-allowed' : ''}
              `}
            >
              <opt.Icon size={14} strokeWidth={isSelected ? 2.4 : 1.8} className="shrink-0" />
              <span className="flex flex-col items-start gap-0.5 leading-tight min-w-0">
                <span className="text-[12px] font-semibold">{opt.label}</span>
                <span className={`text-[11px] ${isSelected ? 'text-accent/70' : 'opacity-60'}`}>{opt.desc}</span>
              </span>
            </button>
          );
        })}
      </div>

      {/* faster-whisper 模型大小选择（引擎为英文 Faster-Whisper 时显示） */}
      {currentEngine !== 'sensevoice' && (
        <div className="flex flex-col gap-1">
          <div className="flex flex-row items-center justify-between gap-2">
            <span className="text-[12px] text-muted-foreground">Faster-Whisper 模型大小</span>
            <select
              value={currentModelSize}
              onChange={handleModelSizeChange}
              disabled={isRunning}
              className="bg-muted/30 border border-border/50 rounded-md px-2 py-1 text-[12px] text-foreground outline-none focus:border-accent cursor-pointer disabled:opacity-50"
            >
              {MODEL_SIZE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
            {modelSizeHint} — 模型越大越准但越慢；改小可显著提升速度（需重新识别生效）。
          </p>
        </div>
      )}

      <p className="text-[11px] text-muted-foreground/70 leading-relaxed bg-muted/30 p-2 rounded border border-border/30">
        {activeHint}
      </p>
    </div>
  );
};