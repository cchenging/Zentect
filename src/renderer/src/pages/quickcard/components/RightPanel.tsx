/** V1.3 B3: RightPanel 右栏精修面板
 *  0↔340px 可折叠动画，内容由 steps[currentStep].rightPanel 配置驱动
 *  为 null 时不显示精修按钮（由主页面通过 showRightPanelButton 控制）
 *  RightPanel 通过 props 接收业务数据，修改 Zustand store → 中栏自动重渲染
 */

import React from 'react';
import { X } from 'lucide-react';

interface RightPanelProps {
  open: boolean;
  onClose: () => void;
  component: React.ComponentType<any> | null;
  componentProps?: Record<string, any>;
}

export const RightPanel: React.FC<RightPanelProps> = ({
  open,
  onClose,
  component: Component,
  componentProps = {},
}) => {
  /** 无内容时不渲染 */
  if (!Component) return null;

  return (
    <aside
      className={`shrink-0 border-l border-border bg-bg-elevated overflow-hidden transition-all duration-300 ease-in-out flex flex-col ${
        open ? 'w-[340px] max-w-[340px] opacity-100' : 'w-0 max-w-0 opacity-0 border-l-0'
      }`}
    >
      {/* 头部固定 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <h3 className="text-sm font-medium text-foreground">精修面板</h3>
        <button
          onClick={onClose}
          className="p-1 rounded-md hover:bg-accent/10 transition-colors"
        >
          <X size={16} className="text-muted-foreground" />
        </button>
      </div>

      {/* 内容滚动区 */}
      <div className="flex-1 overflow-y-auto p-4" style={{ scrollbarWidth: 'thin' }}>
        {open && <Component {...componentProps} />}
      </div>
    </aside>
  );
};