// Module: pipeline/step2-vision - Types

import type { VlmFrame } from '../../../shared/types/entities/editor';

/** Step2 输入接口 */
export interface Step2Input {
  framePaths: string[];
  asrText: string;
}

/** Step2 输出接口 */
export interface Step2Output {
  vlmFrames: VlmFrame[];
  storyLine: string;
}

/** View 组件 Props */
export interface StepVisionDescriptionProps {
  vlmFrames: VlmFrame[];
  onUpdateDescription: (index: number, description: string) => void;
  onSetEditing: (index: number, editing: boolean) => void;
  onGoToStep1?: () => void;
}
