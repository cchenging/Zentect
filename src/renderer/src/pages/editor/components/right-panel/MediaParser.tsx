// 📁 路径: src/renderer/src/pages/editor/components/right-panel/MediaParser.tsx
// 媒体解析面板 - 步骤卡片化改造：每个子步骤独立启动按钮+状态显示
import React, { useCallback, useMemo, useState } from 'react';
import { Film, ScanFace, ListMusic, Mic, Cpu, XCircle, RefreshCw, Loader2, AlertCircle, CheckCircle2, Play, RotateCcw } from 'lucide-react';
import { useStore } from '../../../../store/useStore';
import { useTaskStore } from '../../../../store/useTaskStore';
import { useI18n } from '../../../../store/useI18n';
import { Button } from '../../../../components/ui/button';
import { Switch } from '../../../../components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../../components/ui/select';
import { Slider } from '../../../../components/ui/slider';
import { AppNotifier } from '../../../../core/AppNotifier';
import { getSafeMediaUrl } from '../../../../utils/formatUrl';
import { API } from '../../../../api';
import { FrontendLogger } from '../../../../utils/logger';
import type { StepStatus } from '../../../../store/storeTypes';

/** 状态对应的颜色和图标映射 */
const STATUS_STYLE: Record<StepStatus, { bg: string; text: string; border: string }> = {
  idle: { bg: 'bg-muted/30', text: 'text-muted-foreground', border: 'border-border/40' },
  running: { bg: 'bg-primary/5', text: 'text-primary', border: 'border-primary/30' },
  completed: { bg: 'bg-green-500/5', text: 'text-green-500', border: 'border-green-500/30' },
  failed: { bg: 'bg-destructive/5', text: 'text-destructive', border: 'border-destructive/30' },
};

interface StepCardProps {
  icon: React.ElementType;
  title: string;
  desc: string;
  status: StepStatus;
  isChecked: boolean;
  isDisabled: boolean;
  disableReason?: string;
  /** 子步骤结果摘要 */
  resultSummary?: string;
  onToggle: () => void;
  onStart: () => void;
  onRetry?: () => void;
  children?: React.ReactNode;
}

/** 步骤卡片组件：含状态指示、独立启动按钮、配置展开区 */
const StepCard = React.memo<StepCardProps>(({
  icon: Icon, title, desc, status, isChecked, isDisabled, disableReason, resultSummary, onToggle, onStart, onRetry, children
}) => {
  const style = STATUS_STYLE[status];
  const isRunning = status === 'running';

  return (
    <div className={`flex flex-col border rounded-lg transition-colors ${style.border} ${style.bg}`}>
      {/* 头部：图标+标题+状态+开关+启动按钮 */}
      <div className="flex items-center justify-between p-3 hover:bg-accent/10 transition-colors">
        <div className="flex items-center gap-3 overflow-hidden flex-1">
          {/* 状态图标 */}
          <div className={`w-7 h-7 shrink-0 rounded-md flex items-center justify-center transition-colors ${
            status === 'completed' ? 'bg-green-500/15 text-green-500' :
            status === 'running' ? 'bg-primary/15 text-primary' :
            status === 'failed' ? 'bg-destructive/15 text-destructive' :
            isChecked ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'
          }`}>
            {status === 'running' ? <Loader2 size={14} className="animate-spin" /> :
             status === 'completed' ? <CheckCircle2 size={14} /> :
             status === 'failed' ? <AlertCircle size={14} /> :
             <Icon size={14} />}
          </div>
          <div className="flex flex-col overflow-hidden">
            <span className="text-foreground text-[13px] font-medium truncate">{title}</span>
            <span className="text-muted-foreground text-[11px] truncate mt-0.5">
              {status === 'completed' && resultSummary ? resultSummary : desc}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0 ml-2">
          {/* 启动/重试按钮 */}
          {isChecked && status === 'idle' && (
            <button onClick={onStart} disabled={isDisabled}
              className="w-7 h-7 rounded-md bg-primary/10 text-primary hover:bg-primary/20 flex items-center justify-center transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed outline-none"
              title="启动此步骤">
              <Play size={12} fill="currentColor" />
            </button>
          )}
          {status === 'failed' && onRetry && (
            <button onClick={onRetry}
              className="w-7 h-7 rounded-md bg-destructive/10 text-destructive hover:bg-destructive/20 flex items-center justify-center transition-colors cursor-pointer outline-none"
              title="重试此步骤">
              <RotateCcw size={12} />
            </button>
          )}
          {status === 'completed' && (
            <button onClick={onStart}
              className="w-7 h-7 rounded-md bg-secondary text-muted-foreground hover:text-foreground flex items-center justify-center transition-colors cursor-pointer outline-none"
              title="重新执行此步骤">
              <RefreshCw size={12} />
            </button>
          )}
          {/* 启用开关 */}
          <Switch className="shrink-0" checked={isChecked} onCheckedChange={onToggle} disabled={isRunning} />
        </div>
      </div>

      {/* 依赖阻断提示 */}
      {isDisabled && disableReason && !isChecked && (
        <div className="px-3 pb-2.5 flex items-start gap-1.5 text-destructive mt-1">
          <AlertCircle size={12} className="shrink-0 mt-0.5" />
          <span className="text-[10px] leading-tight">{disableReason}</span>
        </div>
      )}

      {/* 配置展开区 */}
      {isChecked && children && (
        <div className="flex flex-col gap-3.5 px-4 pb-4 pt-2 bg-secondary/10 border-t border-border/20">
          {children}
        </div>
      )}
    </div>
  );
});
StepCard.displayName = 'StepCard';

export const MediaParser: React.FC = () => {
  const { selectedItemId, mediaItems: mediaItemsStore, projectId, extractionConfig, updateExtractionConfig,
    subStepStatuses, setSubStepStatus, setStepStatus, isAutoMode } = useStore();
  const { tasks } = useTaskStore();
  const { t } = useI18n();

  const [imgError, setImgError] = useState(false);

  // 防御性编程：确保 mediaItems 是数组
  const mediaItems = Array.isArray(mediaItemsStore) ? mediaItemsStore : [];

  const activeMedia = useMemo(() => mediaItems.find(m => m.id === selectedItemId), [mediaItems, selectedItemId]);
  const activeTask = activeMedia ? tasks[activeMedia.id] : null;
  const isAnyRunning = Object.values(subStepStatuses).some(s => s === 'running');

  /** 引擎选项配置 */
  const ENGINE_OPTIONS = useMemo(() => ({
    frames: [
      { value: 'scene', label: t.mediaParser?.engines?.scene || '智能场景检测 (推荐)' },
      { value: 'fps', label: t.mediaParser?.engines?.fps || '固定频率抽帧 (FPS)' }
    ],
    faces: [
      { value: 'insightface', label: t.mediaParser?.engines?.insightface || 'InsightFace (高精度)', disabled: false },
      { value: 'mediapipe', label: t.mediaParser?.engines?.mediapipe || 'MediaPipe (待接入)', disabled: true }
    ],
    audio: [
      { value: 'mdx-net', label: t.mediaParser?.engines?.mdx_net || 'UVR MDX-Net (HQ_4)', disabled: false },
      { value: 'spleeter', label: t.mediaParser?.engines?.spleeter || 'Spleeter (待接入)', disabled: true }
    ],
    whisper: [
      { value: 'sensevoice', label: t.mediaParser?.engines?.sensevoice || 'SenseVoice (极速版)', disabled: false },
      { value: 'whisper-v3', label: t.mediaParser?.engines?.whisper_v3 || 'Whisper V3 (待接入)', disabled: true }
    ]
  }), [t]);

  const LANG_OPTIONS = useMemo(() => [
    { value: 'zh-CN', label: t.mediaParser?.lang_zh || '中文 (Mandarin)' },
    { value: 'en-US', label: t.mediaParser?.lang_en || '英语 (English)' },
    { value: 'ja-JP', label: t.mediaParser?.lang_ja || '日语 (日本語)' },
    { value: 'ko-KR', label: t.mediaParser?.lang_ko || '韩语 (한국어)' }
  ], [t]);

  /** 构建指定子步骤的配置载荷（仅启用该子步骤） */
  const buildStepConfig = useCallback((stepKey: string) => ({
    targetLanguage: extractionConfig.targetLanguage || 'zh-CN',
    frames: stepKey === 'frames' ? {
      enabled: true,
      mode: extractionConfig.frames.mode,
      [extractionConfig.frames.mode === 'scene' ? 'sceneThreshold' : 'fps']: extractionConfig.frames.value
    } : { enabled: false },
    audio: stepKey === 'audio' ? { ...extractionConfig.audio, enabled: true } : { enabled: false },
    whisper: stepKey === 'whisper' ? { ...extractionConfig.whisper, enabled: true } : { enabled: false },
    faces: stepKey === 'faces' ? { ...extractionConfig.faces, enabled: true } : { enabled: false },
  }), [extractionConfig]);

  /** 构建全部启用的配置载荷 */
  const buildAllEnabledConfig = useCallback(() => ({
    targetLanguage: extractionConfig.targetLanguage || 'zh-CN',
    frames: extractionConfig.frames.enabled ? {
      enabled: true,
      mode: extractionConfig.frames.mode,
      [extractionConfig.frames.mode === 'scene' ? 'sceneThreshold' : 'fps']: extractionConfig.frames.value
    } : { enabled: false },
    audio: extractionConfig.audio,
    whisper: extractionConfig.whisper,
    faces: extractionConfig.faces,
  }), [extractionConfig]);

  /** 启动单个子步骤 */
  const handleStartSubStep = useCallback(async (stepKey: string) => {
    if (!projectId || !activeMedia?.id || !(activeMedia as any).filePath) {
      AppNotifier.error('请先导入视频素材');
      return;
    }
    const traceId = FrontendLogger.generateTraceId();
    try {
      setSubStepStatus(stepKey, 'running');
      FrontendLogger.info('MediaParser', `Dispatching sub-step: ${stepKey}`, traceId, { mediaId: activeMedia.id });
      const config = buildStepConfig(stepKey);
      await API.media.process(projectId, activeMedia, config);
      AppNotifier.info(`已启动：${stepKey}`);
    } catch (error: any) {
      FrontendLogger.error('MediaParser', `Sub-step ${stepKey} failed`, traceId, error);
      setSubStepStatus(stepKey, 'failed');
      AppNotifier.error(error.message || '步骤启动异常');
    }
  }, [projectId, activeMedia, buildStepConfig, setSubStepStatus, t]);

  /** 启动全部已启用的子步骤 */
  const handleStartAll = useCallback(async () => {
    if (!projectId || !activeMedia?.id || !(activeMedia as any).filePath) {
      AppNotifier.error('请先导入视频素材');
      return;
    }
    const traceId = FrontendLogger.generateTraceId();
    try {
      // 标记所有已启用的子步骤为 running
      const enabledKeys = ['frames', 'audio', 'whisper', 'faces'] as const;
      enabledKeys.forEach(key => {
        if (extractionConfig[key].enabled) {
          setSubStepStatus(key, 'running');
        }
      });
      setStepStatus(1, 'running');
      FrontendLogger.info('MediaParser', 'Dispatching all enabled sub-steps', traceId, { mediaId: activeMedia.id });
      const config = buildAllEnabledConfig();
      await API.media.process(projectId, activeMedia, config);
      AppNotifier.info(t.mediaParser?.notify_success || '任务已加入队列');
    } catch (error: any) {
      FrontendLogger.error('MediaParser', 'All-steps dispatch failed', traceId, error);
      AppNotifier.error(error.message || '提取异常');
    }
  }, [projectId, activeMedia, buildAllEnabledConfig, extractionConfig, setSubStepStatus, setStepStatus, t]);

  /** 取消当前任务 */
  const handleCancel = useCallback(async () => {
    if (!activeMedia?.id) return;
    try {
      await API.media.cancelProcess(activeMedia.id);
      // 重置所有 running 状态为 idle
      ['frames', 'audio', 'whisper', 'faces'].forEach(key => {
        if (subStepStatuses[key] === 'running') {
          setSubStepStatus(key, 'idle');
        }
      });
      setStepStatus(1, 'idle');
      AppNotifier.info(t.mediaParser?.notify_cancel_success || '已终止指令');
    } catch (error: any) {
      AppNotifier.error(error.message || t.mediaParser?.notify_cancel_error || '终止失败');
    }
  }, [activeMedia?.id, subStepStatuses, setSubStepStatus, setStepStatus, t]);

  /** 配置变更处理 */
  const handleConfigChange = useCallback((key: keyof typeof extractionConfig, value: any) => {
    updateExtractionConfig({ [key]: value });
  }, [updateExtractionConfig]);

  /** 监听任务完成，更新子步骤状态 */
  React.useEffect(() => {
    if (!activeMedia?.id || !activeTask) return;

    // 从任务进度码映射到子步骤
    const code = (activeTask as any).code || '';
    const status = activeTask.status;

    if (status === 'completed' || (activeTask as any).percent >= 100) {
      // 全部完成
      ['frames', 'audio', 'whisper', 'faces'].forEach(key => {
        if (subStepStatuses[key] === 'running') {
          setSubStepStatus(key, 'completed');
        }
      });
      setStepStatus(1, 'completed');
      setStepStatus(1, true as any); // 兼容 stepCompleted
    } else if (status === 'error' || status === 'failed') {
      // 根据进度码判断哪个步骤失败
      if (code.includes('extracting_frames') || code.includes('frame')) {
        setSubStepStatus('frames', 'failed');
      } else if (code.includes('audio') || code.includes('separate')) {
        setSubStepStatus('audio', 'failed');
      } else if (code.includes('parsing_text') || code.includes('whisper') || code.includes('asr')) {
        setSubStepStatus('whisper', 'failed');
      } else if (code.includes('vision') || code.includes('face') || code.includes('indexing')) {
        setSubStepStatus('faces', 'failed');
      }
    } else if (status === 'running') {
      // 根据进度码更新当前运行步骤
      if (code.includes('extracting_frames')) {
        setSubStepStatus('frames', 'running');
      } else if (code.includes('audio') || code.includes('separate')) {
        setSubStepStatus('audio', 'running');
      } else if (code.includes('parsing_text') || code.includes('whisper')) {
        setSubStepStatus('whisper', 'running');
      } else if (code.includes('vision') || code.includes('face') || code.includes('indexing')) {
        setSubStepStatus('faces', 'running');
      }
    }
  }, [activeTask, activeMedia?.id]);

  /** 获取子步骤结果摘要 */
  const getSubStepSummary = useCallback((key: string): string => {
    const state = useStore.getState();
    switch (key) {
      case 'frames': return state.frameCount > 0 ? `已提取 ${state.frameCount} 帧` : '';
      case 'audio': return state.audioSeparated ? '人声与BGM已分离' : '';
      case 'whisper': return state.asrLines.length > 0 ? `识别 ${state.asrLines.length} 句台词` : '';
      case 'faces': return ''; // 人脸结果暂无独立计数
      default: return '';
    }
  }, []);

  if (!activeMedia) {
    return <div className="p-4 text-center text-muted-foreground text-xs mt-4">{t.mediaParser?.empty_selection || '未选择任何素材'}</div>;
  }

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden relative">

      {/* 顶部：固定媒体卡片 */}
      <div className="p-3 shrink-0 border-b border-border bg-background z-10">
        <div className="flex gap-3 bg-card p-2.5 rounded-lg border border-border shadow-sm">
          <div className="w-12 h-12 rounded bg-muted overflow-hidden shrink-0 border border-border relative">
            {activeMedia.coverPath && !imgError ? (
              <img src={getSafeMediaUrl(activeMedia.coverPath)} className="w-full h-full object-cover" alt="cover" onError={() => setImgError(true)} />
            ) : (
              <div className="w-full h-full flex items-center justify-center bg-secondary text-muted-foreground"><Film size={16} /></div>
            )}
          </div>
          <div className="flex flex-col flex-1 justify-center overflow-hidden">
            <span className="text-foreground text-[13px] font-semibold truncate leading-tight">{activeMedia.name}</span>
            <span className="text-[11px] text-muted-foreground mt-1 bg-secondary/50 self-start px-1.5 rounded">{activeMedia.duration}</span>
          </div>
        </div>
      </div>

      {/* 中间：可滚动配置区 */}
      <div className="flex-1 overflow-y-auto p-3 custom-scrollbar">
        {/* 目标语言配置舱 */}
        <div className="bg-card border border-border rounded-lg p-3 mb-3 shadow-sm flex items-center justify-between">
          <span className="text-foreground text-[13px] font-medium">{t.mediaParser?.target_lang || '目标配音与重组语种'}</span>
          <Select value={extractionConfig.targetLanguage || 'zh-CN'} onValueChange={(val: string) => handleConfigChange('targetLanguage', val)} disabled={isAnyRunning}>
            <SelectTrigger className="w-[140px] h-8 text-[12px] bg-background border-border"><SelectValue /></SelectTrigger>
            <SelectContent className="bg-popover border-border text-[12px]">
              {LANG_OPTIONS.map(opt => <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        {/* 4个子步骤卡片 */}
        <div className="flex flex-col gap-2.5">

          {/* 视觉切片引擎 */}
          <StepCard
            icon={Film}
            title={t.mediaParser?.frames?.title || '视觉切片引擎'}
            desc={t.mediaParser?.frames?.desc || '抽取关键动作与转场画面'}
            status={subStepStatuses.frames}
            isChecked={extractionConfig.frames.enabled}
            isDisabled={isAnyRunning}
            resultSummary={getSubStepSummary('frames')}
            onToggle={() => handleConfigChange('frames', { ...extractionConfig.frames, enabled: !extractionConfig.frames.enabled })}
            onStart={() => handleStartSubStep('frames')}
            onRetry={() => handleStartSubStep('frames')}
          >
            <div className="flex flex-col gap-1.5">
              <span className="text-muted-foreground text-[11px] font-medium">{t.mediaParser?.frames?.strategy || '切片策略'}</span>
              <Select value={extractionConfig.frames.mode} onValueChange={(val: 'fps' | 'scene') => handleConfigChange('frames', { ...extractionConfig.frames, mode: val, value: val === 'scene' ? 0.3 : 1 })} disabled={isAnyRunning}>
                <SelectTrigger className="w-full h-8 text-[12px] bg-background border-border"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-popover border-border text-[12px]">
                  {ENGINE_OPTIONS.frames.map(opt => <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2 mt-1">
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground text-[11px] font-medium">
                  {extractionConfig.frames.mode === 'scene' ? (t.mediaParser?.frames?.sensitivity || '灵敏度 (越小越敏感)') : (t.mediaParser?.frames?.density || '密度 (越大越密)')}
                </span>
                <span className="text-primary font-mono text-[11px] font-bold bg-primary/10 px-1.5 rounded">{extractionConfig.frames.value}</span>
              </div>
              <Slider
                value={[extractionConfig.frames.value]} min={extractionConfig.frames.mode === 'scene' ? 0.1 : 1} max={extractionConfig.frames.mode === 'scene' ? 0.6 : 10} step={extractionConfig.frames.mode === 'scene' ? 0.1 : 1}
                onValueChange={(vals) => handleConfigChange('frames', { ...extractionConfig.frames, value: vals[0] })} disabled={isAnyRunning} className="w-full cursor-pointer py-2"
              />
            </div>
          </StepCard>

          {/* 音频双轨剥离 */}
          <StepCard
            icon={ListMusic}
            title={t.mediaParser?.audio?.title || '音频双轨剥离'}
            desc={t.mediaParser?.audio?.desc || '分离人声与背景音乐'}
            status={subStepStatuses.audio}
            isChecked={extractionConfig.audio.enabled}
            isDisabled={isAnyRunning}
            resultSummary={getSubStepSummary('audio')}
            onToggle={() => handleConfigChange('audio', { ...extractionConfig.audio, enabled: !extractionConfig.audio.enabled })}
            onStart={() => handleStartSubStep('audio')}
            onRetry={() => handleStartSubStep('audio')}
          >
            <div className="flex flex-col gap-1.5">
              <span className="text-muted-foreground text-[11px] font-medium">{t.mediaParser?.audio?.engine || '音轨分离算力模型'}</span>
              <Select value={extractionConfig.audio.engine} onValueChange={(val: any) => handleConfigChange('audio', { ...extractionConfig.audio, engine: val })} disabled={isAnyRunning}>
                <SelectTrigger className="w-full h-8 text-[12px] bg-background border-border"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-popover border-border text-[12px]">
                  {ENGINE_OPTIONS.audio.map(opt => <SelectItem key={opt.value} value={opt.value} disabled={opt.disabled}>{opt.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </StepCard>

          {/* AI 台词听写 */}
          <StepCard
            icon={Mic}
            title={t.mediaParser?.whisper?.title || 'AI 台词听写'}
            desc={t.mediaParser?.whisper?.desc || '生成精准时间轴字幕'}
            status={subStepStatuses.whisper}
            isChecked={extractionConfig.whisper.enabled}
            isDisabled={isAnyRunning || !extractionConfig.audio.enabled}
            disableReason={t.mediaParser?.whisper?.dependency || '依赖阻断：请先开启上方[音频剥离]提供人声'}
            resultSummary={getSubStepSummary('whisper')}
            onToggle={() => handleConfigChange('whisper', { ...extractionConfig.whisper, enabled: !extractionConfig.whisper.enabled })}
            onStart={() => handleStartSubStep('whisper')}
            onRetry={() => handleStartSubStep('whisper')}
          >
            <div className="flex flex-col gap-1.5">
              <span className="text-muted-foreground text-[11px] font-medium">{t.mediaParser?.whisper?.engine || 'ASR 语音转写引擎'}</span>
              <Select value={extractionConfig.whisper.engine} onValueChange={(val: any) => handleConfigChange('whisper', { ...extractionConfig.whisper, engine: val })} disabled={isAnyRunning}>
                <SelectTrigger className="w-full h-8 text-[12px] bg-background border-border"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-popover border-border text-[12px]">
                  {ENGINE_OPTIONS.whisper.map(opt => <SelectItem key={opt.value} value={opt.value} disabled={opt.disabled}>{opt.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </StepCard>

          {/* 人脸特征库 */}
          <StepCard
            icon={ScanFace}
            title={t.mediaParser?.faces?.title || '人脸特征库'}
            desc={t.mediaParser?.faces?.desc || '扫脸并建立角色档案'}
            status={subStepStatuses.faces}
            isChecked={extractionConfig.faces.enabled}
            isDisabled={isAnyRunning || !extractionConfig.frames.enabled}
            disableReason={t.mediaParser?.faces?.dependency || '依赖阻断：请先开启上方[视觉切片]提供画面'}
            resultSummary={getSubStepSummary('faces')}
            onToggle={() => handleConfigChange('faces', { ...extractionConfig.faces, enabled: !extractionConfig.faces.enabled })}
            onStart={() => handleStartSubStep('faces')}
            onRetry={() => handleStartSubStep('faces')}
          >
            <div className="flex flex-col gap-1.5">
              <span className="text-muted-foreground text-[11px] font-medium">{t.mediaParser?.faces?.engine || '视觉识别引擎'}</span>
              <Select value={extractionConfig.faces.engine} onValueChange={(val: any) => handleConfigChange('faces', { ...extractionConfig.faces, engine: val })} disabled={isAnyRunning}>
                <SelectTrigger className="w-full h-8 text-[12px] bg-background border-border"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-popover border-border text-[12px]">
                  {ENGINE_OPTIONS.faces.map(opt => <SelectItem key={opt.value} value={opt.value} disabled={opt.disabled}>{opt.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </StepCard>

        </div>
        <div className="h-6"></div>
      </div>

      {/* 底部：固定按钮控制区 */}
      <div className="shrink-0 p-3 bg-background border-t border-border z-10">
        {/* 全局进度条 */}
        {activeTask && activeTask.status !== 'pending' && (
          <div className="flex flex-col gap-1.5 mb-3 px-1">
            <div className="flex items-center justify-between text-[11px] font-medium">
              <span className="text-foreground flex items-center gap-1.5 truncate">
                {isAnyRunning && <Loader2 size={12} className="animate-spin text-primary shrink-0" />}
                <span className="truncate">{activeTask.text}</span>
              </span>
              <span className={`font-bold font-mono ml-2 shrink-0 ${isAnyRunning ? 'text-primary' : (activeTask.status === 'failed' ? 'text-destructive' : 'text-green-500')}`}>{activeTask.progress}%</span>
            </div>
            <div className="h-1.5 w-full bg-secondary overflow-hidden rounded-full">
              <div className="h-full bg-primary transition-all duration-300 ease-out" style={{ width: `${activeTask.progress || 0}%` }} />
            </div>
          </div>
        )}

        {/* 操作按钮 */}
        {isAnyRunning ? (
          <Button variant="destructive" className="w-full h-9 text-[13px] font-medium shadow-sm" onClick={handleCancel}>
            <XCircle size={15} className="mr-2 shrink-0" /> {t.mediaParser?.btn_cancel || '强行终止'}
          </Button>
        ) : (
          <div className="flex gap-2">
            <Button variant="default" className="flex-1 h-9 text-[13px] font-medium shadow-sm" onClick={handleStartAll}>
              <Cpu size={15} className="mr-2 shrink-0" /> 全部启动
            </Button>
          </div>
        )}
      </div>

    </div>
  );
};
