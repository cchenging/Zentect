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
  const status = useStore((s) => (s.subStepStatuses as any)['张'] || '等待');
  const progress = useStore((s) => (s.subStepProgresses as any)['张'] || 0);

  const statusText = status === 'completed' ? String(frameCount) + ' 张' : status === 'running' ? String(progress) + '%' : '等待';

  return (
    <CollapsibleCard expanded={expanded} onExpandedChange={onToggle}
      title={<><StatusIcon status={status === '等待' ? 'pending' : status} /><span className="text-[13px] font-semibold">Frame Extract</span></>}
      extra={<span className="text-[13px] text-muted-foreground">{statusText}</span>}>
      <FrameExtractConfig />
    </CollapsibleCard>
  );
};