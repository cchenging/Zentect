import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useStore } from '../../../../store/useStore';
import { Play, Square, Volume2, Mic, ChevronDown, User } from 'lucide-react';
import { STEP_SEQUENCES } from '../../utils/pipelineConstants';
import { API } from '../../../../api';
import { mapPipelineResultToState } from '../../hooks/usePipelineResultMapper';
import { Badge, Progress, StatHeader, EmptyState } from '../../../../components/shared';
import { VoiceCard } from '../../../../components/shared/VoiceCard';
import { AppNotifier } from '../../../../core/AppNotifier';

/** 各引擎的默认音色列表（MOSS 使用官方 16 种预设音色） */
const VOICE_OPTIONS: Record<string, Array<{ id: string; name: string; lang: string }>> = {
  edge: [
    { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓', lang: '中文·女' },
    { id: 'zh-CN-YunxiNeural', name: '云希', lang: '中文·男' },
    { id: 'zh-CN-YunyangNeural', name: '云扬', lang: '中文·男·新闻' },
    { id: 'zh-CN-XiaoyiNeural', name: '晓伊', lang: '中文·女' },
    { id: 'zh-CN-YunjianNeural', name: '云健', lang: '中文·男·体育' },
    { id: 'zh-CN-XiaochenNeural', name: '晓辰', lang: '中文·女·温柔' },
  ],
  moss: [
    { id: 'Junhao', name: '俊豪', lang: '中文·男' },
    { id: 'Zhiming', name: '志明', lang: '中文·男' },
    { id: 'Weiguo', name: '卫国', lang: '中文·男' },
    { id: 'Xiaoyu', name: '小雨', lang: '中文·女' },
    { id: 'Yuewen', name: '悦文', lang: '中文·女' },
    { id: 'Lingyu', name: '灵语', lang: '中文·女' },
    { id: 'Ava', name: 'Ava', lang: '英文·女' },
    { id: 'Bella', name: 'Bella', lang: '英文·女' },
    { id: 'Adam', name: 'Adam', lang: '英文·男' },
    { id: 'Nathan', name: 'Nathan', lang: '英文·男' },
    { id: 'Trump', name: 'Trump', lang: '英文·特型' },
    { id: 'Sakura', name: 'Sakura', lang: '日文·女' },
    { id: 'Yui', name: 'Yui', lang: '日文·女' },
    { id: 'Aoi', name: 'Aoi', lang: '日文·女' },
    { id: 'Hina', name: 'Hina', lang: '日文·女' },
    { id: 'Mei', name: 'Mei', lang: '日文·女' },
  ],
  doubao: [
    { id: 'zh_female_meilinvyou_saturn_bigtts', name: '美女主播', lang: '中文·女' },
    { id: 'zh_male_shaunglangxueke_moon_bigtts', name: '爽朗学科', lang: '中文·男' },
    { id: 'zh_female_vv_uranus_bigtts', name: 'vv 女声', lang: '中文·女' },
    { id: 'zh_male_dashu_saturn_bigtts', name: '大叔', lang: '中文·男' },
  ],
  fish: [
    { id: 'default', name: '默认音色', lang: '通用' },
  ],
  sovits: [
    { id: 'default', name: '本地音色', lang: '通用' },
  ],
};

/** 引擎显示名称映射 */
const ENGINE_LABELS: Record<string, string> = {
  edge: 'Edge TTS',
  moss: 'MOSS',
  doubao: '火山引擎',
  fish: 'Fish Audio',
  sovits: 'SoVITS',
};

/** 步骤4：配音合成 - TTS引擎选择、音色选择、逐段试听与合成触发 */
export const StepTTSSynthesis: React.FC = () => {
  const ttsEngine = useStore((s) => s.ttsEngine);
  const ttsVoiceId = useStore((s) => s.ttsVoiceId);
  const ttsProgress = useStore((s) => s.ttsProgress);
  const ttsResults = useStore((s) => s.ttsResults);
  const scriptParagraphs = useStore((s) => s.scriptParagraphs);
  const pipelineRunning = useStore((s) => s.pipelineRunning);
  const setTtsEngine = useStore((s) => s.setTtsEngine);
  const setTtsVoiceId = useStore((s) => s.setTtsVoiceId);

  /** 语速倍率（0.5x ~ 2.0x） */
  const [speechRate, setSpeechRate] = useState(1.0);
  /** 当前正在播放的段落索引（用索引而非 shotId，避免重复 shotId 导致多段同时高亮） */
  const [playingIdx, setPlayingIdx] = useState<number | null>(null);
  /** 是否正在合成中 */
  const [isSynthesizing, setIsSynthesizing] = useState(false);
  /** 音频对象引用 */
  const audioRef = useRef<HTMLAudioElement | null>(null);
  /** 克隆音色列表 */
  const [clonedVoices, setClonedVoices] = useState<Array<{ id: string; name: string }>>([]);
  /** 音色试听加载中 */
  const [previewingVoiceId, setPreviewingVoiceId] = useState<string | null>(null);

  /** 加载克隆音色列表 */
  useEffect(() => {
    if (ttsEngine === 'sovits' || ttsEngine === 'fish') {
      API.voice.getClonedVoices()
        .then((res: any) => {
          if (res?.voices && Array.isArray(res.voices)) {
            setClonedVoices(res.voices.map((v: any) => ({ id: v.id, name: v.name })));
          }
        })
        .catch(() => {});
    } else {
      setClonedVoices([]);
    }
  }, [ttsEngine]);

  /** 获取当前引擎的音色列表（含克隆音色） */
  const currentVoices = [...(VOICE_OPTIONS[ttsEngine] || [])];
  if (clonedVoices.length > 0) {
    currentVoices.push(...clonedVoices.map(v => ({ id: v.id, name: v.name, lang: '克隆' })));
  }

  /** 音色试听默认示例文本（根据音色语言自动匹配） */
  const DEFAULT_PREVIEW_TEXT = '欢迎使用 Zentect 智能剪辑，这是一段语音合成测试。';
  const PREVIEW_TEXT_MAP: Record<string, string> = {
    zh: '欢迎使用 Zentect 智能剪辑，这是一段语音合成测试。',
    en: 'Welcome to Zentect, this is a voice synthesis preview.',
    ja: 'Zentectへようこそ、これは音声合成のテストです。',
  };

  /** 根据音色 ID 推断语言并返回对应的试听文本 */
  const getPreviewText = useCallback((voiceId: string): string => {
    // MOSS 英文音色
    if (['Ava', 'Bella', 'Adam', 'Nathan', 'Trump'].includes(voiceId)) return PREVIEW_TEXT_MAP.en;
    // MOSS 日文音色
    if (['Sakura', 'Yui', 'Aoi', 'Hina', 'Mei'].includes(voiceId)) return PREVIEW_TEXT_MAP.ja;
    // Edge 英文音色
    if (voiceId.startsWith('en-')) return PREVIEW_TEXT_MAP.en;
    // Edge 日文音色
    if (voiceId.startsWith('ja-')) return PREVIEW_TEXT_MAP.ja;
    // 默认中文
    return PREVIEW_TEXT_MAP.zh;
  }, []);

  /** 停止当前播放 */
  const stopAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    setPlayingIdx(null);
  }, []);

  /** 试听指定段落的合成音频（用索引定位，避免 shotId 重复） */
  const handlePreview = useCallback((idx: number, audioUrl: string) => {
    if (!audioUrl) return;
    if (playingIdx === idx) {
      stopAudio();
      return;
    }
    stopAudio();
    const audio = new Audio(audioUrl);
    audio.playbackRate = speechRate;
    audioRef.current = audio;
    audio.play().catch(() => {});
    setPlayingIdx(idx);
    audio.onended = () => setPlayingIdx(null);
    audio.onerror = () => setPlayingIdx(null);
  }, [playingIdx, speechRate, stopAudio]);

  /** 试听音色（使用示例文本，自动匹配语言） */
  const handleVoicePreview = useCallback(async (voiceId: string) => {
    if (previewingVoiceId) return;
    setPreviewingVoiceId(voiceId);
    try {
      const previewText = getPreviewText(voiceId);
      const result = await API.voice.preview(ttsEngine, voiceId, previewText);
      console.log('[TTS试听] IPC返回:', result);
      if (result?.audioPath) {
        stopAudio();
        let audioUrl = result.audioPath;
        if (!audioUrl.startsWith('http') && !audioUrl.startsWith('magic://')) {
          // 使用 magic://local/ 前缀，host 为 local 不会被拼接到路径
          audioUrl = `magic://local/${audioUrl.replace(/\\/g, '/')}`;
        }
        console.log('[TTS试听] 播放URL:', audioUrl);
        const audio = new Audio(audioUrl);
        audioRef.current = audio;
        audio.play().catch((err) => {
          console.error('[TTS试听] 播放失败:', err);
          AppNotifier.error(`音频播放失败: ${err.message || '未知错误'}`);
          setPreviewingVoiceId(null);
        });
        audio.onended = () => { setPlayingIdx(null); setPreviewingVoiceId(null); };
        audio.onerror = (err) => {
          console.error('[TTS试听] 音频加载错误:', err);
          AppNotifier.error('音频加载失败，请检查文件路径');
          setPreviewingVoiceId(null);
        };
        return; // 成功播放，等 onended 清除状态
      } else {
        console.warn('[TTS试听] IPC返回无audioPath:', result);
        AppNotifier.warning('试听失败：未获取到音频文件');
      }
    } catch (e: any) {
      console.error('[TTS试听] 异常:', e);
      AppNotifier.error(`音色试听失败: ${e.message || '未知错误'}`);
    }
    // 失败或无音频时清除状态
    setPreviewingVoiceId(null);
  }, [ttsEngine, previewingVoiceId, stopAudio, getPreviewText]);

  /** 开始合成所有段落 */
  const handleSynthesize = useCallback(async () => {
    const state = useStore.getState();
    const sequence = STEP_SEQUENCES[4];
    if (!state.projectId || !sequence) return;

    /** 前置检查：确保有剧本文本 */
    if (!state.scriptParagraphs || state.scriptParagraphs.length === 0) {
      AppNotifier.warning('请先完成步骤3「解说文案」生成，再执行配音合成');
      return;
    }

    setIsSynthesizing(true);
    state.setStepStatus(4, 'running');
    state.setPipelineRunning(true);
    state.resetPipeline();

    try {
      const enrichedSequence = sequence.map(node => ({
        ...node,
        params: {
          ...(node.params || {}),
          ttsEngine: state.ttsEngine || 'edge',
          voiceId: state.ttsVoiceId || '',
          mediaPath: state.mediaItems?.[0]?.filePath || '',
          /** 注入步骤3的解说文案，供 TTSStrategy 逐段合成 */
          scriptShots: state.scriptParagraphs || [],
        },
      }));
      const result = await API.engine.runPipeline({
        projectId: state.projectId,
        sequence: enrichedSequence,
        sourceMedia: state.mediaItems?.[0]?.filePath || '',
      });
      if (result) {
        mapPipelineResultToState(result?.data || result, useStore.getState());
      }
      state.setStepCompleted(4, true);
      state.setStepStatus(4, 'completed');
    } catch (err: any) {
      state.setStepStatus(4, 'failed');
      state.setPipelineError(err?.message || '配音合成失败');
    } finally {
      state.setPipelineRunning(false);
      setIsSynthesizing(false);
    }
  }, []);

  const isProcessing = isSynthesizing || pipelineRunning;

  /** 段落状态标签文本 */
  const statusLabel = (status: string | null) => {
    if (status === 'completed') return '可试听';
    if (status === 'processing') return '合成中';
    if (status === 'failed') return '失败';
    return '待合成';
  };

  /** 统计合成结果 */
  const successCount = ttsResults.filter((r: any) => r.audioUrl && !r._failed).length;
  const failedCount = ttsResults.filter((r: any) => r._failed || !r.audioUrl).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="text-[13px] font-semibold">TTS 配音合成</div>
        {scriptParagraphs.length > 0 && (
          <StatHeader
            value={scriptParagraphs.length}
            unit="段配音"
            secondary={ENGINE_LABELS[ttsEngine] || ttsEngine}
          />
        )}
      </div>

      {/* TTS 引擎选择 */}
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground shrink-0">引擎:</span>
        <div className="flex items-center gap-1 flex-wrap">
          {(['edge', 'moss', 'doubao', 'fish', 'sovits'] as const).map(eng => (
            <Badge
              key={eng}
              variant={ttsEngine === eng ? 'accent' : 'default'}
              interactive="selectable"
              selected={ttsEngine === eng}
              onClick={() => setTtsEngine(eng)}
              disabled={isProcessing}
            >
              {ENGINE_LABELS[eng] || eng}
            </Badge>
          ))}
        </div>
      </div>

      {/* 音色选择 — 小卡片多列布局 */}
      <div className="glass-card-sm p-3">
        <div className="flex items-center gap-2 mb-2 text-[11px] text-muted-foreground">
          <User size={12} /> 音色选择
        </div>
        <div className="grid grid-cols-3 gap-1.5 max-h-[200px] overflow-y-auto">
          {currentVoices.map(voice => (
            <VoiceCard
              key={voice.id}
              id={voice.id}
              name={voice.name}
              lang={voice.lang}
              selected={ttsVoiceId === voice.id}
              isPreviewing={previewingVoiceId === voice.id}
              onSelect={setTtsVoiceId}
              onPreview={handleVoicePreview}
            />
          ))}
          {currentVoices.length === 0 && (
            <div className="col-span-3 text-[10px] text-muted-foreground py-1">No voices available</div>
          )}
        </div>
      </div>

      {/* 语速调节滑块 */}
      <div className="glass-card-sm p-3">
        <div className="flex items-center gap-2 mb-2 text-[11px] text-muted-foreground">
          <Volume2 size={12} /> 语速调节
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-muted-foreground">0.5x</span>
          <input type="range" min={0.5} max={2.0} step={0.1} value={speechRate}
            onChange={(e) => setSpeechRate(parseFloat(e.target.value))}
            className="flex-1 h-1 accent-accent-cyan" />
          <span className="text-[10px] text-accent-cyan font-mono w-8 text-right">{speechRate.toFixed(1)}x</span>
        </div>
      </div>

      {/* TTS 合成进度 */}
      {scriptParagraphs.length > 0 && (
        <Progress value={ttsProgress} color="cyan" size="sm" showLabel />
      )}

      {/* 合成结果统计 */}
      {ttsResults.length > 0 && (
        <div className="flex items-center gap-3 text-[10px]">
          <span className="text-accent-green">{successCount} 段成功</span>
          {failedCount > 0 && <span className="text-accent-rose">{failedCount} 段失败</span>}
        </div>
      )}

      {/* 段落试听列表 */}
      {scriptParagraphs.length > 0 ? (
        <div className="flex flex-col gap-2">
          <div className="text-[12px] font-semibold flex items-center gap-2">
            <Mic size={14} />
            逐段试听
          </div>
          {scriptParagraphs.map((p: any, idx: number) => {
            /** 用索引直接定位 ttsResults，避免重复 shotId 导致 find() 总返回第一条 */
            const result: any = ttsResults[idx] || null;
            const pId = p.shotId || p.id || `para_${idx}`;
            const status = result ? (result._failed ? 'failed' : result.audioUrl ? 'completed' : 'failed') : null;
            const isPlaying = playingIdx === idx;

            return (
              <div key={`tts-para-${idx}-${pId}`} className="glass-card-sm p-2.5 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-accent font-mono shrink-0">{p.shotId || p.id}</span>
                    <Badge variant={status === 'completed' ? 'success' : status === 'failed' ? 'danger' : 'default'}>
                      {statusLabel(status)}
                    </Badge>
                    {p.duration && (
                      <span className="text-[10px] text-muted-foreground">{p.duration}s</span>
                    )}
                  </div>
                  <div className="text-[11px] text-foreground truncate mt-0.5">{p.text}</div>
                </div>
                <button
                  onClick={() => result?.audioUrl && handlePreview(idx, result.audioUrl)}
                  disabled={!result?.audioUrl || result._failed || isProcessing}
                  title={isPlaying ? '停止' : '试听'}
                  className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-all cursor-pointer outline-none ${
                    isPlaying
                      ? 'bg-accent/15 text-accent'
                      : result?.audioUrl && !result._failed
                        ? 'bg-accent-cyan/10 text-accent-cyan hover:bg-accent-cyan/20'
                        : 'bg-muted/20 text-muted-foreground/30 cursor-not-allowed'
                  }`}
                >
                  {isPlaying ? <Square size={14} /> : <Play size={14} />}
                </button>
              </div>
            );
          })}

          {/* 合成按钮 */}
          <button
            onClick={handleSynthesize}
            disabled={isProcessing}
            className="flex items-center justify-center gap-2 py-2 rounded-md text-[12px] transition-all cursor-pointer outline-none bg-accent-cyan/10 text-accent-cyan hover:bg-accent-cyan/20 disabled:opacity-50 font-medium"
          >
            <Mic size={14} className={isProcessing ? 'animate-pulse' : ''} />
            {isProcessing ? '合成中...' : '开始合成'}
          </button>
        </div>
      ) : (
        <EmptyState
          title="配音待合成"
          description="文案确认后，TTS 引擎将逐段合成配音，支持试听与重新生成"
          iconType="audio"
          size="md"
          className="glass-card-sm"
        />
      )}
    </div>
  );
};
