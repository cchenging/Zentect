export interface IFrameExtractor {
  extractFrames(params: ExtractFramesParams): Promise<ExtractFramesResult>;
  getProgress(): number;
  abort(): void;
}

export interface ExtractFramesParams {
  mediaPath: string;
  outputDir: string;
  fps?: number;
  startTime?: number;
  endTime?: number;
}

export interface ExtractFramesResult {
  framePaths: string[];
  fps: number;
  totalFrames: number;
  duration: number;
}

export interface ITTSProvider {
  generateTTS(params: TTSParams): Promise<TTSResult>;
  getVoices(): Promise<TTSVoice[]>;
  abort(): void;
}

export interface TTSParams {
  text: string;
  voiceId?: string;
  speed?: number;
  pitch?: number;
  outputPath?: string;
}

export interface TTSResult {
  audioPath: string;
  duration: number;
  format: string;
}

export interface TTSVoice {
  id: string;
  name: string;
  language: string;
  description?: string;
}

export interface IASREngine {
  transcribe(params: ASRParams): Promise<ASRResult>;
  abort(): void;
}

export interface ASRParams {
  audioPath: string;
  language?: string;
}

export interface ASRResult {
  segments: ASRSegment[];
  fullText: string;
  language: string;
}

export interface ASRSegment {
  text: string;
  start: number;
  end: number;
  confidence: number;
}

export interface IVisionAnalyzer {
  analyze(framePath: string): Promise<VisionResult>;
  analyzeBatch(framePaths: string[]): Promise<VisionResult[]>;
}

export interface VisionResult {
  framePath: string;
  labels: string[];
  objects: { label: string; confidence: number; bbox?: number[] }[];
  description: string;
}
