import React from 'react';
import { Play, Square, Loader2 } from 'lucide-react';
import { usePipelineExecutor } from '../hooks/usePipelineExecutor';

interface IslandBtnProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: React.ElementType;
  active?: boolean;
  danger?: boolean;
}

const IslandBtn: React.FC<IslandBtnProps> = ({ icon: Icon, active, danger, children, className = '', ...props }) => {
  const baseStyle = "flex items-center justify-center transition-all duration-200 focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none text-zinc-400 hover:text-zinc-100 hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed";
  const sizeStyle = children ? "px-3 py-1.5 rounded-lg text-xs font-medium gap-1.5" : "w-8 h-8 rounded-lg";
  const activeStyle = active ? "text-white bg-white/15 shadow-sm" : "";
  const dangerStyle = danger ? "text-rose-500 hover:bg-rose-500/20 hover:text-rose-400" : "";

  return (
    <button className={`${baseStyle} ${sizeStyle} ${activeStyle} ${dangerStyle} ${className}`} {...props}>
      <Icon size={15} className={children ? "shrink-0" : ""} />
      {children}
    </button>
  );
};

export const DynamicIsland = () => {
  const { execute, abort, isRunning } = usePipelineExecutor();

  return (
    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center p-1.5 gap-1 bg-zinc-900/60 backdrop-blur-2xl border border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.4)] ring-1 ring-white/5 rounded-2xl">
      
      <div className="flex items-center gap-1">
        {isRunning ? (
          <IslandBtn icon={Square} onClick={abort} aria-label="中止运算" danger>中止运算</IslandBtn>
        ) : (
          <IslandBtn icon={Play} className="text-zinc-900 bg-primary hover:bg-primary/90 hover:text-zinc-900 shadow-[0_0_15px_rgba(var(--primary),0.3)]" onClick={execute} aria-label="启动管线">
            启动管线
          </IslandBtn>
        )}
        
        <div className="flex items-center justify-center w-8 h-8 rounded-full bg-black/30 border border-white/5 ml-1">
          {isRunning ? (
            <Loader2 size={14} className="text-primary animate-spin" />
          ) : (
            <div className="w-1.5 h-1.5 rounded-full bg-zinc-600 shadow-[inset_0_1px_1px_rgba(0,0,0,1)]" />
          )}
        </div>
      </div>
    </div>
  );
};
