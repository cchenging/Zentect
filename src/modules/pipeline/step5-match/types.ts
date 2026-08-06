// Module: pipeline/step5-match - Types

// 🔧 修复 TS2322/TS2300：MediaItem 改从 shared/types 导入，与 useProjectStore.mediaItems 类型保持一致
// 同时清理重复 re-export 导致的 TS2300 错误
import type { MediaItem } from '../../../shared/types';
import type { ScriptParagraph, VlmFrame, TtsResult, MatchResult, VideoChunk } from '../../../shared/types/entities/editor';

// 🔧 修复 TS2459：re-export 给 backend/Service.ts 使用
export type { ScriptParagraph, VlmFrame, TtsResult, VideoChunk } from '../../../shared/types/entities/editor';
// MatchResult 和 MediaItem 单独从各自源 re-export（避免冲突）
export type { MatchResult } from '../../../shared/types/entities/editor';
export type { MediaItem } from '../../../shared/types';

/** BGM 信息 */
export interface BgmInfo {
  id: string;
  filePath: string;
}

/** Step5 输入接口 */
export interface Step5Input {
  scriptParagraphs: ScriptParagraph[];
  vlmFrames: VlmFrame[];
  ttsResults: TtsResult[];
  activeBgm: BgmInfo | null;
}

/** Step5 输出接口 */
export interface Step5Output {
  matchResults: MatchResult[];
}

/** View Props 接口（Container → View） */
export interface StepShotMatchingProps {
  matchResults: MatchResult[];
  videoChunks: VideoChunk[];
  mediaItems: MediaItem[];
  /** 步骤4 配音结果（shotId → audioUrl），用于预览弹窗同步播放配音音频 */
  ttsResults: TtsResult[];
  hasBgm: boolean;
  isProcessing: boolean;
  onConfirm: (shotId: string) => void;
  onReplace: (shotId: string, chunkItem: any) => void;
  onRematch: () => void;
  onReorder: (reordered: MatchResult[]) => void;
}
