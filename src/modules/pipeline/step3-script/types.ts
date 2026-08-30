// Module: pipeline/step3-script - Types

// 🔧 修复 TS2304：re-export 不会引入当前作用域，需要同步 import type 才能在 interface 中使用
import type { VlmFrame, ScriptParagraph, PipelineParams } from '../../../shared/types/entities/editor';
// 章粒度流式元数据（与 useStep3Store 同源类型，供 View 渲染"正在推演第k/N章"）
import type { Step3StreamMeta } from '../stores/useStep3Store';

// Re-export shared types
export type { ScriptParagraph, PipelineParams } from '../../../shared/types/entities/editor';

/**
 * 🎭 step1 识别出的人物角色项（与 ScriptGenStrategy.roles 保持结构对齐）
 * 用于注入 step3 prompt，让 LLM 生成解说词时使用统一人物名称
 */
export interface Step3Role {
  id: string;
  name: string;
  /** 代表性人脸特征（含 gender/age 等），用于补充人物属性描述 */
  representative?: any;
  /** 已合并的子角色列表（可选） */
  mergedRoles?: any[];
}

/** Step3 输入接口 */
export interface Step3Input {
  vlmFrames: VlmFrame[];
  scriptStyle: string;
  speechRate: number;
  pipelineParams: PipelineParams;
  /**
   * 🎭 P0 同步：step1 识别出的人物角色列表，注入到 step3 prompt 中
   * 让 LLM 生成解说词时使用统一人物名称，避免"男子/女子"等模糊代称
   * 与主引擎 ScriptGenStrategy.ts 的 roles 字段保持一致
   */
  roles?: Step3Role[];
}

/** Step3 输出接口 */
export interface Step3Output {
  scriptParagraphs: ScriptParagraph[];
}

/** View Props 接口（Container → View） */
export interface StepScriptGenerationProps {
  scriptParagraphs: ScriptParagraph[];
  speechRate: number;
  pipelineParams: PipelineParams;
  vlmFrames: VlmFrame[];
  isGenerating: boolean;
  /** 章粒度流式元数据：生成中展示"正在推演第k/N章"与章节进度条（§五 5.3-C） */
  streamMeta: Step3StreamMeta | null;
  onSetSpeechRate: (rate: number) => void;
  onSetPipelineParams: (params: PipelineParams) => void;
  onUpdateParagraph: (id: string, text: string) => void;
  onUpdateParagraphEmotion: (id: string, emotion: string) => void;
  onSetScriptParagraphs: (paragraphs: ScriptParagraph[]) => void;
  onRegenerate: () => void;
  onMatchVision: (paragraphId: string) => void;
}