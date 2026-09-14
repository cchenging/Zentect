// Module: pipeline/step1-material - ASRConfig
// ASR 引擎 + faster-whisper 模型大小配置面板
// 🔧 去硬编码：faster-whisper 模型大小不再固定 large-v3，改为前端可配置透传

import React, { useEffect, useMemo, useState } from 'react';
import { Cpu, Target, Languages, Loader2 } from 'lucide-react';
import { useStep1Store } from '@modules/pipeline/stores/useStep1Store';
import { API } from '@renderer/api';
// 下拉美化：shadcn Select（Radix，定制外观，替代系统原生白底 select 弹层）
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@renderer/components/ui/select';
// 从 store 的 ExtractionConfig 派生 whisper 配置类型（含 modelSize）
// 🔧 去 sensevoice：ASR 引擎二选一 —— 中文(Paraformer) / 多语言(Faster-Whisper)。SenseVoice 已删除（2026-09-14）
type WhisperConfig = { enabled: boolean; engine: 'paraformer' | 'faster-whisper'; language?: string; modelSize?: string };

interface ASRConfigProps {
  isRunning?: boolean;
}

/** ASR 引擎选项：2 选 1 单控件（中文 / 多语言） */
const ENGINE_OPTIONS = [
  {
    value: 'paraformer' as const,
    label: '中文',
    desc: 'Paraformer',
    Icon: Target,
    hint: '基于 FunASR + fsmn-vad，880MB 高精度中文引擎，支持热词纠错专名错别字。中文电视剧场景首选（默认）。',
  },
  {
    value: 'faster-whisper' as const,
    label: '多语言',
    desc: 'Faster-Whisper',
    Icon: Cpu,
    hint: '基于 CTranslate2，韩语/日语/粤语/英语等多语言识别（韩语等亚洲语言推荐 large-v3-turbo）。模型大小可在下方选择。',
  },
] as const;

type EngineValue = typeof ENGINE_OPTIONS[number]['value'];

/** faster-whisper 模型大小：效果与效率权衡 */
const MODEL_SIZE_OPTIONS = [
  { value: 'tiny', label: 'tiny', hint: '最快，精度最低（英文 WER 偏高）' },
  { value: 'base', label: 'base', hint: '较快，精度一般' },
  { value: 'small', label: 'small', hint: '速度与精度均衡' },
  { value: 'medium', label: 'medium', hint: '较慢，精度高' },
  // 🎬 2026-09-09 方案A：新增 large-v3-turbo（809M，decoder 4 层），
  //   韩语等亚洲语言精度接近 large-v3（CER ~2%），速度约快 2–8 倍，CPU 韩剧首选。
  { value: 'large-v3-turbo', label: 'large-v3-turbo', hint: '精度接近 large-v3、快约 2–8 倍（韩语/亚洲语言推荐）' },
  { value: 'large-v3', label: 'large-v3', hint: '最慢，精度最高（默认）' },
] as const;

/** 🎬 方案B（2026-09-08）识别语言：独立于引擎选择，决定 ASR 语种与所用模型。
 *  Paraformer 仅支持中文；韩语/日语/粤语/英语等多语言交给 Faster-Whisper。
 *  韩剧要更高准确率：语言=韩语 + 引擎=Faster-Whisper（large-v3-turbo 韩语多语言更强）。 */
const LANGUAGE_OPTIONS = [
  { value: 'zh', label: '中文', hint: 'Paraformer 中文识别，中文电视剧首选（默认）' },
  { value: 'ko', label: '韩语', hint: '韩语剧集：推荐配合 Faster-Whisper large-v3-turbo，速度快且准确率高' },
  { value: 'ja', label: '日语', hint: '日语剧集，使用 Faster-Whisper 识别' },
  { value: 'yue', label: '粤语', hint: '粤语内容，使用 Faster-Whisper 识别' },
  { value: 'en', label: '英语', hint: 'Faster-Whisper large-v3 英语识别率高' },
  { value: 'auto', label: '自动', hint: '交由后端预检测/引擎自动决定（中文剧集片头易误判，默认不建议）' },
] as const;
type LanguageValue = typeof LANGUAGE_OPTIONS[number]['value'];
const LANGUAGE_VALUES: LanguageValue[] = LANGUAGE_OPTIONS.map((o) => o.value);

export const ASRConfig: React.FC<ASRConfigProps> = ({ isRunning }) => {
  const extractionConfig = useStep1Store((s) => s.extractionConfig);
  const updateExtractionConfig = useStep1Store((s) => s.updateExtractionConfig);

  // 🎬 动态已下载模型清单：磁盘 `resources/models/faster_whisper/{size}/` 实际存在的尺寸才可选
  //   null = 拉取中；Set<string> = 已下载的 size（目录名）；空集 = 无已下载模型
  const [downloadedSizes, setDownloadedSizes] = useState<Set<string> | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list: any[] = await API.model.getModuleList();
        if (!alive) return;
        const fw = (list || []).find((m) => m.id === 'faster_whisper');
        const sizes = new Set<string>();
        for (const m of fw?.models || []) {
          // 模型 id `faster_whisper_large_v3` → size `large-v3`（目录名，与后端 get_faster_whisper(model_size) 一致）
          if (m.status === 'downloaded') sizes.add(String(m.id).replace('faster_whisper_', '').replace(/_/g, '-'));
        }
        setDownloadedSizes(sizes);
      } catch (e) {
        if (!alive) return;
        // 拉取失败：如实置空（不伪造列表），由下拉呈现「无已下载模型」，避免掩盖真实状态
        setDownloadedSizes(new Set());
        console.error('[ASRConfig] 读取已下载 whisper 模型失败:', e);
      }
    })();
    return () => { alive = false; };
  }, []);

  // 候选渲染集 = 完整目录里「已下载」的项（tiny/base/small/medium 无对应模型文件定义，天然不出现）
  const modelSizeOptions = useMemo(() => {
    if (!downloadedSizes) return [];
    return MODEL_SIZE_OPTIONS.filter((o) => downloadedSizes.has(o.value));
  }, [downloadedSizes]);

  const whisper: WhisperConfig = extractionConfig?.whisper || { enabled: true, engine: 'paraformer' };
  // 默认选中中文：仅当显式为 faster-whisper 才选中对应项，其余（含旧数据 sensevoice/auto/undefined）一律回退 paraformer
  const currentEngine: EngineValue = whisper.engine === 'faster-whisper'
    ? 'faster-whisper'
    : 'paraformer';
  // 当前实际渲染的模型：存储值若不在已下载集（磁盘缺失则无法用），落到首个已下载项；
  //   列表为空（无任何已下载模型）时仍显示存储值，交由 UI 呈现「无可用模型」
  const storedModelSize = whisper.modelSize || 'large-v3';
  const currentModelSize = (downloadedSizes && downloadedSizes.has(storedModelSize) && storedModelSize)
    || (modelSizeOptions[0]?.value)
    || storedModelSize;
  // 🎬 方案B：识别语言（缺省按引擎推导：faster-whisper→en，paraformer→zh）
  const currentLanguage: LanguageValue = LANGUAGE_VALUES.includes(whisper.language as LanguageValue)
    ? (whisper.language as LanguageValue)
    : (currentEngine === 'faster-whisper' ? 'en' : 'zh');

  /** 🎬 方案B：同步持久化到全局设置，让「极速导入」沿用同一语言/引擎 */
  const persistAsrDefaults = (engine: EngineValue, language: LanguageValue) => {
    API.system.setSetting('asrEngine', engine).catch(() => { /* fire-and-forget */ });
    API.system.setSetting('asrLanguage', language).catch(() => { /* fire-and-forget */ });
  };

  /** 切换引擎：同时联动语言（中文→Paraformer + zh，多语言→Faster-Whisper + en） */
  const handleEngineChange = (engine: EngineValue) => {
    if (isRunning) return;
    const language: LanguageValue = engine === 'faster-whisper' ? 'en' : 'zh';
    updateExtractionConfig({ whisper: { ...whisper, engine, language } });
    persistAsrDefaults(engine, language);
  };

  /** 🎬 方案B：切换识别语言（auto/中/日/韩/粤/英）。
   *  paraformer 仅支持中文——语言非中文时自动切到 Faster-Whisper，防止中文引擎解外文乱码。 */
  const handleLanguageChange = (value: string) => {
    if (isRunning) return;
    const lang = value as LanguageValue;
    const engine: EngineValue = (currentEngine === 'paraformer' && lang !== 'zh') ? 'faster-whisper' : currentEngine;
    updateExtractionConfig({ whisper: { ...whisper, engine, language: lang } });
    persistAsrDefaults(engine, lang);
  };

  /** 切换 faster-whisper 模型大小 */
  const handleModelSizeChange = (value: string) => {
    if (isRunning) return;
    updateExtractionConfig({ whisper: { ...whisper, modelSize: value } });
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
          <Select value={currentLanguage} onValueChange={handleLanguageChange} disabled={isRunning}>
            <SelectTrigger className="h-8 w-auto min-w-[130px] bg-muted/30 border-border/50 text-[12px] focus:border-accent focus:ring-accent/30">
              <SelectValue placeholder="选择语言" />
            </SelectTrigger>
            <SelectContent>
              {LANGUAGE_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
          {LANGUAGE_OPTIONS.find((o) => o.value === currentLanguage)?.hint || ''}
          {currentLanguage === 'ko' && currentEngine === 'faster-whisper'
            ? ' — 韩语 + Faster-Whisper：多语言大模型（推荐 large-v3-turbo），韩剧准确率优先组合。'
            : ''}
        </p>
      </div>

      {/* faster-whisper 模型大小选择（引擎为多语言 Faster-Whisper 时显示）——仅列已下载模型 */}
      {currentEngine === 'faster-whisper' && (
        <div className="flex flex-col gap-1">
          <div className="flex flex-row items-center justify-between gap-2">
            <span className="text-[12px] text-muted-foreground">Faster-Whisper 模型</span>
            <Select value={currentModelSize} onValueChange={handleModelSizeChange} disabled={isRunning || downloadedSizes === null}>
              <SelectTrigger className="h-8 w-auto min-w-[150px] bg-muted/30 border-border/50 text-[12px] focus:border-accent focus:ring-accent/30">
                {downloadedSizes === null ? (
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <Loader2 size={12} className="animate-spin" />
                    读取中…
                  </span>
                ) : (
                  <SelectValue placeholder="无已下载模型" />
                )}
              </SelectTrigger>
              <SelectContent>
                {modelSizeOptions.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
            {modelSizeHint ? `${modelSizeHint} — ` : ''}
            下拉仅显示磁盘已下载的模型（到「模型管理 → 语音识别」下载更多）；改小可显著提升速度（需重新识别生效）。
          </p>
        </div>
      )}

      <p className="text-[11px] text-muted-foreground/70 leading-relaxed bg-muted/30 p-2 rounded border border-border/30">
        {activeHint}
      </p>
    </div>
  );
};