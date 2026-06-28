import React from 'react';
import { useStore } from '../../../../store/useStore';
import { StatusIcon, CollapsibleCard } from '../../../../components/shared';
import { FrameExtractConfig } from '../../inspectors/configs/FrameExtractConfig';

export interface FrameExtractSubStepProps {
  expanded: boolean;
  onToggle: (expanded: boolean) => void;
}

export const FrameExtractSubStep: React.FC<FrameExtractSubStepProps> = ({ expanded, onToggle }) => {
  const frameCount = useStore((s) => s.frameCount);
  const status = useStore((s) => (s.subStepStatuses as any)['frames'] || 'idle');
  const progress = useStore((s) => (s.subStepProgresses as any)['frames'] || 0);

  const statusText = status === 'completed' ? String(frameCount) + ' frames' : status === 'running' ? String(progress) + '%' : 'idle';

  return (
    <CollapsibleCard expanded={expanded} onExpandedChange={onToggle}
      title={<><StatusIcon status={status === 'idle' ? 'pending' : status} /><span className="text-[12px] font-semibold">Frame Extract</span></>}
      extra={<span className="text-[11px] text-muted-foreground">{statusText}</span>}>
      <FrameExtractConfig />
    </CollapsibleCard>
  );
};