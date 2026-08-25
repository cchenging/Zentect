// Module: editor/shell/hooks/useResizablePanel
// 原 editor/hooks/useResizablePanel.ts — 已迁移

import { useEffect, useCallback, useState, useRef } from 'react';

interface ResizablePanelOptions {
  minLeftWidth?: number;        // 左栏最小宽度（像素），默认 480px（防止预览过窄控件被挡）
  maxLeftWidth?: number;        // 左栏最大宽度（像素），默认 5000（基本不限，靠百分比硬上限兜底）
  defaultLeftPercent?: number;  // 默认左栏宽度（百分比），建议 60（60% 预览 / 40% 配置）
  minLeftPercent?: number;      // 左栏宽度百分比硬下限（保证预览栏至少占 20%）
  maxLeftPercent?: number;      // 左栏宽度百分比硬上限（保证配置栏至少占 20%）
  containerSelector?: string;
}

interface ResizablePanelResult {
  leftWidth: number;
  isDragging: boolean;
  // 🔧 React 19 兼容：useRef 类型从 RefObject<T> 变为 RefObject<T | null>
  leftPanelRef: React.RefObject<HTMLDivElement | null>;
  handleDividerMouseDown: (e: React.MouseEvent) => void;
}

export const useResizablePanel = (options: ResizablePanelOptions = {}): ResizablePanelResult => {
  const {
    minLeftWidth = 480,
    maxLeftWidth = 5000,
    defaultLeftPercent = 35,   // ✅ 用户要求"左边再减小一点"：左预览 35% / 右配置 65%（配置空间更充足）
    minLeftPercent = 20,       // 硬下限：预览 ≥ 20%（防止预览被挤没、控件被遮挡）
    maxLeftPercent = 60,       // ✅ 硬上限：预览 ≤ 60%（给配置栏保底 ≥ 40%，配置栏水平空间充足）
    containerSelector = '.editor-body'
  } = options;

  const [isDragging, setIsDragging] = useState(false);
  // 初始化就卡到硬上下限内（防止外部传入 10%/90% 这类极端值）
  const [leftWidth, setLeftWidth] = useState(
    Math.min(100 - minLeftPercent, Math.max(minLeftPercent, defaultLeftPercent))
  );
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

      // ① 像素级边界：minLeftWidth / maxLeftWidth（已考虑窗口极小情况）
      let newWidthPx = e.clientX - bodyRect.left;
      newWidthPx = Math.max(minLeftWidth, Math.min(maxLeftWidth, newWidthPx));

      // ② 转百分比后再卡百分比硬上下限（**保证不会出现"右栏配置只剩 5% 看不见卡片"**）
      let newWidthPercent = (newWidthPx / bodyRect.width) * 100;
      newWidthPercent = Math.max(minLeftPercent, Math.min(maxLeftPercent, newWidthPercent));

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
  }, [isDragging, minLeftWidth, maxLeftWidth, minLeftPercent, maxLeftPercent, containerSelector]);

  return { leftWidth, isDragging, leftPanelRef, handleDividerMouseDown };
};
