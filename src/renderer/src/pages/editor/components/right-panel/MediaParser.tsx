// 📁 路径: src/renderer/src/pages/editor/components/right-panel/MediaParser.tsx
import React, { useCallback, useMemo, useState } from 'react';
import { Film, ScanFace, ListMusic, Mic, Cpu, XCircle, RefreshCw, Loader2, AlertCircle } from 'lucide-react';
import { useEditorStore } from '../../../../store/useStore';
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

interface ParserConfigItemProps {
  icon: React.ElementType;
  title: string;
  desc: string;
  isActive: boolean;
  isChecked: boolean;
  isDisabled: boolean;
  disableReason?: string;
  onToggle: () => void;
  children?: React.ReactNode;
}

const ParserConfigItem = React.memo<ParserConfigItemProps>(({ 
  icon: Icon, title, desc, isActive, isChecked, isDisabled, disableReason, onToggle, children 
}) => (
  // 💥 修复：去掉了破坏下拉框展开的 overflow-hidden
  <div className="flex flex-col border-b border-border/40 last:border-0 bg-card">
    <div className="flex items-center justify-between p-3 hover:bg-accent/20 transition-colors">
      <div className="flex items-center gap-3 overflow-hidden">
        <div className={`w-6 h-6 shrink-0 rounded flex items-center justify-center transition-colors ${isActive ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'}`}>
          <Icon size={14} />
        </div>
        <div className="flex flex-col overflow-hidden">
          <span className="text-foreground text-[13px] font-medium truncate">{title}</span>
          <span className="text-muted-foreground text-[11px] truncate mt-0.5">{desc}</span>
        </div>
      </div>
      <Switch className="shrink-0 ml-2" checked={isChecked} onCheckedChange={onToggle} disabled={isDisabled} />
    </div>
    
    {isDisabled && disableReason && !isChecked && (
      <div className="px-3 pb-2.5 flex items-start gap-1.5 text-destructive mt-1">
        <AlertCircle size={12} className="shrink-0 mt-0.5" />
        <span className="text-[10px] leading-tight">{disableReason}</span>
      </div>
    )}

    {isActive && children && (
      <div className="flex flex-col gap-3.5 px-4 pb-4 pt-2 bg-secondary/10 border-t border-border/20">
        {children}
      </div>
    )}
  </div>
));
ParserConfigItem.displayName = 'ParserConfigItem';

export const MediaParser: React.FC = () => {
  const { selectedItemId, mediaItems: mediaItemsStore, projectId, extractionConfig, updateExtractionConfig } = useEditorStore();
  const { tasks } = useTaskStore();
  const { t } = useI18n();

  const [imgError, setImgError] = useState(false);

  // 💥 防御性编程：确保 mediaItems 是数组
  const mediaItems = Array.isArray(mediaItemsStore) ? mediaItemsStore : [];
  
  const activeMedia = useMemo(() => mediaItems.find(m => m.id === selectedItemId), [mediaItems, selectedItemId]);
  const activeTask = activeMedia ? tasks[activeMedia.id] : null;
  const isProcessing = activeTask?.status === 'running' || activeTask?.status === 'pending';

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

  const backendConfigPayload = useMemo(() => ({
    targetLanguage: extractionConfig.targetLanguage || 'zh-CN',
    frames: extractionConfig.frames.enabled ? { 
      enabled: true, 
      mode: extractionConfig.frames.mode, 
      [extractionConfig.frames.mode === 'scene' ? 'sceneThreshold' : 'fps']: extractionConfig.frames.value 
    } : { enabled: false },
    audio: extractionConfig.audio,
    whisper: extractionConfig.whisper,
    faces: extractionConfig.faces
  }), [extractionConfig]);

  const handleStartExtraction = useCallback(async () => {
    if (!projectId || !activeMedia?.id) {
      AppNotifier.error(t.mediaParser?.notify_context_lost || '上下文流失');
      return;
    }
    const traceId = FrontendLogger.generateTraceId();
    try {
      FrontendLogger.info('MediaParser', 'Dispatching pipeline', traceId, { mediaId: activeMedia.id, config: backendConfigPayload });
      await API.media.process(projectId, activeMedia, backendConfigPayload);
      AppNotifier.info(t.mediaParser?.notify_success || '任务已加入队列');
    } catch (error: any) { 
      FrontendLogger.error('MediaParser', 'Dispatch failed', traceId, error);
      AppNotifier.error(error.message || t.mediaParser?.notify_error || '提取异常'); 
    }
  }, [projectId, activeMedia, backendConfigPayload, t]);

  const handleCancel = useCallback(async () => {
    if (!activeMedia?.id) return;
    try { 
      await API.media.cancelProcess(activeMedia.id); 
      AppNotifier.info(t.mediaParser?.notify_cancel_success || '已终止指令');
    } catch (error: any) { 
      AppNotifier.error(error.message || t.mediaParser?.notify_cancel_error || '终止失败'); 
    }
  }, [activeMedia?.id, t]);

  const handleConfigChange = useCallback((key: keyof typeof extractionConfig, value: any) => {
    updateExtractionConfig({ [key]: value });
  }, [updateExtractionConfig]);

  if (!activeMedia) {
    return <div className="p-4 text-center text-muted-foreground text-xs mt-4">{t.mediaParser?.empty_selection || '未选择任何素材'}</div>;
  }

  return (
    // 💥 修复：h-full 配合 overflow-hidden 控制总外框，但内部配置区允许自由滚动
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

      {/* 💥 修复：中间配置区彻底解放！允许纵向滚动 (overflow-y-auto)，并去掉截断 */}
      <div className="flex-1 overflow-y-auto p-3 custom-scrollbar">
        {/* 💥 跨语种巴别塔：目标语言配置舱 */}
        <div className="bg-card border border-border rounded-lg p-3 mb-3 shadow-sm flex items-center justify-between">
            <span className="text-foreground text-[13px] font-medium">{t.mediaParser?.target_lang || '目标配音与重组语种'}</span>
            <Select value={extractionConfig.targetLanguage || 'zh-CN'} onValueChange={(val: string) => handleConfigChange('targetLanguage', val)} disabled={isProcessing}>
              <SelectTrigger className="w-[140px] h-8 text-[12px] bg-background border-border"><SelectValue /></SelectTrigger>
              <SelectContent className="bg-popover border-border text-[12px]">
                {LANG_OPTIONS.map(opt => <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>)}
              </SelectContent>
            </Select>
        </div>

        <div className="bg-card border border-border rounded-lg flex flex-col shadow-sm">
          
          <ParserConfigItem 
            icon={Film} 
            title={t.mediaParser?.frames?.title || '视觉切片引擎'} 
            desc={t.mediaParser?.frames?.desc || '抽取关键动作与转场画面'} 
            isActive={extractionConfig.frames.enabled} isChecked={extractionConfig.frames.enabled} isDisabled={isProcessing} 
            onToggle={() => handleConfigChange('frames', { ...extractionConfig.frames, enabled: !extractionConfig.frames.enabled })} 
          >
            <div className="flex flex-col gap-1.5">
              <span className="text-muted-foreground text-[11px] font-medium">{t.mediaParser?.frames?.strategy || '切片策略'}</span>
              {/* 保证下拉框选项能渲染到外部 */}
              <Select value={extractionConfig.frames.mode} onValueChange={(val: 'fps' | 'scene') => handleConfigChange('frames', { ...extractionConfig.frames, mode: val, value: val === 'scene' ? 0.3 : 1 })} disabled={isProcessing}>
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
                onValueChange={(vals) => handleConfigChange('frames', { ...extractionConfig.frames, value: vals[0] })} disabled={isProcessing} className="w-full cursor-pointer py-2"
              />
            </div>
          </ParserConfigItem>

          <ParserConfigItem 
            icon={ScanFace} 
            title={t.mediaParser?.faces?.title || '人脸特征库'} 
            desc={t.mediaParser?.faces?.desc || '扫脸并建立角色档案'} 
            isActive={extractionConfig.faces.enabled} isChecked={extractionConfig.faces.enabled} 
            isDisabled={isProcessing || !extractionConfig.frames.enabled} 
            disableReason={t.mediaParser?.faces?.dependency || '依赖阻断：请先开启上方[视觉切片]提供画面'}
            onToggle={() => handleConfigChange('faces', { ...extractionConfig.faces, enabled: !extractionConfig.faces.enabled })} 
          >
            <div className="flex flex-col gap-1.5">
              <span className="text-muted-foreground text-[11px] font-medium">{t.mediaParser?.faces?.engine || '视觉识别引擎'}</span>
              <Select value={extractionConfig.faces.engine} onValueChange={(val: any) => handleConfigChange('faces', { ...extractionConfig.faces, engine: val })} disabled={isProcessing}>
                <SelectTrigger className="w-full h-8 text-[12px] bg-background border-border"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-popover border-border text-[12px]">
                  {ENGINE_OPTIONS.faces.map(opt => <SelectItem key={opt.value} value={opt.value} disabled={opt.disabled}>{opt.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </ParserConfigItem>

          <ParserConfigItem 
            icon={ListMusic} 
            title={t.mediaParser?.audio?.title || '音频双轨剥离'} 
            desc={t.mediaParser?.audio?.desc || '分离人声与背景音乐'} 
            isActive={extractionConfig.audio.enabled} isChecked={extractionConfig.audio.enabled} isDisabled={isProcessing} 
            onToggle={() => handleConfigChange('audio', { ...extractionConfig.audio, enabled: !extractionConfig.audio.enabled })} 
          >
             <div className="flex flex-col gap-1.5">
              <span className="text-muted-foreground text-[11px] font-medium">{t.mediaParser?.audio?.engine || '音轨分离算力模型'}</span>
              <Select value={extractionConfig.audio.engine} onValueChange={(val: any) => handleConfigChange('audio', { ...extractionConfig.audio, engine: val })} disabled={isProcessing}>
                <SelectTrigger className="w-full h-8 text-[12px] bg-background border-border"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-popover border-border text-[12px]">
                  {ENGINE_OPTIONS.audio.map(opt => <SelectItem key={opt.value} value={opt.value} disabled={opt.disabled}>{opt.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </ParserConfigItem>

          <ParserConfigItem 
            icon={Mic} 
            title={t.mediaParser?.whisper?.title || 'AI 台词听写'} 
            desc={t.mediaParser?.whisper?.desc || '生成精准时间轴字幕'} 
            isActive={extractionConfig.whisper.enabled} isChecked={extractionConfig.whisper.enabled} 
            isDisabled={isProcessing || !extractionConfig.audio.enabled} 
            disableReason={t.mediaParser?.whisper?.dependency || '依赖阻断：请先开启上方[音频剥离]提供人声'}
            onToggle={() => handleConfigChange('whisper', { ...extractionConfig.whisper, enabled: !extractionConfig.whisper.enabled })} 
          >
             <div className="flex flex-col gap-1.5">
              <span className="text-muted-foreground text-[11px] font-medium">{t.mediaParser?.whisper?.engine || 'ASR 语音转写引擎'}</span>
              <Select value={extractionConfig.whisper.engine} onValueChange={(val: any) => handleConfigChange('whisper', { ...extractionConfig.whisper, engine: val })} disabled={isProcessing}>
                <SelectTrigger className="w-full h-8 text-[12px] bg-background border-border"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-popover border-border text-[12px]">
                  {ENGINE_OPTIONS.whisper.map(opt => <SelectItem key={opt.value} value={opt.value} disabled={opt.disabled}>{opt.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </ParserConfigItem>

        </div>
        {/* 底部留白，防止内容被遮挡 */}
        <div className="h-6"></div>
      </div>

      {/* 底部：固定的按钮控制区 */}
      <div className="shrink-0 p-3 bg-background border-t border-border z-10">
        {activeTask && activeTask.status !== 'pending' && (
          <div className="flex flex-col gap-1.5 mb-3 px-1">
             <div className="flex items-center justify-between text-[11px] font-medium">
                <span className="text-foreground flex items-center gap-1.5 truncate">
                  {isProcessing && <Loader2 size={12} className="animate-spin text-primary shrink-0" />}
                  <span className="truncate">{activeTask.text}</span>
                </span>
                <span className={`font-bold font-mono ml-2 shrink-0 ${isProcessing ? 'text-primary' : (activeTask.status === 'failed' ? 'text-destructive' : 'text-green-500')}`}>{activeTask.progress}%</span>
             </div>
             <div className="h-1.5 w-full bg-secondary overflow-hidden rounded-full">
               <div className="h-full bg-primary transition-all duration-300 ease-out" style={{ width: `${activeTask.progress || 0}%` }} />
             </div>
          </div>
        )}

        {isProcessing ? (
          <Button variant="destructive" className="w-full h-9 text-[13px] font-medium shadow-sm" onClick={handleCancel}>
            <XCircle size={15} className="mr-2 shrink-0"/> {t.mediaParser?.btn_cancel || '强行终止'}
          </Button>
        ) : activeMedia.status === 'parsed' ? (
          <Button variant="secondary" className="w-full h-9 text-[13px] font-medium shadow-sm border border-border" onClick={handleStartExtraction}>
            <RefreshCw size={15} className="mr-2 shrink-0"/> {t.mediaParser?.btn_re_extract || '重新提取'}
          </Button>
        ) : (
          <Button variant="default" className="w-full h-9 text-[13px] font-medium shadow-sm" onClick={handleStartExtraction}>
            <Cpu size={15} className="mr-2 shrink-0"/> {t.mediaParser?.btn_extract || '启动物理提取'}
          </Button>
        )}
      </div>

    </div>
  );
};
