// 定義所有 AI 提取器的標準輸入輸出介面
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
    transcribe(audioPath: string, outDir: string, mediaId: string): Promise<TextExtractResult>;
}

export interface IVisionExtractor {
    scanFaces(videoPath: string, framesDir: string): Promise<VisionExtractResult>;
}