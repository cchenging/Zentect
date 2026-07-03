import React from 'react';
import { StatusIcon, CollapsibleCard } from '../../../../components/shared';
import { useStore } from '../../../../store/useStore';

export interface FaceDetectionSubStepProps {
  expanded: boolean;
  onToggle: (expanded: boolean) => void;
}

export const FaceDetectionSubStep: React.FC<FaceDetectionSubStepProps> = ({ expanded, onToggle }) => {
  const roles = useStore((s) => s.roles);
  const status = useStore((s) => s.subStepStatuses['faces'] || 'idle');

  return (
    <CollapsibleCard expanded={expanded} onExpandedChange={onToggle}
      title={<><StatusIcon status={status === 'idle' ? 'pending' : status} /><span className="text-[13px] font-semibold">人物识别</span></>}
      extra={<span className="text-[13px] text-muted-foreground">{status === 'completed' ? roles.length + ' 个角色' : '等待'}</span>}>
      {status === 'completed' && roles.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {roles.map((role: any) => (
            <div key={role.id} className="flex flex-col items-center gap-1 p-2 rounded-md bg-bg-secondary">
              <div className="w-12 h-12 rounded-full bg-bg-primary overflow-hidden">
                {role.avatarPath && <img src={role.avatarPath} className="w-full h-full object-cover" />}
              </div>
              <span className="text-[13px]">{role.name || '未命名'}</span>
            </div>
          ))}
        </div>
      )}
    </CollapsibleCard>
  );
};