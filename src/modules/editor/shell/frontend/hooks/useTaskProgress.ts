// Module: editor/shell/hooks/useTaskProgress
// 原 editor/hooks/useTaskProgress.ts — 已迁移

import { useEffect, useRef } from 'react';
import { usePipelineStore } from '@renderer/store/usePipelineStore';
import { IPC_CHANNELS } from '@modules/infra/ipc/IpcConstants';
import { CODE_TO_NAME } from '../../utils/pipelineConstants';

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
 * - 全 completed → 'completed'
 * - 任一 failed → 'failed'
 * - 部分完成无失败 → 'idle'
 * - 全 idle → 'idle'
 */
function deriveStep1Status(subStepStatuses: Record<string, string>): 'completed' | 'failed' | 'idle' {
  const step1Values = STEP1_SUBSTEPS
    .map(k => subStepStatuses[k])
    .filter(v => v !== undefined && v !== null);
  if (step1Values.length === 0) return 'idle';
  const hasFailed = step1Values.some(v => v === 'failed');
  const allCompleted = step1Values.length === STEP1_SUBSTEPS.length
    && step1Values.every(v => v === 'completed');
  if (allCompleted) return 'completed';
  if (hasFailed) return 'failed';
  return 'idle';
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
      const { code, percent, status } = payload;
      if (!code) return;

      const state = usePipelineStore.getState();
      if (lastProgressRef.current[code] === percent && code !== 'TASK_SUCCESS' && code !== 'TASK_FAILED') {
        return;
      }
      lastProgressRef.current[code] = percent;

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
          const derivedStep1Status = deriveStep1Status(newSubStepStatuses);
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
