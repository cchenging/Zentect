// Module: editor/shell/frontend/components/StepPanel
// 原 editor/components/StepPanel.tsx — 已迁移

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../../../../../renderer/src/store/useStore';
import { usePipelineStore } from '../../../../../renderer/src/store/usePipelineStore';
import { useEditorNavStore } from '../../../stores/useEditorNavStore';
import { STEPS } from '../../utils/pipelineConstants';
import { PipelineStatusBar } from './PipelineStatusBar';
import { PropertyBar } from './PropertyBar';
import { StepMaterialAnalysis } from '../../../../pipeline/step1-material/frontend/Container';
import { StepVisionDescription } from '../../../../pipeline/step2-vision/frontend/Container';
import { StepScriptGeneration } from '../../../../pipeline/step3-script/frontend/Container';
import { StepTTSSynthesis } from '../../../../pipeline/step4-tts/frontend/Container';
import { StepShotMatching } from '../../../../pipeline/step5-match/frontend/Container';
import { Play, ChevronRight, RefreshCcw } from 'lucide-react';
import { Badge, StatusIcon } from '../../../../../renderer/src/components/shared';
import { StepIndicator } from '../../../../../renderer/src/components/shared/StepIndicator';
import { AppNotifier } from '../../../../../renderer/src/core/AppNotifier';

interface StepPanelProps {
  onStart: () => void;
  onNextStep: () => void;
}

export const StepPanel: React.FC<StepPanelProps> = ({ onStart, onNextStep }) => {
  const navigate = useNavigate();
  const currentStep = useEditorNavStore((s) => s.currentStep);
  const isAutoMode = useEditorNavStore((s) => s.isAutoMode);
  const pipelineRunning = usePipelineStore((s) => s.pipelineRunning);
  const stepCompleted = usePipelineStore((s) => s.stepCompleted) ?? [];
  const stepStatuses = usePipelineStore((s) => s.stepStatuses) ?? [];
  const hydrationStatus = useStore((s) => s.hydrationStatus);
  const setCurrentStep = useEditorNavStore((s) => s.setCurrentStep);
  const setIsAutoMode = useEditorNavStore((s) => s.setIsAutoMode);

  const handleStepClick = (targetStep: number) => {
    if (targetStep < 1 || targetStep > STEPS.length) return;
    if (targetStep === currentStep) return;
    if (targetStep <= currentStep) {
      setCurrentStep(targetStep);
      return;
    }
    if (targetStep === currentStep + 1 && stepStatuses[currentStep - 1] === 'completed') {
      setCurrentStep(targetStep);
      return;
    }
    const lastCompletedStep = stepStatuses.findIndex((s) => s !== 'completed') + 1;
    if (targetStep <= lastCompletedStep) {
      setCurrentStep(targetStep);
      return;
    }
    const prevStep = STEPS[targetStep - 2];
    if (prevStep) {
      AppNotifier.warn(`请先完成步骤 ${targetStep - 1}（${prevStep.label}）再进入此步骤`);
    }
  };

  const renderStepContent = () => {
    switch (currentStep) {
      case 1: return <StepMaterialAnalysis />;
      case 2: return <StepVisionDescription />;
      case 3: return <StepScriptGeneration />;
      case 4: return <StepTTSSynthesis />;
      case 5: return <StepShotMatching />;
      default: return null;
    }
  };

  return (
    <div className="flex-1 flex flex-col min-w-[400px] glass-card overflow-hidden" style={{ borderRadius: '0 12px 12px 0' }}>
      <div className="flex items-center justify-between px-5 py-2.5 border-b border-border/30 shrink-0">
        <div className="flex items-center gap-0">
          <StepIndicator currentStep={currentStep} steps={STEPS.map(s => ({ id: s.key, label: s.label }))} stepStatuses={stepStatuses as any} stepCompleted={stepCompleted} onStepClick={handleStepClick} />
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-0.5 bg-bg-secondary rounded-lg p-[3px]">
            <Badge
              variant={!isAutoMode ? 'accent' : 'default'}
              interactive="selectable"
              selected={!isAutoMode}
              onClick={() => setIsAutoMode(false)}
              className="px-2.5 py-1"
            >
              手动
            </Badge>
            <Badge
              variant={isAutoMode ? 'accent' : 'default'}
              interactive="selectable"
              selected={isAutoMode}
              onClick={() => setIsAutoMode(true)}
              className="px-2.5 py-1"
            >
              自动
            </Badge>
          </div>
        </div>
      </div>

      <PipelineStatusBar />

      <PropertyBar />

      <div className="flex-1 overflow-y-auto p-5">
        {(hydrationStatus === 'LOADING' || hydrationStatus === 'IDLE') && (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <StatusIcon status="running" size={32} className="mb-4" />
            <div className="text-[13px] font-medium tracking-widest animate-pulse">装载工作空间...</div>
          </div>
        )}

        {hydrationStatus === 'ERROR' && (
          <div className="flex flex-col items-center justify-center h-full">
            <div className="w-16 h-16 rounded-2xl bg-accent-rose/10 flex items-center justify-center mb-6 border border-accent-rose/20">
              <StatusIcon status="warning" size={32} />
            </div>
            <h2 className="text-lg font-bold mb-2">工作空间装载失败</h2>
            <div className="flex gap-3">
              <button onClick={() => window.location.reload()} className="flex items-center gap-2 px-6 py-2.5 bg-bg-secondary hover:bg-muted rounded-xl text-[13px] transition-all cursor-pointer outline-none">
                <RefreshCcw size={14} /> 强制重载
              </button>
              <button onClick={() => navigate('/')} className="flex items-center gap-2 px-6 py-2.5 bg-bg-secondary hover:bg-muted rounded-xl text-[13px] transition-all cursor-pointer outline-none">
                返回首页
              </button>
            </div>
          </div>
        )}

        {hydrationStatus === 'READY' && (
          <div className="animate-fade-in-up">
            {renderStepContent()}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between px-4 py-2.5 border-t border-border/30 shrink-0 bg-bg-secondary/50">
        <span className="text-[13px] text-muted-foreground">
          步骤 {currentStep}/5 · {STEPS[currentStep - 1]?.label ?? '未知'}
          {stepStatuses[currentStep - 1] === 'completed' && <Badge variant="success" className="ml-1">已完成</Badge>}
          {stepStatuses[currentStep - 1] === 'failed' && <Badge variant="danger" className="ml-1">失败</Badge>}
          {stepStatuses[currentStep - 1] === 'idle' && <Badge variant="default" className="ml-1">等待管线执行</Badge>}
        </span>
        <div className="flex items-center gap-2">
          <button onClick={onStart} disabled={pipelineRunning || stepStatuses[currentStep - 1] === 'running'}
            className="h-7 px-4 rounded-md bg-gradient-to-r from-accent to-accent-purple text-white text-[13px] font-semibold shadow-sm hover:brightness-110 transition-all cursor-pointer outline-none flex items-center gap-1.5 disabled:opacity-60 disabled:cursor-not-allowed">
            <Play size={11} /> {pipelineRunning ? '执行中...' : '启动'}
          </button>
          {!isAutoMode && stepStatuses[currentStep - 1] === 'completed' && currentStep < 5 && (
            <button onClick={onNextStep}
              className="h-7 px-4 rounded-md bg-bg-secondary border border-border/50 text-[13px] font-medium hover:border-accent/40 hover:text-accent transition-all cursor-pointer outline-none flex items-center gap-1.5">
              下一步 <ChevronRight size={11} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
