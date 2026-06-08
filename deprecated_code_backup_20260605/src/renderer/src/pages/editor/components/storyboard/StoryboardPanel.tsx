import { useCallback, useState } from 'react';
import type { Shot, Role } from '../../../../../../shared/types';
import ShotCard from './ShotCard';
import { Plus, AlertTriangle } from 'lucide-react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';

/** StoryboardPanel 组件 Props */
interface StoryboardPanelProps {
  shots: Shot[];
  roles: Role[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onAdd: () => void;
  onClearSelection: () => void;
  onSave: (id: string, text: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
}

/** 故事板面板 - 水平滚动卡片列表 + 拖拽排序 + 空状态引导 + 添加片段 + 删除确认 */
export default function StoryboardPanel({
  shots,
  roles,
  selectedId,
  onSelect,
  onDelete,
  onAdd,
  onClearSelection,
  onSave,
  onReorder,
}: StoryboardPanelProps) {
  /** 删除确认状态 */
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  /** 拖拽传感器 - 5px 防误触 */
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  /** 拖拽结束处理 */
  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = shots.findIndex(s => s.id === active.id);
    const newIndex = shots.findIndex(s => s.id === over.id);
    if (oldIndex !== -1 && newIndex !== -1) {
      onReorder(oldIndex, newIndex);
    }
  }, [shots, onReorder]);

  /** 点击空白区域取消选中 */
  const handlePanelClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClearSelection();
    }
  }, [onClearSelection]);

  /** 确认删除 */
  const handleConfirmDelete = useCallback((id: string) => {
    setDeleteConfirmId(id);
  }, []);

  /** 执行删除 */
  const handleExecuteDelete = useCallback(() => {
    if (deleteConfirmId) {
      onDelete(deleteConfirmId);
      setDeleteConfirmId(null);
    }
  }, [deleteConfirmId, onDelete]);

  /** 取消删除 */
  const handleCancelDelete = useCallback(() => {
    setDeleteConfirmId(null);
  }, []);

  return (
    <div
      className="w-full overflow-x-auto border-t border-[var(--border-default)] bg-[var(--bg-secondary)]"
      onClick={handlePanelClick}
    >
      <div className="flex items-start gap-2 p-3 min-h-[216px]">
        {/* 空状态：无镜头 */}
        {shots.length === 0 && !deleteConfirmId ? (
          <div
            className="flex-shrink-0 w-[160px] h-[200px] rounded-lg border-2 border-dashed border-[var(--border-default)] flex flex-col items-center justify-center gap-2 cursor-pointer hover:border-[var(--accent)] hover:bg-[var(--bg-hover)] transition-colors"
            onClick={onAdd}
          >
            <Plus className="w-6 h-6 text-[var(--text-tertiary)]" />
            <span className="text-xs text-[var(--text-tertiary)]">添加第一个片段</span>
          </div>
        ) : (
          <>
            {/* 拖拽排序上下文 */}
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={shots.map(s => s.id)}
                strategy={horizontalListSortingStrategy}
              >
                {shots.map((shot, idx) => (
                  <ShotCard
                    key={shot.id}
                    shot={shot}
                    index={idx}
                    isSelected={shot.id === selectedId}
                    roles={roles}
                    onSelect={() => { onSelect(shot.id); setDeleteConfirmId(null); }}
                    onDelete={() => handleConfirmDelete(shot.id)}
                    onSave={onSave}
                  />
                ))}
              </SortableContext>
            </DndContext>

            {/* 删除确认卡片 */}
            {deleteConfirmId && (
              <div className="flex-shrink-0 w-[160px] h-[200px] rounded-lg border-2 border-red-500/50 bg-[var(--bg-elevated)] flex flex-col items-center justify-center gap-3 p-3">
                <AlertTriangle className="w-6 h-6 text-red-400" />
                <p className="text-[11px] text-[var(--text-primary)] text-center">确定要删除这个镜头片段吗？</p>
                <div className="flex gap-2">
                  <button
                    onClick={handleExecuteDelete}
                    className="px-2.5 py-1 text-[10px] rounded bg-red-500 text-white hover:bg-red-600 transition-colors"
                  >
                    删除
                  </button>
                  <button
                    onClick={handleCancelDelete}
                    className="px-2.5 py-1 text-[10px] rounded bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    取消
                  </button>
                </div>
              </div>
            )}

            {/* 末尾 "+ 添加片段" 按钮 */}
            <div
              className="flex-shrink-0 w-[160px] h-[200px] rounded-lg border-2 border-dashed border-[var(--border-default)] flex flex-col items-center justify-center gap-2 cursor-pointer hover:border-[var(--accent)] hover:bg-[var(--bg-hover)] transition-colors"
              onClick={() => { setDeleteConfirmId(null); onAdd(); }}
            >
              <Plus className="w-6 h-6 text-[var(--text-tertiary)]" />
              <span className="text-xs text-[var(--text-tertiary)]">添加片段</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}