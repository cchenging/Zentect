// Module: editor/shell/hooks/useStepRunner
// 原 editor/hooks/useStepRunner.ts — 已迁移

import { useCallback } from 'react';
import { useStore } from '../../../../../renderer/src/store/useStore';
import { useEditorNavStore } from '../../../stores/useEditorNavStore';
import { API } from '../../../../../renderer/src/api';
import { usePipelineOrchestrator } from './usePipelineOrchestrator';

interface StepRunnerResult {
  handleRunStep: (step: number) => Promise<void>;
  handleStart: () => Promise<void>;
  handleNextStep: () => void;
  handleAbortPipeline: () => Promise<void>;
  handleVideoImport: () => Promise<void>;
}

export const useStepRunner = (projectId: string | undefined): StepRunnerResult => {
  const currentStep = useEditorNavStore((s) => s.currentStep);
  const setCurrentStep = useEditorNavStore((s) => s.setCurrentStep);
  const addMediaItems = useStore((s) => s.addMediaItems);
  const setActivePlaySource = useStore((s) => s.setActivePlaySource);

  const { executeStep, startCurrentStep, abortPipeline } = usePipelineOrchestrator();

  const handleRunStep = useCallback(async (step: number) => {
    await executeStep(step);
  }, [executeStep]);

  const handleStart = useCallback(async () => {
    await startCurrentStep();
  }, [startCurrentStep]);

  const handleNextStep = useCallback(() => {
    if (currentStep < 5) {
      setCurrentStep(currentStep + 1);
    }
  }, [currentStep, setCurrentStep]);

  const handleAbortPipeline = useCallback(async () => {
    await abortPipeline();
  }, [abortPipeline]);

  const handleVideoImport = useCallback(async () => {
    if (!projectId) return;
    try {
      const filePaths: string[] = await API.system.openMediaDialog();
      if (filePaths && filePaths.length > 0) {
        const newItems = await API.media.import(projectId, filePaths);
        if (Array.isArray(newItems) && newItems.length > 0) {
          useStore.setState({ currentTime: 0, isPlaying: false });
          addMediaItems(newItems);
          setActivePlaySource(newItems[0]);
          useStore.setState({ selectedItemId: newItems[0].id, selectedItemType: 'media' });
        }
      }
    } catch (err: any) {
      console.error('[Editor] 视频导入失败:', err);
    }
  }, [projectId, setActivePlaySource, addMediaItems]);

  return { handleRunStep, handleStart, handleNextStep, handleAbortPipeline, handleVideoImport };
};
