import React from 'react';
import { Edit3, Play, UndoDot } from 'lucide-react';
import { useStore } from '../../../../store/useStore';
import { Badge, StatusIcon, CollapsibleCard } from '../../../../components/shared';

export interface ASRSubStepProps {
  expanded: boolean;
  onToggle: (expanded: boolean) => void;
}

export const ASRSubStep: React.FC<ASRSubStepProps> = ({ expanded, onToggle }) => {
  const asrLines = useStep1Store((s) => s.asrLines);
  const updateAsrLine = useStore((s) => s.updateAsrLine);
  const setCurrentTime = useStore((s) => s.setCurrentTime);
  const status = useStore((s) => s.subStepStatuses['whisper'] || 'idle');

  const parseTime = (t: string): number => { const p = t.split(':'); return p.length >= 2 ? parseInt(p[0],10)*60 + parseFloat(p[1]) : parseFloat(t) || 0; };

  return (
    <CollapsibleCard expanded={expanded} onExpandedChange={onToggle}
      title={<><StatusIcon status={status === 'idle' ? 'pending' : status} /><span className="text-[13px] font-semibold">ASR 台词识别</span></>}
      extra={<span className="text-[13px] text-muted-foreground">{asrLines.length} 句</span>}>
      {asrLines.map((line: any, idx: number) => {
        const isModified = line.originalText !== undefined && line.text !== line.originalText;
        return (
          <div key={idx} className="flex items-center gap-2 px-3 py-1.5 border-b border-border/10 group">
            <span className="text-[13px] font-mono text-accent w-12">{line.start || '00:00'}</span>
            <span className="flex-1 text-[13px] cursor-pointer" onClick={() => updateAsrLine(idx, line.text)}>{line.text}</span>
            <Badge variant={isModified ? 'danger' : 'success'}>{isModified ? '已修改' : '已确认'}</Badge>
            <button onClick={() => setCurrentTime(parseTime(line.start))} className="opacity-0 group-hover:opacity-100"><Play size={11} /></button>
            {isModified && <button onClick={() => updateAsrLine(idx, line.originalText)} className="opacity-0 group-hover:opacity-100"><UndoDot size={11} /></button>}
            <Edit3 size={11} className="opacity-0 group-hover:opacity-100" />
          </div>
        );
      })}
    </CollapsibleCard>
  );
};