// 📁 路径: src/renderer/src/pages/editor/index.tsx
// 编辑器页面 - V3 原型对齐 + 完整5步工作区 + 管线事件流绑定
import { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getSafeMediaUrl } from '../../utils/formatUrl';
import {
  Loader2, AlertTriangle, RefreshCcw, Play, Sparkles, ChevronRight,
  Volume2, Film, Music, Image, Pause, Check, Edit3, Sliders, Video,
  Search, PictureInPicture, PenLine, Mic, Clapperboard, Clock, CheckCircle2,
  Maximize, Square
} from 'lucide-react';
import { useStore } from '../../store/useStore';
import { AppNotifier } from '../../core/AppNotifier';
import { TopBar } from './components/top-bar';
import { VideoImport } from './components/VideoImport';
import { API } from '../../api';
import { useEditorHydration, useEditorAutoSave, useSyncDaemon } from './hooks/useEditorLogic';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';

/** 步骤定义 */
const STEPS = [
  { key: 1, label: '素材分析', icon: Search },
  { key: 2, label: '画面描述', icon: PictureInPicture },
  { key: 3, label: '解说文案', icon: PenLine },
  { key: 4, label: '配音合成', icon: Mic },
  { key: 5, label: '镜头匹配', icon: Clapperboard },
];

/** 素材库标签 */

const MEDIA_TABS = [
  { key: 'all', label: '全部' },
  { key: 'video', label: '视频', icon: <Film size={12} /> },
  { key: 'audio', label: '音频', icon: <Music size={12} /> },
  { key: 'frames', label: '关键帧', icon: <Image size={12} /> },
];

/** 文案风格选项 */
const SCRIPT_STYLES = ['赛博现实主义', '无厘头废话文学', '正经科普', '情感叙事', '悬疑推理', '轻松幽默'];

/**
 * 将管线执行结果映射到编辑器各步骤状态
 * @param result 管线执行返回的结果对象（按 nodeId 索引）
 * @param store 全局 Store 操作集合
 */
function mapPipelineResultToState(result: Record<string, any>, store: any) {
  if (!result || typeof result !== 'object') return;

  // 遍历所有节点结果，按节点类型映射到对应步骤状态
  for (const [nodeId, nodeResult] of Object.entries(result)) {
    if (!nodeResult || typeof nodeResult !== 'object') continue;

    // 步骤1: 素材分析 - 音频分离 / ASR / 抽帧
    if (nodeId.includes('audio') || nodeId.includes('separate')) {
      store.setAudioSeparated(true);
    }
    if (nodeId.includes('asr') && nodeResult.lines) {
      store.setAsrLines(nodeResult.lines.map((l: any) => ({
        start: l.start || l.begin || '00:00',
        text: l.text || l.content || '',
        editing: false
      })));
    }
    if (nodeId.includes('frame') || nodeId.includes('extract')) {
      if (nodeResult.framesCount) store.setFrameCount(nodeResult.framesCount);
      if (nodeResult.framePaths) store.setFrameCount(nodeResult.framePaths.length);
    }

    // 步骤2: 画面描述 - VLM 分析结果
    if (nodeId.includes('vision') || nodeId.includes('vlm')) {
      const frames = nodeResult.frames || nodeResult.frameDescriptions || [];
      if (frames.length > 0) {
        store.setVlmFrames(frames.map((f: any, idx: number) => ({
          url: f.url || f.framePath || f.thumbnail || '',
          description: f.description || f.text || f.content || '',
          editing: false
        })));
      } else if (nodeResult.sceneDescriptions) {
        // 后端返回整段文本描述，拆分为逐帧
        const descriptions = nodeResult.sceneDescriptions.split('\n').filter((s: string) => s.trim());
        const framePaths = nodeResult.framePaths || [];
        store.setVlmFrames(descriptions.map((desc: string, idx: number) => ({
          url: framePaths[idx] || '',
          description: desc.replace(/^\d+[\.\)、]\s*/, ''), // 移除序号前缀
          editing: false
        })));
      }
    }

    // 步骤3: 解说文案
    if (nodeId.includes('script') || nodeId.includes('narration')) {
      const paragraphs = nodeResult.paragraphs || nodeResult.shots || [];
      if (paragraphs.length > 0) {
        store.setScriptParagraphs(paragraphs.map((p: any, idx: number) => ({
          id: p.id || p.shotId || `para_${idx}`,
          text: p.text || p.content || p.narration || '',
          shotId: p.shotId,
          duration: p.duration,
          editing: false
        })));
      }
    }

    // 步骤4: TTS 配音
    if (nodeId.includes('tts')) {
      const ttsResults = nodeResult.results || nodeResult.shots || [];
      if (ttsResults.length > 0) {
        store.setTtsResults(ttsResults.map((r: any) => ({
          shotId: r.shotId,
          audioUrl: r.audioUrl || r.audioPath || '',
          duration: r.duration || 0
        })));
      }
      store.setTtsProgress(100);
    }

    // 步骤5: 镜头匹配
    if (nodeId.includes('match') || nodeId.includes('align') || nodeId.includes('semantic')) {
      const matches = nodeResult.matches || nodeResult.results || [];
      if (matches.length > 0) {
        store.setMatchResults(matches.map((m: any) => ({
          shotId: m.shotId || m.id,
          mediaId: m.mediaId || m.frameId,
          score: m.score || m.confidence || 0,
          thumbnail: m.thumbnail || m.coverPath || m.framePath || '',
          confirmed: m.confirmed || false
        })));
      } else if (nodeResult.segments && nodeResult.segments.length > 0) {
        // 兼容后端 semantic-analyze 返回的 segments 格式
        store.setMatchResults(nodeResult.segments.map((seg: any, idx: number) => ({
          shotId: seg.shotId || seg.id || `shot_${idx}`,
          mediaId: seg.mediaId || seg.frameId || '',
          score: seg.score || seg.confidence || seg.similarity || 0,
          thumbnail: seg.thumbnail || seg.coverPath || seg.framePath || '',
          confirmed: seg.confirmed || false
        })));
      }
    }
  }
}

export default function Editor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const hydrationStatus = useStore((s) => s.hydrationStatus);

  useEditorHydration(id);
  useEditorAutoSave(id);
  useSyncDaemon();
  useKeyboardShortcuts();

  /** 从全局 Store 读取编辑器状态 */
  const currentStep = useStore((s) => s.currentStep);
  const isAutoMode = useStore((s) => s.isAutoMode);
  const pipelineRunning = useStore((s) => s.pipelineRunning);
  const pipelineProgress = useStore((s) => s.pipelineProgress);
  const pipelineNode = useStore((s) => s.pipelineNode);
  const pipelineError = useStore((s) => s.pipelineError);
  const stepCompleted = useStore((s) => s.stepCompleted);
  const stepStatuses = useStore((s) => s.stepStatuses);

  const asrLines = useStore((s) => s.asrLines);
  const frameCount = useStore((s) => s.frameCount);
  const audioSeparated = useStore((s) => s.audioSeparated);
  const vlmFrames = useStore((s) => s.vlmFrames);
  const scriptParagraphs = useStore((s) => s.scriptParagraphs);
  const scriptStyle = useStore((s) => s.scriptStyle);
  const pipelineParams = useStore((s) => s.pipelineParams);
  const ttsEngine = useStore((s) => s.ttsEngine);
  const ttsProgress = useStore((s) => s.ttsProgress);
  const matchResults = useStore((s) => s.matchResults);
  const mediaItems = useStore((s) => s.mediaItems);
  const activePlaySource = useStore((s) => s.activePlaySource);
  const isPlaying = useStore((s) => s.isPlaying);
  const currentTime = useStore((s) => s.currentTime);
  const videoDuration = useStore((s) => s.videoDuration);

  /** Store 操作 */
  const setCurrentStep = useStore((s) => s.setCurrentStep);
  const setIsAutoMode = useStore((s) => s.setIsAutoMode);
  const setPipelineRunning = useStore((s) => s.setPipelineRunning);
  const setPipelineError = useStore((s) => s.setPipelineError);
  const resetPipeline = useStore((s) => s.resetPipeline);
  const setStepCompleted = useStore((s) => s.setStepCompleted);
  const setStepStatus = useStore((s) => s.setStepStatus);
  const updateAsrLine = useStore((s) => s.updateAsrLine);
  const updateVlmDescription = useStore((s) => s.updateVlmDescription);
  const setVlmEditing = useStore((s) => s.setVlmEditing);
  const updateScriptParagraph = useStore((s) => s.updateScriptParagraph);
  const setScriptStyle = useStore((s) => s.setScriptStyle);
  const setPipelineParams = useStore((s) => s.setPipelineParams);
  const setTtsEngine = useStore((s) => s.setTtsEngine);
  const confirmMatch = useStore((s) => s.confirmMatch);
  const setIsPlaying = useStore((s) => s.setIsPlaying);
  const setCurrentTime = useStore((s) => s.setCurrentTime);
  const setVideoDuration = useStore((s) => s.setVideoDuration);
  const addMediaItems = useStore((s) => s.addMediaItems);
  const setActivePlaySource = useStore((s) => s.setActivePlaySource);

  const videoRef = useRef<HTMLVideoElement>(null);
  const dividerRef = useRef<HTMLDivElement>(null);
  const leftPanelRef = useRef<HTMLDivElement>(null);

  // 分隔条拖拽状态
  const [isDragging, setIsDragging] = useState(false);
  const [leftWidth, setLeftWidth] = useState(30); // 左侧宽度百分比
  const [videoLoading, setVideoLoading] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const MIN_LEFT_WIDTH = 280; // 最小宽度 px
  const MAX_LEFT_WIDTH = 800; // 最大宽度 px

  /** 分隔条拖拽逻辑 */
  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const bodyRect = document.querySelector('.editor-body')?.getBoundingClientRect();
      if (!bodyRect || !leftPanelRef.current) return;

      let newWidth = e.clientX - bodyRect.left;
      if (newWidth < MIN_LEFT_WIDTH) newWidth = MIN_LEFT_WIDTH;
      if (newWidth > MAX_LEFT_WIDTH) newWidth = MAX_LEFT_WIDTH;

      const newWidthPercent = (newWidth / bodyRect.width) * 100;
      setLeftWidth(newWidthPercent);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  /** 窗口尺寸 */
  useEffect(() => {
    if (id) API.system.resizeWindow(1440, 900).catch(console.error);
  }, [id]);

  /** 监听管线进度事件 - 实时更新步骤状态和进度 */
  useEffect(() => {
    const unsubscribe = API.engine.onPipelineProgress((payload: any) => {
      const { progress, status, nodeId, results } = payload;

      // 更新管线进度
      setPipelineProgress(progress || 0, nodeId || '');

      // 如果节点完成并携带结果，实时映射到步骤状态
      if (status === 'success' && results) {
        mapPipelineResultToState({ [nodeId || 'unknown']: results }, useStore.getState());
      }

      // 根据当前执行的节点自动切换步骤
      if (nodeId) {
        if (nodeId.includes('audio') || nodeId.includes('asr') || nodeId.includes('frame') || nodeId.includes('extract')) {
          if (useStore.getState().currentStep !== 1) setCurrentStep(1);
        } else if (nodeId.includes('vision') || nodeId.includes('vlm')) {
          if (useStore.getState().currentStep < 2) setCurrentStep(2);
        } else if (nodeId.includes('script') || nodeId.includes('narration')) {
          if (useStore.getState().currentStep < 3) setCurrentStep(3);
        } else if (nodeId.includes('tts')) {
          if (useStore.getState().currentStep < 4) setCurrentStep(4);
        } else if (nodeId.includes('match') || nodeId.includes('align')) {
          if (useStore.getState().currentStep < 5) setCurrentStep(5);
        }
      }
    });

    return () => {
      if (unsubscribe && typeof unsubscribe === 'function') unsubscribe();
      API.engine.offPipelineProgress?.();
    };
  }, []);

  /** 监听素材提取完成事件 - 自动模式下推进到步骤2 */
  useEffect(() => {
    const unsub = API.events.onExtractionSuccess((payload: any) => {
      const state = useStore.getState();
      // 标记步骤1完成
      state.setStepCompleted(1, true);
      state.setStepStatus(1, 'completed');
      state.setPipelineRunning(false);

      if (state.isAutoMode) {
        // 自动模式：推进到步骤2并启动
        state.setCurrentStep(2);
        state.setStepStatus(2, 'running');
        state.setPipelineRunning(true);
        API.engine.runPipeline({
          projectId: state.projectId!,
          sequence: [{ actionType: 'vision-extract', nodeId: 'vlm-1', label: '画面描述' }],
          sourceMedia: state.mediaItems?.[0]?.filePath || '',
        })
          .then((result: any) => {
            if (result) {
              const pipelineData = result?.data || result;
              mapPipelineResultToState(pipelineData, useStore.getState());
            }
            state.setStepCompleted(2, true);
            state.setStepStatus(2, 'completed');
            // 继续自动推进步骤3
            if (useStore.getState().isAutoMode) {
              useStore.getState().setCurrentStep(3);
              useStore.getState().setStepStatus(3, 'running');
              return API.engine.runPipeline({
                projectId: state.projectId!,
                sequence: [{ actionType: 'script-gen', nodeId: 'script-1', label: '解说文案' }],
                sourceMedia: state.mediaItems?.[0]?.filePath || '',
              });
            }
          })
          .then((result: any) => {
            if (result) {
              const pipelineData = result?.data || result;
              mapPipelineResultToState(pipelineData, useStore.getState());
            }
            if (useStore.getState().isAutoMode) {
              useStore.getState().setStepCompleted(3, true);
              useStore.getState().setStepStatus(3, 'completed');
              useStore.getState().setCurrentStep(4);
            }
          })
          .catch((err: any) => {
            state.setPipelineError(err?.message || '自动管线执行失败');
            state.setPipelineRunning(false);
          })
          .finally(() => {
            useStore.getState().setPipelineRunning(false);
          });
      }
      // 手动模式：停留在步骤1，等待用户点击"下一步"
    });

    return () => {
      if (unsub && typeof unsub === 'function') unsub();
    };
  }, []);

  /** 获取步骤状态（融合 stepCompleted 和 stepStatuses） */
  const getStepStatus = (step: number) => {
    const execStatus = stepStatuses[step - 1];
    if (execStatus === 'completed' || stepCompleted[step - 1]) return 'done';
    if (execStatus === 'running') return 'running';
    if (step === currentStep) return 'active';
    return 'pending';
  };

  /** 步骤编号到管线节点序列的映射 */
  const STEP_SEQUENCES: Record<number, { actionType: string; nodeId: string; label: string }[]> = useMemo(() => ({
    2: [{ actionType: 'vision-extract', nodeId: 'vlm-1', label: '画面描述' }],
    3: [{ actionType: 'script-gen', nodeId: 'script-1', label: '解说文案' }],
    4: [{ actionType: 'tts-synthesize', nodeId: 'tts-1', label: '配音合成' }],
    5: [{ actionType: 'semantic-analyze', nodeId: 'match-1', label: '镜头匹配' }],
  }), []);

  /** 执行指定步骤（步骤2-5通过引擎管线执行） */
  const handleRunStep = useCallback(async (step: number) => {
    if (!id) return;
    const sequence = STEP_SEQUENCES[step];
    if (!sequence) {
      AppNotifier.error(`步骤 ${step} 未配置管线节点`);
      return;
    }
    setStepStatus(step, 'running');
    setPipelineRunning(true);
    resetPipeline();
    try {
      const result = await API.engine.runPipeline({
        projectId: id,
        sequence,
        sourceMedia: mediaItems[0]?.filePath || '',
      });
      if (result) {
        const pipelineData = result?.data || result;
        mapPipelineResultToState(pipelineData, useStore.getState());
      }
      setStepCompleted(step, true);
      setStepStatus(step, 'completed');

      // 自动模式：完成后自动推进到下一步并启动
      if (isAutoMode && step < 5) {
        setCurrentStep(step + 1);
        handleRunStep(step + 1);
      }
      // 手动模式：停留在当前步骤，等待用户点击"下一步"
    } catch (err: any) {
      setStepStatus(step, 'failed');
      setPipelineError(err?.message || '步骤执行失败');
    } finally {
      setPipelineRunning(false);
    }
  }, [id, isAutoMode, STEP_SEQUENCES, mediaItems]);

  /** 启动当前步骤 */
  const handleStart = useCallback(async () => {
    if (currentStep === 1) {
      // 步骤1：素材提取，通过 API.media.process 触发
      const state = useStore.getState();
      const activeMedia = state.mediaItems?.[0];
      const projectId = state.projectId;
      if (!projectId || !activeMedia?.filePath) {
        AppNotifier.error('请先导入视频素材');
        return;
      }
      const config = state.extractionConfig;
      setStepStatus(1, 'running');
      setPipelineRunning(true);
      try {
        await API.media.process(projectId, activeMedia, {
          targetLanguage: config.targetLanguage || 'zh-CN',
          frames: config.frames.enabled ? {
            enabled: true,
            mode: config.frames.mode,
            [config.frames.mode === 'scene' ? 'sceneThreshold' : 'fps']: config.frames.value
          } : { enabled: false },
          audio: config.audio,
          whisper: config.whisper,
          faces: config.faces,
        });
        AppNotifier.info('素材提取任务已加入队列');
      } catch (err: any) {
        setStepStatus(1, 'failed');
        setPipelineError(err?.message || '素材提取启动失败');
        setPipelineRunning(false);
      }
      return;
    }
    handleRunStep(currentStep);
  }, [currentStep, handleRunStep, setStepStatus, setPipelineRunning, setPipelineError]);

  /** 下一步（手动模式：确认当前步骤结果，推进到下一步） */
  const handleNextStep = useCallback(() => {
    if (currentStep < 5) {
      setCurrentStep(currentStep + 1);
    }
  }, [currentStep]);

  /** 中止管线 */
  const handleAbortPipeline = useCallback(async () => {
    try { await API.engine.abortPipeline(); } catch {}
    setPipelineRunning(false);
  }, []);

  /** 视频导入：通过系统文件对话框选择视频文件并导入到项目，直接在播放器播放 */
  const handleVideoImport = useCallback(async () => {
    if (!id) return;
    try {
      setVideoError(null);
      const filePaths: string[] = await API.system.openMediaDialog();
      if (filePaths && filePaths.length > 0) {
        setVideoLoading(true);
        const newItems = await API.media.import(id, filePaths);
        if (Array.isArray(newItems) && newItems.length > 0) {
          addMediaItems(newItems);
          setActivePlaySource(newItems[0]);
        }
      }
    } catch (err: any) {
      setVideoLoading(false);
      setVideoError(err?.message || '视频导入失败');
    }
  }, [id, setActivePlaySource]);

  /** 播放/暂停切换 */
  const togglePlay = useCallback(() => {
    if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.pause();
      } else {
        // 捕获 play() 的 Promise，防止 AbortError
        videoRef.current.play().catch(() => {});
      }
    }
  }, [isPlaying]);

  /** 格式化时间 */
  const formatTime = (t: number) => {
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="flex flex-col h-screen w-screen bg-bg-deep text-foreground overflow-hidden">
      <TopBar />

        {/* 主体两栏：左侧播放器+文件区 | 分隔条 | 右侧编辑区 */}
        <div className="flex-1 flex overflow-hidden p-2 gap-0 editor-body" style={{ cursor: isDragging ? 'col-resize' : undefined, userSelect: isDragging ? 'none' : undefined }}>
          
          {/* ===== 左侧区域：播放器 + 成功文件展示 ===== */}
          <div 
            ref={leftPanelRef}
            className="glass-card overflow-hidden flex flex-col"
            style={{ 
              width: `${leftWidth}%`, 
              flexShrink: 0,
              borderRadius: '12px 0 0 12px',
              minWidth: MIN_LEFT_WIDTH
            }}
          >

            {/* 视频播放器 - 16:9 比例 */}
            <div className="glass-card overflow-hidden flex flex-col shrink-0">
              <div className="w-full bg-[#07070f] rounded-xl flex items-center justify-center relative m-2.5 mb-1"
                style={{ aspectRatio: '16 / 9' }}>
                {activePlaySource?.filePath ? (
                  <>
                    <video 
                      ref={videoRef} 
                      className="w-full h-full object-contain"
                      src={getSafeMediaUrl(activePlaySource.filePath)}
                      onCanPlay={() => { setVideoLoading(false); setVideoError(null); }}
                      onError={(e) => {
                        setVideoLoading(false);
                        const vid = e.currentTarget;
                        const err = vid.error;
                        let msg = '视频加载失败';
                        if (err) {
                          switch (err.code) {
                            case 1: msg = '视频加载被中止'; break;
                            case 2: msg = '网络错误，无法加载视频'; break;
                            case 3: msg = '视频解码失败（格式可能不受支持）'; break;
                            case 4: msg = '视频格式不支持播放'; break;
                          }
                        }
                        setVideoError(msg);
                        console.error('[VideoPlayer] 加载失败:', msg, 'src:', vid.src, 'error:', err);
                      }}
                      onTimeUpdate={() => { if (videoRef.current) setCurrentTime(videoRef.current.currentTime); }}
                      onLoadedMetadata={() => { if (videoRef.current) setVideoDuration(videoRef.current.duration); }}
                      onEnded={() => setIsPlaying(false)} 
                      onPlay={() => setIsPlaying(true)}
                      onPause={() => setIsPlaying(false)}
                    />
                    {videoLoading && (
                      <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#07070f]/80">
                        <Loader2 size={28} className="animate-spin text-accent/60" />
                        <span className="text-[11px] text-muted-foreground mt-2">正在加载视频...</span>
                      </div>
                    )}
                    {videoError && (
                      <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#07070f]/80">
                        <AlertTriangle size={28} className="text-red-400/60" />
                        <span className="text-[11px] text-red-400/80 mt-2">{videoError}</span>
                        <button onClick={handleVideoImport}
                          className="text-[10px] text-accent hover:underline cursor-pointer mt-1">重新导入</button>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="flex flex-col items-center gap-4">
                    <div className="w-[300px] h-[120px] border-2 border-dashed border-border rounded-xl flex flex-col items-center justify-center gap-2 cursor-pointer hover:border-accent hover:bg-accent/5 transition-all"
                      onClick={handleVideoImport}>
                      <Video size={32} className="opacity-40" />
                      <span className="text-[12px] text-muted-foreground">拖入视频或点击导入</span>
                      <span className="text-[10px] text-muted-foreground/50">支持 MP4 / MOV / AVI</span>
                    </div>
                  </div>
                )}
              </div>
              {/* 播放控制条 */}
              <div className="flex items-center gap-3 px-4 py-2 shrink-0">
                <button onClick={togglePlay}
                  className="w-[22px] h-[22px] rounded-full bg-accent/20 flex items-center justify-center text-accent hover:bg-accent/30 transition-colors cursor-pointer outline-none">
                  {isPlaying ? <Square size={10} fill="currentColor" /> : <Play size={11} fill="currentColor" />}
                </button>
                <div className="flex-1 h-[3px] bg-muted rounded-full overflow-hidden cursor-pointer"
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const ratio = (e.clientX - rect.left) / rect.width;
                    if (videoRef.current && videoDuration) {
                      videoRef.current.currentTime = ratio * videoDuration;
                      setCurrentTime(ratio * videoDuration);
                    }
                  }}>
                  <div className="h-full bg-accent/50 rounded-full transition-all" style={{ width: videoDuration ? `${(currentTime / videoDuration) * 100}%` : '0%' }} />
                </div>
                <span className="text-[11px] text-muted-foreground font-mono">{formatTime(currentTime)} / {formatTime(videoDuration)}</span>
                <button className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer outline-none">
                  <Volume2 size={14} />
                </button>
                <button onClick={() => {
                  const container = videoRef.current?.parentElement;
                  if (container) {
                    if (document.fullscreenElement) {
                      document.exitFullscreen();
                    } else {
                      container.requestFullscreen();
                    }
                  }
                }} className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer outline-none">
                  <Maximize size={14} />
                </button>
              </div>
            </div>

            {/* 成功文件展示区域 - 填充剩余空间 */}
            <div className="glass-card overflow-hidden flex flex-col flex-1 min-h-0">
              <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-border/30 shrink-0">
                <span className="text-[12px] font-semibold">成功文件</span>
                <span className="text-[10px] text-muted-foreground">共 {mediaItems.filter((m: any) => m.type !== 'video').length} 项</span>
              </div>
              {/* 分类标签 */}
              <div className="flex items-center gap-1 px-3.5 pt-1.5 pb-0 shrink-0">
                {MEDIA_TABS.map(tab => (
                  <button key={tab.key} onClick={() => {}}
                    className={`flex items-center gap-1 px-2.5 py-1 text-[11px] rounded-t-md transition-colors cursor-pointer outline-none ${
                      tab.key === 'all' ? 'bg-bg-secondary text-foreground font-medium border-b-2 border-accent' : 'text-muted-foreground hover:text-foreground'
                    }`}>
                    {tab.icon}{tab.label}
                    {tab.key === 'video' && mediaItems.filter((m: any) => m.type === 'video').length > 0 && (
                      <span className="ml-0.5 text-[9px] opacity-60">({mediaItems.filter((m: any) => m.type === 'video').length})</span>
                    )}
                    {tab.key === 'audio' && mediaItems.filter((m: any) => m.type === 'audio').length > 0 && (
                      <span className="ml-0.5 text-[9px] opacity-60">({mediaItems.filter((m: any) => m.type === 'audio').length})</span>
                    )}
                    {tab.key === 'frames' && mediaItems.filter((m: any) => m.type === 'frame').length > 0 && (
                      <span className="ml-0.5 text-[9px] opacity-60">({mediaItems.filter((m: any) => m.type === 'frame').length})</span>
                    )}
                  </button>
                ))}
              </div>
              {/* 横向滚动卡片展示区 - 只展示管线产出物，过滤掉原始视频 */}
              <div className="flex-1 overflow-x-auto overflow-y-hidden px-3.5 py-3">
                {mediaItems.filter((m: any) => m.type !== 'video').length > 0 ? (
                  <div className="flex gap-2.5 h-full items-start">
                    {mediaItems.filter((m: any) => m.type !== 'video').map((item: any) => (
                      <div key={item.id} 
                        className={`min-w-[120px] glass-card-sm overflow-hidden cursor-pointer hover:border-accent/30 transition-all ${activePlaySource?.id === item.id ? 'border-accent' : ''}`}
                        onClick={() => setActivePlaySource(item)}>
                        <div className="w-full h-[68px] bg-bg-secondary flex items-center justify-center relative">
                          {item.coverPath || item.thumbnail ? (
                            <img src={getSafeMediaUrl(item.coverPath || item.thumbnail)} className="w-full h-full object-cover" />
                          ) : item.type === 'audio' ? (
                            <Music size={20} className="text-muted-foreground/30" />
                          ) : (
                            <Image size={20} className="text-muted-foreground/30" />
                          )}
                          {/* 类型标签 */}
                          <span className="absolute top-1.5 right-1.5 text-[8px] px-1 py-0.5 rounded bg-black/50 text-white/70">
                            {item.type === 'audio' ? '音频' : '帧'}
                          </span>
                          {/* 时长 */}
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
            ref={dividerRef}
            onMouseDown={handleDividerMouseDown}
            className={`w-1.5 flex-shrink-0 cursor-col-resize transition-all relative group ${isDragging ? 'bg-accent' : 'bg-transparent hover:bg-accent/50'}`}
            style={{ cursor: isDragging ? 'col-resize' : undefined }}
          >
            <div className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-0.5 h-8 rounded transition-all ${isDragging ? 'bg-white' : 'bg-border group-hover:bg-accent/50'}`} />
          </div>

          {/* ===== 右侧区域：编辑工作区 + 参数设置 ===== */}
          <div className="flex-1 flex flex-col min-w-[400px] glass-card overflow-hidden" style={{ borderRadius: '0 12px 12px 0' }}>

            {/* 步骤进度条 */}
            <div className="flex items-center justify-between px-5 py-2.5 border-b border-border/30 shrink-0">
              <div className="flex items-center gap-0">
                {STEPS.map((step, i) => (
                  <div key={step.key} className="flex items-center">
                    <button onClick={() => setCurrentStep(step.key)}
                      className={`flex items-center gap-1.5 cursor-pointer outline-none transition-all ${
                        getStepStatus(step.key) === 'active' ? 'text-accent' :
                        getStepStatus(step.key) === 'done' ? 'text-accent-green' :
                        getStepStatus(step.key) === 'running' ? 'text-primary' : 'text-muted-foreground'
                      }`}>
                      <div className={`w-[22px] h-[22px] rounded-md flex items-center justify-center text-[11px] font-bold ${
                        getStepStatus(step.key) === 'active' ? 'bg-accent text-white shadow-sm shadow-accent/30' :
                        getStepStatus(step.key) === 'done' ? 'bg-accent-green/20 text-accent-green' :
                        getStepStatus(step.key) === 'running' ? 'bg-primary/20 text-primary' :
                        'bg-muted text-muted-foreground'
                      }`}>
                        {getStepStatus(step.key) === 'done' ? <Check size={12} /> :
                         getStepStatus(step.key) === 'running' ? <Loader2 size={12} className="animate-spin" /> :
                         step.key}
                      </div>
                      <span className="text-[11px] font-medium hidden xl:inline">{step.label}</span>
                    </button>
                    {i < STEPS.length - 1 && (
                      <div className={`w-7 h-px mx-1 ${step.key < currentStep ? 'bg-accent-green/40' : 'bg-border/30'}`} />
                    )}
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-0.5 bg-bg-secondary rounded-lg p-[3px]">
                <button onClick={() => setIsAutoMode(false)}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-all cursor-pointer outline-none ${!isAutoMode ? 'bg-accent/15 text-accent' : 'text-muted-foreground hover:text-foreground'}`}>
                  手动
                </button>
                <button onClick={() => setIsAutoMode(true)}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-all cursor-pointer outline-none ${isAutoMode ? 'bg-accent/15 text-accent' : 'text-muted-foreground hover:text-foreground'}`}>
                  自动
                </button>
              </div>
            </div>

            {/* 管线进度条 */}
            <div className="flex items-center gap-3 px-4 py-1.5 border-b border-border/30 shrink-0">
              <span className="text-[11px] text-muted-foreground shrink-0">当前: {pipelineNode || '待启动'}</span>
              <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden">
                <div className="h-full bg-accent rounded-full transition-all duration-300" style={{ width: `${pipelineProgress}%` }} />
              </div>
              <span className="text-[11px] text-accent font-medium shrink-0">{pipelineProgress}%</span>
              {pipelineRunning && (
                <button onClick={handleAbortPipeline} className="text-[11px] text-accent-rose hover:underline cursor-pointer outline-none shrink-0">
                  中止
                </button>
              )}
            </div>

            {/* 管线错误提示 */}
            {pipelineError && (
              <div className="flex items-center gap-2 px-4 py-2 bg-accent-rose/10 border-b border-accent-rose/20 shrink-0">
                <AlertTriangle size={14} className="text-accent-rose shrink-0" />
                <span className="text-[11px] text-accent-rose flex-1">{pipelineError}</span>
                <button onClick={() => resetPipeline()} className="text-[11px] text-accent-rose hover:underline cursor-pointer outline-none">
                  关闭
                </button>
              </div>
            )}

            {/* 工作区 */}
            <div className="flex-1 overflow-y-auto p-5">
              {(hydrationStatus === 'LOADING' || hydrationStatus === 'IDLE') && (
                <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                  <Loader2 className="w-8 h-8 animate-spin text-accent mb-4" />
                  <div className="text-[13px] font-medium tracking-widest animate-pulse">装载工作空间...</div>
                </div>
              )}

              {hydrationStatus === 'ERROR' && (
                <div className="flex flex-col items-center justify-center h-full">
                  <div className="w-16 h-16 rounded-2xl bg-accent-rose/10 flex items-center justify-center mb-6 border border-accent-rose/20">
                    <AlertTriangle className="w-8 h-8 text-accent-rose" />
                  </div>
                  <h2 className="text-lg font-bold mb-2">工作空间装载失败</h2>
                  <div className="flex gap-3">
                    <button onClick={() => window.location.reload()} className="flex items-center gap-2 px-6 py-2.5 bg-bg-secondary hover:bg-muted rounded-xl text-[12px] transition-all cursor-pointer outline-none">
                      <RefreshCcw size={14} /> 强制重载
                    </button>
                    <button onClick={() => navigate('/')} className="flex items-center gap-2 px-6 py-2.5 bg-bg-secondary hover:bg-muted rounded-xl text-[12px] transition-all cursor-pointer outline-none">
                      返回首页
                    </button>
                  </div>
                </div>
              )}

              {hydrationStatus === 'READY' && (
                <div className="animate-fade-in-up">
                  {/* ===== 步骤1：素材分析 ===== */}
                  {currentStep === 1 && (
                    <div className="flex flex-col gap-4">
                      {/* 音频分离状态 */}
                      <div className="flex items-center gap-3">
                        <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${audioSeparated ? 'bg-accent-green/10' : 'bg-muted/30'}`}>
                          {audioSeparated ? <CheckCircle2 size={18} className="text-accent-green" /> : <Clock size={18} className="text-muted-foreground" />}
                        </div>
                        <div>
                          <div className="text-[13px] font-semibold">音频分离</div>
                          <div className="text-[11px] text-muted-foreground">{audioSeparated ? '已提取人声和背景音轨' : '等待管线执行'}</div>
                        </div>
                      </div>

                      {/* 关键帧提取状态 */}
                      <div className="flex items-center gap-3">
                        <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${frameCount > 0 ? 'bg-accent-green/10' : 'bg-muted/30'}`}>
                          {frameCount > 0 ? <CheckCircle2 size={18} className="text-accent-green" /> : <Clock size={18} className="text-muted-foreground" />}
                        </div>
                        <div>
                          <div className="text-[13px] font-semibold">关键帧提取</div>
                          <div className="text-[11px] text-muted-foreground">{frameCount > 0 ? `共提取 ${frameCount} 帧画面` : '等待管线执行'}</div>
                        </div>
                      </div>

                      {/* ASR 台词识别列表 */}
                      <div>
                        <div className="text-[13px] font-semibold mb-2">ASR 台词识别（可修正）</div>
                        {asrLines.length > 0 ? (
                          <div className="glass-card-sm overflow-hidden">
                            {asrLines.map((line: any, idx: number) => (
                              <div key={idx} className="flex items-start gap-3 px-3.5 py-2.5 border-b border-border/15 last:border-0">
                                <span className="text-[11px] font-mono text-accent shrink-0 pt-0.5 w-12">{line.start || '00:00'}</span>
                                {line.editing ? (
                                  <input value={line.text} onChange={(e) => updateAsrLine(idx, e.target.value)}
                                    onBlur={() => useStore.setState(s => ({ asrLines: s.asrLines.map((l: any, i: number) => i === idx ? { ...l, editing: false } : l) }))}
                                    onKeyDown={(e) => { if (e.key === 'Enter') useStore.setState(s => ({ asrLines: s.asrLines.map((l: any, i: number) => i === idx ? { ...l, editing: false } : l) })); }}
                                    className="flex-1 text-[12px] bg-bg-secondary px-2 py-1 rounded border border-accent/30 outline-none" autoFocus />
                                ) : (
                                  <span className="flex-1 text-[12px] text-foreground cursor-pointer hover:text-accent transition-colors"
                                    onClick={() => useStore.setState(s => ({ asrLines: s.asrLines.map((l: any, i: number) => i === idx ? { ...l, editing: true } : l) }))}>
                                    {line.text}
                                  </span>
                                )}
                                <button onClick={() => useStore.setState(s => ({ asrLines: s.asrLines.map((l: any, i: number) => i === idx ? { ...l, editing: true } : l) }))}
                                  className="text-muted-foreground hover:text-accent transition-colors cursor-pointer outline-none shrink-0">
                                  <Edit3 size={12} />
                                </button>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="glass-card-sm p-4 text-[12px] text-muted-foreground text-center">
                            执行管线后，ASR 识别结果将在此显示，支持逐句点击修正
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* ===== 步骤2：画面描述 ===== */}
                  {currentStep === 2 && (
                    <div className="flex flex-col gap-4">
                      <div className="text-[13px] font-semibold">VLM 画面描述修正</div>
                      {vlmFrames.length > 0 ? (
                        <div className="flex flex-col gap-3">
                          {vlmFrames.map((frame: any, idx: number) => (
                            <div key={idx} className="glass-card-sm p-3 flex gap-3">
                              <div className="w-[100px] h-[68px] rounded-md bg-bg-secondary overflow-hidden shrink-0">
                                {frame.url ? <img src={frame.url} className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center text-[10px] text-muted-foreground">帧 {idx + 1}</div>}
                              </div>
                              <div className="flex-1 flex flex-col gap-1">
                                {frame.editing ? (
                                  <textarea value={frame.description}
                                    onChange={(e) => updateVlmDescription(idx, e.target.value)}
                                    onBlur={() => setVlmEditing(idx, false)}
                                    className="flex-1 text-[12px] bg-bg-secondary px-2 py-1.5 rounded border border-accent/30 outline-none resize-none min-h-[40px]" autoFocus />
                                ) : (
                                  <div className="text-[12px] text-foreground leading-relaxed cursor-pointer hover:text-accent transition-colors"
                                    onClick={() => setVlmEditing(idx, true)}>
                                    {frame.description || '点击添加描述'}
                                  </div>
                                )}
                                <div className="text-[10px] text-muted-foreground">帧 {idx + 1}</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="glass-card-sm p-4 text-[12px] text-muted-foreground text-center">
                          完成素材分析后，VLM 分析结果将在此显示，支持逐帧修正描述
                        </div>
                      )}
                    </div>
                  )}

                  {/* ===== 步骤3：解说文案 ===== */}
                  {currentStep === 3 && (
                    <div className="flex flex-col gap-4">
                      <div className="text-[13px] font-semibold">AI 解说文案生成</div>

                      {/* 风格选择 */}
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-muted-foreground shrink-0">风格:</span>
                        <div className="flex items-center gap-1 flex-wrap">
                          {SCRIPT_STYLES.map(style => (
                            <button key={style} onClick={() => setScriptStyle(style)}
                              className={`px-2 py-0.5 rounded-md text-[10px] transition-all cursor-pointer outline-none ${
                                scriptStyle === style ? 'bg-accent/15 text-accent font-medium' : 'bg-bg-secondary text-muted-foreground hover:text-foreground'
                              }`}>
                              {style}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* R/S/T/P 参数滑块 - 参数设置面板 */}
                      <div className="glass-card-sm p-3 flex flex-col gap-3">
                        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                          <Sliders size={12} /> 创作参数
                        </div>
                        {(['R', 'S', 'T', 'P'] as const).map(param => (
                          <div key={param} className="flex items-center gap-3">
                            <span className="w-20 text-[11px] text-foreground font-medium shrink-0">
                              {param === 'R' ? '经典保留' : param === 'S' ? '原台词保留' : param === 'T' ? 'TTS覆盖' : '节奏因子'}
                            </span>
                            <input type="range" min={0} max={100} value={pipelineParams[param]}
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
                              <div className="flex items-center gap-2 mb-1">
                                <span className="text-[10px] text-accent font-mono">{p.shotId || p.id}</span>
                                <span className="text-[10px] text-muted-foreground">{p.duration ? `${p.duration}s` : ''}</span>
                              </div>
                              <textarea value={p.text}
                                onChange={(e) => updateScriptParagraph(p.id, e.target.value)}
                                className="w-full text-[13px] leading-relaxed bg-transparent outline-none resize-none min-h-[48px]" />
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="glass-card-sm p-4 text-[12px] text-muted-foreground text-center">
                          执行管线后，AI 生成的解说文案将在此显示，支持逐段编辑与参数调节
                        </div>
                      )}
                    </div>
                  )}

                  {/* ===== 步骤4：配音合成 ===== */}
                  {currentStep === 4 && (
                    <div className="flex flex-col gap-4">
                      <div className="text-[13px] font-semibold">TTS 配音合成</div>

                      {/* TTS 引擎选择 */}
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-muted-foreground shrink-0">引擎:</span>
                        <div className="flex items-center gap-1">
                          {(['edge', 'moss', 'doubao', 'fish'] as const).map(eng => (
                            <button key={eng} onClick={() => setTtsEngine(eng)}
                              className={`px-2.5 py-1 rounded-md text-[10px] transition-all cursor-pointer outline-none ${
                                ttsEngine === eng ? 'bg-accent/15 text-accent font-medium' : 'bg-bg-secondary text-muted-foreground hover:text-foreground'
                              }`}>
                              {eng === 'edge' ? 'Edge TTS' : eng === 'moss' ? 'MOSS' : eng === 'doubao' ? '火山引擎' : 'Fish Audio'}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* TTS 合成进度 */}
                      {ttsProgress > 0 && ttsProgress < 100 && (
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden">
                            <div className="h-full bg-accent-cyan rounded-full transition-all" style={{ width: `${ttsProgress}%` }} />
                          </div>
                          <span className="text-[10px] text-accent-cyan">{ttsProgress}%</span>
                        </div>
                      )}

                      {/* TTS 合成结果 */}
                      <div className="glass-card-sm p-4 text-[12px] text-muted-foreground text-center">
                        文案确认后，TTS 引擎将逐段合成配音，支持试听与重新生成
                      </div>
                    </div>
                  )}

                  {/* ===== 步骤5：镜头匹配 ===== */}
                  {currentStep === 5 && (
                    <div className="flex flex-col gap-4">
                      <div className="text-[13px] font-semibold">镜头匹配</div>
                      {matchResults.length > 0 ? (
                        <div className="grid grid-cols-2 gap-3">
                          {matchResults.map((m: any) => (
                            <div key={m.shotId} className={`glass-card-sm p-3 flex gap-3 ${m.confirmed ? 'border-accent-green/30' : ''}`}>
                              <div className="w-[140px] h-[80px] rounded-md bg-bg-secondary overflow-hidden shrink-0">
                                {m.thumbnail ? <img src={m.thumbnail} className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center text-[10px] text-muted-foreground">镜头</div>}
                              </div>
                              <div className="flex-1 flex flex-col gap-1.5">
                                <div className="flex items-center gap-2">
                                  <span className="text-[11px] font-medium">{m.shotId}</span>
                                  <span className={`text-[9px] px-1.5 py-0.5 rounded ${m.score > 0.8 ? 'bg-accent-green/15 text-accent-green' : m.score > 0.5 ? 'bg-yellow-500/15 text-yellow-500' : 'bg-accent-rose/15 text-accent-rose'}`}>
                                    匹配度 {Math.round(m.score * 100)}%
                                  </span>
                                </div>
                                <div className="flex items-center gap-1.5 mt-auto">
                                  {m.confirmed ? (
                                    <span className="text-[10px] text-accent-green flex items-center gap-1"><Check size={10} /> 已确认</span>
                                  ) : (
                                    <>
                                      <button onClick={() => confirmMatch(m.shotId)}
                                        className="text-[10px] px-2 py-0.5 rounded bg-accent-green/15 text-accent-green hover:bg-accent-green/25 cursor-pointer outline-none">
                                        确认
                                      </button>
                                      <button className="text-[10px] px-2 py-0.5 rounded bg-bg-secondary text-muted-foreground hover:text-foreground cursor-pointer outline-none">
                                        替换
                                      </button>
                                    </>
                                  )}
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="glass-card-sm p-4 text-[12px] text-muted-foreground text-center">
                          执行管线后，AI 将自动匹配文案段落与画面素材，支持手动替换与重新匹配
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 底部操作栏 */}
            <div className="flex items-center justify-between px-4 py-2 border-t border-border/30 shrink-0">
              <span className="text-[12px] text-muted-foreground">
                步骤 {currentStep}/5 · {STEPS[currentStep - 1].label}
                {stepStatuses[currentStep - 1] === 'completed' && <span className="text-green-500 ml-1">已完成</span>}
                {stepStatuses[currentStep - 1] === 'failed' && <span className="text-destructive ml-1">失败</span>}
              </span>
              <div className="flex items-center gap-2">
                {/* 启动按钮：执行当前步骤 */}
                <button onClick={handleStart} disabled={pipelineRunning || stepStatuses[currentStep - 1] === 'running'}
                  className="h-8 px-4 rounded-lg bg-gradient-to-r from-accent to-accent-purple text-white text-[11px] font-semibold shadow-md shadow-accent/20 hover:brightness-110 transition-all cursor-pointer outline-none flex items-center gap-1.5 disabled:opacity-60 disabled:cursor-not-allowed">
                  <Play size={13} /> {pipelineRunning ? '执行中...' : '启动'}
                </button>
                {/* 下一步按钮：手动模式下，当前步骤已完成时显示 */}
                {!isAutoMode && stepStatuses[currentStep - 1] === 'completed' && currentStep < 5 && (
                  <button onClick={handleNextStep}
                    className="h-8 px-4 rounded-lg bg-bg-secondary border border-border/50 text-[11px] font-medium hover:border-accent/40 hover:text-accent transition-all cursor-pointer outline-none flex items-center gap-1.5">
                    下一步 <ChevronRight size={13} />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
    </div>
  );
}
