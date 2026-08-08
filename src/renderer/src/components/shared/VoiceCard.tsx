// VoiceCard - 音色卡片组件
import React from 'react';
import { Play, Square, Check } from 'lucide-react';
import { cn } from '../../lib/utils';

interface VoiceCardProps {
  /** 音色 ID（兼容旧调用方传入） */
  id?: string;
  /** 音色名称 */
  name: string;
  /** 语言标识（兼容旧调用方传入） */
  lang?: string;
  /** 是否选中 */
  selected?: boolean;
  /** 是否预览中 */
  isPreviewing?: boolean;
  /** 选中回调 */
  onSelect?: () => void;
  /** 预览回调（参数为音色 ID） */
  onPreview?: (voiceId: string) => void;
}

/**
 * 音色卡片组件
 * 用于 TTS 步骤的音色选择，支持选中态高亮与试听预览
 */
export const VoiceCard: React.FC<VoiceCardProps> = ({ name, selected, isPreviewing, onSelect, onPreview, id, lang }) => {
  return (
    <div
      onClick={onSelect}
      className={cn(
        'group relative p-2 rounded-lg border cursor-pointer transition-all duration-200 select-none',
        'flex flex-col gap-0.5 min-h-[52px]',
        selected
          ? 'border-accent/60 bg-accent/10 shadow-sm'
          : 'border-border/40 bg-bg-tertiary/40 hover:border-accent/30 hover:bg-bg-secondary/50'
      )}
    >
      {/* 选中标记 */}
      {selected && (
        <span className="absolute top-1 right-1 w-4 h-4 rounded-full bg-accent flex items-center justify-center">
          <Check size={10} className="text-white" />
        </span>
      )}

      {/* 音色名称 */}
      <span className={cn(
        'text-[12px] font-medium truncate',
        selected ? 'text-accent' : 'text-foreground'
      )}>
        {name}
      </span>

      {/* 语言标识 */}
      {lang && (
        <span className="text-[12px] text-muted-foreground/70 truncate">{lang}</span>
      )}

      {/* 试听按钮：始终可见（一键试听），hover 时高亮 */}
      {onPreview && id && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onPreview(id);
          }}
          className={cn(
            'absolute bottom-1 right-1 w-5 h-5 rounded-full flex items-center justify-center transition-all',
            isPreviewing
              ? 'bg-accent-cyan/20 text-accent-cyan'
              : 'bg-muted/40 text-muted-foreground hover:bg-accent-cyan/15 hover:text-accent-cyan'
          )}
          aria-label={isPreviewing ? '停止试听' : '试听音色'}
        >
          {isPreviewing ? <Square size={10} /> : <Play size={10} />}
        </button>
      )}
    </div>
  );
};

export default VoiceCard;
