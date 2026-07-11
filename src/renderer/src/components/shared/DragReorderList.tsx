// DragReorderList - compatibility stub
import React from 'react';

interface DragReorderListProps {
  items: any[];
  onReorder: (items: any[]) => void;
  renderItem: (item: any, index: number) => React.ReactNode;
}

export const DragReorderList: React.FC<DragReorderListProps> = ({
  items,
  renderItem
}) => {
  return (
    <div className="flex flex-col gap-2">
      {items.map((item, index) => (
        <div key={index}>{renderItem(item, index)}</div>
      ))}
    </div>
  );
};

export default DragReorderList;
