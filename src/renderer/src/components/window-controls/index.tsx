import React from 'react';
import { Minus, Square, X } from 'lucide-react';
import { API } from '../../api';
import { useI18n } from '../../store/useI18n';

/**
 * 窗口控制组件：封装原生窗口的三大金刚键
 * 通过暴露 onClose 和各类样式类名，确保能复用于 TitleBar、编辑器 TopBar 及 Settings 页面
 */
interface WindowControlsProps {
  className?: string;
  // 允许外部覆盖默认的鼠标悬停样式，以适应不同页面的主题（如 Settings 的深色背景）
  btnClassName?: string;
  hoverBgClassName?: string;
  closeHoverBgClassName?: string;
  // 编辑器 TopBar 的 "关闭" 实际上是返回首页，这里提供覆写机制
  onClose?: () => void;
  closeTitle?: string;
}

export const WindowControls: React.FC<WindowControlsProps> = ({
  className = "flex items-center gap-0.5",
  btnClassName = "h-8 w-8 flex items-center justify-center bg-transparent border-none rounded-md transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-primary text-muted-foreground",
  hoverBgClassName = "hover:bg-muted hover:text-foreground",
  closeHoverBgClassName = "hover:bg-red-500 hover:text-white",
  onClose,
  closeTitle
}) => {
  const { t } = useI18n();

  const handleClose = () => {
    if (onClose) {
      onClose();
    } else {
      API.system.close();
    }
  };

  return (
    <div className={className}>
      <button
        className={`${btnClassName} ${hoverBgClassName}`}
        onClick={() => API.system.minimize()}
        aria-label="最小化"
        title={t.common?.minimize || '最小化'}
      >
        <Minus size={16} />
      </button>

      <button
        className={`${btnClassName} ${hoverBgClassName}`}
        onClick={() => API.system.maximize()}
        aria-label="最大化"
        title={t.common?.maximize || '最大化'}
      >
        <Square size={14} />
      </button>

      <button
        className={`${btnClassName} ${closeHoverBgClassName}`}
        onClick={handleClose}
        aria-label="关闭"
        title={closeTitle || t.common?.close || '关闭'}
      >
        <X size={16} />
      </button>
    </div>
  );
};
