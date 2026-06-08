import { usePipelineOrchestrator } from '../../hooks/usePipelineOrchestrator';

/** 管线操作 Hook（TopBar 使用）- 委托给统一管线编排器 */
export function usePipelineActions() {
  const { executeWithContext, abortPipeline, resetAll } = usePipelineOrchestrator();

  return {
    handleExecutePipeline: executeWithContext,
    handleStopOrReset: async () => {
      await abortPipeline();
      resetAll();
    }
  };
}
