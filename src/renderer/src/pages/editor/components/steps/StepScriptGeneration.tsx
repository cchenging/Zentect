import React, { useState, useCallback } from 'react';
import { useStore } from '../../../../store/useStore';
import { Sliders, RefreshCw, Tag } from 'lucide-react';
import { SCRIPT_STYLES, STEP_SEQUENCES } from '../../utils/pipelineConstants';
import { API } from '../../../../api';
import { mapPipelineResultToState } from '../../hooks/usePipelineResultMapper';
import { Badge, StatHeader, EmptyState } from '../../../../components/shared';

/** 情绪标签选项及对应 Badge variant */
const EMOTION_TAGS: { value: string; label: string; variant: 'danger' | 'warning' | 'success' | 'info' | 'accent' | 'purple' | 'default' }[] = [
  { value: '激昂', label: '激昂', variant: 'danger' },
  { value: '温馨', label: '温馨', variant: 'warning' },
  { value: '紧张', label: '紧张', variant: 'warning' },
  { value: '平静', label: '平静', variant: 'success' },
  { value: '悲伤', label: '悲伤', variant: 'info' },
  { value: '欢快', label: '欢快', variant: 'accent' },
  { value: '悬疑', label: '悬疑', variant: 'purple' },
  { value: '庄重', label: '庄重', variant: 'default' },
];

/** 获取情绪标签的 Badge variant */
const getEmotionVariant = (emotion: string): 'danger' | 'warning' | 'success' | 'info' | 'accent' | 'purple' | 'default' => {
  return EMOTION_TAGS.find(t => t.value === emotion)?.variant || 'default';
};

/** 步骤3：解说文案 - AI 解说文案生成与参数调节，含情绪标签和重新生成 */
export const StepScriptGeneration: React.FC = () => {
  const scriptParagraphs = useStore((s) => s.scriptParagraphs);
  const scriptStyle = useStore((s) => s.scriptStyle);
  const pipelineParams = useStore((s) => s.pipelineParams);
  const pipelineRunning = useStore((s) => s.pipelineRunning);
  const setScriptStyle = useStore((s) => s.setScriptStyle);
  const setPipelineParams = useStore((s) => s.setPipelineParams);
  const updateScriptParagraph = useStore((s) => s.updateScriptParagraph);
  const setScriptParagraphs = useStore((s) => s.setScriptParagraphs);

  const [isRegenerating, setIsRegenerating] = useState(false);

  /** 更新某个段落的情绪标签 */
  const updateParagraphEmotion = useCallback((paragraphId: string, emotion: string) => {
    const state = useStore.getState();
    const updated = state.scriptParagraphs.map((p: any) =>
      p.id === paragraphId ? { ...p, emotion } : p
    );
    setScriptParagraphs(updated);
  }, [setScriptParagraphs]);

  /** 重新生成文案 */
  const handleRegenerate = useCallback(async () => {
    const state = useStore.getState();
    const sequence = STEP_SEQUENCES[3];
    if (!state.projectId || !sequence) return;

    setIsRegenerating(true);
    state.setStepStatus(3, 'running');
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
      state.setStepCompleted(3, true);
      state.setStepStatus(3, 'completed');
    } catch (err: any) {
      state.setStepStatus(3, 'failed');
      state.setPipelineError(err?.message || '重新生成失败');
    } finally {
      state.setPipelineRunning(false);
      setIsRegenerating(false);
    }
  }, []);

  const isGenerating = isRegenerating || pipelineRunning;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="text-[13px] font-semibold">AI 解说文案生成</div>
        {scriptParagraphs.length > 0 && (
          <StatHeader
            value={scriptParagraphs.length}
            unit="个段落"
            secondary={`总时长约 ${Math.ceil(scriptParagraphs.reduce((acc: number, p: any) => acc + (p.duration || 0), 0) / 60)} 分钟`}
          />
        )}
      </div>

      {/* 风格选择 */}
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground shrink-0">风格:</span>
        <select
          value={scriptStyle}
          onChange={(e) => setScriptStyle(e.target.value)}
          disabled={isGenerating}
          className="text-[11px] px-2 py-1 rounded-md bg-bg-secondary border border-border/30 text-foreground outline-none cursor-pointer appearance-none hover:border-accent/40 transition-colors"
        >
          {SCRIPT_STYLES.map(style => (
            <option key={style} value={style}>{style}</option>
          ))}
        </select>
      </div>

      {/* R/S/T/P 参数滑块 */}
      <div className="glass-card-sm p-3 flex flex-col gap-3">
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <Sliders size={12} /> 创作参数
        </div>
        {(['R', 'S', 'T', 'P'] as const).map(param => (
          <div key={param} className="flex items-center gap-3">
            <span className="w-20 text-[11px] text-foreground font-medium shrink-0">
              {param === 'R' ? '经典保留' : param === 'S' ? '原台词保留' : param === 'T' ? 'TTS覆盖' : '节奏因子'}
            </span>
            <input type="range" min={0} max={100} value={pipelineParams[param]} disabled={isGenerating}
              onChange={(e) => setPipelineParams({ ...pipelineParams, [param]: parseInt(e.target.value) })}
              className="flex-1 h-1 accent-accent" />
            <span className="w-8 text-[11px] text-accent font-mono text-right">{pipelineParams[param]}</span>
          </div>
        ))}
      </div>

      {/* 文案段落编辑 */}
      {scriptParagraphs.length > 0 ? (
        <div className="flex flex-col gap-2">
          {scriptParagraphs.map((p: any) => (
            <div key={p.id} className="glass-card-sm p-3">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span className="text-[10px] text-accent font-mono">{p.shotId || p.id}</span>
                <span className="text-[10px] text-muted-foreground">{p.duration ? `${p.duration}s` : ''}</span>
                {/* 情绪标签 */}
                <div className="flex items-center gap-1 ml-auto">
                  <Tag size={10} className="text-muted-foreground" />
                  <select
                    value={p.emotion || ''}
                    onChange={(e) => updateParagraphEmotion(p.id, e.target.value)}
                    className="text-[10px] px-1.5 py-0.5 rounded border outline-none cursor-pointer appearance-none bg-bg-secondary text-muted-foreground"
                    style={{ backgroundImage: 'none' }}
                  >
                    <option value="" className="text-muted-foreground bg-bg-base">无标签</option>
                    {EMOTION_TAGS.map(tag => (
                      <option key={tag.value} value={tag.value}>{tag.label}</option>
                    ))}
                  </select>
                  {p.emotion && (
                    <Badge variant={getEmotionVariant(p.emotion)} className="text-[10px]">{p.emotion}</Badge>
                  )}
                </div>
              </div>
              <textarea value={p.text}
                onChange={(e) => updateScriptParagraph(p.id, e.target.value)}
                className="w-full text-[13px] leading-relaxed bg-transparent outline-none resize-none min-h-[48px]" />
            </div>
          ))}

          {/* 重新生成按钮 */}
          <button
            onClick={handleRegenerate}
            disabled={isGenerating}
            className="flex items-center justify-center gap-2 py-2 rounded-md text-[12px] transition-all cursor-pointer outline-none bg-bg-secondary text-muted-foreground hover:text-foreground hover:bg-bg-secondary/80 disabled:opacity-50"
          >
            <RefreshCw size={14} className={isGenerating ? 'animate-spin' : ''} />
            {isGenerating ? '重新生成中...' : '重新生成'}
          </button>
        </div>
      ) : (
        <EmptyState
          title="解说文案待生成"
          description="执行管线后，AI 生成的解说文案将在此显示，支持逐段编辑与参数调节"
          iconType="text"
          size="md"
          className="glass-card-sm"
        />
      )}
    </div>
  );
};