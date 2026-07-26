// DragReorderList - compatibility stub
import React from 'react';

interface DragReorderListProps {
  items: any[];
  onReorder: (items: any[]) => void;
  // 🔧 React 19 兼容：renderItem 签名补齐 isDragging 参数（与 drag-reorder-list.tsx 实现对齐）
  renderItem: (item: any, index: number, isDragging?: boolean) => React.ReactNode;
  getItemId?: (item: any) => string | number;
}

export const DragReorderList: React.FC<DragReorderListProps> = ({
  items,
  renderItem
}) => {
  return (
    <div className="flex flex-col gap-2">
      {items.map((item, index) => (
        <div key={index}>{renderItem(item, index, false)}</div>
      ))}
    </div>
  );
};

export default DragReorderList;
