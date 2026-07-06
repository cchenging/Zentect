// Module: editor/preview/frontend/View — PreviewMonitor
// 架构规格 §3.4.2：视频预览播放器，Props 驱动，不访问 Store

import React from 'react';
import { Player } from './components/Player';
import type { PreviewInput, PreviewCallbacks } from '../types';

interface PreviewMonitorProps extends PreviewInput, PreviewCallbacks {}

/**
 * 视频预览监视器
 * - 无素材时显示导入引导
 * - 有素材时渲染 Player（VideoCanvas + PlayerControls）
 */
export const PreviewMonitor: React.FC<PreviewMonitorProps> = ({
  mediaPath,
  onImportClick,
}) => {
  if (!mediaPath) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-[var(--bg-deepest)] rounded-lg border border-dashed border-[var(--border-default)] min-h-[300px] gap-4">
        <svg className="w-12 h-12 text-[var(--text-disabled)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <polygon points="23 7 16 12 23 17 23 7" />
          <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
        </svg>
        <p className="text-[var(--text-secondary)] text-sm">导入视频素材开始创作</p>
        {onImportClick && (
          <button
            onClick={onImportClick}
            className="px-4 py-2 bg-[var(--accent)]/10 border border-[var(--accent)]/30 rounded-lg text-[var(--accent)] text-sm hover:bg-[var(--accent)]/20 transition-colors cursor-pointer outline-none"
          >
            导入视频素材
          </button>
        )}
      </div>
    );
  }

  return <Player />;
};

PreviewMonitor.displayName = 'PreviewMonitor';

export default PreviewMonitor;
