import { classifyNodeId, PipelineNodeType } from '../utils/pipelineConstants';

/**
 * 管线结果映射器所需的 Setter 对象（阶段四：从依赖 useStore.getState() 改为各模块 Store 的 Setter 桥接对象）
 */
export interface PipelineResultMappers {
  setAudioSeparated: (separated: boolean) => void;
  setAsrLines: (lines: any[]) => void;
  setFrameCount: (count: number) => void;
  setExtractedData: (data: any) => void;
  setVlmFrames: (frames: any[]) => void;
  setScriptParagraphs: (paragraphs: any[]) => void;
  setTtsResults: (results: any[]) => void;
  setTtsProgress: (progress: number) => void;
  setMatchResults: (results: any[]) => void;
  setVideoChunks: (chunks: any[]) => void;
  setBeatTimestamps: (beats: number[]) => void;
}

/**
 * 将管线执行结果映射到编辑器各步骤状态
 * @param result 管线执行返回的结果对象（按 nodeId 索引）
 * @param mappers 各模块 Store 的 Setter 桥接对象
 */
export const mapPipelineResultToState = (result: Record<string, any>, mappers: PipelineResultMappers) => {
  if (!result || typeof result !== 'object') return;

  for (const [nodeId, nodeResult] of Object.entries(result)) {
    if (!nodeResult || typeof nodeResult !== 'object') continue;

    const nodeType = classifyNodeId(nodeId);

    switch (nodeType) {
      case PipelineNodeType.AUDIO_SEPARATE:
        mappers.setAudioSeparated(true);
        break;

      case PipelineNodeType.ASR:
        if (nodeResult.lines) {
          mappers.setAsrLines(nodeResult.lines.map((l: any) => ({
            start: l.start || l.begin || '00:00',
            text: l.text || l.content || '',
            editing: false
          })));
        }
        break;

      case PipelineNodeType.FRAME_EXTRACT:
        if (nodeResult.framesCount) mappers.setFrameCount(nodeResult.framesCount);
        if (nodeResult.framePaths) mappers.setFrameCount(nodeResult.framePaths.length);
        /** 将帧路径数组持久化到 store，修复"抽得到图片但前端看不见" */
        if (nodeResult.framePaths && Array.isArray(nodeResult.framePaths)) {
          mappers.setExtractedData({ framePaths: nodeResult.framePaths, frameCount: nodeResult.framePaths.length });
        } else if (nodeResult.frames && Array.isArray(nodeResult.frames)) {
          mappers.setExtractedData({ framePaths: nodeResult.frames, frameCount: nodeResult.frames.length });
        }
        break;

      case PipelineNodeType.VISION: {
        /** 💥 统一 VLM 数据映射：兼容两种后端返回格式
         *  格式1（对象数组）: frames = [{ url, description, ... }]
         *  格式2（VisionExtractStrategy）: { sceneDescriptions: string, framePaths: string[] }
         *  关键修复：framePaths 是绝对路径，需通过 getSafeMediaUrl 转换为可显示的 URL */
        const frames = nodeResult.frames || nodeResult.frameDescriptions || [];
        if (Array.isArray(frames) && frames.length > 0 && typeof frames[0] === 'object') {
          mappers.setVlmFrames(frames.map((f: any) => ({
            url: f.url || f.framePath || f.thumbnail || '',
            description: f.description || f.text || f.content || '',
            editing: false,
            confirmed: !!(f.description || f.text || f.content || '').trim(),
          })));
        } else if (nodeResult.sceneDescriptions) {
          const descriptions = nodeResult.sceneDescriptions.split('\n').filter((s: string) => s.trim());
          const framePaths = nodeResult.framePaths || [];
          mappers.setVlmFrames(descriptions.map((desc: string, idx: number) => ({
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
          /** 确保 id 唯一：当 shotId 重复时追加索引后缀，避免编辑时多段联动 */
          const idCountMap: Record<string, number> = {};
          mappers.setScriptParagraphs(paragraphs.map((p: any, idx: number) => {
            const baseId = p.id || p.shotId || `para_${idx}`;
            const count = (idCountMap[baseId] || 0) + 1;
            idCountMap[baseId] = count;
            const uniqueId = count > 1 ? `${baseId}_${idx}` : baseId;
            return {
              id: uniqueId,
              text: p.text || p.content || p.narration || '',
              shotId: p.shotId,
              duration: p.duration,
              emotion: p.emotion || '',
              editing: false
            };
          }));
        }
        break;
      }

      case PipelineNodeType.TTS: {
        /** TTS 结果映射：兼容逐段合成结果 { shots: [...] } 和旧格式 */
        const ttsShots = nodeResult.shots || nodeResult.results || [];
        if (ttsShots.length > 0) {
          mappers.setTtsResults(ttsShots.map((r: any) => {
            /** 将本地绝对路径转为 magic://local/ URL，供前端 Audio 标签播放 */
            let audioUrl = r.audioUrl || r.audioPath || '';
            if (audioUrl && !audioUrl.startsWith('http') && !audioUrl.startsWith('magic://')) {
              audioUrl = `magic://local/${audioUrl.replace(/\\/g, '/')}`;
            }
            return {
              shotId: r.shotId,
              audioUrl,
              duration: r.duration || 0,
              _failed: r._failed || false,
              _error: r._error || '',
            };
          }));
        }
        mappers.setTtsProgress(100);
        break;
      }

      case PipelineNodeType.MATCH: {
        const matches = nodeResult.matches || nodeResult.results || [];
        if (matches.length > 0) {
          mappers.setMatchResults(matches.map((m: any) => ({
            shotId: m.shotId || m.id,
            mediaType: m.mediaType || 'frame',
            mediaId: m.mediaId || m.chunkId || m.frameId || '',
            score: m.score || m.confidence || 0,
            thumbnail: m.thumbnail || m.coverPath || m.framePath || '',
            chunkData: m.chunkData || null,
            audioDurationMs: m.audioDurationMs || 0,
            videoTimelineStartMs: m.videoTimelineStartMs || 0,
            videoTimelineEndMs: m.videoTimelineEndMs || 0,
            appliedSpeedFactor: m.appliedSpeedFactor || 1.0,
            confirmed: m.confirmed || false
          })));
        } else if (nodeResult.segments && nodeResult.segments.length > 0) {
          mappers.setMatchResults(nodeResult.segments.map((seg: any, idx: number) => ({
            shotId: seg.shotId || seg.id || `shot_${idx}`,
            mediaType: seg.mediaType || 'frame',
            mediaId: seg.mediaId || seg.chunkId || seg.frameId || '',
            score: seg.score || seg.confidence || seg.similarity || 0,
            thumbnail: seg.thumbnail || seg.coverPath || seg.framePath || '',
            chunkData: seg.chunkData || null,
            audioDurationMs: seg.audioDurationMs || 0,
            videoTimelineStartMs: seg.videoTimelineStartMs || 0,
            videoTimelineEndMs: seg.videoTimelineEndMs || 0,
            appliedSpeedFactor: seg.appliedSpeedFactor || 1.0,
            confirmed: seg.confirmed || false
          })));
        }
        /** 同步视频切片池和 BGM 节拍到 Store */
        if (nodeResult.videoChunks) {
          mappers.setVideoChunks(nodeResult.videoChunks);
        }
        if (nodeResult.bgmBeats) {
          mappers.setBeatTimestamps(nodeResult.bgmBeats.map((b: number) => Math.round(b * 1000)));
        }
        break;
      }
    }
  }
};


