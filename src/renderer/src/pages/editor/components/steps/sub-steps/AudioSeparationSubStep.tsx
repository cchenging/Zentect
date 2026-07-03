import React from 'react';
import { Music, Play } from 'lucide-react';
import { useStore } from '../../../../store/useStore';
import { StatusIcon, EmptyState, CollapsibleCard } from '../../../../components/shared';

export interface AudioSeparationSubStepProps {
  expanded: boolean;
  onToggle: (expanded: boolean) => void;
}

export const AudioSeparationSubStep: React.FC<AudioSeparationSubStepProps> = ({ expanded, onToggle }) => {
  const audioItems = useStore((s) => s.mediaItems.filter((m: any) => m.type === 'audio'));
  const status = useStore((s) => s.subStepStatuses['audio'] || 'idle');
  const setActivePlaySource = useStore((s) => s.setActivePlaySource);

  return (
    <CollapsibleCard expanded={expanded} onExpandedChange={onToggle}
      title={<><StatusIcon status={status === 'idle' ? 'pending' : status} /><span className="text-[13px] font-semibold">音频分离</span></>}
      extra={<span className="text-[13px] text-muted-foreground">{status === 'completed' ? '人声+BGM' : '等待'}</span>}>
      {status === 'completed' && audioItems.length > 0 && (
        <div className="flex flex-col gap-1">
          {audioItems.map((item: any) => (
            <div key={item.id} className="flex items-center gap-2 py-1 px-2 text-[13px] cursor-pointer hover:bg-bg-secondary rounded" onClick={() => setActivePlaySource(item)}>
              <Music size={12} /><span className="flex-1 truncate">{item.name || '音频'}</span>
              {item.duration && <span className="text-[10px] text-muted-foreground">{item.duration}s</span>}
              <Play size={11} className="text-accent" />
            </div>
          ))}
        </div>
      )}
    </CollapsibleCard>
  );
};