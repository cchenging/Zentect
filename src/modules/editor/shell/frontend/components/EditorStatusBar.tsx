// Module: editor/shell/frontend/components/EditorStatusBar
// 编辑器底部全局状态栏：整条管线唯一的进度显示入口。
// 口径：overall = (已完成步骤数 + 当前步骤内部进度/100) / 5 × 100，
// 不再把单个节点各自 0→100 的原始百分比直接当整体进度（那会让状态栏逐节点回跳）。

import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { usePipelineStore } from '@renderer/store/usePipelineStore';
import { useEditorNavStore } from '@modules/editor/stores/useEditorNavStore';
import { usePipelineOrchestrator } from '../hooks/usePipelineOrchestrator';
import { STEPS } from '../../utils/pipelineConstants';

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

export const EditorStatusBar: React.FC = () => {
  const currentStep = useEditorNavStore((s) => s.currentStep);
  const stepStatuses = usePipelineStore((s) => s.stepStatuses);
  const pipelineRunning = usePipelineStore((s) => s.pipelineRunning);
  const pipelineProgress = usePipelineStore((s) => s.pipelineProgress);
  const pipelineNode = usePipelineStore((s) => s.pipelineNode);
  const pipelineError = usePipelineStore((s) => s.pipelineError);
  const resetPipeline = usePipelineStore((s) => s.resetPipeline);
  const { abortPipeline } = usePipelineOrchestrator();

  const completedSteps = stepStatuses.filter((status) => status === 'completed').length;
  const stepLabel = STEPS[currentStep - 1]?.label ?? '未知';
  const inStepProgress = Math.min(100, Math.max(0, pipelineProgress));

  const overall = pipelineRunning
    ? Math.min(100, Math.round(((completedSteps + inStepProgress / 100) / STEPS.length) * 100))
    : Math.round((completedSteps / STEPS.length) * 100);

  const narrated = pipelineRunning
    ? (ROLE_NARRATION[pipelineNode] ?? `正在执行：${pipelineNode || '准备中'}`)
    : stepStatuses[currentStep - 1] === 'completed'
      ? '本步骤已完成'
      : '就绪';

  return (
    <div className="shrink-0 border-t border-border/40 bg-bg-secondary/60">
      {/* 唯一的进度线：2px，贴着状态栏上缘，横跨左右两栏 */}
      <div className="h-[2px] w-full bg-border/30 overflow-hidden">
        <div
          className="h-full bg-accent transition-all duration-500 ease-out"
          style={{ width: `${overall}%` }}
        />
      </div>

      <div className="h-7 flex items-center gap-2.5 px-4">
        <span className="text-[11px] text-muted-foreground shrink-0">
          步骤 {currentStep}/{STEPS.length} · {stepLabel}
        </span>
        {pipelineRunning && <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse shrink-0" />}
        <span className={`text-[11px] truncate flex-1 ${pipelineRunning ? 'text-foreground/80' : 'text-muted-foreground/60'}`}>
          {narrated}
        </span>
        <span className="text-[11px] font-mono tabular-nums text-accent shrink-0 w-9 text-right">{overall}%</span>
        {pipelineRunning && (
          <button
            onClick={() => { void abortPipeline(); }}
            className="text-[11px] text-accent-rose hover:underline cursor-pointer outline-none shrink-0"
          >
            中止
          </button>
        )}
      </div>

      {pipelineError && (
        <div className="flex items-center gap-2 px-4 py-1 border-t border-accent-rose/20 bg-accent-rose/10">
          <AlertTriangle size={12} className="text-accent-rose shrink-0" />
          <span className="text-[11px] text-accent-rose flex-1 truncate">{pipelineError}</span>
          <button onClick={() => resetPipeline()} className="text-[11px] text-accent-rose hover:underline cursor-pointer outline-none">
            关闭
          </button>
        </div>
      )}
    </div>
  );
};
