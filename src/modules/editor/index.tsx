/**
 * Editor 页面组件 — 模块化入口
 * 原路径: src/renderer/src/pages/editor/index.tsx（已删除）
 * 子组件已迁移至 @modules/editor/{shell,preview,storyboard}
 */
import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { getSafeMediaUrl } from '@renderer/utils/formatUrl';
import { Music, Image, Check } from 'lucide-react';
import { usePlayerStore } from './stores/usePlayerStore';
import { useProjectStore } from './stores/useProjectStore';
import { useStep1Store } from '@modules/pipeline/stores/useStep1Store';
import { useStep5Store } from '@modules/pipeline/stores/useStep5Store';
import { TopBar } from '@modules/editor/shell';
import { API } from '@renderer/api';
import { useEditorHydration, useEditorAutoSave, useSyncDaemon } from '@modules/editor/shell';
import { useKeyboardShortcuts } from '@modules/editor/shell';
import { usePipelineExecutor } from '@modules/editor/shell';
import { useResizablePanel } from '@modules/editor/shell';
import { useTaskProgress } from '@modules/editor/shell';
import { useExtractionHandler } from '@modules/editor/shell';
import { useStepRunner } from '@modules/editor/shell';
import { usePipelineOrchestrator } from '@modules/editor/shell';
import { useMediaUpdatedListener } from '@modules/editor/shell';
import { StepPanel } from '@modules/editor/shell';
import PreviewMonitor from '@modules/editor/preview';

import { MEDIA_TABS } from '@modules/editor/shell';
import { formatTime } from '@modules/editor/preview';

export default function Editor() {
  const { id } = useParams();

  /** 编辑器核心 Hooks */
  useEditorHydration(id);
  useEditorAutoSave(id);
  useSyncDaemon();
  useKeyboardShortcuts();
  usePipelineExecutor();
  useTaskProgress();
  useMediaUpdatedListener();

  /** 管线编排器，提供 executeStep 供自动模式递进 */
  const { executeStep } = usePipelineOrchestrator();
  useExtractionHandler(async (nextStep: number) => { await executeStep(nextStep); });

  const { handleStart, handleNextStep, handleVideoImport, handleReplaceVideo } = useStepRunner(id);

  /** 可拖拽分隔条 */
  const { leftWidth, isDragging, leftPanelRef, handleDividerMouseDown } = useResizablePanel({
    minLeftWidth: 280,
    maxLeftWidth: 800,
    defaultLeftPercent: 30,
  });

  /** 播放器状态 */
  const activePlaySource = usePlayerStore((s) => s.activePlaySource);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const mediaItems = useProjectStore((s) => s.mediaItems);
  const addMediaItems = useProjectStore((s) => s.addMediaItems);
  const videoChunks = useStep5Store((s) => s.videoChunks);
  const setActivePlaySource = usePlayerStore((s) => s.setActivePlaySource);
  const extractedData = useProjectStore((s) => s.extractedData);
  const extractionConfig = useStep1Store((s) => s.extractionConfig);
  const fps = extractionConfig?.frames?.fps || 2;

  /** 格式化帧时间：根据帧序号和 fps 计算时间码 */
  const formatFrameTime = (frameIndex: number): string => {
    const totalSeconds = frameIndex / fps;
    const mm = Math.floor(totalSeconds / 60);
    const ss = Math.floor(totalSeconds % 60);
    const ff = Math.round((totalSeconds % 1) * fps);
    return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(ff).padStart(2, '0')}`;
  };

  /** 拖拽导入视频 */
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    dragCounterRef.current = 0;

    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;

    const videoExts = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.wmv', '.m4v'];
    const filePaths: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const fp = (f as any).path || f.name;
      const ext = '.' + fp.split('.').pop()?.toLowerCase();
      if (videoExts.includes(ext)) {
        filePaths.push(fp);
      }
    }
    if (filePaths.length === 0 || !id) return;

    try {
      usePlayerStore.setState({ currentTime: 0, isPlaying: false });
      const newItems = await API.media.import(id, filePaths);
      if (Array.isArray(newItems) && newItems.length > 0) {
        addMediaItems(newItems);
        setActivePlaySource(newItems[0]);
      }
    } catch (err: any) {
      console.error('[Editor] 拖拽导入失败:', err);
    }
  }, [id, setActivePlaySource, addMediaItems]);

  const [activeMediaTab, setActiveMediaTab] = useState('video');

  /** 缓存过滤结果，避免每次渲染重复过滤 */
  const videoCount = useMemo(() => mediaItems.filter((m: any) => m.type === 'video').length, [mediaItems]);
  const audioCount = useMemo(() => mediaItems.filter((m: any) => m.type === 'audio').length, [mediaItems]);
  /** 视频切片池：优先从 Store 的 videoChunks 取，回退到 mediaItems 过滤 */
  const chunkItems = useMemo(() => {
    if (videoChunks.length > 0) return videoChunks;
    return mediaItems.filter((m: any) => m.type === 'video_chunk');
  }, [videoChunks, mediaItems]);
  const chunkCount = chunkItems.length;
  /** 关键帧数量 */
  const frameCount = useMemo(() => (extractedData?.framePaths?.length || mediaItems.filter((m: any) => m.type === 'frame').length), [mediaItems, extractedData]);

  const activeCount = useMemo(() => {
    if (activeMediaTab === 'video') return videoCount;
    if (activeMediaTab === 'audio') return audioCount;
    if (activeMediaTab === 'chunks') return chunkCount;
    if (activeMediaTab === 'frames') return frameCount;
    return 0;
  }, [activeMediaTab, videoCount, audioCount, chunkCount, frameCount]);

  const filteredItems = useMemo(() => {
    if (activeMediaTab === 'video') return mediaItems.filter((m: any) => m.type === 'video');
    if (activeMediaTab === 'audio') return mediaItems.filter((m: any) => m.type === 'audio');
    if (activeMediaTab === 'chunks') return chunkItems;
    if (activeMediaTab === 'frames') {
      if (extractedData?.framePaths?.length) {
        return extractedData.framePaths.map((fp: string, i: number) => ({ id: `frame_${i}`, type: 'frame', filePath: fp, name: `关键帧 ${i + 1}` }));
      }
      return mediaItems.filter((m: any) => m.type === 'frame');
    }
    return [];
  }, [mediaItems, activeMediaTab, chunkItems, extractedData]);

  /** 窗口尺寸调整 */
  useEffect(() => {
    if (id) API.system.resizeWindow(1280, 800).catch(console.error);
  }, [id]);

  return (
    <div
      className={`flex flex-col h-screen w-screen bg-bg-deep text-foreground overflow-hidden relative ${isDragOver ? 'ring-2 ring-accent ring-inset' : ''}`}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* 拖拽导入视觉覆盖层 */}
      {isDragOver && (
        <div className="absolute inset-0 z-50 bg-accent/10 backdrop-blur-sm flex items-center justify-center pointer-events-none">
          <div className="glass-card px-8 py-6 rounded-2xl border-2 border-accent border-dashed flex flex-col items-center gap-3 animate-in zoom-in-95 duration-200">
            <svg className="w-12 h-12 text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
            </svg>
            <span className="text-accent font-semibold text-sm">释放以导入视频素材</span>
            <span className="text-muted-foreground text-xs">支持 MP4 / MOV / AVI / MKV / WebM</span>
          </div>
        </div>
      )}
      <TopBar />

      <div className="flex-1 flex overflow-hidden p-2 gap-0 editor-body" style={{ cursor: isDragging ? 'col-resize' : undefined, userSelect: isDragging ? 'none' : undefined }}>

        {/* 左侧区域：播放器 + 成功文件展示 */}
        <div
          ref={leftPanelRef}
          className="glass-card overflow-y-auto flex flex-col"
          style={{
            width: `${leftWidth}%`,
            flexShrink: 0,
            borderRadius: '12px 0 0 12px',
            minWidth: 280
          }}
        >
          {/* 视频播放器 */}
          <div className="glass-card overflow-hidden flex flex-col shrink-0 aspect-video">
            <PreviewMonitor
              onImportClick={handleVideoImport}
              onReplaceClick={handleReplaceVideo}
            />
          </div>

          {/* 成功文件展示区域 */}
          <div className="glass-card overflow-hidden flex flex-col flex-1 min-h-0">
            <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-border/30 shrink-0">
              <span className="text-[12px] font-semibold">{activeMediaTab === 'video' ? '视频' : activeMediaTab === 'audio' ? '音频' : activeMediaTab === 'chunks' ? '视频切片' : '关键帧'}</span>
              <span className="text-[10px] text-muted-foreground">共 {activeCount} 项</span>
            </div>
            <div className="flex items-center gap-1 px-3.5 pt-1.5 pb-0 shrink-0">
              {MEDIA_TABS.map(tab => (
                <button key={tab.key} onClick={() => setActiveMediaTab(tab.key)}
                  className={`flex items-center gap-1 px-2.5 py-1 text-[11px] rounded-t-md transition-colors cursor-pointer outline-none ${
                    tab.key === activeMediaTab ? 'bg-bg-secondary text-foreground font-medium border-b-2 border-accent' : 'text-muted-foreground hover:text-foreground'
                  }`}>
                  {tab.icon && <tab.icon size={12} />}{tab.label}
                  {tab.key === 'video' && videoCount > 0 && (
                    <span className="ml-0.5 text-[9px] opacity-60">({videoCount})</span>
                  )}
                  {tab.key === 'audio' && audioCount > 0 && (
                    <span className="ml-0.5 text-[9px] opacity-60">({audioCount})</span>
                  )}
                  {tab.key === 'chunks' && chunkCount > 0 && (
                    <span className="ml-0.5 text-[9px] opacity-60">({chunkCount})</span>
                  )}
                  {tab.key === 'frames' && frameCount > 0 && (
                    <span className="ml-0.5 text-[9px] opacity-60">({frameCount})</span>
                  )}
                </button>
              ))}
            </div>
            <div className={`flex-1 px-3.5 py-3 ${(activeMediaTab === 'chunks' || activeMediaTab === 'frames') ? 'overflow-y-auto overflow-x-hidden' : 'overflow-x-auto overflow-y-hidden'}`}>
              {filteredItems.length > 0 ? (
                activeMediaTab === 'chunks' ? (
                  /** 动态视频切片网格布局：2列，垂直滚动，展示切片时长 */
                  <div className="grid grid-cols-2 gap-2">
                    {filteredItems.map((item: any) => (
                      <div key={item.id}
                        className={`group relative rounded-lg border overflow-hidden bg-bg-secondary p-1 transition-all cursor-pointer hover:border-accent ${activePlaySource?.id === item.id ? 'border-accent ring-1 ring-accent' : 'border-border'}`}
                        onClick={() => setActivePlaySource(item)}>
                        <div className="w-full aspect-video bg-black rounded overflow-hidden relative">
                          <img
                            src={getSafeMediaUrl(item.coverPath || item.thumbnail || item.filePath)}
                            className="w-full h-full object-cover group-hover:scale-105 transition-all duration-300"
                            loading="lazy"
                          />
                          {/* 切片时长标签 */}
                          {item.endMs != null && item.startMs != null && (
                            <span className="absolute bottom-1 right-1 bg-black/75 px-1.5 py-0.5 rounded text-[9px] font-mono text-white">
                              {((item.endMs - item.startMs) / 1000).toFixed(1)}s
                            </span>
                          )}
                          {/* 运动显著性标签 */}
                          {item.motionScore > 0.3 && (
                            <span className="absolute top-1 left-1 bg-amber-500/80 px-1 py-0.5 rounded text-[8px] text-white font-semibold">
                              动态
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] font-medium mt-1 text-center truncate px-1 text-muted-foreground group-hover:text-foreground">
                          {item.name || `分镜切片-${(item.id || '').substring(0, 4)}`}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : activeMediaTab === 'frames' ? (
                  /** 关键帧网格布局：3列，垂直滚动，展示序号和时间码 */
                  <div className="grid grid-cols-3 gap-1">
                    {filteredItems.map((item: any, index: number) => (
                      <div key={item.id}
                        className="aspect-video bg-muted/30 rounded overflow-hidden border border-border/30 cursor-pointer hover:border-accent/50 transition-colors relative group"
                        onClick={() => setActivePlaySource(item)}>
                        <img src={getSafeMediaUrl(item.filePath)} className="w-full h-full object-cover group-hover:opacity-90 transition-opacity" loading="lazy" alt={item.name} />
                        {/* 序号 - 左上 */}
                        <span className="absolute top-0.5 left-0.5 text-[8px] bg-black/70 text-white/90 px-1 font-mono rounded font-bold">#{index + 1}</span>
                        {/* 时间码 - 右下 */}
                        <span className="absolute bottom-0.5 right-0.5 text-[7px] bg-black/70 text-emerald-300 px-1 font-mono rounded">{formatFrameTime(index)}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                <div className="flex gap-2.5 h-full items-start">
                  {filteredItems.map((item: any) => (
                    <div key={item.id}
                      className={`min-w-[120px] glass-card-sm overflow-hidden cursor-pointer hover:border-accent/30 transition-all ${activePlaySource?.id === item.id ? 'border-accent' : ''}`}
                      onClick={() => setActivePlaySource(item)}>
                      <div className="w-full h-[68px] bg-bg-secondary flex items-center justify-center relative">
                        {item.coverPath || item.thumbnail || (item.type === 'video' && item.filePath) ? (
                          <img src={getSafeMediaUrl(item.coverPath || item.thumbnail || item.filePath)} className="w-full h-full object-cover" />
                        ) : item.type === 'audio' ? (
                          <Music size={20} className="text-muted-foreground/30" />
                        ) : (
                          <Image size={20} className="text-muted-foreground/30" />
                        )}
                        <span className="absolute top-1.5 right-1.5 text-[8px] px-1 py-0.5 rounded bg-black/50 text-white/70">
                          {item.type === 'audio' ? '音频' : item.type === 'video' ? '视频' : '帧'}
                        </span>
                        {item.duration && (
                          <span className="absolute bottom-1.5 right-1.5 text-[8px] px-1 py-0.5 rounded bg-black/50 text-white/70">
                            {formatTime(item.duration)}
                          </span>
                        )}
                      </div>
                      <div className="p-1.5">
                        <div className="text-[11px] truncate">{item.fileName || item.name || '未命名'}</div>
                      </div>
                    </div>
                  ))}
                </div>
                )
              ) : (
                <div className="flex gap-2.5 h-full items-center justify-center">
                  <div className="glass-card-sm p-4 flex flex-col items-center justify-center text-muted-foreground min-w-[120px]">
                    <Check size={20} className="opacity-30 mb-2" />
                    <span className="text-[11px]">暂无成功文件</span>
                    <span className="text-[9px] opacity-60 mt-1">执行管线后将在此展示</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 可拖拽分隔条 */}
        <div
          onMouseDown={handleDividerMouseDown}
          className={`w-1.5 flex-shrink-0 cursor-col-resize transition-all relative group ${isDragging ? 'bg-accent' : 'bg-transparent hover:bg-accent/50'}`}
          style={{ cursor: isDragging ? 'col-resize' : undefined }}
        >
          <div className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-0.5 h-8 rounded transition-all ${isDragging ? 'bg-white' : 'bg-border group-hover:bg-accent/50'}`} />
        </div>

        {/* 右侧区域：步骤导航面板 */}
        <StepPanel onStart={handleStart} onNextStep={handleNextStep} />
      </div>
    </div>
  );
}
