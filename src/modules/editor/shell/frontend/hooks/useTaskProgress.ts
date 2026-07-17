// Module: editor/shell/hooks/useTaskProgress
// 原 editor/hooks/useTaskProgress.ts — 已迁移

import { useEffect, useRef } from 'react';
import { usePipelineStore } from '../../../../../renderer/src/store/usePipelineStore';
import { useStep1Store } from '../../../../pipeline/stores/useStep1Store';
import { IPC_CHANNELS } from '../../../../infra/ipc/IpcConstants';
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
      const progressKey = `${code}:${percent}`;
      if (lastProgressRef.current[code] === percent && code !== 'TASK_SUCCESS' && code !== 'TASK_FAILED') {
        return;
      }
      lastProgressRef.current[code] = percent;

      if (code === 'TASK_SUCCESS' || status === 'completed') {
        const completedStatuses = { frames: 'completed' as const, audio: 'completed' as const, whisper: 'completed' as const, faces: 'completed' as const };
        const completedProgresses = { frames: 100, audio: 100, whisper: 100, faces: 100 };
        usePipelineStore.setState({
          pipelineProgress: 100,
          pipelineNode: CODE_TO_NAME[code] || code || '',
          subStepStatuses: completedStatuses,
          subStepProgresses: completedProgresses,
        });
        // 💥 修复：同步写入 useStep1Store，确保右侧面板子步骤状态与 PipelineStore 一致
        const s1 = useStep1Store.getState();
        for (const [key, status] of Object.entries(completedStatuses)) {
          s1.setSubStepStatus(key, status);
        }
        for (const [key, progress] of Object.entries(completedProgresses)) {
          s1.setSubStepProgress(key, progress);
        }
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
          usePipelineStore.setState({ subStepStatuses: newSubStepStatuses });
          // 💥 修复：同步写入 useStep1Store
          const s1 = useStep1Store.getState();
          for (const [key, status] of Object.entries(newSubStepStatuses)) {
            if (status === 'failed') s1.setSubStepStatus(key, status);
          }
        }
        return;
      }

      const completionKey = COMPLETION_CODES[code];
      if (completionKey) {
        usePipelineStore.setState({
          subStepStatuses: { ...state.subStepStatuses, [completionKey]: 'completed' },
          subStepProgresses: { ...state.subStepProgresses, [completionKey]: 100 },
        });
        // 💥 修复：同步写入 useStep1Store
        useStep1Store.getState().setSubStepStatus(completionKey, 'completed');
        useStep1Store.getState().setSubStepProgress(completionKey, 100);
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
        // 💥 修复：同步写入 useStep1Store
        const s1Store = useStep1Store.getState();
        if (updates.subStepStatuses?.[subStepKey]) {
          s1Store.setSubStepStatus(subStepKey, updates.subStepStatuses[subStepKey]);
        }
        if (updates.subStepProgresses?.[subStepKey] !== undefined) {
          s1Store.setSubStepProgress(subStepKey, updates.subStepProgresses[subStepKey]);
        }
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
