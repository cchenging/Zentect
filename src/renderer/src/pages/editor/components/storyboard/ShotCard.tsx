/**
 * @deprecated 已迁移至 src/modules/editor/storyboard/frontend/components/ShotCard.tsx
 * 请使用 import { ShotCard } from '@/modules/editor/storyboard'
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import type { Shot, Role } from '../../../../../../shared/types';
import { getSafeMediaUrl } from '../../../../utils/formatUrl';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../../../components/ui/dropdown-menu';
import { GripVertical } from 'lucide-react';

/** ShotCard 组件 Props */
interface ShotCardProps {
  shot: Shot;
  index: number;
  isSelected: boolean;
  roles: Role[];
  onSelect: () => void;
  onDelete: () => void;
  onSave: (id: string, text: string) => void;
}

/** 根据镜头数据推断状态 */
function getShotStatus(shot: Shot): 'completed' | 'processing' | 'pending' {
  if (shot.aiText && shot.coverPath) return 'completed';
  if (shot.text || shot.originalText || shot.coverPath) return 'processing';
  return 'pending';
}

/** 状态指示器颜色映射 */
const STATUS_COLORS: Record<string, string> = {
  completed: 'bg-green-500',
  processing: 'bg-blue-500',
  pending: 'bg-gray-500',
};

/** 获取角色名称 */
function getRoleName(shot: Shot, roles: Role[]): string | null {
  const roleId = shot.roleId || shot.linkedRoleId;
  if (!roleId) return null;
  const role = roles.find(r => r.id === roleId);
  return role?.name || null;
}

/** 镜头卡片组件 - 160px x 200px 固定尺寸，支持拖拽排序 */
export default function ShotCard({ shot, index, isSelected, roles, onSelect, onDelete, onSave }: ShotCardProps) {
  const status = getShotStatus(shot);
  const roleName = getRoleName(shot, roles);
  const displayText = shot.aiText || shot.text || '';
  const coverSrc = getSafeMediaUrl(shot.coverPath || shot.imagePath);
  const duration = shot.duration ? `${shot.duration}s` : '';
  const emotion = shot.audioEmotion || '';

  /** 拖拽排序 */
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: shot.id });

  const dragStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 50 : 1,
  };

  /** 编辑状态 */
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const editRef = useRef<HTMLTextAreaElement>(null);

  /** 进入编辑模式 */
  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setEditValue(displayText);
    setIsEditing(true);
  }, [displayText]);

  /** 保存编辑 */
  const handleSave = useCallback(() => {
    setIsEditing(false);
    const trimmed = editValue.trim();
    if (trimmed !== displayText) {
      onSave(shot.id, trimmed);
    }
  }, [editValue, displayText, shot.id, onSave]);

  /** 取消编辑 */
  const handleCancel = useCallback(() => {
    setIsEditing(false);
    setEditValue('');
  }, []);

  /** 键盘事件处理 */
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleCancel();
    }
  }, [handleSave, handleCancel]);

  /** 自动聚焦编辑框 */
  useEffect(() => {
    if (isEditing && editRef.current) {
      editRef.current.focus();
      editRef.current.select();
    }
  }, [isEditing]);

  return (
    <div ref={setNodeRef} style={dragStyle} className="relative flex-shrink-0">
      {/* 拖拽手柄 */}
      <div
        {...attributes}
        {...listeners}
        className="absolute -left-2 top-1/2 -translate-y-1/2 w-5 h-12 flex items-center justify-center cursor-grab active:cursor-grabbing z-20 opacity-0 hover:opacity-100 transition-opacity rounded bg-[var(--bg-elevated)] border border-[var(--border-default)]"
      >
        <GripVertical className="w-3.5 h-3.5 text-[var(--text-tertiary)]" />
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <div
            className={`
              relative w-[160px] h-[200px] rounded-lg border cursor-pointer
              transition-all duration-200 select-none
              ${isSelected
                ? 'border-[var(--accent)] ring-2 ring-[var(--accent)] shadow-[0_0_12px_var(--glow-accent,rgba(99,102,241,0.3))]'
                : 'border-[var(--border-default)] hover:border-[var(--accent)] hover:-translate-y-0.5'
              }
              bg-[var(--bg-elevated)] overflow-hidden
            `}
            onClick={onSelect}
          >
            {/* 左上角状态指示灯 */}
            <div className={`absolute top-2 left-2 w-2 h-2 rounded-full ${STATUS_COLORS[status]} z-10`} />

            {/* 缩略图区域 160x90 */}
            <div className="w-full h-[90px] bg-[var(--bg-secondary)] flex items-center justify-center overflow-hidden">
              {coverSrc ? (
                <img
                  src={coverSrc}
                  alt={`镜头 ${index + 1}`}
                  className="w-full h-full object-cover"
                  loading="lazy"
                />
              ) : (
                <span className="text-[var(--text-tertiary)] text-xs">暂无画面</span>
              )}
            </div>

            {/* 内容区域 */}
            <div className="p-2 flex flex-col gap-1 flex-1">
              {/* 台词文本 - 双击编辑 */}
              {isEditing ? (
                <textarea
                  ref={editRef}
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={handleSave}
                  onKeyDown={handleKeyDown}
                  onClick={(e) => e.stopPropagation()}
                  className="w-full h-full min-h-[48px] text-[11px] leading-[15px] bg-[var(--bg-secondary)] border border-[var(--accent)] rounded-md p-1 resize-none outline-none text-[var(--text-primary)]"
                />
              ) : (
                <p
                  className="text-[11px] leading-[15px] text-[var(--text-primary)] line-clamp-2 min-h-[30px] cursor-text"
                  onDoubleClick={handleDoubleClick}
                >
                  {displayText || '未配置台词'}
                </p>
              )}

              {/* 角色标签 */}
              {roleName && (
                <span className="inline-block text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent)]/15 text-[var(--accent)] truncate w-fit max-w-full">
                  {roleName}
                </span>
              )}

              {/* 底部：时长 + 语速 */}
              {(duration || emotion) && (
                <div className="flex items-center gap-2 mt-auto text-[10px] text-[var(--text-tertiary)]">
                  {duration && <span>{duration}</span>}
                  {emotion && <span className="capitalize">{emotion}</span>}
                </div>
              )}
            </div>
          </div>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="start" className="w-36">
          <DropdownMenuItem
            className="text-red-500 focus:text-red-500 cursor-pointer"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            删除镜头
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}