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

  /** 🛑 React key 安全防御：getItemId 返回空/假值时，React 会直接报
   *   "Each child in a list should have a unique key prop" 且在 DOM reconciliation 中错位重渲染。
   *   即使上游（步骤5流式 partialMatches）偶发 id 缺失，也在此组件层拦一道：
   *   空 id 回退稳定占位 `fallback-{index}`（仅渲染兜底，不用于拖拽逻辑），并打印诊断日志。 */
  const getItemKey = useCallback((item: T, index: number): string => {
    const raw = String(getItemId(item) || '').trim();
    if (raw) return raw;
    // 用 console.warn 提示上游提供合法唯一键；兜底仅为不让 React 告警掩盖真实问题
    if (process.env.NODE_ENV !== 'production') {
      // 🔧 完整打印对象结构（JSON.stringify 截断），便于一次性锁定空 id 卡片的真实来源（id/shotId/mediaId 均缺）
      try {
        const itemJson = JSON.stringify(item) || '';
        console.warn(
          `[DragReorderList] 第 ${index} 项的 getItemId 返回空值，回退占位 key。` +
          `item.id=${JSON.stringify((item as any)?.id)} item.shotId=${JSON.stringify((item as any)?.shotId)} ` +
          `item.mediaId=${JSON.stringify((item as any)?.mediaId)} body=${itemJson.slice(0, 600)}`,
        );
      } catch {
        console.warn('[DragReorderList] 第', index, '项的 getItemId 返回空值，回退占位 key。item 序列化失败', item);
      }
    }
    return `__fallback-${index}`;
  }, [getItemId]);

  return (
    <div className="flex flex-col gap-2">
      {localItems.map((item, index) => (
        <div
          key={getItemKey(item, index)}
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