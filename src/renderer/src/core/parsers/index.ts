// 📁 路径：src/renderer/src/core/parsers/index.ts
// 各管线算力节点的解析器注册中心。
// ActionParser 依据节点的 actionType 匹配对应解析器，把画布节点编译为可执行 PipelineTask。
import type { INodeParser } from './types';
import { ASRParser } from './ASRParser';
import { FaceDetectParser } from './FaceDetectParser';
import { LLMProcessorParser } from './LLMProcessorParser';
import { ScriptGenParser } from './ScriptGenParser';
import { SemanticAnalyzeParser } from './SemanticAnalyzeParser';
import { SentimentAnalyzeParser } from './SentimentAnalyzeParser';
import { TTSParser } from './TTSParser';
import { VisionExtractParser } from './VisionExtractParser';

/** actionType → 解析器实例 的映射表 */
export const nodeParsers: Map<string, INodeParser> = new Map([
  ['asr', new ASRParser()],
  ['face-detect', new FaceDetectParser()],
  ['llm-processor', new LLMProcessorParser()],
  ['script-gen', new ScriptGenParser()],
  ['semantic-analyze', new SemanticAnalyzeParser()],
  ['sentiment-analyze', new SentimentAnalyzeParser()],
  ['tts-synthesize', new TTSParser()],
  ['vision-extract', new VisionExtractParser()],
]);

export type { INodeParser, PipelineNodeRef } from './types';