import type { MediaItem, Shot, Role } from '../../../shared/types';
import type { AsrLine, VlmFrame, ScriptParagraph, TtsResult, MatchResult } from '../../../shared/types/entities/editor';
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
  theme: 'dark' | 'light';
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

  toggleTheme: () => void;
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
  canvasData: any;

  /** 💥 合并后的单职责核心资产区：完全承载音轨路径与 ASR 文本流契约 */
  extractedData: ExtractedData;

  pastSnapshots: HistorySnapshot[];
  futureSnapshots: HistorySnapshot[];
  saveSnapshot: () => void;
  undo: () => void;
  redo: () => void;

  setProjectMeta: (id: string, name: string) => void;
  resetProjectState: () => void;
  hydrateProjectData: (data: Partial<EditorState>) => void;
  setStoryboardMode: (mode: 'original' | 'ai') => void;

  /** 💥 单职责 Action：更新音轨或 ASR 增量数据，并自动触发防抖落盘 */
  setExtractedData: (data: Partial<ExtractedData>) => void;

  addMediaItem: (item: MediaItem) => void;
  addMediaItems: (items: MediaItem[]) => void;
  setMediaItems: (items: MediaItem[]) => void;
  updateMediaItem: (id: string, updates: Partial<MediaItem>) => void;
  removeMediaItem: (id: string) => void;

  updateShot: (id: string, updates: Partial<Shot>) => void;
  removeShot: (id: string) => void;
  addBlankShot: () => void;
  moveShotByIndex: (fromIndex: number, toIndex: number) => void;
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

  importNodeMedia: (nodeId?: string) => Promise<void>;
}

export type EditorState = UISlice & PlayerSlice & DataSlice & EditorSlice;

// --- 步骤状态类型 ---
export type StepStatus = 'idle' | 'running' | 'completed' | 'failed';

// --- 切片定义: Editor Slice (编辑器核心状态) ---
// 阶段四清理：已迁移至各独立 Store（useStep1Store~useStep5Store + usePipelineStore + useEditorNavStore）
// 仅保留 hydrationStatus 作为编辑器加载状态
export interface EditorSlice {
  // 水合与项目整体加载状态
  hydrationStatus: HydrationStatusType;
  setHydrationStatus: (status: HydrationStatusType) => void;
}
