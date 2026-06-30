/**
 * PipelineResultAdapter - 类型安全的管线结果映射
 * 替代 mapPipelineResultToState 中的 Record<string, any> + switch-case
 */
import type {
  AsrLine, VlmFrame, ScriptParagraph, TtsResult, MatchResult
} from '../../../../shared/types/entities/editor';

// 判别联合类型：每种管线节点的结果
export type PipelineStepResult =
  | { type: 'audio_separate'; vocalsPath: string; bgmPath: string }
  | { type: 'asr'; lines: AsrLine[] }
  | { type: 'frame_extract'; framePaths: string[]; frameCount: number }
  | { type: 'vlm_analyze'; frames: VlmFrame[]; storyLine: string }
  | { type: 'script_gen'; paragraphs: ScriptParagraph[] }
  | { type: 'tts_synthesize'; results: TtsResult[] }
  | { type: 'shot_match'; results: MatchResult[] }
  | { type: 'unknown'; raw: unknown };

/** 根据 nodeId 分类结果类型 */
export function classifyNodeResult(nodeId: string, data: unknown): PipelineStepResult {
  const lower = nodeId.toLowerCase();
  if (lower.includes('audio') || lower.includes('separate')) {
    const d = data as any;
    return { type: 'audio_separate', vocalsPath: d?.vocalsPath || '', bgmPath: d?.bgmPath || '' };
  }
  if (lower.includes('asr') || lower.includes('whisper')) {
    const d = data as any;
    return { type: 'asr', lines: Array.isArray(d?.lines) ? d.lines : Array.isArray(d) ? d : [] };
  }
  if (lower.includes('frame') || lower.includes('extract')) {
    const d = data as any;
    return { type: 'frame_extract', framePaths: d?.framePaths || [], frameCount: d?.frameCount || 0 };
  }
  if (lower.includes('vision') || lower.includes('vlm')) {
    const d = data as any;
    const frames: VlmFrame[] = Array.isArray(d?.frames) ? d.frames.map((f: any) => ({
      url: typeof f === 'string' ? f : (f.path || f.url || ''),
      description: f.description || f.text || '',
      editing: false, confirmed: !!(f.description || f.text),
    })) : [];
    const storyLine = frames.map(f => f.description).filter(Boolean).join('\n\n');
    return { type: 'vlm_analyze', frames, storyLine };
  }
  if (lower.includes('script') || lower.includes('narration')) {
    const d = data as any;
    const paragraphs: ScriptParagraph[] = (d?.paragraphs || d?.shots || []).map((p: any, idx: number) => ({
      id: p.id || p.shotId || `para_${idx}`,
      shotId: p.shotId, text: p.text || p.content || p.narration || '',
      duration: p.duration, emotion: p.emotion || '', editing: false,
      audioSafeText: p.audioSafeText || '',
      cleanText: p.cleanText || '',
    }));
    return { type: 'script_gen', paragraphs };
  }
  if (lower.includes('tts')) {
    const d = data as any;
    const results: TtsResult[] = (d?.results || d || []).map((r: any, idx: number) => ({
      shotId: r.shotId || `tts_${idx}`,
      audioUrl: r.audioUrl || r.audioPath || r.path || undefined,
      _failed: r._failed || !r.audioUrl,
      _error: r._error || r.error,
    }));
    return { type: 'tts_synthesize', results };
  }
  if (lower.includes('match') || lower.includes('align') || lower.includes('semantic')) {
    const d = data as any;
    const results: MatchResult[] = (d?.results || d?.matches || d || []).map((r: any, idx: number) => ({
      shotId: r.shotId || `match_${idx}`,
      mediaId: r.mediaId || r.chunkId || '',
      thumbnail: r.thumbnail || r.coverPath,
      score: r.score || r.matchScore || 0,
      confirmed: r.confirmed || false,
      appliedSpeedFactor: r.appliedSpeedFactor,
      audioDurationMs: r.audioDurationMs,
      chunkData: r.chunkData,
    }));
    return { type: 'shot_match', results };
  }
  return { type: 'unknown', raw: data };
}

/** 将 PipelineResult (Record<string, unknown>) 映射到 Store */
export function applyPipelineResult(
  result: Record<string, unknown>,
  store: {
    setAsrLines: (lines: AsrLine[]) => void;
    setVlmFrames: (frames: VlmFrame[]) => void;
    setScriptParagraphs: (p: ScriptParagraph[]) => void;
    setTtsResults: (r: TtsResult[]) => void;
    setMatchResults: (r: MatchResult[]) => void;
    setExtractedData: (d: any) => void;
    setFrameCount: (n: number) => void;
    addMediaItems: (items: any[]) => void;
  }
): void {
  for (const [nodeId, data] of Object.entries(result)) {
    const stepResult = classifyNodeResult(nodeId, data);
    switch (stepResult.type) {
      case 'asr':
        store.setAsrLines(stepResult.lines);
        break;
      case 'vlm_analyze':
        store.setVlmFrames(stepResult.frames);
        break;
      case 'script_gen':
        store.setScriptParagraphs(stepResult.paragraphs);
        break;
      case 'tts_synthesize':
        store.setTtsResults(stepResult.results);
        break;
      case 'shot_match':
        store.setMatchResults(stepResult.results);
        break;
      case 'frame_extract':
        store.setExtractedData({ framePaths: stepResult.framePaths, frameCount: stepResult.frameCount });
        store.setFrameCount(stepResult.frameCount);
        break;
      case 'audio_separate':
      case 'unknown':
        // handled separately or skipped
        break;
    }
  }
}