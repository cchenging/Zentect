import type { INodeParser } from './types';
import { VisionExtractParser } from './VisionExtractParser';
import { AudioSeparateParser } from './AudioSeparateParser';
import { ASRParser } from './ASRParser';
import { ScriptGenParser } from './ScriptGenParser';
import { TTSParser } from './TTSParser';
import { FaceDetectParser } from './FaceDetectParser';
import { SemanticAnalyzeParser } from './SemanticAnalyzeParser';
import { SentimentAnalyzeParser } from './SentimentAnalyzeParser';
import { LLMProcessorParser } from './LLMProcessorParser';

export const nodeParsers = new Map<string, INodeParser>([
  ['vision-extract', new VisionExtractParser()],
  ['frame-extract', new VisionExtractParser()],
  ['audio-separate', new AudioSeparateParser()],
  ['asr', new ASRParser()],
  ['script-gen', new ScriptGenParser()],
  ['tts-synthesize', new TTSParser()],
  ['face-detect', new FaceDetectParser()],
  ['semantic-analyze', new SemanticAnalyzeParser()],
  ['sentiment-analyze', new SentimentAnalyzeParser()],
  ['llm-processor', new LLMProcessorParser()],
]);

export type { INodeParser } from './types';