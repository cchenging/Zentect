// 📁 路径：src/renderer/src/pages/editor/components/semantic-flow/nodes/BaseNode.tsx
import React from 'react';
import { Handle, Position } from '@xyflow/react';
import { Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { NODE_STATUS, type NodeStatusType } from '../../../../../store/constants';
import { stopEvent } from '../../../../../utils/domEvents';

export interface BaseNodeProps {
  id: string;
  title: string;
  icon?: React.ReactNode;
  status?: NodeStatusType;
  progress?: number;
  selected?: boolean;
  className?: string;
  children: React.ReactNode;

  inputs?: { id: string; type: string; label?: string }[] | true;
  outputs?: { id: string; type: string; label?: string }[] | true;
  handles?: React.ReactNode;
  themeColor?: string;
  themeBg?: string;
  width?: string | number;
  contentClassName?: string;
  accent?: string;
  
  /** default: 标准头部 / compact: 紧凑头部 / wide: 宽幅头部 / player: 无头部 / minimal: 极简头部 */
  variant?: 'default' | 'compact' | 'wide' | 'player' | 'minimal';
}

const ACCENT_BORDER: Record<string, string> = {
  blue: 'border-l-blue-500',
  indigo: 'border-l-indigo-500',
  purple: 'border-l-purple-500',
  emerald: 'border-l-emerald-500',
  amber: 'border-l-amber-500',
  rose: 'border-l-rose-500',
  green: 'border-l-green-500',
};

const renderHeader = (
  variant: string,
  icon: React.ReactNode | undefined,
  title: string,
  status: string,
  themeColor: string,
  themeBg: string,
  accent: string | undefined
) => {
  if (variant === 'player') return null;

  const _accentBorder = accent ? ACCENT_BORDER[accent] || '' : '';
  void _accentBorder;

  switch (variant) {
    case 'minimal':
      return (
        <div className={`flex items-center gap-1.5 px-2 py-1.5 ${themeBg} rounded-t-xl shrink-0`}>
          {icon && <div className={`shrink-0 ${themeColor}`}>{icon}</div>}
          <span className={`text-[11px] font-medium truncate ${themeColor}`}>{title}</span>
          <div className="ml-auto shrink-0">
            {status === NODE_STATUS.PROCESSING && <Loader2 size={12} className="text-primary animate-spin" />}
            {status === NODE_STATUS.ERROR && <AlertCircle size={12} className="text-red-500" />}
            {status === NODE_STATUS.SUCCESS && <CheckCircle2 size={12} className="text-green-500" />}
          </div>
        </div>
      );

    case 'compact':
      return (
        <div className={`flex items-center gap-2 px-2 py-2 border-b border-white/5 ${themeBg} rounded-t-xl shrink-0`}>
          {accent && <div className={`w-[3px] h-4 rounded-full shrink-0 ${ACCENT_BORDER[accent] || 'bg-primary'}`} />}
          {icon && <div className={`shrink-0 ${themeColor}`}>{icon}</div>}
          <span className={`text-[11px] font-semibold truncate ${themeColor}`}>{title}</span>
          <div className="ml-auto shrink-0">
            {status === NODE_STATUS.PROCESSING && <Loader2 size={12} className="text-primary animate-spin" />}
            {status === NODE_STATUS.ERROR && <AlertCircle size={12} className="text-red-500" />}
            {status === NODE_STATUS.SUCCESS && <CheckCircle2 size={12} className="text-green-500" />}
          </div>
        </div>
      );

    case 'wide':
      return (
        <div className={`flex items-center gap-3 px-4 py-3 border-b border-white/5 ${themeBg} rounded-t-xl shrink-0`}>
          {icon && <div className={`shrink-0 w-7 h-7 rounded-lg flex items-center justify-center ${accent ? `bg-${accent}-500/15 text-${accent}-400` : ''}`}>{icon}</div>}
          <div className="flex flex-col min-w-0">
            <span className={`text-xs font-bold truncate ${themeColor}`}>{title}</span>
            {status === NODE_STATUS.PROCESSING && <span className="text-[10px] text-zinc-500">运行中...</span>}
            {status === NODE_STATUS.SUCCESS && <span className="text-[10px] text-green-500/60">已完成</span>}
          </div>
          <div className="ml-auto shrink-0">
            {status === NODE_STATUS.PROCESSING && <Loader2 size={16} className="text-primary animate-spin" />}
            {status === NODE_STATUS.ERROR && <AlertCircle size={16} className="text-red-500" />}
            {status === NODE_STATUS.SUCCESS && <CheckCircle2 size={16} className="text-green-500" />}
          </div>
        </div>
      );

    default:
      return (
        <div className={`flex items-center justify-between px-3 py-2.5 border-b border-white/5 ${themeBg} rounded-t-xl shrink-0`}>
          <div className="flex items-center gap-2 overflow-hidden">
            {accent && <div className={`w-[3px] h-4 rounded-full shrink-0 ${ACCENT_BORDER[accent] || 'bg-primary'}`} />}
            {icon && <div className={`shrink-0 ${themeColor}`}>{icon}</div>}
            <span className={`text-xs font-semibold tracking-wide truncate ${themeColor}`}>{title}</span>
          </div>
          <div className="shrink-0 ml-2">
            {status === NODE_STATUS.PROCESSING && <Loader2 size={14} className="text-primary animate-spin" />}
            {status === NODE_STATUS.ERROR && <AlertCircle size={14} className="text-red-500" />}
            {status === NODE_STATUS.SUCCESS && <CheckCircle2 size={14} className="text-green-500" />}
          </div>
        </div>
      );
  }
};

export const BaseNode: React.FC<BaseNodeProps> = ({
  title,
  icon,
  status = NODE_STATUS.IDLE,
  progress = 0,
  selected = false,
  className = 'w-[260px]',
  children,
  inputs,
  outputs,
  handles,
  themeColor = 'text-zinc-300',
  themeBg = 'bg-white/[0.02]',
  width,
  contentClassName,
  accent,
  variant = 'default',
}) => {
  const statusStyles = {
    [NODE_STATUS.IDLE]: 'border-zinc-800/80 bg-zinc-950/90 shadow-sm',
    [NODE_STATUS.PROCESSING]: 'border-primary/60 bg-zinc-950/95 shadow-[0_0_15px_rgba(var(--primary),0.15)] ring-1 ring-primary/30',
    [NODE_STATUS.SUCCESS]: 'border-green-500/40 bg-zinc-950/90 shadow-[0_0_10px_rgba(34,197,94,0.1)]',
    [NODE_STATUS.ERROR]: 'border-red-500/50 bg-red-950/20 shadow-[0_0_15px_rgba(239,68,68,0.15)] ring-1 ring-red-500/30',
  };

  const currentStyle = statusStyles[status] || statusStyles[NODE_STATUS.IDLE];
  const isSelectedStyle = selected ? 'ring-2 ring-primary border-transparent' : '';

  return (
    <div
      className={`relative rounded-xl border backdrop-blur-md transition-all duration-300 ${currentStyle} ${isSelectedStyle} flex flex-col ${className}`}
      style={{ width: width ? width : 'auto', minWidth: '160px' }}
      onContextMenu={stopEvent}
    >
      {handles ? handles : (
        <>
          {Array.isArray(inputs) && inputs.map((inp, idx) => (
            <Handle
              key={inp.id} type="target" position={Position.Left} id={inp.id}
              className={`w-4 h-4 border-2 border-zinc-950 ${status === NODE_STATUS.PROCESSING ? 'bg-primary animate-pulse' : 'bg-zinc-500'}`}
              style={{ top: `${(idx + 1) * (100 / (inputs.length + 1))}%` }}
            />
          ))}
          {inputs === true && (
            <Handle
              type="target" position={Position.Left} id="in"
              className={`w-4 h-4 border-2 border-zinc-950 ${status === NODE_STATUS.PROCESSING ? 'bg-primary animate-pulse' : 'bg-zinc-500'}`}
              style={{ top: '50%' }}
            />
          )}

          {Array.isArray(outputs) && outputs.map((out, idx) => (
            <Handle
              key={out.id} type="source" position={Position.Right} id={out.id}
              className="w-4 h-4 bg-zinc-400 border-2 border-zinc-950 hover:bg-white transition-colors"
              style={{ top: `${(idx + 1) * (100 / (outputs.length + 1))}%` }}
            />
          ))}
          {outputs === true && (
            <Handle
              type="source" position={Position.Right} id="out"
              className="w-4 h-4 bg-zinc-400 border-2 border-zinc-950 hover:bg-white transition-colors"
              style={{ top: '50%' }}
            />
          )}
        </>
      )}

      {renderHeader(variant, icon, title, status, themeColor, themeBg, accent)}

      {status === NODE_STATUS.PROCESSING && progress > 0 && (
        <div className="absolute top-0 left-0 h-[2px] bg-primary transition-all duration-300 rounded-tl-xl" style={{ width: `${progress}%` }} />
      )}

      <div className={`${contentClassName || 'p-3'}`}>
        {children}
      </div>
    </div>
  );
};
