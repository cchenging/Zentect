// StepIndicator - compatibility stub
import React from 'react';

interface Step {
  id: string;
  label: string;
}

interface StepIndicatorProps {
  currentStep: number;
  steps: Step[];
  stepStatuses?: Record<string, string>;
  stepCompleted?: Record<string, boolean>;
  onStepClick?: (step: number) => void;
}

export const StepIndicator: React.FC<StepIndicatorProps> = ({
  currentStep,
  steps,
  onStepClick
}) => {
  return (
    <div className="flex items-center gap-2">
      {steps.map((step, index) => (
        <button
          key={step.id}
          onClick={() => onStepClick?.(step.id)}
          className={`px-3 py-1 rounded text-sm ${
            index === currentStep
              ? 'bg-blue-500 text-white'
              : index < currentStep
              ? 'bg-green-500 text-white'
              : 'bg-gray-200 text-gray-600'
          }`}
        >
          {step.label}
        </button>
      ))}
    </div>
  );
};

export default StepIndicator;
