// 📁 路径：src/modules/home/frontend/components/ProjectCard.tsx
import React from 'react';
import type { ProjectRecord } from '../../types';
import { AppIcon } from '../../../../renderer/src/components/app-icon';
import { useI18n } from '../../../../renderer/src/store/useI18n';
import { formatDurationStandard } from '../../../../renderer/src/utils/timeUtils';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../../../../renderer/src/components/ui/dropdown-menu';

interface ProjectCardProps {
  project: ProjectRecord;
  onClick: (id: string) => void;
  onRename: (proj: ProjectRecord) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string, name: string) => void;
  onExport: (id: string, name: string) => void;
}

/**
 * 按字符宽度智能截断
 * 中文字符宽度为 2，英文为 1
 * 取前一半宽度 + 后一半宽度的字符，超出用 .. 连接
 */
const truncateMiddleSmart = (text: string, maxCharWidth = 28) => {
  if (!text) return '';
  let total = 0;
  for (let i = 0; i < text.length; i++) {
    total += text.charCodeAt(i) > 255 ? 2 : 1;
  }
  if (total <= maxCharWidth) return text;
  // 头部取 maxCharWidth 的一半宽度
  const targetHalf = maxCharWidth / 2;

  let front = '';
  let currentLen = 0;
  for (let i = 0; i < text.length; i++) {
    const charLen = text.charCodeAt(i) > 255 ? 2 : 1;
    if (currentLen + charLen > Math.ceil(targetHalf)) break;
    front += text[i];
    currentLen += charLen;
  }

  let back = '';
  currentLen = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    const charLen = text.charCodeAt(i) > 255 ? 2 : 1;
    if (currentLen + charLen > Math.floor(targetHalf)) break;
    back = text[i] + back;
    currentLen += charLen;
  }

  return `${front}..${back}`;
};

const formatBytes = (bytes?: number) => {
  if (bytes === undefined || bytes === null || isNaN(bytes)) return '-- MB';
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

export const ProjectCard: React.FC<ProjectCardProps> = ({ project, onClick, onRename, onDuplicate, onDelete, onExport }) => {
  const { t } = useI18n();

  const coverUrl = project.coverPath || '';
  const displayName = truncateMiddleSmart(project.name);

  return (
    // 容器增加了柔和的间距和动画过渡
    <div className="group flex flex-col w-[190px] shrink-0 cursor-pointer gap-2.5 hover:z-40 [-webkit-app-region:no-drag] transition-all duration-300">

      {/* 💥 美学重构 1：封面大圆角 (rounded-xl) + 柔和边框 + 独立 Hover 层 (group/cover) */}
      <div
        className="w-full aspect-video shrink-0 bg-secondary/30 rounded-xl overflow-hidden border border-border/60 relative shadow-sm group-hover:shadow-md transition-all duration-300 group/cover"
        onClick={() => onClick(project.id)}
      >
        {coverUrl ? (
          // 图片增加了 duration-700 ease-out 打造极致丝滑的呼吸感放大
          <img src={coverUrl} alt={project.name} className="w-full h-full object-cover transition-transform duration-700 ease-out group-hover/cover:scale-110" />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-muted/50 to-muted">
            <AppIcon name="Video" size={28} className="text-muted-foreground/30" />
          </div>
        )}
        
        {/* 护眼遮罩层：防止封面太亮导致白色按钮看不清 */}
        <div className="absolute inset-0 bg-gradient-to-bl from-black/40 via-transparent to-transparent opacity-0 group-hover/cover:opacity-100 transition-opacity duration-300 pointer-events-none" />
        
        {/* 项目完成状态标签 — 纯图标角标风格 */}
        {/* 项目完成状态标签 — 纯图标角标风格，主题自适应 */}
        <div className="absolute top-1.5 right-1.5">
          <div className="w-[22px] h-[22px] flex items-center justify-center rounded-full light:bg-black/25 bg-black/40">
            {project.step5Status === 'completed' ? (
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" className="text-success">
                <path d="M3.5 6.5L5.5 9L9.5 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" className="text-muted-foreground">
                <circle cx="6.5" cy="6.5" r="4.8" stroke="currentColor" strokeWidth="1.2"/>
                <path d="M6.5 4V6.8L8.5 7.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
          </div>
        </div>
        
        {/* 💥 美学重构 2：毛玻璃正圆形按钮 (rounded-full) */}
        <div className="absolute top-2 right-2" onClick={e => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button 
                title={t.common?.more || '更多'}
                className="w-7 h-7 flex items-center justify-center bg-black/20 hover:bg-black/60 data-[state=open]:bg-black/70 backdrop-blur-md text-white/95 rounded-full border border-white/10 transition-all shadow-sm outline-none opacity-0 group-hover/cover:opacity-100 data-[state=open]:opacity-100"
              >
                <AppIcon name="MoreHorizontal" size={15} />
              </button>
            </DropdownMenuTrigger>
            
            {/* 菜单增加 rounded-xl 和更大阴影，彻底脱离廉价感 */}
            <DropdownMenuContent align="start" sideOffset={8} className="w-32 z-50 rounded-xl shadow-xl border-border/50 bg-popover/95 backdrop-blur-xl">
              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onRename(project); }} className="text-xs gap-2.5 py-2 cursor-pointer rounded-md">
                <AppIcon name="Edit" size={13} className="text-muted-foreground" />
                {t.common?.rename || '重命名'}
              </DropdownMenuItem>
              
              {/* 💥 修复防御：加入硬编码降级保护，绝不会再出现文字消失的情况 */}
              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onDuplicate(project.id); }} className="text-xs gap-2.5 py-2 cursor-pointer rounded-md">
                <AppIcon name="Copy" size={13} className="text-muted-foreground" />
                {t.common?.duplicate || t.common?.copy || '创建副本'}
              </DropdownMenuItem>
              
              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onExport?.(project.id, project.name); }} className="text-xs gap-2.5 py-2 cursor-pointer rounded-md">
                <AppIcon name="Download" size={13} className="text-muted-foreground" />
                导出备份
              </DropdownMenuItem>
              
              <DropdownMenuSeparator className="bg-border/50" />
              
              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onDelete(project.id, project.name); }} className="text-xs text-destructive focus:text-destructive focus:bg-destructive/10 gap-2.5 py-2 cursor-pointer rounded-md">
                <AppIcon name="Trash2" size={13} />
                {t.common?.delete || '删除'}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* 💥 美学重构 3：苹果级紧凑排版，用圆点 (●) 分割，拒绝松散 */}
      <div className="flex flex-col px-0.5 gap-1" onClick={() => onClick(project.id)}>
        <span 
          className="w-full block text-[13px] font-semibold tracking-tight leading-tight text-foreground/90 group-hover:text-primary transition-colors"
          title={project.name}
        >
          {displayName}
        </span>
        
        <div className="flex items-center text-muted-foreground/70 text-[11px] font-medium tracking-wide">
          <span>{formatBytes(project.size)}</span>
          <span className="mx-1.5 text-[8px] opacity-40">●</span>
          <span>{formatDurationStandard(project.duration || 0)}</span>
        </div>
      </div>

    </div>
  );
};
