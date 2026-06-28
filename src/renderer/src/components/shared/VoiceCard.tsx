import React from 'react';
import { User, Play } from 'lucide-react';

export interface VoiceCardProps {
  id: string; name: string; lang?: string;
  selected: boolean; isPreviewing?: boolean; disabled?: boolean;
  onSelect: (id: string) => void; onPreview: (id: string) => void;
}

export const VoiceCard: React.FC<VoiceCardProps> = ({
  id, name, lang, selected, isPreviewing, disabled, onSelect, onPreview,
}) => (
  <div onClick={() => !disabled && onSelect(id)}
    className={`flex items-center gap-1.5 px-2 py-1.5 rounded-md border cursor-pointer text-[11px] transition-all ${
      selected ? 'border-accent bg-accent/10 text-accent' : 'border-border/30 bg-bg-secondary text-muted-foreground hover:border-accent/40'
    } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}>
    <User size={11} />
    <span className="flex-1 truncate">{name}</span>
    {lang && <span className="text-[9px] opacity-60">{lang}</span>}
    <button onClick={(e) => { e.stopPropagation(); onPreview(id); }}
      disabled={isPreviewing || disabled}
      className={`shrink-0 p-0.5 rounded cursor-pointer ${isPreviewing ? 'text-accent animate-pulse' : 'text-muted-foreground hover:text-accent'}`}>
      <Play size={10} />
    </button>
  </div>
);