import { useCallback } from 'react';
import { useStore } from '../../../store/useStore';
import { API } from '../../../api';
import { usePipelineOrchestrator } from './usePipelineOrchestrator';

/** 步骤执行 Hook 的返回值 */
interface StepRunnerResult {
  handleRunStep: (step: number) => Promise<void>;
  handleStart: () => Promise<void>;
  handleNextStep: () => void;
  handleAbortPipeline: () => Promise<void>;
  handleVideoImport: () => Promise<void>;
}

/**
 * 步骤执行 Hook
 * 委托给统一管线编排器，管理步骤导航和视频导入
 */
export const useStepRunner = (projectId: string | undefined): StepRunnerResult => {
  const currentStep = useStore((s) => s.currentStep);
  const setCurrentStep = useStore((s) => s.setCurrentStep);
  const addMediaItems = useStore((s) => s.addMediaItems);
  const setActivePlaySource = useStore((s) => s.setActivePlaySource);

  const { executeStep, startCurrentStep, abortPipeline } = usePipelineOrchestrator();

  /** 执行指定步骤（委托给编排器） */
  const handleRunStep = useCallback(async (step: number) => {
    await executeStep(step);
  }, [executeStep]);

  /** 启动当前步骤（委托给编排器） */
  const handleStart = useCallback(async () => {
    await startCurrentStep();
  }, [startCurrentStep]);

  /** 下一步（手动模式：确认当前步骤结果，推进到下一步） */
  const handleNextStep = useCallback(() => {
    if (currentStep < 5) {
      setCurrentStep(currentStep + 1);
    }
  }, [currentStep, setCurrentStep]);

  /** 中止管线（委托给编排器） */
  const handleAbortPipeline = useCallback(async () => {
    await abortPipeline();
  }, [abortPipeline]);

  /** 视频导入：通过系统文件对话框选择视频文件并导入到项目 */
  const handleVideoImport = useCallback(async () => {
    if (!projectId) return;
    try {
      const filePaths: string[] = await API.system.openMediaDialog();
      if (filePaths && filePaths.length > 0) {
        const newItems = await API.media.import(projectId, filePaths);
        if (Array.isArray(newItems) && newItems.length > 0) {
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
