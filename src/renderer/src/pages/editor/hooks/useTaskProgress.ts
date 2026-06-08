import { useEffect, useRef } from 'react';
import { useStore } from '../../../store/useStore';
import { IPC_CHANNELS } from '../../../../../shared/utils/IpcConstants';
import { CODE_TO_NAME } from '../utils/pipelineConstants';

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

/** 完成类 code → 子步骤 key（收到此 code 表示该子步骤已结束） */
const COMPLETION_CODES: Record<string, string> = {
  extracting_frames: 'frames',
  audio_separated: 'audio',
  parsing_text: 'whisper',
  TASK_CLUSTER_FACES: 'faces',
};

/** 子步骤的进度范围映射（全局进度 → 子步骤本地进度 0-100） */
const SUBSTEP_PROGRESS_RANGE: Record<string, [number, number]> = {
  frames: [10, 20],
  audio: [15, 35],
  whisper: [50, 60],
  faces: [70, 80],
};

/** 将全局进度转换为子步骤本地进度 */
function toLocalProgress(subStepKey: string, globalPercent: number): number {
  const range = SUBSTEP_PROGRESS_RANGE[subStepKey];
  if (!range) return globalPercent;
  const [start, end] = range;
  if (globalPercent <= start) return 0;
  if (globalPercent >= end) return 100;
  return Math.round(((globalPercent - start) / (end - start)) * 100);
}

/**
 * 任务进度监听 Hook
 * 监听 IPC 任务进度事件，更新管线进度和子步骤状态
 * 核心修复：每个子步骤独立进度 + 正确的完成判定 + 批量状态更新防止连锁重渲染
 */
export const useTaskProgress = () => {
  /** 使用 ref 去重：防止同一 code + percent 组合触发重复更新 */
  const lastProgressRef = useRef<Record<string, number>>({});

  useEffect(() => {
    /** 任务进度事件处理器：使用 setState 批量更新，避免多次独立 set 触发连锁重渲染 */
    const handler = (_event: any, payload: any) => {
      const { code, percent, status } = payload;

      if (!code) return;

      const state = useStore.getState();

      /** 去重：相同 code 且进度未变化时跳过 */
      const progressKey = `${code}:${percent}`;
      if (lastProgressRef.current[code] === percent && code !== 'TASK_SUCCESS' && code !== 'TASK_FAILED') {
        return;
      }
      lastProgressRef.current[code] = percent;

      /** 管线整体完成 → 批量标记所有子步骤完成 */
      if (code === 'TASK_SUCCESS' || status === 'completed') {
        useStore.setState({
          pipelineProgress: 100,
          pipelineNode: CODE_TO_NAME[code] || code || '',
          subStepStatuses: { frames: 'completed', audio: 'completed', whisper: 'completed', faces: 'completed' },
          subStepProgresses: { frames: 100, audio: 100, whisper: 100, faces: 100 },
        });
        return;
      }

      /** 管线失败 → 批量标记当前运行中的子步骤为失败 */
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
          useStore.setState({ subStepStatuses: newSubStepStatuses });
        }
        return;
      }

      /** 完成类 code → 标记对应子步骤为完成 */
      const completionKey = COMPLETION_CODES[code];
      if (completionKey) {
        useStore.setState({
          subStepStatuses: { ...state.subStepStatuses, [completionKey]: 'completed' },
          subStepProgresses: { ...state.subStepProgresses, [completionKey]: 100 },
        });
        return;
      }

      /** 启动/运行类 code → 批量更新进度和子步骤状态 */
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
        useStore.setState(updates);
      } else if (typeof percent === 'number') {
        /** 未知 code 但有进度 → 仅更新进度条 */
        useStore.setState({
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
