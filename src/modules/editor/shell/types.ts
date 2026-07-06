// Module: editor/shell - Types

/** 编辑器外壳输入接口 */
export interface EditorShellInput {
  projectId: string;
  currentStep: number;
  isAutoMode: boolean;
}

/** 编辑器外壳输出接口 */
export interface EditorShellOutput {
  currentStep: number;
  isAutoMode: boolean;
  leftPanelWidth: number; // 百分比
}

/** 步骤定义 */
export interface StepInfo {
  key: number;
  label: string;
}

/** 素材库标签 */
export interface MediaTab {
  key: string;
  label: string;
}
