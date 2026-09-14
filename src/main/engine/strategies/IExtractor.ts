// 定义所有 AI 提取器的标准输入输出接口
export interface AudioExtractResult {
    vocalsPath?: string;
    bgmPath?: string;
}

export interface TextExtractResult {
    whisperJsonPath: string | null;
}

export interface VisionExtractResult {
    roles: any[];
}

export interface IAudioExtractor {
    separateVocals(audioPath: string, outDir: string): Promise<AudioExtractResult>;
}

export interface ITextExtractor {
    transcribe(audioPath: string, outDir: string, mediaId: string, language?: string, engine?: 'paraformer' | 'faster-whisper' | 'auto'): Promise<TextExtractResult>;
}

export interface IVisionExtractor {
    scanFaces(videoPath: string, framesDir: string): Promise<VisionExtractResult>;
}