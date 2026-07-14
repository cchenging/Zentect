// Module: editor/preview/frontend/View — PreviewMonitor
// 架构规格 §3.4.2：视频预览播放器

import React from 'react';
import { Player } from './components/Player';
import { usePlayerStore } from '../../stores/usePlayerStore';
import type { PreviewInput, PreviewCallbacks } from '../types';

interface PreviewMonitorProps extends PreviewInput, PreviewCallbacks {}

/**
 * 视频预览监视器
 * - 无素材时显示导入引导
 * - 有素材时渲染 Player（VideoCanvas + PlayerControls）
 */
export const PreviewMonitor: React.FC<PreviewMonitorProps> = ({
  onImportClick,
}) => {
  const activePlaySource = usePlayerStore((s) => s.activePlaySource);

  if (!activePlaySource) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-[var(--bg-deepest)] min-h-0 gap-[clamp(4px,2%,12px)] p-2">
        <svg className="w-[clamp(20px,8%,48px)] h-[clamp(20px,8%,48px)] text-[var(--text-disabled)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <polygon points="23 7 16 12 23 17 23 7" />
          <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
        </svg>
        <p className="text-[var(--text-secondary)] text-[clamp(10px,2.2vw,14px)] text-center leading-tight">导入视频素材开始创作</p>
        {onImportClick && (
          <button
            onClick={onImportClick}
            className="px-3 py-1.5 bg-[var(--accent)]/10 border border-[var(--accent)]/30 rounded-lg text-[var(--accent)] text-[clamp(10px,2.2vw,13px)] hover:bg-[var(--accent)]/20 transition-colors cursor-pointer outline-none shrink-0"
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
