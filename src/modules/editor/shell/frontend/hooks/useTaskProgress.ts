// Module: editor/shell/hooks/useTaskProgress
// 原 editor/hooks/useTaskProgress.ts — 已迁移

import { useEffect, useRef } from 'react';
import { usePipelineStore } from '@renderer/store/usePipelineStore';
import { useStep1Store } from '@modules/pipeline/stores/useStep1Store';
import { IPC_CHANNELS } from '@modules/infra/ipc/IpcConstants';
import { CODE_TO_NAME } from '../../utils/pipelineConstants';
import type { Step1SubStep } from '../../utils/pipelineArtifactMeta';
import type { StepStatus } from '../../../../../shared/types/entities/editor';

/** 启动类 code → 子步骤 key */
const CODE_TO_SUBSTEP: Record<string, string> = {
  extracting_frames: 'frames',
  TASK_EXTRACT_FRAMES: 'frames',
  separating_audio: 'audio',
  TASK_EXTRACT_AUDIO: 'audio',
  TASK_SEPARATE_AUDIO_MATRIX: 'audio',
  parsing_text: 'whisper',
  transcribing: 'whisper',
  TASK_WHISPER: 'whisper',
  indexing_vision: 'faces',
  TASK_SCAN_FACES: 'faces',
  TASK_CLUSTER_FACES: 'faces',
};

/** 完成类 code → 子步骤 key */
const COMPLETION_CODES: Record<string, string> = {
  extracting_frames: 'frames',
  audio_separated: 'audio',
  parsing_text: 'whisper',
  TASK_CLUSTER_FACES: 'faces',
};

/** 子步骤的进度范围映射 */
const SUBSTEP_PROGRESS_RANGE: Record<string, [number, number]> = {
  frames: [10, 20],
  audio: [15, 35],
  whisper: [50, 60],
  faces: [70, 80],
};

/** 步骤1 的 4 个子任务 key（cluster/semantic 属于步骤2，不参与步骤1状态推导） */
const STEP1_SUBSTEPS = ['frames', 'audio', 'whisper', 'faces'] as const;

/**
 * 根据子任务状态推导步骤1总状态（与 useExtractionHandler 保持一致）
 * - 启用子任务全 completed → 'completed'
 * - 任一启用子任务 failed → 'failed'
 * - 部分完成无失败 → 'idle'
 * - 全 idle → 'idle'
 */
function deriveStep1Status(
  subStepStatuses: Record<string, string>,
  enabledSubSteps: readonly Step1SubStep[]
): 'completed' | 'failed' | 'idle' {
  const step1Values = enabledSubSteps
    .map(k => subStepStatuses[k])
    .filter(v => v !== undefined && v !== null);
  if (step1Values.length === 0) return 'idle';
  const hasFailed = step1Values.some(v => v === 'failed');
  const allCompleted = step1Values.length === enabledSubSteps.length
    && step1Values.every(v => v === 'completed');
  if (allCompleted) return 'completed';
  if (hasFailed) return 'failed';
  return 'idle';
}

function enabledStep1SubSteps(): Step1SubStep[] {
  const config = useStep1Store.getState().extractionConfig;
  return STEP1_SUBSTEPS.filter(k => config?.[k]?.enabled !== false);
}

function toLocalProgress(subStepKey: string, globalPercent: number): number {
  const range = SUBSTEP_PROGRESS_RANGE[subStepKey];
  if (!range) return globalPercent;
  const [start, end] = range;
  if (globalPercent <= start) return 0;
  if (globalPercent >= end) return 100;
  return Math.round(((globalPercent - start) / (end - start)) * 100);
}

export const useTaskProgress = () => {
  const lastProgressRef = useRef<Record<string, number>>({});

  useEffect(() => {
    const handler = (_event: any, payload: any) => {
      const { code, percent, status, subStep, subStepProgress } = payload;
      if (!code) return;

      const state = usePipelineStore.getState();
      if (lastProgressRef.current[code] === percent && code !== 'TASK_SUCCESS' && code !== 'TASK_FAILED') {
        return;
      }
      lastProgressRef.current[code] = percent;

      // 🆕 子步骤真实进度：优先采用 payload 显式携带的 subStep/subStepProgress（由子引擎真实完成量动态计算）
      //   直接写入各子业务进度，替代固定档位换算；这是步骤1各子业务百分比的数据来源。
      if (subStep && typeof subStepProgress === 'number') {
        const failed = status === 'error' || status === 'failed';
        // 🛑 进度 100% ≠ 产物已落库：完成标记必须由抽取成功回调（finishSubStep）确认后写入。
        //   旧实现按百分比直接置 completed，会让「进度跑满但产物为空」的子步骤伪装成完成。
        const stepStatus: StepStatus = failed ? 'failed' : 'running';
        usePipelineStore.setState({
          subStepStatuses: { ...state.subStepStatuses, [subStep]: stepStatus },
          subStepProgresses: { ...state.subStepProgresses, [subStep]: subStepProgress },
          pipelineProgress: typeof percent === 'number' ? percent : state.pipelineProgress,
          pipelineNode: CODE_TO_NAME[code] || code || state.pipelineNode,
        });
        return;
      }

      if (code === 'TASK_SUCCESS' || status === 'completed') {
        usePipelineStore.setState({
          pipelineProgress: 100,
          pipelineNode: CODE_TO_NAME[code] || code || '',
        });
        return;
      }

      if (code === 'TASK_FAILED' || code === 'DB_WRITE_FAILED') {
        const newSubStepStatuses = { ...state.subStepStatuses };
        let hasChanges = false;
        Object.entries(newSubStepStatuses).forEach(([key, val]) => {
          if (val === 'running') {
            newSubStepStatuses[key] = 'failed';
            hasChanges = true;
          }
        });
        if (hasChanges) {
          /** 💥 关键修复：同步推导 step1 总状态，替代旧版只更新 subStepStatuses 的 bug
           *  旧版 bug：TASK_FAILED 时 subStepStatuses 有 failed 但 stepStatuses[0] 仍为 running/idle，
           *  导致步骤1状态与子任务状态长期不一致 */
          const derivedStep1Status = deriveStep1Status(
            newSubStepStatuses,
            enabledStep1SubSteps()
          );
          const newStepStatuses = [...state.stepStatuses];
          newStepStatuses[0] = derivedStep1Status;
          const newStepCompleted = [...state.stepCompleted];
          newStepCompleted[0] = derivedStep1Status === 'completed';
          usePipelineStore.setState({
            subStepStatuses: newSubStepStatuses,
            stepStatuses: newStepStatuses,
            stepCompleted: newStepCompleted,
          });
        }
        return;
      }

      const completionKey = COMPLETION_CODES[code];
      if (completionKey) {
        usePipelineStore.setState({
          subStepStatuses: { ...state.subStepStatuses, [completionKey]: 'completed' },
          subStepProgresses: { ...state.subStepProgresses, [completionKey]: 100 },
        });
        return;
      }

      const subStepKey = CODE_TO_SUBSTEP[code];
      if (subStepKey) {
        const updates: Record<string, any> = {
          subStepStatuses: { ...state.subStepStatuses, [subStepKey]: 'running' },
        };
        if (typeof percent === 'number') {
          updates.pipelineProgress = percent;
          updates.pipelineNode = CODE_TO_NAME[code] || code || '';
          updates.subStepProgresses = {
            ...state.subStepProgresses,
            [subStepKey]: toLocalProgress(subStepKey, percent),
          };
        }
        usePipelineStore.setState(updates);
      } else if (typeof percent === 'number') {
        usePipelineStore.setState({
          pipelineProgress: percent,
          pipelineNode: CODE_TO_NAME[code] || code || '',
        });
      }
    };

    window.api.ipc.on(IPC_CHANNELS.EVENT_TASK_PROGRESS, handler);

    return () => {
      try {
        if (typeof window.api?.ipc?.removeListener === 'function') {
          window.api.ipc.removeListener(IPC_CHANNELS.EVENT_TASK_PROGRESS, handler);
        }
      } catch {}
    };
  }, []);
};
