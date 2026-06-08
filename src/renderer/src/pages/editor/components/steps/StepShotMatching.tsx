import React, { useState, useCallback } from 'react';
import { useStore } from '../../../../store/useStore';
import { Check, RefreshCw, Image, X } from 'lucide-react';
import { getSafeMediaUrl } from '../../../../utils/formatUrl';
import { STEP_SEQUENCES } from '../../utils/pipelineConstants';
import { API } from '../../../../api';
import { mapPipelineResultToState } from '../../hooks/usePipelineResultMapper';
import { Badge, StatHeader, EmptyState } from '../../../../components/shared';

/** 步骤5：镜头匹配 - AI 匹配文案与画面，故事板布局，支持替换和重新匹配 */
export const StepShotMatching: React.FC = () => {
  const matchResults = useStore((s) => s.matchResults);
  const mediaItems = useStore((s) => s.mediaItems);
  const pipelineRunning = useStore((s) => s.pipelineRunning);
  const confirmMatch = useStore((s) => s.confirmMatch);
  const replaceMatch = useStore((s) => s.replaceMatch);
  const setMatchResults = useStore((s) => s.setMatchResults);

  /** 替换面板：被替换的 shotId */
  const [replacingShotId, setReplacingShotId] = useState<string | null>(null);
  /** 拖拽状态 */
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  /** 重新匹配状态 */
  const [isRematching, setIsRematching] = useState(false);

  /** 可用帧素材 */
  const frameItems = mediaItems.filter((m: any) => m.type === 'frame');

  /** 替换选中的画面 */
  const handleReplaceSelect = useCallback((shotId: string, frameItem: any) => {
    const framePath = frameItem.filePath || frameItem.coverPath || frameItem.thumbnail;
    replaceMatch(shotId, frameItem.id);
    const state = useStore.getState();
    const updatedResults = state.matchResults.map((m: any) =>
      m.shotId === shotId
        ? { ...m, mediaId: frameItem.id, thumbnail: framePath, confirmed: false }
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
      const result = await API.engine.runPipeline({
        projectId: state.projectId,
        sequence,
        sourceMedia: state.mediaItems?.[0]?.filePath || '',
      });
      if (result) {
        mapPipelineResultToState(result?.data || result, useStore.getState());
      }
      state.setStepCompleted(5, true);
      state.setStepStatus(5, 'completed');
    } catch (err: any) {
      state.setStepStatus(5, 'failed');
      state.setPipelineError(err?.message || '重新匹配失败');
    } finally {
      state.setPipelineRunning(false);
      setIsRematching(false);
    }
  }, []);

  const isProcessing = isRematching || pipelineRunning;

  /** 拖拽排序处理 */
  const handleDragStart = useCallback((index: number) => {
    setDragIndex(index);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (dragIndex === null || dragIndex === index) return;
    const items = [...matchResults];
    const draggedItem = items[dragIndex];
    items.splice(dragIndex, 1);
    items.splice(index, 0, draggedItem);
    setMatchResults(items);
    setDragIndex(index);
  }, [dragIndex, matchResults, setMatchResults]);

  const handleDragEnd = useCallback(() => {
    setDragIndex(null);
  }, []);

  return (
    <div className="flex flex-col gap-4">
      {/* 头部操作栏 */}
      <div className="flex items-center justify-between">
        <div className="text-[13px] font-semibold">镜头匹配</div>
        <div className="flex items-center gap-3">
          {matchResults.length > 0 && (
            <StatHeader
              value={matchResults.length}
              unit="个段落"
              secondary={`匹配完成 ${matchResults.filter((m: any) => m.confirmed).length}/${matchResults.length}`}
            />
          )}
          <button
            onClick={handleRematch}
            disabled={isProcessing}
            className="flex items-center gap-1.5 px-3 py-1 rounded-md text-[11px] transition-all cursor-pointer outline-none bg-bg-secondary text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw size={12} className={isProcessing ? 'animate-spin' : ''} />
            {isProcessing ? '匹配中...' : '重新匹配'}
          </button>
        </div>
      </div>

      {matchResults.length > 0 ? (
        <>
          {/* 故事板：垂直排列卡片 */}
          <div className="flex flex-col gap-3">
              {matchResults.map((m: any, index: number) => (
                <div
                  key={m.shotId}
                  draggable
                  onDragStart={() => handleDragStart(index)}
                  onDragOver={(e) => handleDragOver(e, index)}
                  onDragEnd={handleDragEnd}
                  className={`shrink-0 w-[160px] glass-card-sm p-2.5 flex flex-col gap-2 transition-all cursor-grab active:cursor-grabbing border-l-2 ${
                    dragIndex === index ? 'opacity-50' : ''
                  } ${m.confirmed ? 'border-l-accent-green' : m.score >= 0.85 ? 'border-l-accent-green' : m.score >= 0.6 ? 'border-l-yellow-500' : 'border-l-accent-rose'}`}
                >
                  {/* 缩略图 */}
                  <div className="w-full h-[90px] rounded-md bg-bg-secondary overflow-hidden shrink-0 group/img relative">
                    {m.thumbnail ? (
                      <img src={getSafeMediaUrl(m.thumbnail)} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <Image size={24} className="text-muted-foreground/30" />
                      </div>
                    )}
                  </div>

                  {/* 信息 */}
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] font-medium truncate flex-1">{m.shotId}</span>
                      <Badge
                        variant={m.score > 0.8 ? 'success' : m.score > 0.5 ? 'warning' : 'danger'}
                        className="text-[9px]"
                      >
                        {Math.round(m.score * 100)}%
                      </Badge>
                    </div>

                    <div className="flex items-center gap-1">
                      {m.confirmed ? (
                        <span className="text-[10px] text-accent-green flex items-center gap-1">
                          <Check size={10} /> 已确认
                        </span>
                      ) : (
                        <>
                          <button onClick={() => confirmMatch(m.shotId)} className="cursor-pointer outline-none">
                            <Badge variant="success" className="text-[10px] hover:bg-accent-green/25 transition-colors cursor-pointer">确认</Badge>
                          </button>
                          <button
                            onClick={() => setReplacingShotId(m.shotId)}
                            className="text-[10px] px-2 py-1 rounded bg-bg-secondary text-muted-foreground hover:text-foreground cursor-pointer outline-none leading-none"
                          >
                            替换画面
                          </button>
                          {m.score < 0.6 && (
                            <button onClick={() => setReplacingShotId(m.shotId)} className="cursor-pointer outline-none">
                              <Badge variant="danger" className="text-[10px] hover:bg-accent-rose/20 transition-colors cursor-pointer">手动选择</Badge>
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>

          <div className="text-[10px] text-muted-foreground text-center">
            ↕ 拖拽卡片可调整段落顺序
          </div>
        </>
      ) : (
        <EmptyState
          title="镜头匹配待执行"
          description="执行管线后，AI 将自动匹配文案段落与画面素材，支持手动替换与重新匹配"
          iconType="media"
          size="md"
          className="glass-card-sm"
        />
      )}

      {/* 替换素材选择面板 */}
      {replacingShotId && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center" onClick={() => setReplacingShotId(null)}>
          <div className="bg-bg-base border border-border rounded-xl shadow-2xl w-[420px] max-h-[520px] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <span className="text-[13px] font-semibold">选择替换画面</span>
              <button onClick={() => setReplacingShotId(null)} className="text-muted-foreground hover:text-foreground cursor-pointer outline-none">
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {frameItems.length > 0 ? (
                <div className="grid grid-cols-3 gap-3">
                  {frameItems.map((item: any) => (
                    <div
                      key={item.id}
                      onClick={() => handleReplaceSelect(replacingShotId, item)}
                      className="cursor-pointer hover:ring-1 hover:ring-accent/40 rounded-md overflow-hidden transition-all bg-bg-secondary p-1"
                    >
                      <div className="w-full aspect-video rounded bg-bg-base overflow-hidden flex items-center justify-center">
                        {item.coverPath || item.thumbnail ? (
                          <img src={getSafeMediaUrl(item.coverPath || item.thumbnail)} className="w-full h-full object-cover" />
                        ) : (
                          <Image size={20} className="text-muted-foreground/30" />
                        )}
                      </div>
                      <div className="text-[10px] text-foreground truncate mt-1 text-center">
                        {item.fileName || item.name || '帧画面'}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState
                  title="暂无关键帧素材"
                  description="请先在步骤1中完成素材分析"
                  iconType="search"
                  size="md"
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};