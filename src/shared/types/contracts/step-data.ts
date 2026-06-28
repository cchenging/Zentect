/**
 * 步骤间数据传递契约
 * 定义每一步的输出类型 = 下一步的输入类型
 */

import type { AsrLine, VlmFrame, ScriptParagraph, TtsResult, MatchResult, PipelineParams, Role } from '../entities/editor';

// ── 步骤1 → 步骤2 ──
export interface ExtractionOutput {
  asrLines: AsrLine[];
  framePaths: string[];
  frameCount: number;
  audioSeparated: boolean;
  roles: Role[];
}
export type VisionInput = ExtractionOutput;

// ── 步骤2 → 步骤3 ──
export interface VisionOutput {
  vlmFrames: VlmFrame[];
  storyLine: string;
}

export interface ScriptGenInput {
  vlmFrames: VlmFrame[];
  storyLine: string;
  scriptStyle: string;
  speechRate: number;
  pipelineParams: PipelineParams;
}

// ── 步骤3 → 步骤4 ──
export interface ScriptGenOutput {
  scriptParagraphs: ScriptParagraph[];
}

export interface TtsInput {
  scriptParagraphs: ScriptParagraph[];
  ttsEngine: string;
  voiceId: string;
}

// ── 步骤4 → 步骤5 ──
export interface TtsOutput {
  ttsResults: TtsResult[];
}

export interface MatchingInput {
  scriptParagraphs: ScriptParagraph[];
  vlmFrames: VlmFrame[];
  ttsResults: TtsResult[];
  activeBgm: { id: string; filePath: string } | null;
}

// ── 步骤5 最终输出 ──
export interface MatchingOutput {
  matchResults: MatchResult[];
}