// Module: pipeline/step4-tts - Types

import type { ScriptParagraph } from '../../../shared/types/entities/editor';

/** TTS 引擎类型 */
export type TTSEngine = 'edge' | 'doubao' | 'kokoro';

/** Step4 输入接口 */
export interface Step4Input {
  scriptParagraphs: ScriptParagraph[];
  engine: TTSEngine;
  voiceId: string;
  speechRate: number;
}

/** Step4 输出接口 */
export interface Step4Output {
  results: TTSResult[];
  successCount: number;
  failedCount: number;
}

/** 单段 TTS 合成结果 */
export interface TTSResult {
  /** ✅ 身份键统一：id 为段落唯一主键（出生处全局唯一），消费端一律读 id；shotId 保留同值兼容 */
  id: string;
  shotId: string;
  audioUrl?: string;
  _failed?: boolean;
  _error?: string;
  /** 合成中标记：每段完成时由 Strategy 推送增量结果，前端用于显示"合成中"状态 */
  _synthesizing?: boolean;
}

/** 音色选项 */
export interface VoiceOption {
  id: string;
  name: string;
  lang: string;
}

/** Store 状态 */
export interface Step4State {
  ttsEngine: TTSEngine;
  ttsVoiceId: string;
  ttsProgress: number;
  ttsResults: TTSResult[];
}

/** UI 层音色选项（从 StepTTSSynthesisView 提取） */
export interface TtsVoiceOption {
  id: string;
  name: string;
  lang: string;
}
