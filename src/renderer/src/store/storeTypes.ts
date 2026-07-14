import type { MediaItem, Shot, Role } from '../../../shared/types';
import type { AsrLine } from '../../../shared/types/entities/editor';
import type { HydrationStatusType } from './constants';

/** 角色关系定义 */
export interface CharacterRelation {
  id?: string;
  sourceRoleId: string;
  targetRoleId: string;
  relationType: string;
  description?: string;
}

export type LeftTabType = 'workflow' | 'media' | 'audio' | 'text' | 'casting' | 'storyboard' | 'narration' | 'aiAssets';
export type ItemType = 'media' | 'role' | 'shot' | null;

// --- 切片定义: UI Slice ---
export interface UISlice {
  mode: 'dark' | 'light' | 'system';
  skin: string;
  scale: string;
  particleStyle: string;
  leftTab: LeftTabType;
  selectedItemId: string | null;
  selectedItemType: ItemType;
  projectRatio: string;
  videoFps: number;
  canvasZoom: number;
  isCanvasFit: boolean;
  isFullscreen: boolean;
  globalFocusMode: 'timeline' | 'media';

  activeRoleFilter: string | null;
  semanticSearchResults: Array<{shotId: string, score: number}> | null;

  setMode: (mode: 'dark' | 'light' | 'system') => void;
  cycleMode: () => void;
  hydrateUI: () => Promise<void>;
  setLeftTab: (tab: LeftTabType) => void;
  selectItem: (id: string | null, type: ItemType) => void;
  clearSelection: () => void;
  setProjectRatio: (ratio: string) => void;
  setVideoFps: (fps: number) => void;
  setCanvasZoom: (zoom: number) => void;
  setIsCanvasFit: (isFit: boolean) => void;
  setIsFullscreen: (isFull: boolean) => void;
  setGlobalFocusMode: (mode: 'timeline' | 'media') => void;

  setActiveRoleFilter: (clusterId: string | null) => void;
  setSemanticSearchResults: (results: Array<{shotId: string, score: number}> | null) => void;

  setParticleStyle: (style: string) => void;
  setSkin: (skin: string) => void;
  setScale: (scale: string) => void;
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
export interface ExtractedData {
  videoPath: string;
  vocalPath: string;
  backgroundPath: string;
  asrLines: AsrLine[];
  frameCount: number;
  /** 抽帧产出的物理文件路径数组，用于前端预览和分镜匹配 */
  framePaths: string[];
}

/**
 * @deprecated DataSlice 已迁移至 useProjectStore。
 * 保留 ExtractedData / HistorySnapshot / CharacterRelation 作为独立类型供引用。
 */
export type EditorState = UISlice & PlayerSlice & EditorSlice;

// --- 步骤状态类型 ---
export type StepStatus = 'idle' | 'running' | 'completed' | 'failed';

// --- 切片定义: Editor Slice (编辑器核心状态) ---
// 阶段五清理：仅保留 hydrationStatus 作为编辑器加载状态。
// 其他字段已全部迁移至独立 Store：
// - currentStep / isAutoMode → useEditorNavStore
// - 管线状态（stepStatuses/pipelineRunning 等）→ usePipelineStore
// - 步骤专属数据 → useStep1Store ~ useStep5Store
export interface EditorSlice {
  // 水合与项目整体加载状态
  hydrationStatus: HydrationStatusType;
  setHydrationStatus: (status: HydrationStatusType) => void;

  // === Canvas 遗留字段（待后续清理）===
  nodes: any[];
  edges: any[];
  setActiveNode: (node: any, type?: any) => void;
}
