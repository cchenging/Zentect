// 📁 路径: src/renderer/src/pages/Home/components/MiniCard.tsx
import React from 'react';

interface MiniCardProps {
  title: string;
  sub: string;
  icon: React.ReactNode;
  onClick: () => void;
  color?: 'purple' | 'blue' | 'green' | 'orange' | string;
}

export const MiniCard: React.FC<MiniCardProps> = ({ title, sub, icon, onClick, color }) => {
  const themeMap: Record<string, { iconBg: string, iconColor: string, hoverBorder: string }> = {
    purple: {
      iconBg: 'bg-purple-500/10',
      iconColor: 'text-purple-500',
      hoverBorder: 'hover:border-purple-500/40 hover:shadow-purple-500/5'
    },
    blue: {
      iconBg: 'bg-blue-500/10',
      iconColor: 'text-blue-500',
      hoverBorder: 'hover:border-blue-500/40 hover:shadow-blue-500/5'
    },
    green: {
      iconBg: 'bg-emerald-500/10',
      iconColor: 'text-emerald-500',
      hoverBorder: 'hover:border-emerald-500/40 hover:shadow-emerald-500/5'
    },
    orange: {
      iconBg: 'bg-amber-500/10',
      iconColor: 'text-amber-500',
      hoverBorder: 'hover:border-amber-500/40 hover:shadow-amber-500/5'
    },
  };

  const theme = themeMap[color || 'blue'] || themeMap.blue;

  return (
    <div
      onClick={onClick}
      className={`group flex items-center p-4 rounded-xl border border-border bg-card cursor-pointer transition-all duration-300 hover:bg-muted/30 hover:shadow-md ${theme.hoverBorder}`}
    >
      <div className={`w-11 h-11 rounded-[10px] flex items-center justify-center shrink-0 mr-4 transition-transform duration-300 group-hover:scale-105 group-hover:bg-opacity-20 ${theme.iconBg} ${theme.iconColor}`}>
        {icon}
      </div>
      
      <div className="flex flex-col min-w-0">
        {/* 💥 text-[14px] -> text-body */}
        <div className="text-body font-semibold text-foreground tracking-wide mb-0.5 truncate">
          {title}
        </div>
        {/* 💥 text-[12px] -> text-caption */}
        <div className="text-caption text-muted-foreground opacity-80 truncate">
          {sub}
        </div>
      </div>
    </div>
  );
};
