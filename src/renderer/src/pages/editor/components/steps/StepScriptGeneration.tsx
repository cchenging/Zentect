import React, { useState, useCallback, useMemo } from 'react';
import { useStore } from '../../../../store/useStore';
import { Sliders, RefreshCw, Tag, AlertTriangle, Search, Image } from 'lucide-react';
import { SCRIPT_STYLES, STEP_SEQUENCES } from '../../utils/pipelineConstants';
import { API } from '../../../../api';
import { mapPipelineResultToState } from '../../hooks/usePipelineResultMapper';
import { Badge, StatHeader, EmptyState } from '../../../../components/shared';
import { ParameterSlider } from '../../../../components/shared/ParameterSlider';
import { predictSpeechCapacity, type OverflowLevel } from '../../utils/speechPredictor';
import { diffParagraphs, applyDiffUpdate } from '../../utils/scriptDiffTree';
import { findBestVisionMatches, type MatchCandidate } from '../../utils/bidirectionalMatcher';

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

/** 溢出级别到颜色的映射 */
const overflowColorMap: Record<OverflowLevel, string> = {
  safe: 'text-accent-green',
  warning: 'text-warning',
  overflow: 'text-accent-rose',
};

/** 溢出级别到边框的映射 */
const overflowBorderMap: Record<OverflowLevel, string> = {
  safe: '',
  warning: 'border-l-2 border-l-warning',
  overflow: 'border-l-2 border-l-accent-rose',
};

/** 语速选项 */
const SPEECH_RATE_OPTIONS = [
  { value: 5.5, label: '5.5 字/秒 (极快)', desc: '信息密集，适合快节奏解说' },
  { value: 5.0, label: '5.0 字/秒 (较快)', desc: '节奏紧凑，干货多' },
  { value: 4.5, label: '4.5 字/秒 (标准)', desc: '正常解说节奏（推荐）' },
  { value: 4.0, label: '4.0 字/秒 (较慢)', desc: '舒缓稳健' },
  { value: 3.5, label: '3.5 字/秒 (舒缓)', desc: '娓娓道来，适合情感叙事' },
];

/** 步骤3：解说文案 - AI 解说文案生成与参数调节，含语速预测、差异更新、双向检索 */
export const StepScriptGeneration: React.FC = () => {
  const scriptParagraphs = useStore((s) => s.scriptParagraphs);
  const scriptStyle = useStore((s) => s.scriptStyle);
  const speechRate = useStore((s) => s.speechRate);
  const pipelineParams = useStore((s) => s.pipelineParams);
  const pipelineRunning = useStore((s) => s.pipelineRunning);
  const vlmFrames = useStore((s) => s.vlmFrames);
  const setScriptStyle = useStore((s) => s.setScriptStyle);
  const setSpeechRate = useStore((s) => s.setSpeechRate);
  const setPipelineParams = useStore((s) => s.setPipelineParams);
  const updateScriptParagraph = useStore((s) => s.updateScriptParagraph);
  const setScriptParagraphs = useStore((s) => s.setScriptParagraphs);

  const [isRegenerating, setIsRegenerating] = useState(false);
  /** 正在检索匹配画面的段落 ID */
  const [matchingParagraphId, setMatchingParagraphId] = useState<string | null>(null);
  /** 检索结果缓存：paragraphId -> MatchCandidate[] */
  const [matchResults, setMatchResults] = useState<Record<string, MatchCandidate[]>>({});

  /** 对每个段落进行语速容量预测（memoized） */
  const predictions = useMemo(() => {
    const map: Record<string, ReturnType<typeof predictSpeechCapacity>> = {};
    for (const p of scriptParagraphs) {
      const id = p.id || p.shotId;
      map[id] = predictSpeechCapacity(p.text || '', p.duration || 3);
    }
    return map;
  }, [scriptParagraphs]);

  /** 统计溢出情况 */
  const overflowStats = useMemo(() => {
    let safe = 0, warning = 0, overflow = 0;
    for (const pred of Object.values(predictions)) {
      if (pred.overflowLevel === 'safe') safe++;
      else if (pred.overflowLevel === 'warning') warning++;
      else overflow++;
    }
    return { safe, warning, overflow };
  }, [predictions]);

  /** 更新某个段落的情绪标签 */
  const updateParagraphEmotion = useCallback((paragraphId: string, emotion: string) => {
    const state = useStore.getState();
    const updated = state.scriptParagraphs.map((p: any) =>
      p.id === paragraphId ? { ...p, emotion } : p
    );
    setScriptParagraphs(updated);
  }, [setScriptParagraphs]);

  /** 重新生成文案（使用 Diff Tree 增量更新） */
  const handleRegenerate = useCallback(async () => {
    const state = useStore.getState();
    const sequence = STEP_SEQUENCES[3];
    if (!state.projectId || !sequence) return;

    setIsRegenerating(true);
    state.setStepStatus(3, 'running');
    state.setPipelineRunning(true);
    state.resetPipeline();

    try {
      const enrichedSequence = sequence.map(node => ({
        ...node,
        params: {
          ...(node.params || {}),
          mediaPath: state.mediaItems?.[0]?.filePath || '',
          scriptStyle: state.scriptStyle || '赛博现实主义',
          speechRate: state.speechRate || 4.5,
          pipelineParams: state.pipelineParams || { R: 50, S: 50, T: 50, P: 50 },
          /** 注入 VLM 画面描述，提供上下文给脚本生成 */
          visionResult: {
            sceneDescriptions: state.vlmFrames
              ?.map((f: any) => f.description || '')
              .filter(Boolean)
              .join('\n') || '',
          },
        },
      }));
      const result = await API.engine.runPipeline({
        projectId: state.projectId,
        sequence: enrichedSequence,
        sourceMedia: state.mediaItems?.[0]?.filePath || '',
      });
      if (result) {
        // 使用 Diff Tree 增量更新，而非全量替换
        const rawData = result?.data || result;
        const nodeType = 'script';
        const nodeResult = rawData['script-1'] || rawData['script'] || rawData;
        if (nodeResult) {
          /** 确保 id 唯一：当 shotId 重复时追加索引后缀 */
          const idCountMap: Record<string, number> = {};
          const newParagraphs = (nodeResult.paragraphs || nodeResult.shots || []).map((p: any, idx: number) => {
            const baseId = p.id || p.shotId || `para_${idx}`;
            const count = (idCountMap[baseId] || 0) + 1;
            idCountMap[baseId] = count;
            const uniqueId = count > 1 ? `${baseId}_${idx}` : baseId;
            return {
              id: uniqueId,
              text: p.text || p.content || p.narration || '',
              shotId: p.shotId,
              duration: p.duration,
              emotion: p.emotion || '',
              editing: false
            };
          });

          // 执行差异对比，仅更新变更的段落
          const diffs = diffParagraphs(state.scriptParagraphs, newParagraphs);
          const updatedParagraphs = applyDiffUpdate(state.scriptParagraphs, diffs);
          setScriptParagraphs(updatedParagraphs);
        } else {
          mapPipelineResultToState(rawData, useStore.getState());
        }
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

  /** 为指定段落执行文案→画面双向检索 */
  const handleMatchVision = useCallback((paragraphId: string) => {
    const state = useStore.getState();
    const paragraph = state.scriptParagraphs.find((p: any) => (p.id || p.shotId) === paragraphId);
    if (!paragraph || !vlmFrames.length) return;

    setMatchingParagraphId(paragraphId);
    const candidates = findBestVisionMatches(paragraph.text || '', vlmFrames, 3);
    setMatchResults(prev => ({ ...prev, [paragraphId]: candidates }));
    setMatchingParagraphId(null);
  }, [vlmFrames]);

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

      {/* 语速容量溢出统计 */}
      {overflowStats.overflow + overflowStats.warning > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-accent-rose/10 text-[11px]">
          <AlertTriangle size={14} className="text-accent-rose shrink-0" />
          <span className="text-accent-rose">
            {overflowStats.overflow} 个段落严重溢出，{overflowStats.warning} 个段落接近上限
          </span>
        </div>
      )}

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
                <ParameterSlider label="经典保留" code="R" value={pipelineParams.R} onChange={(v) => setPipelineParams({ ...pipelineParams, R: v })} disabled={isGenerating} unit="%" />
                <ParameterSlider label="原台词保留" code="S" value={pipelineParams.S} onChange={(v) => setPipelineParams({ ...pipelineParams, S: v })} disabled={isGenerating} unit="%" />
                <ParameterSlider label="TTS覆盖" code="T" value={pipelineParams.T} onChange={(v) => setPipelineParams({ ...pipelineParams, T: v })} disabled={isGenerating} unit="%" />
                <ParameterSlider label="节奏因子" code="P" value={pipelineParams.P} onChange={(v) => setPipelineParams({ ...pipelineParams, P: v })} disabled={isGenerating} unit="%" />

      {/* 语速控制 + 预估字数 */}
      <div className="glass-card-sm p-3 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span>语速控制</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-secondary text-accent font-mono">{speechRate}字/秒</span>
          </div>
          {scriptParagraphs.length > 0 && (
            <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
              <span>当前总字数: <span className="text-foreground font-mono">{scriptParagraphs.reduce((s: number, p: any) => s + (p.text?.length || 0), 0)}</span></span>
              <span>预估语音时长: <span className="text-foreground font-mono">{Math.ceil(scriptParagraphs.reduce((s: number, p: any) => s + (p.text?.length || 0), 0) / speechRate)}s</span></span>
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {SPEECH_RATE_OPTIONS.map(opt => (
            <button key={opt.value} onClick={() => setSpeechRate(opt.value)}
              disabled={isGenerating}
              className={`text-[11px] px-2.5 py-1 rounded-md border transition-all cursor-pointer outline-none ${
                speechRate === opt.value
                  ? 'border-accent bg-accent/10 text-accent font-medium'
                  : 'border-border/30 bg-bg-secondary text-muted-foreground hover:border-accent/40'
              } disabled:opacity-50`}
              title={opt.desc}>
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* 文案段落编辑 */}
      {scriptParagraphs.length > 0 ? (
        <div className="flex flex-col gap-2">
          {scriptParagraphs.map((p: any) => {
            const pId = p.id || p.shotId;
            const pred = predictions[pId];
            const overflowLevel = pred?.overflowLevel || 'safe';

            return (
              <div key={pId} className={`glass-card-sm p-3 ${overflowBorderMap[overflowLevel]}`}>
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className="text-[10px] text-accent font-mono">{p.shotId || p.id}</span>
                  <span className="text-[10px] text-muted-foreground">{p.duration ? `${p.duration}s` : ''}</span>

                  {/* 语速容量预测指示 */}
                  {pred && pred.overflowLevel !== 'safe' && (
                    <span className={`text-[10px] flex items-center gap-1 ${overflowColorMap[overflowLevel]}`}>
                      <AlertTriangle size={10} />
                      预计 {pred.predictedDuration}s
                      {pred.suggestCutChars > 0 && ` / 建议减 ${pred.suggestCutChars} 字`}
                    </span>
                  )}

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
                  className={`w-full text-[13px] leading-relaxed bg-transparent outline-none resize-none min-h-[48px] ${
                    overflowLevel === 'overflow' ? 'text-accent-rose/90' : ''
                  }`} />

                {/* 段落底部操作栏：双向检索 */}
                <div className="flex items-center gap-2 mt-1 pt-1 border-t border-border/20">
                  <button
                    onClick={() => handleMatchVision(pId)}
                    disabled={!vlmFrames.length || matchingParagraphId === pId}
                    className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-accent transition-colors cursor-pointer outline-none disabled:opacity-40"
                  >
                    <Search size={10} />
                    {matchingParagraphId === pId ? '检索中...' : '匹配画面'}
                  </button>
                </div>

                {/* 双向检索结果 */}
                {matchResults[pId] && matchResults[pId].length > 0 && (
                  <div className="mt-2 flex gap-2">
                    {matchResults[pId].map((c: MatchCandidate) => (
                      <div key={c.frameId} className="w-16 h-12 rounded bg-bg-secondary overflow-hidden relative group/cand cursor-pointer hover:ring-1 hover:ring-accent/40 transition-all">
                        {c.frameUrl ? (
                          <img src={c.frameUrl} className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <Image size={12} className="text-muted-foreground/30" />
                          </div>
                        )}
                        <div className="absolute bottom-0 left-0 right-0 bg-overlay-mask text-[8px] text-white text-center py-0.5">
                          {Math.round(c.score * 100)}%
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {matchResults[pId] && matchResults[pId].length === 0 && (
                  <div className="mt-1 text-[10px] text-muted-foreground">未找到匹配画面</div>
                )}
              </div>
            );
          })}

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
