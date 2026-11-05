// Module: editor/shell/frontend/hooks/useArtifactEvaluations
// 🎫 阶段4：订阅所有会影响产物指纹的 store 切片，计算各步骤产物的当前有效性，
// 供 StepIndicator/StepPanel 展示「已过期 / 未验证」状态（不阻断运行，仅提示）。

import { useMemo } from 'react';
import { usePipelineStore } from '@renderer/store/usePipelineStore';
import { useProjectStore } from '@modules/editor/stores/useProjectStore';
import { useStep1Store } from '@modules/pipeline/stores/useStep1Store';
import { useStep3Store } from '@modules/pipeline/stores/useStep3Store';
import { useStep4Store } from '@modules/pipeline/stores/useStep4Store';
import { useStep5Store } from '@modules/pipeline/stores/useStep5Store';
import type { ArtifactState } from '../../utils/pipelineArtifactMeta';
import { evaluateProjectArtifacts } from '../../utils/pipelineArtifactState';

export interface ArtifactEvaluationView {
  key: string;
  state: ArtifactState;
  exportBlocked: boolean;
}

export function useArtifactEvaluations(): ArtifactEvaluationView[] {
  const stepStatuses = usePipelineStore((s) => s.stepStatuses);
  const artifactMeta = usePipelineStore((s) => s.artifactMeta);
  const extractionConfig = useStep1Store((s) => s.extractionConfig);
  const asrLines = useStep1Store((s) => s.asrLines);
  const scriptStyle = useStep3Store((s) => s.scriptStyle);
  const speechRate = useStep3Store((s) => s.speechRate);
  const pipelineParams = useStep3Store((s) => s.pipelineParams);
  const ttsEngine = useStep4Store((s) => s.ttsEngine);
  const ttsVoiceId = useStep4Store((s) => s.ttsVoiceId);
  const ttsSpeechRate = useStep4Store((s) => s.speechRate);
  const activeBgm = useStep5Store((s) => s.activeBgm);
  const roles = useProjectStore((s) => s.roles);
  const mediaItems = useProjectStore((s) => s.mediaItems);

  return useMemo(
    () => evaluateProjectArtifacts().map((a) => ({
      key: a.key,
      state: a.state,
      exportBlocked: a.exportBlocked,
    })),
    // evaluateProjectArtifacts 直接读 store 快照；这里订阅全部指纹输入，保证状态变化能触发重算
    [stepStatuses, artifactMeta, extractionConfig, asrLines, scriptStyle, speechRate, pipelineParams,
      ttsEngine, ttsVoiceId, ttsSpeechRate, activeBgm, roles, mediaItems],
  );
}
