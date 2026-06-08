import React, { useState } from 'react';
import { useStore } from '../../../../store/useStore';
import { Edit3, User, Music, Play, UndoDot, RotateCcw } from 'lucide-react';
import { getSafeMediaUrl } from '../../../../utils/formatUrl';
import { API } from '../../../../api';
import { AppNotifier } from '../../../../core/AppNotifier';
import { Badge, StatusIcon, StatHeader, EmptyState, CollapsibleCard } from '../../../../components/shared';
import { FrameExtractConfig } from '../inspectors/configs/FrameExtractConfig';

/** 抽帧密度选项映射：稀疏→1fps, 标准→2fps, 密集→5fps */
const DENSITY_MAP: Record<string, { label: string; fps: number }> = {
  sparse: { label: '稀疏', fps: 1 },
  standard: { label: '标准', fps: 2 },
  dense: { label: '密集', fps: 5 },
};

/** 缩放尺寸选项 */
const SCALE_OPTIONS = [
  { value: 320, label: '320' },
  { value: 480, label: '480' },
  { value: 640, label: '640' },
  { value: 0, label: '原始' },
];

/** 步骤1：素材分析 - 紧凑折叠行设计，对齐 editor.html 原型 */
const StepMaterialAnalysisInner: React.FC = () => {
  const asrLines = useStore((s) => s.asrLines);
  const frameCount = useStore((s) => s.frameCount);
  const audioSeparated = useStore((s) => s.audioSeparated);
  const mediaItems = useStore((s) => s.mediaItems);
  const roles = useStore((s) => s.roles);
  const updateAsrLine = useStore((s) => s.updateAsrLine);
  const setAsrLines = useStore((s) => s.setAsrLines);
  const setCurrentTime = useStore((s) => s.setCurrentTime);
  const setActivePlaySource = useStore((s) => s.setActivePlaySource);
  const updateRole = useStore((s) => s.updateRole);
  const subStepStatuses = useStore((s) => s.subStepStatuses);
  const subStepProgresses = useStore((s) => s.subStepProgresses);
  const setSubStepStatus = useStore((s) => s.setSubStepStatus);
  const projectId = useStore((s) => s.projectId);
  const mediaItems_store = useStore((s) => s.mediaItems);
  const extractionConfig = useStore((s) => s.extractionConfig);
  const updateExtractionConfig = useStore((s) => s.updateExtractionConfig);
  const extractedData = useStore((s) => s.extractedData);

  /** 折叠/展开状态：关键帧默认展开，其余折叠 */
  const [expandedSubSteps, setExpandedSubSteps] = useState<Record<string, boolean>>({
    frames: true,
    audio: false,
    whisper: false,
    faces: false,
  });

  /** 切换子步骤折叠状态 */
  const toggleSubStep = (key: string) => {
    setExpandedSubSteps((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  /** 将 mm:ss 格式的时间字符串转换为秒数 */
  const parseTime = (timeStr: string): number => {
    if (!timeStr) return 0;
    const parts = timeStr.split(':');
    if (parts.length >= 2) {
      return parseInt(parts[0], 10) * 60 + parseFloat(parts[1]);
    }
    return parseFloat(timeStr) || 0;
  };

  /** 切换指定行的编辑状态 */
  const toggleEditing = (idx: number, editing: boolean) => {
    const lines = useStore.getState().asrLines.map((l: any, i: number) => i === idx ? { ...l, editing } : l);
    setAsrLines(lines);
  };

  /** 重试指定子步骤，参数对齐后端管线契约 */
  const handleRetrySubStep = async (stepKey: string) => {
    const state = useStore.getState();
    const activeVideo = state.mediaItems.find((m: any) => m.type === 'video');
    if (!projectId || !activeVideo) {
      AppNotifier.error('请先导入视频素材');
      return;
    }
    try {
      setSubStepStatus(stepKey, 'running');
      /** 前后端参数大闭环对齐：字段名与 ExtractionPipeline 契约一致 */
      const framesConfig = state.extractionConfig?.frames || {};
      const config: any = {
        targetLanguage: state.extractionConfig?.targetLanguage || 'zh-CN',
        frames: stepKey === 'frames' ? {
          enabled: true,
          mode: framesConfig.mode || 'VLM_OPTIMIZED',
          sceneThreshold: framesConfig.sceneThreshold || 0.28,
          minFrameInterval: framesConfig.minFrameInterval ?? 4,
          fps: framesConfig.fps || 2,
          scale: framesConfig.scale ?? 1024,
          quality: framesConfig.quality ?? 3,
          timePoint: framesConfig.timePoint,
        } : { enabled: false },
        audio: stepKey === 'audio' ? { ...state.extractionConfig?.audio, enabled: true } : { enabled: false },
        whisper: stepKey === 'whisper' ? { ...state.extractionConfig?.whisper, enabled: true } : { enabled: false },
        faces: stepKey === 'faces' ? { ...state.extractionConfig?.faces, enabled: true } : { enabled: false },
      };
      await API.media.process(projectId, activeVideo, config);
      AppNotifier.info(`智能抽帧进程已重新启动`);
    } catch (error: any) {
      setSubStepStatus(stepKey, 'failed');
      AppNotifier.error(error.message || '引擎微服务调用失败');
    }
  };

  /** 过滤音频项 */
  const audioItems = mediaItems.filter((m: any) => m.type === 'audio');
  const framesStatus = subStepStatuses['frames'] || 'idle';
  const audioStatus = subStepStatuses['audio'] || 'idle';
  const whisperStatus = subStepStatuses['whisper'] || 'idle';
  const facesStatus = subStepStatuses['faces'] || 'idle';
  /** ASR 已确认台词数 */
  const confirmed = asrLines.filter((l: any) => l.originalText !== undefined && l.text === l.originalText).length;

  return (
    <div className="flex flex-col gap-1">
      {/* 1. 关键帧提取 — 折叠行 + 抽帧参数卡片 */}
      <CollapsibleCard
        expanded={expandedSubSteps.frames}
        onExpandedChange={(v) => toggleSubStep('frames')}
        title={
          <>
            <StatusIcon status={framesStatus === 'idle' ? 'pending' : framesStatus} />
            <span className={`text-[12px] font-semibold ${framesStatus === 'completed' ? 'text-accent-green' : framesStatus === 'failed' ? 'text-red-400' : ''}`}>
              关键帧提取
            </span>
          </>
        }
        extra={
          <>
            <span className="text-[11px] text-muted-foreground">
              {framesStatus === 'completed' ? `已提取 ${frameCount} 张关键帧` : framesStatus === 'running' ? `提取中 ${subStepProgresses['frames'] || 0}%` : framesStatus === 'failed' ? '提取失败' : '等待管线执行'}
            </span>
            {framesStatus !== 'running' && (
              <button
                onClick={(e) => { e.stopPropagation(); handleRetrySubStep('frames'); }}
                className="ml-auto text-muted-foreground hover:text-primary transition-colors cursor-pointer outline-none"
                title="按当前参数重新抽帧"
              >
                <RotateCcw size={13} />
              </button>
            )}
          </>
        }
        borderColor={framesStatus === 'failed' ? 'var(--accent-rose)' : undefined}
      >
        <FrameExtractConfig />
      </CollapsibleCard>

      {/* 2. 音频分离 — 紧凑折叠行 32px */}
      <CollapsibleCard
        expanded={expandedSubSteps.audio}
        onExpandedChange={(v) => toggleSubStep('audio')}
        title={
          <>
            <StatusIcon status={audioStatus === 'idle' ? 'pending' : audioStatus} />
            <span className={`text-[12px] font-semibold ${audioStatus === 'completed' ? 'text-accent-green' : audioStatus === 'failed' ? 'text-red-400' : ''}`}>
              音频分离
            </span>
          </>
        }
        extra={
          <>
            <span className="text-[11px] text-muted-foreground">
              {audioStatus === 'completed' ? '人声台词 + 背景音乐' : audioStatus === 'running' ? `执行中 ${subStepProgresses['audio'] || 0}%` : audioStatus === 'failed' ? '执行失败' : '等待管线执行'}
            </span>
            {audioStatus === 'failed' && (
              <button
                onClick={(e) => { e.stopPropagation(); handleRetrySubStep('audio'); }}
                className="ml-auto text-red-400 hover:text-accent transition-colors cursor-pointer outline-none"
                title="重试音频分离"
              >
                <RotateCcw size={13} />
              </button>
            )}
          </>
        }
        borderColor={audioStatus === 'failed' ? 'var(--accent-rose)' : undefined}
      >
        {audioStatus === 'completed' && (
          <div className="p-2 rounded-md bg-bg-secondary border border-border/20">
            {audioItems.length > 0 ? (
              <div className="flex flex-col gap-1">
                {audioItems.map((item: any) => (
                  <div
                    key={item.id}
                    className="flex items-center justify-between py-1.5 px-2 text-[13px] hover:bg-bg-glass/50 rounded cursor-pointer transition-colors"
                    onClick={() => setActivePlaySource(item)}
                  >
                    <Music size={14} className="text-muted-foreground shrink-0" />
                    <span className="flex-1 mx-2 truncate">{item.fileName || item.name || '未命名音频'}</span>
                    {item.duration && <span className="text-[11px] text-muted-foreground shrink-0">{item.duration}s</span>}
                    <button className="text-accent hover:text-accent/80 cursor-pointer outline-none ml-2 shrink-0" title="试听">
                      <Play size={13} />
                    </button>
                  </div>
                ))}
              </div>
            ) : audioSeparated ? (
              <div className="text-[11px] text-muted-foreground text-center py-2">音频分离完成，无音频素材</div>
            ) : (
              <EmptyState
                title="暂无音频数据"
                description="启动管线后自动提取音频轨道"
                iconType="audio"
                size="sm"
                action={
                  <button
                    onClick={() => handleRetrySubStep('audio')}
                    className="text-[11px] px-3 py-1 rounded-md bg-accent/10 text-accent hover:bg-accent/20 transition-colors cursor-pointer outline-none"
                  >
                    提取音频
                  </button>
                }
              />
            )}
          </div>
        )}
      </CollapsibleCard>

      {/* 3. ASR台词识别 — 紧凑折叠行 32px */}
      <CollapsibleCard
        expanded={expandedSubSteps.whisper}
        onExpandedChange={(v) => toggleSubStep('whisper')}
        title={
          <>
            <StatusIcon status={whisperStatus === 'idle' ? 'pending' : whisperStatus} />
            <span className={`text-[12px] font-semibold ${whisperStatus === 'completed' ? 'text-accent-green' : whisperStatus === 'failed' ? 'text-red-400' : ''}`}>
              ASR台词识别
            </span>
          </>
        }
        extra={
          <>
            {whisperStatus === 'completed' ? (
              <StatHeader value={asrLines.length} unit="句台词" secondary={`已确认 ${confirmed} 句`} />
            ) : (
              <span className="text-[11px] text-muted-foreground">
                {whisperStatus === 'running' ? `执行中 ${subStepProgresses['whisper'] || 0}%` : whisperStatus === 'failed' ? '执行失败' : '等待管线执行'}
              </span>
            )}
            {whisperStatus === 'failed' && (
              <button
                onClick={(e) => { e.stopPropagation(); handleRetrySubStep('whisper'); }}
                className="ml-auto text-red-400 hover:text-accent transition-colors cursor-pointer outline-none"
                title="重试ASR台词识别"
              >
                <RotateCcw size={13} />
              </button>
            )}
          </>
        }
        borderColor={whisperStatus === 'failed' ? 'var(--accent-rose)' : undefined}
      >
        {whisperStatus === 'completed' && asrLines.length > 0 && (
          <div className="rounded-md bg-bg-secondary border border-border/20 overflow-hidden">
            {asrLines.map((line: any, idx: number) => {
              const isModified = line.originalText !== undefined && line.text !== line.originalText;
              const isPending = !isModified && line.originalText === undefined;
              return (
                <div key={idx} className={`flex items-center gap-2 px-3 py-2 border-b border-border/10 last:border-0 group ${isModified ? 'bg-accent/5 border-l-2 border-l-red-400' : ''}`}>
                  <span className="text-[11px] font-mono text-accent shrink-0 w-12">{line.start || '00:00'}</span>
                  {line.editing ? (
                    <input
                      value={line.text}
                      onChange={(e) => updateAsrLine(idx, e.target.value)}
                      onBlur={() => toggleEditing(idx, false)}
                      onKeyDown={(e) => { if (e.key === 'Enter') toggleEditing(idx, false); }}
                      className="flex-1 text-[12px] bg-bg-secondary px-2 py-1 rounded border border-accent/30 outline-none"
                      autoFocus
                    />
                  ) : (
                    <span className="flex-1 text-[12px] text-foreground cursor-pointer hover:text-accent transition-colors" onClick={() => toggleEditing(idx, true)}>
                      {line.text}
                    </span>
                  )}
                  <Badge variant={isModified ? 'danger' : isPending ? 'default' : 'success'}>
                    {isModified ? '待修正' : isPending ? '待确认' : '已确认'}
                  </Badge>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => setCurrentTime(parseTime(line.start))}
                      className="text-muted-foreground hover:text-accent-green transition-colors cursor-pointer outline-none opacity-0 group-hover:opacity-100"
                      title="从该时间戳开始播放"
                    >
                      <Play size={12} />
                    </button>
                    {isModified && (
                      <button
                        onClick={() => updateAsrLine(idx, line.originalText)}
                        className="text-muted-foreground hover:text-accent transition-colors cursor-pointer outline-none opacity-0 group-hover:opacity-100"
                        title="还原为AI原始识别结果"
                      >
                        <UndoDot size={12} />
                      </button>
                    )}
                    <button onClick={() => toggleEditing(idx, true)} className="text-muted-foreground hover:text-accent transition-colors cursor-pointer outline-none opacity-0 group-hover:opacity-100">
                      <Edit3 size={12} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CollapsibleCard>

      {/* 4. 人脸检测 — 紧凑折叠行 32px，展开后显示卡片网格 */}
      <CollapsibleCard
        expanded={expandedSubSteps.faces}
        onExpandedChange={(v) => toggleSubStep('faces')}
        title={
          <>
            <StatusIcon status={facesStatus === 'idle' ? 'pending' : facesStatus} />
            <span className={`text-[12px] font-semibold ${facesStatus === 'completed' ? 'text-accent-purple' : facesStatus === 'failed' ? 'text-red-400' : ''}`}>
              人脸检测
            </span>
          </>
        }
        extra={
          <>
            <span className="text-[11px] text-muted-foreground">
              {facesStatus === 'completed' ? `检测到 ${roles.length} 个角色` : facesStatus === 'running' ? `执行中 ${subStepProgresses['faces'] || 0}%` : facesStatus === 'failed' ? '执行失败' : '等待管线执行'}
            </span>
            {facesStatus === 'failed' && (
              <button
                onClick={(e) => { e.stopPropagation(); handleRetrySubStep('faces'); }}
                className="ml-auto text-red-400 hover:text-accent transition-colors cursor-pointer outline-none"
                title="重试人脸检测"
              >
                <RotateCcw size={13} />
              </button>
            )}
          </>
        }
        borderColor={facesStatus === 'failed' ? 'var(--accent-rose)' : undefined}
      >
        {facesStatus === 'completed' && roles.length > 0 && (
          <div className="p-3 rounded-md bg-bg-secondary border border-border/20">
            <div className="flex flex-wrap gap-3">
              {roles.map((role: any) => (
                <div key={role.id} className="flex flex-col items-center gap-2 py-2.5 px-3.5 rounded-lg bg-bg-glass border border-border/20 min-w-[90px]">
                  <div className="w-12 h-12 rounded-full bg-gradient-to-br from-accent/20 to-accent-purple/30 flex items-center justify-center overflow-hidden">
                    {role.avatarPath ? (
                      <img src={getSafeMediaUrl(role.avatarPath)} className="w-full h-full object-cover" />
                    ) : (
                      <User size={20} className="text-muted-foreground" />
                    )}
                  </div>
                  <input
                    value={role.name || ''}
                    onChange={(e) => updateRole(role.id, { name: e.target.value })}
                    placeholder="角色名称"
                    className="w-[90px] text-[12px] text-center bg-transparent border border-border/30 rounded px-2 py-1 outline-none focus:border-accent/50 transition-colors"
                  />
                  <span className="text-[10px] text-muted-foreground">
                    出现 {role.faceCount || 0} 次
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        {facesStatus === 'completed' && roles.length === 0 && (
          <EmptyState
            title="暂无人脸数据"
            description="启动管线后自动检测人脸"
            iconType="user"
            size="sm"
            action={
              <button
                onClick={() => handleRetrySubStep('faces')}
                className="text-[11px] px-3 py-1 rounded-md bg-accent-purple/10 text-accent-purple hover:bg-accent-purple/20 transition-colors cursor-pointer outline-none"
              >
                检测人脸
              </button>
            }
          />
        )}
      </CollapsibleCard>
    </div>
  );
};

/** 使用 React.memo 包裹，防止管线进度事件引发的连锁重渲染 */
export const StepMaterialAnalysis = React.memo(StepMaterialAnalysisInner);
