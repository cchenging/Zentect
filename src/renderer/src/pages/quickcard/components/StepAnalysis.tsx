import React, { useEffect, useState } from 'react';
import { Loader2, CheckCircle2, AlertCircle, XCircle } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { API } from '../../../api';
import { useI18n } from '../../../store/useI18n';

interface StepAnalysisProps {
  projectId: string;
  mediaId: string;
  mediaPath: string;
  onComplete: () => void;
}

const STEP_IDS = [
  { id: 'extract_frames', label: '帧提取' },
  { id: 'separate_audio', label: '音频分离' },
  { id: 'asr', label: '语音识别' },
  { id: 'face_detect', label: '人脸检测' },
  { id: 'scene_detect', label: '场景分割' },
  { id: 'script_gen', label: '解说稿生成' },
  { id: 'tts_export', label: 'TTS 配音' },
];

type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'degraded';

export const StepAnalysis: React.FC<StepAnalysisProps> = ({ projectId, mediaId, mediaPath, onComplete }) => {
  const { t } = useI18n();
  const qc = t.quickcard?.analysis || {};
  const [stepStatuses, setStepStatuses] = useState<Record<string, StepStatus>>({});
  const [overallProgress, setOverallProgress] = useState(0);
  const [currentMessage, setCurrentMessage] = useState('准备就绪');
  const [pipelineError, setPipelineError] = useState<string | null>(null);
  const [pipelineDone, setPipelineDone] = useState(false);

  // 启动 Pipeline
  useEffect(() => {
    if (!projectId || !mediaId) return;

    const startPipeline = async () => {
      try {
        const result: any = await API.engine.runV1Pipeline(projectId, mediaId, mediaPath);
        if (result?.success !== false) {
          setPipelineDone(true);
        } else {
          setPipelineError(result?.error || 'Pipeline 执行失败');
        }
      } catch (err: any) {
        setPipelineError(err.message || '连接引擎失败');
      }
    };

    startPipeline();
  }, [projectId, mediaId]);

  // 监听引擎进度事件（engine:pipeline-progress）
  useEffect(() => {
    const handler = (p: any) => {
      if (!p || !p.stepId) return;
      setStepStatuses(prev => ({
        ...prev,
        [p.stepId]: p.status === 'running' ? 'running'
                  : p.status === 'completed' ? 'completed'
                  : p.status === 'degraded' ? 'degraded'
                  : p.status === 'failed' ? 'failed'
                  : 'running',
      }));
      setOverallProgress(p.overallProgress || 0);
      if (p.message) setCurrentMessage(p.message);
    };
    API.engine.onPipelineProgress(handler);
    return () => { API.engine.offPipelineProgress(); };
  }, []);

  const allDone = STEP_IDS.every(s => stepStatuses[s.id] === 'completed' || stepStatuses[s.id] === 'degraded');

  return (
    <div className="max-w-xl mx-auto pt-8 flex flex-col items-center gap-6">
      {/* Icon */}
      <div className={`w-16 h-16 rounded-2xl flex items-center justify-center
        ${pipelineError ? 'bg-error/10' : allDone || pipelineDone ? 'bg-success/10' : 'bg-primary/10'}`}>
        {pipelineError ? <XCircle size={32} className="text-error" /> :
         (allDone || pipelineDone) ? <CheckCircle2 size={32} className="text-success" /> :
         <Loader2 size={32} className="text-primary animate-spin" />}
      </div>

      <h2 className="text-xl font-semibold">
        {pipelineError ? (qc.title_failed || '处理失败') : (allDone || pipelineDone) ? (qc.title_done || '分析完成') : (qc.title_processing || 'AI 正在分析...')}
      </h2>
      <p className="text-sm text-muted-foreground">{pipelineError || currentMessage}</p>

      {/* Progress */}
      {!(allDone || pipelineDone) && !pipelineError && (
        <>
          <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
            <div className="bg-primary h-full rounded-full transition-all duration-500" style={{ width: `${overallProgress}%` }} />
          </div>
          <span className="text-xs text-muted-foreground">{(qc.progress_label || '总体进度 {percent}%').replace('{percent}', String(overallProgress))}</span>
        </>
      )}

      {/* Error */}
      {pipelineError && (
        <div className="w-full p-4 rounded-xl bg-error/10 border border-error/30 text-sm text-error">
          {pipelineError}
        </div>
      )}

      {/* Step list */}
      <div className="w-full space-y-2 mt-2">
        {STEP_IDS.map((step) => {
          const status = stepStatuses[step.id] || 'pending';
          return (
            <div key={step.id} className="flex items-center gap-3 px-4 py-2.5 rounded-lg bg-card border border-border">
              {status === 'completed' && <CheckCircle2 size={18} className="text-success shrink-0" />}
              {status === 'degraded' && <AlertCircle size={18} className="text-warning shrink-0" />}
              {status === 'running' && <Loader2 size={18} className="text-primary animate-spin shrink-0" />}
              {status === 'failed' && <XCircle size={18} className="text-error shrink-0" />}
              {status === 'pending' && <div className="w-[18px] h-[18px] rounded-full border-2 border-border shrink-0" />}
              <span className={`text-sm ${
                status === 'completed' ? 'text-foreground' :
                status === 'degraded' ? 'text-warning font-medium' :
                status === 'running' ? 'text-primary font-medium' :
                status === 'failed' ? 'text-error' :
                'text-muted-foreground'
              }`}>
                {step.label}
              </span>
              <span className="text-xs ml-auto">
                {status === 'completed' && <span className="text-success">{qc.done || '已完成'}</span>}
                {status === 'degraded' && <span className="text-warning">{qc.degraded || '已降级'}</span>}
                {status === 'running' && <span className="text-primary">{qc.processing || '正在处理...'}</span>}
                {status === 'failed' && <span className="text-error">{qc.failed || '失败'}</span>}
              </span>
            </div>
          );
        })}
      </div>

      {(allDone || pipelineDone) && (
        <Button onClick={onComplete} size="lg" className="mt-4">
          {qc.view_review || '查看审阅'}
        </Button>
      )}
    </div>
  );
};
