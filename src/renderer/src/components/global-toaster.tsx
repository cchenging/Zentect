import React from 'react';
import { Toaster } from 'react-hot-toast';
import { UI_CONSTANTS } from '../constants/ui';

/**
 * 💥 重构点：全局统一的提示 UI 容器
 * 职责：严格控制全站提示的物理位置、Z轴层级、防遮挡偏移、以及统一的暗色主题
 */
export const GlobalToaster: React.FC = () => {
  return (
    <Toaster
      position="top-right"
      containerStyle={{
        // 💥 优化点：基于 41px 的 TopBar，外边距设为 49px (41 + 8)，紧凑防遮挡
        top: '49px',
        right: '16px',
        zIndex: UI_CONSTANTS.Z_INDEX.TOAST,
      }}
      toastOptions={{
        duration: UI_CONSTANTS.DURATION.TOAST_NORMAL,
        style: {
          background: 'var(--bg-secondary)',
          color: 'var(--text-secondary)',
          border: '1px solid var(--border-default)',
          boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.5)',
          fontSize: '14px',
          backdropFilter: 'blur(10px)',
          zIndex: UI_CONSTANTS.Z_INDEX.TOAST,
        },
        success: {
          iconTheme: {
            primary: 'var(--success)',
            secondary: 'var(--bg-secondary)',
          },
        },
        error: {
          duration: UI_CONSTANTS.DURATION.TOAST_LONG,
          iconTheme: {
            primary: 'var(--destructive)',
            secondary: 'var(--bg-secondary)',
          },
        },
      }}
    />
  );
};
