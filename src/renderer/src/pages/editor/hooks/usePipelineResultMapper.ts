import { useStore } from '../../../store/useStore';
import { classifyNodeId, PipelineNodeType } from '../utils/pipelineConstants';

/**
 * 将管线执行结果映射到编辑器各步骤状态
 * @param result 管线执行返回的结果对象（按 nodeId 索引）
 */
export const mapPipelineResultToState = (result: Record<string, any>, store: any) => {
  if (!result || typeof result !== 'object') return;

  for (const [nodeId, nodeResult] of Object.entries(result)) {
    if (!nodeResult || typeof nodeResult !== 'object') continue;

    const nodeType = classifyNodeId(nodeId);

    switch (nodeType) {
      case PipelineNodeType.AUDIO_SEPARATE:
        store.setAudioSeparated(true);
        break;

      case PipelineNodeType.ASR:
        if (nodeResult.lines) {
          store.setAsrLines(nodeResult.lines.map((l: any) => ({
            start: l.start || l.begin || '00:00',
            text: l.text || l.content || '',
            editing: false
          })));
        }
        break;

      case PipelineNodeType.FRAME_EXTRACT:
        if (nodeResult.framesCount) store.setFrameCount(nodeResult.framesCount);
        if (nodeResult.framePaths) store.setFrameCount(nodeResult.framePaths.length);
        /** 将帧路径数组持久化到 store，修复"抽得到图片但前端看不见" */
        if (nodeResult.framePaths && Array.isArray(nodeResult.framePaths)) {
          store.setExtractedData?.({ framePaths: nodeResult.framePaths, frameCount: nodeResult.framePaths.length });
        } else if (nodeResult.frames && Array.isArray(nodeResult.frames)) {
          store.setExtractedData?.({ framePaths: nodeResult.frames, frameCount: nodeResult.frames.length });
        }
        break;

      case PipelineNodeType.VISION: {
        /** 💥 统一 VLM 数据映射：兼容两种后端返回格式
         *  格式1（对象数组）: frames = [{ url, description, ... }]
         *  格式2（VisionExtractStrategy）: { sceneDescriptions: string, framePaths: string[] }
         *  关键修复：framePaths 是绝对路径，需通过 getSafeMediaUrl 转换为可显示的 URL */
        const frames = nodeResult.frames || nodeResult.frameDescriptions || [];
        if (Array.isArray(frames) && frames.length > 0 && typeof frames[0] === 'object') {
          store.setVlmFrames(frames.map((f: any) => ({
            url: f.url || f.framePath || f.thumbnail || '',
            description: f.description || f.text || f.content || '',
            editing: false,
            confirmed: !!(f.description || f.text || f.content || '').trim(),
          })));
        } else if (nodeResult.sceneDescriptions) {
          const descriptions = nodeResult.sceneDescriptions.split('\n').filter((s: string) => s.trim());
          const framePaths = nodeResult.framePaths || [];
          store.setVlmFrames(descriptions.map((desc: string, idx: number) => ({
            url: framePaths[idx] || '',
            description: desc.replace(/^\d+[\.\)、]\s*/, ''),
            editing: false,
            confirmed: !!desc.replace(/^\d+[\.\)、]\s*/, '').trim(),
          })));
        }
        break;
      }

      case PipelineNodeType.SCRIPT: {
        const paragraphs = nodeResult.paragraphs || nodeResult.shots || [];
        if (paragraphs.length > 0) {
          store.setScriptParagraphs(paragraphs.map((p: any, idx: number) => ({
            id: p.id || p.shotId || `para_${idx}`,
            text: p.text || p.content || p.narration || '',
            shotId: p.shotId,
            duration: p.duration,
            editing: false
          })));
        }
        break;
      }

      case PipelineNodeType.TTS: {
        const ttsResults = nodeResult.results || nodeResult.shots || [];
        if (ttsResults.length > 0) {
          store.setTtsResults(ttsResults.map((r: any) => ({
            shotId: r.shotId,
            audioUrl: r.audioUrl || r.audioPath || '',
            duration: r.duration || 0
          })));
        }
        store.setTtsProgress(100);
        break;
      }

      case PipelineNodeType.MATCH: {
        const matches = nodeResult.matches || nodeResult.results || [];
        if (matches.length > 0) {
          store.setMatchResults(matches.map((m: any) => ({
            shotId: m.shotId || m.id,
            mediaId: m.mediaId || m.frameId,
            score: m.score || m.confidence || 0,
            thumbnail: m.thumbnail || m.coverPath || m.framePath || '',
            confirmed: m.confirmed || false
          })));
        } else if (nodeResult.segments && nodeResult.segments.length > 0) {
          store.setMatchResults(nodeResult.segments.map((seg: any, idx: number) => ({
            shotId: seg.shotId || seg.id || `shot_${idx}`,
            mediaId: seg.mediaId || seg.frameId || '',
            score: seg.score || seg.confidence || seg.similarity || 0,
            thumbnail: seg.thumbnail || seg.coverPath || seg.framePath || '',
            confirmed: seg.confirmed || false
          })));
        }
        break;
      }
    }
  }
};

/** Hook：提供管线结果映射函数 */
export const usePipelineResultMapper = () => {
  return { mapPipelineResultToState };
};
