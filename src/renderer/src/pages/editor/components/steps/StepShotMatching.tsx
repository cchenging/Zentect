import React, { useState, useMemo, useCallback } from 'react';
import { useStore } from '../../../../store/useStore';
import { Check, RefreshCw, Film, X, Music } from 'lucide-react';
import { getSafeMediaUrl } from '../../../../utils/formatUrl';
import { STEP_SEQUENCES } from '../../utils/pipelineConstants';
import { API } from '../../../../api';
import { mapPipelineResultToState } from '../../hooks/usePipelineResultMapper';
import { Badge, StatHeader, EmptyState } from '../../../../components/shared';
import { DragReorderList } from '../../../../components/shared/DragReorderList';

/** 步骤5：智能视听转场卡点匹配 - 三维一体弹性时间轴对齐 */
export const StepShotMatching: React.FC = () => {
  const matchResults = useStore((s) => s.matchResults);
  const mediaItems = useStore((s) => s.mediaItems);
    const activeBgm = useStore((s) => s.activeBgm);
  const videoChunks = useStore((s) => s.videoChunks);
  const pipelineRunning = useStore((s) => s.pipelineRunning);
  const confirmMatch = useStore((s) => s.confirmMatch);
  const replaceMatch = useStore((s) => s.replaceMatch);
  const setMatchResults = useStore((s) => s.setMatchResults);

  /** 替换面板：被替换的 shotId */
  const [replacingShotId, setReplacingShotId] = useState<string | null>(null);
  /** 拖拽状态 */

  /** 重新匹配状态 */
  const [isRematching, setIsRematching] = useState(false);

  /** 动态视频切片片段池 */
  const chunkPool = useMemo(() => {
    return videoChunks.length > 0
      ? videoChunks
      : mediaItems.filter((m: any) => m.type === 'video_chunk' || m.type === 'frame');
  }, [videoChunks, mediaItems]);

  /** 替换选中的画面 */
  const handleReplaceSelect = useCallback((shotId: string, chunkItem: any) => {
    const coverPath = chunkItem.coverPath || chunkItem.filePath || chunkItem.thumbnail;
    replaceMatch(shotId, chunkItem.id);
    const state = useStore.getState();
    const updatedResults = state.matchResults.map((m: any) =>
      m.shotId === shotId
        ? {
            ...m,
            mediaId: chunkItem.id,
            thumbnail: coverPath,
            chunkData: chunkItem.chunkData || chunkItem,
            confirmed: false,
          }
        : m
    );
    setMatchResults(updatedResults);
    setReplacingShotId(null);
  }, [replaceMatch, setMatchResults]);

  /** 重新匹配全部 */
  const handleRematch = useCallback(async () => {
    const state = useStore.getState();
    const sequence = STEP_SEQUENCES[5];
    if (!state.projectId || !sequence) return;

    setIsRematching(true);
    state.setStepStatus(5, 'running');
    state.setPipelineRunning(true);
    state.resetPipeline();

    try {
      /** 三维一体参数注入：文案 + 视觉描述 + TTS刚性时长 + BGM信息 */
      const enrichedSequence = sequence.map(node => ({
        ...node,
        params: {
          ...(node.params || {}),
          mediaPath: state.mediaItems?.[0]?.filePath || '',
          mediaId: state.mediaItems?.[0]?.id || '',
          scriptShots: state.scriptParagraphs || [],
          visionResult: {
            sceneDescriptions: state.vlmFrames
              ?.map((f: any) => f.description || '')
              .filter(Boolean)
              .join('\n') || '',
          },
          ttsDurations: state.ttsResults || [],
          bgmInfo: state.activeBgm ? {
            id: state.activeBgm.id,
            filePath: state.activeBgm.filePath,
          } : null,
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
      state.setStepCompleted(5, true);
      state.setStepStatus(5, 'completed');
    } catch (err: any) {
      state.setStepStatus(5, 'failed');
      state.setPipelineError(err?.message || '智能视听匹配失败');
    } finally {
      state.setPipelineRunning(false);
      setIsRematching(false);
    }
  }, []);

  const isProcessing = isRematching || pipelineRunning;

  /** 拖拽排序处理 */

  return (
    <div className="flex flex-col gap-4">
      {/* 头部操作栏 */}
      <div className="flex items-center justify-between">
        <div className="text-[13px] font-semibold flex items-center gap-1.5">
          <span>智能视听匹配</span>
          {activeBgm && (
            <Badge variant="success" className="flex items-center gap-0.5">
              <Music size={10} /> BGM已锁
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-3">
          {matchResults.length > 0 && (
            <StatHeader
              value={matchResults.length}
              unit="个分镜"
              secondary={`对齐 ${matchResults.filter((m: any) => m.confirmed).length}/${matchResults.length}`}
            />
          )}
          <button
            onClick={handleRematch}
            disabled={isProcessing}
            className="flex items-center gap-1.5 px-3 py-1 bg-accent text-accent-foreground rounded-md text-[11px] font-medium transition-all hover:opacity-90 disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw size={12} className={isProcessing ? 'animate-spin' : ''} />
            {isProcessing ? '多维求解中...' : '启动智能匹配'}
          </button>
        </div>
      </div>

      {matchResults.length > 0 ? (
        <>
          {/* 故事板：垂直排列卡片 */}
          <DragReorderList
            items={matchResults}
            getItemId={(m: any) => m.shotId}
            onReorder={(reordered: any[]) => setMatchResults(reordered)}
            renderItem={(m: any, _index: number, isDragging: boolean) => (
              <div className={`glass-card-sm p-3 flex flex-col gap-2 transition-all border-l-4 ${
                isDragging ? 'opacity-50' : ''
              } ${m.confirmed ? 'border-l-accent-green' : m.score >= 0.85 ? 'border-l-accent-green' : m.score >= 0.6 ? 'border-l-yellow-500' : 'border-l-accent-rose'}`}>
                <div className="flex gap-3">
                  <div className="w-[140px] h-[90px] rounded-md bg-bg-secondary overflow-hidden shrink-0 relative group/img">
                    {m.thumbnail ? (
                      <img src={getSafeMediaUrl(m.thumbnail)} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <Film size={24} className="text-muted-foreground/20" />
                      </div>
                    )}
                    {m.chunkData && (
                      <div className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-black/70 text-[9px] text-white font-mono">
                        {((m.chunkData.endMs - m.chunkData.startMs) / 1000).toFixed(1)}s
                      </div>
                    )}
                    {m.appliedSpeedFactor !== 1 && m.appliedSpeedFactor !== undefined && (
                      <div className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-accent-rose/80 text-[9px] text-white">
                        {m.appliedSpeedFactor.toFixed(2)}x
                      </div>
                    )}
                  </div>
                  <div className="flex-1 flex flex-col gap-1.5 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-semibold truncate">{m.shotId}</span>
                      <Badge variant={m.score > 0.8 ? 'success' : m.score > 0.5 ? 'warning' : 'danger'} className="text-[9px] shrink-0">
                        {Math.round(m.score * 100)}%
                      </Badge>
                    </div>
                    {m.audioDurationMs > 0 && (
                      <div className="text-[10px] text-muted-foreground bg-bg-secondary/40 px-1.5 py-0.5 rounded">
                        {(m.audioDurationMs / 1000).toFixed(2)}s
                      </div>
                    )}
                    <div className="flex items-center gap-2 mt-auto">
                      {m.confirmed ? (
                        <span className="text-[10px] text-accent-green flex items-center gap-0.5">
                          <Check size={12} />
                        </span>
                      ) : (
                        <>
                          <button onClick={() => confirmMatch(m.shotId)} className="px-2.5 py-1 text-[10px] bg-accent-green/20 text-accent-green hover:bg-accent-green hover:text-white rounded transition-all cursor-pointer">
                            OK
                          </button>
                          <button onClick={() => setReplacingShotId(m.shotId)} className="px-2.5 py-1 text-[10px] bg-bg-secondary text-muted-foreground hover:text-foreground rounded transition-all cursor-pointer">
                            Replace
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          />
        </>
      ) : (
        <EmptyState
          title="智能卡点匹配就绪"
          description="算法将自动分析 BGM 节拍、配音刚性时长，通过全局排他匹配算法截取动态视频切片"
          iconType="media"
          size="md"
          className="glass-card-sm"
        />
      )}

      {/* 替换素材选择面板 */}
      {replacingShotId && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center" onClick={() => setReplacingShotId(null)}>
          <div className="bg-bg-base border border-border rounded-xl shadow-2xl w-[500px] max-h-[550px] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-bg-secondary/30">
              <span className="text-[13px] font-semibold">视频动态切片池</span>
              <button onClick={() => setReplacingShotId(null)} className="text-muted-foreground hover:text-foreground cursor-pointer outline-none">
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 grid grid-cols-2 gap-3">
              {chunkPool.length > 0 ? (
                chunkPool.map((chunk: any) => (
                  <div
                    key={chunk.id}
                    onClick={() => handleReplaceSelect(replacingShotId, chunk)}
                    className="cursor-pointer border border-border hover:border-accent rounded-lg overflow-hidden transition-all bg-bg-secondary p-1.5 flex flex-col gap-1"
                  >
                    <div className="w-full aspect-video rounded bg-black overflow-hidden relative">
                      <img
                        src={getSafeMediaUrl(chunk.coverPath || chunk.thumbnail)}
                        className="w-full h-full object-cover"
                      />
                      {chunk.endMs && chunk.startMs !== undefined && (
                        <span className="absolute bottom-1 right-1 bg-black/80 px-1 text-[9px] text-white font-mono rounded">
                          {((chunk.endMs - chunk.startMs) / 1000).toFixed(1)}s
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] font-medium truncate px-1 text-center">
                      {chunk.name || '动态镜头切片'}
                    </div>
                  </div>
                ))
              ) : (
                <div className="col-span-2">
                  <EmptyState
                    title="暂无切片素材"
                    description="请先执行智能匹配生成视频切片"
                    iconType="search"
                    size="md"
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
