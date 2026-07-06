// Module: editor/shell/hooks/useResizablePanel
// 原 editor/hooks/useResizablePanel.ts — 已迁移

import { useEffect, useCallback, useState, useRef } from 'react';

interface ResizablePanelOptions {
  minLeftWidth?: number;
  maxLeftWidth?: number;
  defaultLeftPercent?: number;
  containerSelector?: string;
}

interface ResizablePanelResult {
  leftWidth: number;
  isDragging: boolean;
  leftPanelRef: React.RefObject<HTMLDivElement>;
  handleDividerMouseDown: (e: React.MouseEvent) => void;
}

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

  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const bodyRect = document.querySelector(containerSelector)?.getBoundingClientRect();
      if (!bodyRect || !leftPanelRef.current) return;

      let newWidth = e.clientX - bodyRect.left;
      if (newWidth < minLeftWidth) newWidth = minLeftWidth;
      if (newWidth > maxLeftWidth) newWidth = maxLeftWidth;

      const newWidthPercent = (newWidth / bodyRect.width) * 100;
      setLeftWidth(newWidthPercent);
    };

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
