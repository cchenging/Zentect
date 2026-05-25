/** V1.3 B2: LeftNav 左栏流程导航
 *  48px 宽，垂直排列步骤图标，自动从 FLOW_CONFIGS 配置生成
 *  状态色：已完成(accent) / 当前(bg-accent/10 + border-l-2) / 未到(dim)
 *  仅已完成步骤可点击回退
 */

import React from 'react';
import type { StepConfig } from '../config/flows';

interface LeftNavProps {
  steps: StepConfig[];
  currentStep: number;
  onStepClick: (index: number) => void;
}

export const LeftNav: React.FC<LeftNavProps> = ({ steps, currentStep, onStepClick }) => {
  return (
    <nav className="w-12 shrink-0 flex flex-col items-center gap-1 py-4 border-r border-border bg-bg-secondary">
      {steps.map((step, i) => {
        const isCompleted = i < currentStep;
        const isCurrent = i === currentStep;
        const isPending = i > currentStep;

        /** 状态色逻辑 */
        const iconColor = isCompleted
          ? 'text-[var(--accent,#7B5EEA)]'
          : isCurrent
            ? 'text-foreground'
            : 'text-muted-foreground/40';

        const containerClass = isCurrent
          ? 'bg-accent/10 border-l-2 border-accent rounded-r-md'
          : '';

        const cursorClass = isCompleted ? 'cursor-pointer hover:bg-accent/10' : 'cursor-default';

        const StepIcon = step.icon;

        return (
          <button
            key={step.id}
            onClick={() => { if (isCompleted) onStepClick(i); }}
            disabled={!isCompleted}
            title={step.title}
            className={`w-full flex items-center justify-center py-2.5 transition-all rounded-md ${containerClass} ${cursorClass} ${
              isPending ? 'opacity-50' : ''
            }`}
          >
            <StepIcon size={18} className={`${iconColor} transition-colors`} />
          </button>
        );
      })}
    </nav>
  );
};