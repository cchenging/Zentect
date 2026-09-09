// Module: pipeline/step1-material - ASRConfig
// ASR 引擎 + faster-whisper 模型大小配置面板
// 🔧 去硬编码：faster-whisper 模型大小不再固定 large-v3，改为前端可配置透传

import React from 'react';
import { Zap, Cpu, Target, Languages } from 'lucide-react';
import { useStep1Store } from '@modules/pipeline/stores/useStep1Store';
import { API } from '@renderer/api';
// 从 store 的 ExtractionConfig 派生 whisper 配置类型（含 modelSize）
// 🔧 去 auto：ASR 引擎三选一 —— 中文(SenseVoice) / 英文(Faster-Whisper) / 高精度中文(Paraformer)
type WhisperConfig = { enabled: boolean; engine: 'sensevoice' | 'faster-whisper' | 'paraformer'; language?: string; modelSize?: string };

interface ASRConfigProps {
  isRunning?: boolean;
}

/** ASR 引擎选项：3 选 1 单控件（中文 / 英文 / 高精度中文） */
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
  {
    value: 'paraformer' as const,
    label: '高精度',
    desc: 'Paraformer',
    Icon: Target,
    hint: '基于 FunASR + fsmn-vad，880MB 高精度中文引擎，支持热词纠错专名错别字。CPU 较慢但更准。',
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

/** 🎬 方案B（2026-09-08）识别语言：独立于引擎选择，决定 ASR 语种与模型匹配。
 *  中日韩粤 → SenseVoice；英语 → Faster-Whisper；韩剧要更高准确率可选英语类引擎外，
 *  更优做法：语言=韩语 + 引擎=Faster-Whisper（large-v3 韩语多语言更强）。 */
const LANGUAGE_OPTIONS = [
  { value: 'zh', label: '中文', hint: 'SenseVoice 中文识别，中文电视剧首选（默认）' },
  { value: 'ko', label: '韩语', hint: '韩语剧集：SenseVoice 快；追求准确率建议配合 Faster-Whisper large-v3' },
  { value: 'ja', label: '日语', hint: '日语剧集，SenseVoice 支持' },
  { value: 'yue', label: '粤语', hint: '粤语内容，SenseVoice 支持' },
  { value: 'en', label: '英语', hint: 'Faster-Whisper large-v3 英语识别率高' },
  { value: 'auto', label: '自动', hint: '交由后端预检测/引擎自动决定（中文剧集片头易误判，默认不建议）' },
] as const;
type LanguageValue = typeof LANGUAGE_OPTIONS[number]['value'];
const LANGUAGE_VALUES: LanguageValue[] = LANGUAGE_OPTIONS.map((o) => o.value);

export const ASRConfig: React.FC<ASRConfigProps> = ({ isRunning }) => {
  const extractionConfig = useStep1Store((s) => s.extractionConfig);
  const updateExtractionConfig = useStep1Store((s) => s.updateExtractionConfig);

  const whisper: WhisperConfig = extractionConfig?.whisper || { enabled: true, engine: 'sensevoice' };
  // 默认选中中文：仅当显式为 faster-whisper / paraformer 才选中对应项，其余（含旧数据 auto/undefined）一律回退中文
  const currentEngine: EngineValue = whisper.engine === 'faster-whisper'
    ? 'faster-whisper'
    : whisper.engine === 'paraformer'
      ? 'paraformer'
      : 'sensevoice';
  const currentModelSize = whisper.modelSize || 'large-v3';
  // 🎬 方案B：识别语言（缺省按引擎推导：faster-whisper→en，sensevoice/paraformer→zh）
  const currentLanguage: LanguageValue = LANGUAGE_VALUES.includes(whisper.language as LanguageValue)
    ? (whisper.language as LanguageValue)
    : (currentEngine === 'faster-whisper' ? 'en' : 'zh');

  /** 🎬 方案B：同步持久化到全局设置，让「极速导入」沿用同一语言/引擎 */
  const persistAsrDefaults = (engine: EngineValue, language: LanguageValue) => {
    API.system.setSetting('asrEngine', engine).catch(() => { /* fire-and-forget */ });
    API.system.setSetting('asrLanguage', language).catch(() => { /* fire-and-forget */ });
  };

  /** 切换引擎：同时联动语言（中文→SenseVoice + zh，英文→Faster-Whisper + en） */
  const handleEngineChange = (engine: EngineValue) => {
    if (isRunning) return;
    const language: LanguageValue = engine === 'faster-whisper' ? 'en' : 'zh';
    updateExtractionConfig({ whisper: { ...whisper, engine, language } });
    persistAsrDefaults(engine, language);
  };

  /** 🎬 方案B：切换识别语言（auto/中/日/韩/粤/英）。
   *  paraformer 仅支持中文——语言非中文时自动切回 SenseVoice（覆盖中日韩粤），防止中文引擎解韩语乱码。 */
  const handleLanguageChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    if (isRunning) return;
    const lang = e.target.value as LanguageValue;
    const engine: EngineValue = (currentEngine === 'paraformer' && lang !== 'zh') ? 'sensevoice' : currentEngine;
    updateExtractionConfig({ whisper: { ...whisper, engine, language: lang } });
    persistAsrDefaults(engine, lang);
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

      {/* 🎬 方案B：识别语言（auto / 中 / 日 / 韩 / 粤 / 英）——决定 ASR 语种与所用模型 */}
      <div className="flex flex-col gap-1">
        <div className="flex flex-row items-center justify-between gap-2">
          <span className="flex flex-row items-center gap-1.5 text-[12px] text-muted-foreground">
            <Languages size={13} className="shrink-0" />
            识别语言
          </span>
          <select
            value={currentLanguage}
            onChange={handleLanguageChange}
            disabled={isRunning}
            className="bg-muted/30 border border-border/50 rounded-md px-2 py-1 text-[12px] text-foreground outline-none focus:border-accent cursor-pointer disabled:opacity-50"
          >
            {LANGUAGE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
          {LANGUAGE_OPTIONS.find((o) => o.value === currentLanguage)?.hint || ''}
          {currentLanguage === 'ko' && currentEngine === 'faster-whisper'
            ? ' — 韩语 + Faster-Whisper large-v3：多语言大模型，韩剧准确率优先组合。'
            : ''}
        </p>
      </div>

      {/* faster-whisper 模型大小选择（引擎为英文 Faster-Whisper 时显示） */}
      {currentEngine === 'faster-whisper' && (
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