import React from 'react';

interface StepIndicatorProps {
  currentStep: number;
  stepNames: readonly string[];
}

export const StepIndicator: React.FC<StepIndicatorProps> = ({ currentStep, stepNames }) => {
  return (
    <div className="h-[60px] shrink-0 flex items-center justify-center gap-8 border-b border-border bg-card">
      {stepNames.map((name, i) => {
        const isActive = i === currentStep;
        const isDone = i < currentStep;
        return (
          <div key={i} className="flex items-center gap-2">
            <div
              className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold transition-colors
                ${isDone ? 'bg-primary text-primary-foreground' : ''}
                ${isActive ? 'bg-primary text-primary-foreground ring-2 ring-primary/30' : ''}
                ${!isActive && !isDone ? 'bg-muted text-muted-foreground' : ''}`}
            >
              {isDone ? '✓' : i + 1}
            </div>
            <span
              className={`text-sm transition-colors
                ${isActive ? 'text-foreground font-medium' : ''}
                ${isDone ? 'text-muted-foreground' : ''}
                ${!isActive && !isDone ? 'text-muted-foreground/60' : ''}`}
            >
              {name}
            </span>
            {i < stepNames.length - 1 && (
              <div className={`w-8 h-[1px] mx-1 ${i < currentStep ? 'bg-primary' : 'bg-border'}`} />
            )}
          </div>
        );
      })}
    </div>
  );
};
