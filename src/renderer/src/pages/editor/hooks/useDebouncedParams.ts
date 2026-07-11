import { useEffect, useRef } from 'react';
import { useEditorStore } from '../../../store/useStore';
import { useStep3Store } from '../../../../../modules/pipeline/stores/useStep3Store';
import { API } from '../../../api';

/** V1.1 R/S/T/P 参数 500ms 防抖 → 重新计算 Timeline */
export const useDebouncedParams = () => {
  const projectId = useEditorStore((s) => s.projectId);
  const pipelineParams = useStep3Store((s) => s.pipelineParams);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!projectId) return;

    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(() => {
      API.engine.updateParams(projectId, {
        R: pipelineParams.R,
        S: pipelineParams.S,
        T: pipelineParams.T,
        P: pipelineParams.P,
      });
      API.system.setSetting('pipeline.param.retainRatio', pipelineParams.R);
      API.system.setSetting('pipeline.param.silenceRatio', pipelineParams.S);
      API.system.setSetting('pipeline.param.ttsCoverage', pipelineParams.T);
      API.system.setSetting('pipeline.param.paceFactor', pipelineParams.P);
    }, 500);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [pipelineParams.R, pipelineParams.S, pipelineParams.T, pipelineParams.P, projectId]);
};
