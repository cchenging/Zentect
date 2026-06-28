import React, { useState, useCallback } from 'react';
import { GripVertical } from 'lucide-react';

/** 泛型拖拽排序列表组件 */
export interface DragReorderListProps<T> {
  items: T[];
  /** 唯一标识 */
  getItemId: (item: T) => string;
  /** 渲染每一行 */
  renderItem: (item: T, index: number, isDragging: boolean) => React.ReactNode;
  /** 排序完成回调（仅在 dragEnd 触发一次，不高频写 Store） */
  onReorder: (reordered: T[]) => void;
  /** 是否启用拖拽 */
  disabled?: boolean;
  /** 拖拽手柄（默认 GripVertical 图标） */
  dragHandle?: React.ReactNode;
}

export function DragReorderList<T>({ items, getItemId, renderItem, onReorder, disabled, dragHandle }: DragReorderListProps<T>) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [localItems, setLocalItems] = useState<T[]>(items);

  // 同步外部 items 变化（非拖拽期间的更新）
  React.useEffect(() => {
    if (dragIndex === null) setLocalItems(items);
  }, [items, dragIndex]);

  const handleDragStart = useCallback((index: number) => setDragIndex(index), []);
  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (dragIndex === null || dragIndex === index) return;
    const next = [...localItems];
    const [dragged] = next.splice(dragIndex, 1);
    next.splice(index, 0, dragged);
    setLocalItems(next);
    setDragIndex(index);
  }, [dragIndex, localItems]);
  const handleDragEnd = useCallback(() => {
    if (dragIndex !== null) {
      onReorder(localItems); // 单次写入
      setDragIndex(null);
    }
  }, [dragIndex, localItems, onReorder]);

  return (
    <div className="flex flex-col gap-2">
      {localItems.map((item, index) => (
        <div
          key={getItemId(item)}
          draggable={!disabled}
          onDragStart={() => handleDragStart(index)}
          onDragOver={(e) => handleDragOver(e, index)}
          onDragEnd={handleDragEnd}
          className={`transition-all ${dragIndex === index ? 'opacity-50' : ''}`}
        >
          <div className="flex items-center gap-1">
            {!disabled && (
              <span className="cursor-grab active:cursor-grabbing text-muted-foreground/30 hover:text-muted-foreground shrink-0">
                {dragHandle || <GripVertical size={14} />}
              </span>
            )}
            <div className="flex-1">{renderItem(item, index, dragIndex === index)}</div>
          </div>
        </div>
      ))}
    </div>
  );
}