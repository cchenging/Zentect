// Module: editor/shell/frontend/components/PipelineStatusBar
// 原 editor/components/PipelineStatusBar.tsx — 已迁移

import React from 'react';
import { usePipelineStore } from '@renderer/store/usePipelineStore';
import { AlertTriangle } from 'lucide-react';
import { Progress } from '@renderer/components/shared';
import { IPC_CHANNELS } from '@modules/infra/ipc/IpcConstants';

/**
 * 节点 → 剧组人设话术映射（产品"虚拟电影剧组"心智：让状态栏读出"各司其职"的生动感）
 * 仅做展示层文案包裹，不污染技术日志 pipelineNode 原始值；
 * 未命中(key 不在此表)时回退显示原始 pipelineNode。
 */
const ROLE_NARRATION: Record<string, string> = {
  '关键帧提取': '素材助理正在拆解原片帧画面…',
  '音频分离': '素材助理正在分离人声与配乐…',
  '人声分离': '素材助理正在分离人声与配乐…',
  'ASR 识别': '素材助理正在逐句攀写台词对白…',
  '人脸检测': '素材助理正在清点出场演员…',
  '人脸聚类': '素材助理正在为演员建档…',
  '数据组装': '素材助理正在归整素材账本…',
  '语义提取': '看片员正在逐镜审视画面内涵…',
  '语义流生成': '看片员正在记录镜头演变…',
  '初始化': '剧组正在架设设备、清点场次…',
  '完成': '本组镜头已交付，请验收成片。',
};

export const PipelineStatusBar: React.FC = () => {
  const pipelineRunning = usePipelineStore((s) => s.pipelineRunning);
  const pipelineProgress = usePipelineStore((s) => s.pipelineProgress);
  const pipelineNode = usePipelineStore((s) => s.pipelineNode);
  const pipelineError = usePipelineStore((s) => s.pipelineError);
  const resetPipeline = usePipelineStore((s) => s.resetPipeline);
  const setPipelineRunning = usePipelineStore((s) => s.setPipelineRunning);

  const handleAbort = async () => {
    try { await window.api.ipc.invoke(IPC_CHANNELS.ENGINE_ABORT_PIPELINE); } catch {}
    setPipelineRunning(false);
  };

  /** 人设话术：命中 ROLE_NARRATION 用剧词，否则回退原始节点名（守"错就错"，不吞技术态） */
  const narrated = pipelineRunning && ROLE_NARRATION[pipelineNode]
    ? ROLE_NARRATION[pipelineNode]
    : (pipelineRunning ? `剧组正在执行：${pipelineNode || '待命'}` : (pipelineNode || '待启动'));

  return (
    <>
      <div className="flex items-center gap-3 px-4 py-1.5 border-b border-border/30 shrink-0">
        <span className="text-[12px] text-muted-foreground shrink-0 truncate">{narrated}</span>
        <Progress value={pipelineProgress} color="accent" size="sm" className="flex-1" />
        <span className="text-[12px] text-accent font-medium shrink-0">{pipelineProgress}%</span>
        {pipelineRunning && (
          <button onClick={handleAbort} className="text-[12px] text-accent-rose hover:underline cursor-pointer outline-none shrink-0">
            中止
          </button>
        )}
      </div>

      {pipelineError && (
        <div className="flex items-center gap-2 px-4 py-2 bg-accent-rose/10 border-b border-accent-rose/20 shrink-0">
          <AlertTriangle size={14} className="text-accent-rose shrink-0" />
          <span className="text-[12px] text-accent-rose flex-1">{pipelineError}</span>
          <button onClick={() => resetPipeline()} className="text-[12px] text-accent-rose hover:underline cursor-pointer outline-none">
            关闭
          </button>
        </div>
      )}
    </>
  );
};
