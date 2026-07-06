// Module: pipeline/step5-match - Types

import type { ScriptParagraph, VlmFrame, TtsResult, MatchResult, MediaItem, VideoChunk } from '../../../shared/types/entities/editor';

// Re-export shared types
export type { MatchResult } from '../../../shared/types/entities/editor';

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
  hasBgm: boolean;
  isProcessing: boolean;
  onConfirm: (shotId: string) => void;
  onReplace: (shotId: string, chunkItem: any) => void;
  onRematch: () => void;
  onReorder: (reordered: MatchResult[]) => void;
}
