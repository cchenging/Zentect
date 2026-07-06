// Module: editor/shell - Public API

export type { EditorShellInput, EditorShellOutput, StepInfo, MediaTab } from './types';

export { TopBar } from './frontend/components/TopBar';
export { StepPanel } from './frontend/components/StepPanel';
export { PipelineStatusBar } from './frontend/components/PipelineStatusBar';
export { PropertyBar } from './frontend/components/PropertyBar';

export { useEditorHydration, useEditorAutoSave, useSyncDaemon } from './frontend/hooks/useEditorLogic';
export { useStepRunner } from './frontend/hooks/useStepRunner';
export { usePipelineOrchestrator, PipelineMode } from './frontend/hooks/usePipelineOrchestrator';
export { useResizablePanel } from './frontend/hooks/useResizablePanel';
export { usePipelineExecutor } from './frontend/hooks/usePipelineExecutor';
export { useTaskProgress } from './frontend/hooks/useTaskProgress';
export { useExtractionHandler } from './frontend/hooks/useExtractionHandler';
export { useKeyboardShortcuts } from './frontend/hooks/useKeyboardShortcuts';

export { STEPS, STEP_SEQUENCES, SCRIPT_STYLES, MEDIA_TABS, CODE_TO_NAME, PipelineNodeType, classifyNodeId } from './utils/pipelineConstants';
