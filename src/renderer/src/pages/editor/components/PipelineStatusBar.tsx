/**
 * @deprecated 已迁移至 src/modules/editor/shell/frontend/components/PipelineStatusBar.tsx
 * 请使用 import { PipelineStatusBar } from '@/modules/editor/shell'
 */

import React from 'react';
import { usePipelineStore } from '../../../store/usePipelineStore';
import { AlertTriangle } from 'lucide-react';
import { Progress } from '../../../components/shared';
import { IPC_CHANNELS } from '../../../../../shared/utils/IpcConstants';

/** 管线状态栏 - 展示管线进度、错误提示和中止按钮 */
export const PipelineStatusBar: React.FC = () => {
  const pipelineRunning = usePipelineStore((s) => s.pipelineRunning);
  const pipelineProgress = usePipelineStore((s) => s.pipelineProgress);
  const pipelineNode = usePipelineStore((s) => s.pipelineNode);
  const pipelineError = usePipelineStore((s) => s.pipelineError);
  const resetPipeline = usePipelineStore((s) => s.resetPipeline);
  const setPipelineRunning = usePipelineStore((s) => s.setPipelineRunning);

  /** 中止管线执行，使用 IPC 常量而非硬编码字符串 */
  const handleAbort = async () => {
    try { await window.api.ipc.invoke(IPC_CHANNELS.ENGINE_ABORT_PIPELINE); } catch {}
    setPipelineRunning(false);
  };

  return (
    <>
      {/* 管线进度条 */}
      <div className="flex items-center gap-3 px-4 py-1.5 border-b border-border/30 shrink-0">
        <span className="text-[11px] text-muted-foreground shrink-0">当前: {pipelineNode || '待启动'}</span>
        <Progress value={pipelineProgress} color="accent" size="sm" className="flex-1" />
        <span className="text-[11px] text-accent font-medium shrink-0">{pipelineProgress}%</span>
        {pipelineRunning && (
          <button onClick={handleAbort} className="text-[11px] text-accent-rose hover:underline cursor-pointer outline-none shrink-0">
            中止
          </button>
        )}
      </div>

      {/* 管线错误提示 */}
      {pipelineError && (
        <div className="flex items-center gap-2 px-4 py-2 bg-accent-rose/10 border-b border-accent-rose/20 shrink-0">
          <AlertTriangle size={14} className="text-accent-rose shrink-0" />
          <span className="text-[11px] text-accent-rose flex-1">{pipelineError}</span>
          <button onClick={() => resetPipeline()} className="text-[11px] text-accent-rose hover:underline cursor-pointer outline-none">
            关闭
          </button>
        </div>
      )}
    </>
  );
};
