import { useEffect, useCallback, useState, useRef } from 'react';

/** 可拖拽分隔条面板 Hook 的配置 */
interface ResizablePanelOptions {
  minLeftWidth?: number;
  maxLeftWidth?: number;
  defaultLeftPercent?: number;
  containerSelector?: string;
}

/** 可拖拽分隔条面板 Hook 的返回值 */
interface ResizablePanelResult {
  leftWidth: number;
  isDragging: boolean;
  leftPanelRef: React.RefObject<HTMLDivElement>;
  handleDividerMouseDown: (e: React.MouseEvent) => void;
}

/**
 * 可拖拽分隔条面板 Hook
 * 管理左侧面板宽度的拖拽调整逻辑
 */
export const useResizablePanel = (options: ResizablePanelOptions = {}): ResizablePanelResult => {
  const {
    minLeftWidth = 280,
    maxLeftWidth = 800,
    defaultLeftPercent = 30,
    containerSelector = '.editor-body'
  } = options;

  const [isDragging, setIsDragging] = useState(false);
  const [leftWidth, setLeftWidth] = useState(defaultLeftPercent);
  const leftPanelRef = useRef<HTMLDivElement>(null);

  /** 分隔条鼠标按下事件处理 */
  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  useEffect(() => {
    if (!isDragging) return;

    /** 鼠标移动事件处理：计算新的左侧面板宽度 */
    const handleMouseMove = (e: MouseEvent) => {
      const bodyRect = document.querySelector(containerSelector)?.getBoundingClientRect();
      if (!bodyRect || !leftPanelRef.current) return;

      let newWidth = e.clientX - bodyRect.left;
      if (newWidth < minLeftWidth) newWidth = minLeftWidth;
      if (newWidth > maxLeftWidth) newWidth = maxLeftWidth;

      const newWidthPercent = (newWidth / bodyRect.width) * 100;
      setLeftWidth(newWidthPercent);
    };

    /** 鼠标松开事件处理：停止拖拽 */
    const handleMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, minLeftWidth, maxLeftWidth, containerSelector]);

  return { leftWidth, isDragging, leftPanelRef, handleDividerMouseDown };
};
