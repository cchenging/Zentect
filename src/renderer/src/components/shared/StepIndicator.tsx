import React from 'react';
import { StatusIcon } from './StatusIcon';

export interface StepIndicatorProps {
  currentStep: number;
  steps: Array<{ id: number; label: string }>;
  stepStatuses: Array<'idle'|'running'|'completed'|'failed'>;
  stepCompleted: boolean[];
  onStepClick: (step: number) => void;
}

export const StepIndicator: React.FC<StepIndicatorProps> = ({
  currentStep, steps, stepStatuses, stepCompleted, onStepClick,
}) => (
  <div className="flex items-center gap-0">
    {steps.map((step, i) => {
      const status = stepStatuses[i];
      const isActive = step.id === currentStep;
      const isDone = status === 'completed' || stepCompleted[i];
      const isRunning = status === 'running';
      const colorClass = isActive ? 'text-accent' : isDone ? 'text-accent-green' : isRunning ? 'text-primary' : 'text-muted-foreground';
      const bgClass = isActive ? 'bg-accent text-white' : isDone ? 'bg-accent-green/20 text-accent-green' : isRunning ? 'bg-primary/20' : 'bg-muted text-muted-foreground';
      return (
        <div key={step.id} className="flex items-center">
          <button onClick={() => onStepClick(step.id)}
            className={`flex items-center gap-1.5 cursor-pointer outline-none ${colorClass}`}>
            <div className={`w-[22px] h-[22px] rounded-md flex items-center justify-center text-[11px] font-bold ${bgClass}`}>
              {isDone ? <StatusIcon status="completed" size={12} /> : isRunning ? <StatusIcon status="running" size={12} /> : step.id}
            </div>
            <span className="text-[11px] font-medium hidden xl:inline">{step.label}</span>
          </button>
          {i < steps.length - 1 && (
            <div className={`w-7 h-px mx-1 ${step.id < currentStep ? 'bg-accent-green/40' : 'bg-border/30'}`} />
          )}
        </div>
      );
    })}
  </div>
);