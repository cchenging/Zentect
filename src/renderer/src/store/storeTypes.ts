// 💥 Phase 2.2: 统一引用 shared 类型定义
import type { Node, Edge, NodeChange, EdgeChange } from '@xyflow/react';
import type { MediaItem, Shot, Role } from '../../../shared/types';
import type { NodeStatusType, HydrationStatusType } from './constants';
import { NODE_TYPES } from './constants';

export type LeftTabType = 'workflow' | 'media' | 'audio' | 'text' | 'casting' | 'storyboard' | 'narration' | 'aiAssets';
export type ItemType = 'media' | 'role' | 'shot' | null;

export interface CharacterRelation {
  id: string;
  roleA: string;
  roleB: string;
  relationType: string;
  description: string;
}

// --- 切片定义: UI Slice ---
export interface UISlice {
  theme: 'dark' | 'light';
  leftTab: LeftTabType;
  selectedItemId: string | null;
  selectedItemType: ItemType;
  projectRatio: string;
  canvasZoom: number;
  isCanvasFit: boolean;
  isFullscreen: boolean;
  globalFocusMode: 'timeline' | 'media';

  activeRoleFilter: string | null;
  semanticSearchResults: Array<{shotId: string, score: number}> | null;

  toggleTheme: () => void;
  setLeftTab: (tab: LeftTabType) => void;
  selectItem: (id: string | null, type: ItemType) => void;
  clearSelection: () => void;
  setProjectRatio: (ratio: string) => void;
  setCanvasZoom: (zoom: number) => void;
  setIsCanvasFit: (isFit: boolean) => void;
  setIsFullscreen: (isFull: boolean) => void;
  setGlobalFocusMode: (mode: 'timeline' | 'media') => void;

  setActiveRoleFilter: (clusterId: string | null) => void;
  setSemanticSearchResults: (results: Array<{shotId: string, score: number}> | null) => void;
}

// --- 切片定义: Player Slice (高频状态区) ---
export interface PlayerSlice {
  activePlaySource: MediaItem | null;
  isPlaying: boolean;
  currentTime: number;
  videoDuration: number;
  duration: number;
  manualSeekTime: number | null;
  activeScript: string | null;
  activeShots: any[] | null;

  scale: number;
  scrollX: number;
  gpuAcceleration: boolean;

  setActivePlaySource: (item: MediaItem | null) => void;
  setIsPlaying: (playing: boolean) => void;
  setCurrentTime: (time: number) => void;
  setVideoDuration: (duration: number) => void;
  setManualSeekTime: (time: number | null) => void;
  setActiveScript: (content: string | null) => void;
  setActiveShots: (shots: any[] | null) => void;

  play: () => void;
  pause: () => void;
  seek: (time: number) => void;
  setDuration: (duration: number) => void;
  setScale: (scale: number) => void;
  setGpuAcceleration: (enable: boolean) => void;
  setScrollX: (scrollX: number) => void;
}

export interface HistorySnapshot {
  shots: Shot[];
  aiShots: Shot[];
}

// --- 切片定义: Data Slice ---
export interface DataSlice {
  projectId: string | null;
  projectPath: string | null;
  projectName: string;
  mediaItems: MediaItem[];
  roles: Role[];
  shots: Shot[];
  aiShots: Shot[];
  characterRelations: CharacterRelation[];
  storyboardMode: 'original' | 'ai';

  pastSnapshots: HistorySnapshot[];
  futureSnapshots: HistorySnapshot[];
  saveSnapshot: () => void;
  undo: () => void;
  redo: () => void;

  setProjectMeta: (id: string, name: string) => void;
  resetProjectState: () => void;
  hydrateProjectData: (data: Partial<EditorState>) => void;
  setStoryboardMode: (mode: 'original' | 'ai') => void;

  addMediaItem: (item: MediaItem) => void;
  addMediaItems: (items: MediaItem[]) => void;
  setMediaItems: (items: MediaItem[]) => void;
  updateMediaItem: (id: string, updates: Partial<MediaItem>) => void;
  removeMediaItem: (id: string) => void;

  updateShot: (id: string, updates: Partial<Shot>) => void;
  removeShot: (id: string) => void;
  setAiShots: (shots: Shot[]) => void;
  updateAiShot: (id: string, updates: Partial<Shot>) => void;
  insertOriginalShot: (shot: Shot) => void;

  updateRole: (id: string, updates: Partial<Role>) => void;
  mergeRoles: (sourceRoleId: string, targetRoleId: string) => void;
  unmergeRole: (sourceRoleId: string, targetRoleId: string) => void;

  applyAudioDomino: (shotId: string, audioPath: string, audioDuration: number, strategy: 'slow' | 'freeze' | 'cut', target?: 'shots' | 'aiShots') => void;
  reorderShot: (id: string, droppedTimeX: number) => void;
  addShotFromMedia: (media: any, droppedTimeX: number) => void;
  splitShot: (splitTime: number) => void;

  addExtractedAssets: (newShots: any[], newRoles: any[]) => void;
  replaceExtractedAssets: (mediaId: string, newShots: any[], newRoles: any[]) => void;

  importNodeMedia: (nodeId: string) => Promise<void>;
}

// --- 节点强类型定义 (接入字典) ---
export interface SourceNodeData {
  [key: string]: unknown;
  mediaId?: string;
  status?: NodeStatusType;
  label?: string;
  progress?: number;
}

export interface ProcessNodeData extends Record<string, unknown> {
  label: string;
  icon: string;
  status: NodeStatusType;
  accent: string;
  metaLabel?: string;
  progress?: number;
  results?: any[];
  content?: string;
}

export type FlowNode =
  | Node<SourceNodeData, typeof NODE_TYPES.SOURCE>
  | Node<ProcessNodeData, typeof NODE_TYPES.PROCESS>
  | Node<any, typeof NODE_TYPES.VECTOR>
  | Node<any, typeof NODE_TYPES.SCRIPT>
  | Node<any, typeof NODE_TYPES.PLAYER>;

export type FlowEdge = Edge<any>;

// --- 切片定义: Canvas Slice (画布核心) ---
export interface CanvasSlice {
  nodes: FlowNode[];
  edges: FlowEdge[];
  hydrationStatus: HydrationStatusType;
  activeWorkflowId: string | null;
  isWorkflowLoading: boolean;
  activeNode: { id: string; type: string } | null;

  setNodes: (nodes: FlowNode[] | ((prev: FlowNode[]) => FlowNode[])) => void;
  setEdges: (edges: FlowEdge[] | ((prev: FlowEdge[]) => FlowEdge[])) => void;
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  updateNodeData: (nodeId: string, data: Partial<FlowNode['data']>) => void;
  updateNodeStatus: (nodeId: string, status: NodeStatusType, progress?: number, results?: any) => void; // 💥 正式纳入类型契约
  setActiveNode: (id: string | null, type: string | null) => void;
  addNode: (node: FlowNode) => void;
  removeNode: (nodeId: string) => void;
  duplicateNode: (nodeId: string) => void;
  resetCanvas: () => void;
  setHydrationStatus: (status: HydrationStatusType) => void;
  switchWorkflow: (targetId: string, initialNodes?: FlowNode[], initialEdges?: FlowEdge[]) => Promise<void>;
}

export type EditorState = UISlice & PlayerSlice & DataSlice & CanvasSlice & EditorSlice;

// --- 切片定义: Editor Slice (编辑器核心状态) ---
export interface EditorSlice {
  // 步骤状态
  currentStep: number;
  isAutoMode: boolean;
  stepCompleted: boolean[];

  // 管线执行状态
  pipelineRunning: boolean;
  pipelineProgress: number;
  pipelineNode: string;
  pipelineError: string | null;
  pipelineNodes: any[];

  // 步骤1: 素材分析
  asrLines: any[];
  frameCount: number;
  audioSeparated: boolean;

  // 步骤2: 画面描述
  vlmFrames: any[];

  // 步骤3: 解说文案
  scriptParagraphs: any[];
  scriptStyle: string;
  pipelineParams: { R: number; S: number; T: number; P: number };

  // 步骤4: 配音合成
  ttsEngine: string;
  ttsProgress: number;
  ttsResults: any[];

  // 步骤5: 镜头匹配
  matchResults: any[];

  // 步骤操作
  setCurrentStep: (step: number) => void;
  setIsAutoMode: (auto: boolean) => void;
  setStepCompleted: (step: number, completed: boolean) => void;

  // 管线操作
  setPipelineRunning: (running: boolean) => void;
  setPipelineProgress: (progress: number, node?: string) => void;
  setPipelineError: (error: string | null) => void;
  resetPipeline: () => void;

  // ASR操作
  setAsrLines: (lines: any[]) => void;
  updateAsrLine: (index: number, text: string) => void;
  setFrameCount: (count: number) => void;
  setAudioSeparated: (separated: boolean) => void;

  // VLM操作
  setVlmFrames: (frames: any[]) => void;
  updateVlmDescription: (index: number, description: string) => void;
  setVlmEditing: (index: number, editing: boolean) => void;

  // 文案操作
  setScriptParagraphs: (paragraphs: any[]) => void;
  updateScriptParagraph: (id: string, text: string) => void;
  setScriptStyle: (style: string) => void;
  setPipelineParams: (params: { R: number; S: number; T: number; P: number }) => void;

  // TTS操作
  setTtsEngine: (engine: string) => void;
  setTtsProgress: (progress: number) => void;
  setTtsResults: (results: any[]) => void;

  // 匹配操作
  setMatchResults: (results: any[]) => void;
  confirmMatch: (shotId: string) => void;
  replaceMatch: (shotId: string, newMediaId: string) => void;
}
