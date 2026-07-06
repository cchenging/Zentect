// Module: pipeline/step3-script - Types

import type { VlmFrame } from '../../../shared/types/entities/editor';

// Re-export shared types
export type { ScriptParagraph, PipelineParams } from '../../../shared/types/entities/editor';

/** Step3 输入接口 */
export interface Step3Input {
  vlmFrames: VlmFrame[];
  scriptStyle: string;
  speechRate: number;
  pipelineParams: PipelineParams;
}

/** Step3 输出接口 */
export interface Step3Output {
  scriptParagraphs: ScriptParagraph[];
}

/** View Props 接口（Container → View） */
export interface StepScriptGenerationProps {
  scriptParagraphs: ScriptParagraph[];
  scriptStyle: string;
  speechRate: number;
  pipelineParams: PipelineParams;
  vlmFrames: VlmFrame[];
  isGenerating: boolean;
  onSetScriptStyle: (style: string) => void;
  onSetSpeechRate: (rate: number) => void;
  onSetPipelineParams: (params: PipelineParams) => void;
  onUpdateParagraph: (id: string, text: string) => void;
  onUpdateParagraphEmotion: (id: string, emotion: string) => void;
  onSetScriptParagraphs: (paragraphs: ScriptParagraph[]) => void;
  onRegenerate: () => void;
  onMatchVision: (paragraphId: string) => void;
}