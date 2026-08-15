// Module: pipeline/step5-match - Types

// 🔧 修复 TS2322/TS2300：MediaItem 改从 shared/types 导入，与 useProjectStore.mediaItems 类型保持一致
// 同时清理重复 re-export 导致的 TS2300 错误
import type { MediaItem } from '../../../shared/types';
import type { ScriptParagraph, VlmFrame, TtsResult, MatchResult, VideoChunk, BgmInfo } from '../../../shared/types/entities/editor';

// 🔧 修复 TS2459：re-export 给 backend/Service.ts 使用
export type { ScriptParagraph, VlmFrame, TtsResult, VideoChunk, BgmInfo } from '../../../shared/types/entities/editor';
// MatchResult 和 MediaItem 单独从各自源 re-export（避免冲突）
export type { MatchResult } from '../../../shared/types/entities/editor';
export type { MediaItem } from '../../../shared/types';

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
  /** 当前选中的 BGM（null 表示未选） */
  activeBgm: BgmInfo | null;
  /** 当前解说文案段落（用于个性化 BGM 推荐的情绪分析） */
  scriptParagraphs: ScriptParagraph[];
  /** 全局情绪基调（neutral/emotional/suspense/epic/comedy） */
  emotionTone: string;
  /** P3 多模态：步骤2 画面情绪标签（去重），参与选曲意图生成 */
  frameEmotions?: string[];
  /** P3 多模态：步骤2 镜头景别标签（去重），参与选曲意图生成 */
  shotTypes?: string[];
  /** P3 多模态：源视频总时长（毫秒），用于推算目标切点密度 */
  videoDurationMs?: number;
  /** 已分离的伴奏音频项（mediaItems type=audio 且 extractedBgm），可直接选用 */
  bgmOptions: MediaItem[];
  /** 设置/更换 BGM */
  onSetBgm: (bgm: BgmInfo) => void;
  /** 移除 BGM */
  onRemoveBgm: () => void;
  /** 弹出系统文件选择框上传本地 BGM */
  onUploadBgm: () => void;
  onConfirm: (shotId: string) => void;
  onReplace: (shotId: string, chunkItem: any) => void;
  onRematch: () => void;
  onReorder: (reordered: MatchResult[]) => void;
}
