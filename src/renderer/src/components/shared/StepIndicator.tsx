// StepIndicator - 步骤导航指示器
import React from 'react';
import { StatusIcon } from './status-icon';

interface Step {
  id: string | number;
  label: string;
}

interface StepIndicatorProps {
  currentStep: number;
  steps: Step[];
  stepStatuses?: Array<'idle' | 'running' | 'completed' | 'failed'> | Record<string, string>;
  stepCompleted?: boolean[] | Record<string, boolean>;
  onStepClick?: (step: number) => void;
}

/**
 * 步骤导航指示器
 * - 点击步骤按钮时，将 step.id 转为数字传给 onStepClick（步骤号 1-N）
 * - 旧版 bug：传 index（0-N），导致点击步骤2实际进入步骤1，全错位
 * - 修复：传 Number(step.id)，与 STEPS 常量的 key（1-5）一致
 */
export const StepIndicator: React.FC<StepIndicatorProps> = ({
  currentStep,
  steps,
  stepStatuses,
  stepCompleted,
  onStepClick,
}) => {
  /** 安全取步骤状态：兼容数组和对象两种格式 */
  const getStatus = (index: number): 'idle' | 'running' | 'completed' | 'failed' => {
    if (Array.isArray(stepStatuses)) {
      return (stepStatuses[index] as any) || 'idle';
    }
    if (stepStatuses && typeof stepStatuses === 'object') {
      return (stepStatuses[index] as any) || (stepStatuses[String(index)] as any) || 'idle';
    }
    return 'idle';
  };

  /** 安全取完成状态：兼容数组和对象两种格式 */
  const isCompleted = (index: number): boolean => {
    if (Array.isArray(stepCompleted)) {
      return !!stepCompleted[index];
    }
    if (stepCompleted && typeof stepCompleted === 'object') {
      return !!(stepCompleted[index] ?? stepCompleted[String(index)]);
    }
    return false;
  };

  return (
    <div className="flex items-center gap-0">
      {steps.map((step, i) => {
        /** 💥 关键修复：stepId 用 Number(step.id)，不是 index i
         *  STEPS 常量 key 是 1-5，StepPanel.handleStepClick 期望接收 1-5 */
        const stepId = Number(step.id);
        const status = getStatus(i);
        const isActive = stepId === currentStep;
        const isDone = status === 'completed' || isCompleted(i);
        const isRunning = status === 'running';
        const colorClass = isActive ? 'text-accent' : isDone ? 'text-accent-green' : isRunning ? 'text-primary' : 'text-muted-foreground';
        const bgClass = isActive ? 'bg-accent text-white' : isDone ? 'bg-accent-green/20 text-accent-green' : isRunning ? 'bg-primary/20' : 'bg-muted text-muted-foreground';
        return (
          <div key={step.id} className="flex items-center">
            <button onClick={() => onStepClick?.(stepId)}
              className={`flex items-center gap-1.5 cursor-pointer outline-none ${colorClass}`}>
              <div className={`w-[22px] h-[22px] rounded-md flex items-center justify-center text-[11px] font-bold ${bgClass}`}>
                {isDone ? <StatusIcon status="completed" size={12} /> : isRunning ? <StatusIcon status="running" size={12} /> : stepId}
              </div>
              <span className="text-[11px] font-medium hidden xl:inline">{step.label}</span>
            </button>
            {i < steps.length - 1 && (
              <div className={`w-7 h-px mx-1 ${stepId < currentStep ? 'bg-accent-green/40' : 'bg-border/30'}`} />
            )}
          </div>
        );
      })}
    </div>
  );
};

export default StepIndicator;
