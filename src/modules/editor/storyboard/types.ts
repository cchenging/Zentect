// Module: editor/storyboard - Types
// UI/UX 规格见 pipeline/step5-match 模块规格 (§3.3.6)

import type { MatchResult } from '../../../shared/types/entities/editor';

/** 故事板输入接口 */
export interface StoryboardInput {
  matchResults: MatchResult[];
  projectId: string;
}

/** 故事板输出接口 */
export interface StoryboardOutput {
  confirmedCount: number;
  totalCount: number;
}

/** 镜头卡片 Props */
export interface ShotCardProps {
  shot: MatchResult;
  index: number;
  isSelected: boolean;
  onSelect: (shotId: string) => void;
  onConfirm: (shotId: string) => void;
  onReplace: (shotId: string) => void;
}
