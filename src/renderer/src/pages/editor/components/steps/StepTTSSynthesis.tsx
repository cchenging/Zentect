import React, { useState, useCallback, useRef } from 'react';
import { useStore } from '../../../../store/useStore';
import { Play, Square, Volume2, Mic } from 'lucide-react';
import { STEP_SEQUENCES } from '../../utils/pipelineConstants';
import { API } from '../../../../api';
import { mapPipelineResultToState } from '../../hooks/usePipelineResultMapper';
import { Badge, Progress, StatHeader, EmptyState } from '../../../../components/shared';

/** 步骤4：配音合成 - TTS引擎选择、逐段试听、语速调节与合成触发 */
export const StepTTSSynthesis: React.FC = () => {
  const ttsEngine = useStore((s) => s.ttsEngine);
  const ttsProgress = useStore((s) => s.ttsProgress);
  const ttsResults = useStore((s) => s.ttsResults);
  const scriptParagraphs = useStore((s) => s.scriptParagraphs);
  const pipelineRunning = useStore((s) => s.pipelineRunning);
  const setTtsEngine = useStore((s) => s.setTtsEngine);

  /** 语速倍率（0.5x ~ 2.0x） */
  const [speechRate, setSpeechRate] = useState(1.0);
  /** 当前正在播放的段落ID */
  const [playingId, setPlayingId] = useState<string | null>(null);
  /** 是否正在合成中 */
  const [isSynthesizing, setIsSynthesizing] = useState(false);
  /** 音频对象引用 */
  const audioRef = useRef<HTMLAudioElement | null>(null);

  /** 停止当前播放 */
  const stopAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    setPlayingId(null);
  }, []);

  /** 试听指定段落的合成音频 */
  const handlePreview = useCallback((result: any) => {
    if (!result?.audioUrl) return;
    if (playingId === result.shotId) {
      stopAudio();
      return;
    }
    stopAudio();
    const audio = new Audio(result.audioUrl);
    audio.playbackRate = speechRate;
    audioRef.current = audio;
    audio.play().catch(() => {});
    setPlayingId(result.shotId);
    audio.onended = () => setPlayingId(null);
    audio.onerror = () => setPlayingId(null);
  }, [playingId, speechRate, stopAudio]);

  /** 开始合成所有段落 */
  const handleSynthesize = useCallback(async () => {
    const state = useStore.getState();
    const sequence = STEP_SEQUENCES[4];
    if (!state.projectId || !sequence) return;

    setIsSynthesizing(true);
    state.setStepStatus(4, 'running');
    state.setPipelineRunning(true);
    state.resetPipeline();

    try {
      const result = await API.engine.runPipeline({
        projectId: state.projectId,
        sequence,
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

  /** 获取段落的合成状态 */
  const getTtsStatus = (shotId: string) => {
    const found = ttsResults.find((r: any) => r.shotId === shotId);
    if (!found) return null;
    if (found.audioUrl) return 'completed';
    if (found.status) return found.status;
    return 'completed';
  };

  /** 段落状态标签文本 */
  const statusLabel = (status: string | null) => {
    if (status === 'completed') return '可试听';
    if (status === 'processing') return '合成中';
    if (status === 'failed') return '失败';
    return '待合成';
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="text-[13px] font-semibold">TTS 配音合成</div>
        {scriptParagraphs.length > 0 && (
          <StatHeader
            value={scriptParagraphs.length}
            unit="段配音"
            secondary={ttsEngine === 'edge' ? 'Edge TTS' : ttsEngine === 'moss' ? 'MOSS' : ttsEngine === 'doubao' ? '火山引擎' : 'Fish Audio'}
          />
        )}
      </div>

      {/* TTS 引擎选择 */}
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground shrink-0">引擎:</span>
        <div className="flex items-center gap-1">
          {(['edge', 'moss', 'doubao', 'fish'] as const).map(eng => (
            <Badge
              key={eng}
              variant={ttsEngine === eng ? 'accent' : 'default'}
              interactive="selectable"
              selected={ttsEngine === eng}
              onClick={() => setTtsEngine(eng)}
              disabled={isProcessing}
            >
              {eng === 'edge' ? 'Edge TTS' : eng === 'moss' ? 'MOSS' : eng === 'doubao' ? '火山引擎' : 'Fish Audio'}
            </Badge>
          ))}
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

      {/* 段落试听列表 */}
      {scriptParagraphs.length > 0 ? (
        <div className="flex flex-col gap-2">
          <div className="text-[12px] font-semibold flex items-center gap-2">
            <Mic size={14} />
            逐段试听
          </div>
          {scriptParagraphs.map((p: any) => {
            const result = ttsResults.find((r: any) => r.shotId === p.id || r.shotId === p.shotId);
            const status = getTtsStatus(p.id);
            const isPlaying = playingId === p.id;

            return (
              <div key={p.id} className="glass-card-sm p-2.5 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-accent font-mono shrink-0">{p.shotId || p.id}</span>
                    <Badge variant={status === 'completed' ? 'success' : status === 'processing' ? 'accent' : status === 'failed' ? 'danger' : 'default'}>
                      {statusLabel(status)}
                    </Badge>
                    {p.duration && (
                      <span className="text-[10px] text-muted-foreground">{p.duration}s</span>
                    )}
                  </div>
                  <div className="text-[11px] text-foreground truncate mt-0.5">{p.text}</div>
                </div>
                <button
                  onClick={() => result && handlePreview(result)}
                  disabled={!result || !result.audioUrl || isProcessing}
                  title={isPlaying ? '停止' : '试听'}
                  className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-all cursor-pointer outline-none ${
                    isPlaying
                      ? 'bg-accent/15 text-accent'
                      : result?.audioUrl
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