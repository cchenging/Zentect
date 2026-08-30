import { classifyNodeId, PipelineNodeType } from '../../utils/pipelineConstants';
// 归一化工厂单源：引擎结果落库前统一净化为判别联合契约（补 type / 毫秒时间轴，剥离废弃键）
import { normalizeScriptParagraph } from '../../../../../shared/utils/normalizeScriptParagraph';

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
          mappers.setAsrLines(nodeResult.lines.map((l: any) => {
            // 从原始数据计算毫秒时间戳
            let startMs = l.startMs;
            if (startMs === undefined && l.start != null) {
              if (typeof l.start === 'number') {
                startMs = Math.round(l.start * 1000);
              } else {
                // 尝试解析 MM:SS 字符串
                const parts = String(l.start).split(':').map(Number);
                if (parts.length >= 2) startMs = (parts[0] * 60 + parts[1]) * 1000;
              }
            }
            let endMs = l.endMs;
            if (endMs === undefined && l.end != null) {
              if (typeof l.end === 'number') {
                endMs = Math.round(l.end * 1000);
              } else {
                const parts = String(l.end).split(':').map(Number);
                if (parts.length >= 2) endMs = (parts[0] * 60 + parts[1]) * 1000;
              }
            }
            return {
              start: l.start || l.begin || '00:00',
              startMs: startMs || 0,
              text: l.text || l.content || '',
              editing: false,
              endMs: endMs || 0,
            };
          }));
        }
        break;

      case PipelineNodeType.FRAME_EXTRACT:
        if (nodeResult.framesCount) mappers.setFrameCount(nodeResult.framesCount);
        if (nodeResult.framePaths) mappers.setFrameCount(nodeResult.framePaths.length);
        /** 将帧路径数组持久化到 store，修复"抽得到图片但前端看不见" */
        if (nodeResult.framePaths && Array.isArray(nodeResult.framePaths)) {
          mappers.setExtractedData({
            framePaths: nodeResult.framePaths,
            frameCount: nodeResult.framePaths.length,
            // 🎬 帧真实时间戳（源坐标，与 framePaths 顺序对齐）：随帧路径一并写入 extractedData
            frameTimeMs: nodeResult.frameTimeMs || [],
          });
        } else if (nodeResult.frames && Array.isArray(nodeResult.frames)) {
          // 🛑 根因修复：nodeResult.frames 可能是对象数组（[{url,path,...}]，如 VisionExtractStrategy 的 frames: frameDetails），
          // 若整包对象数组直接塞入 framePaths，数组项为 object，渲染时 getSafeMediaUrl().trim() 崩溃。
          // 在此提取 url/path/filePath/thumbnail 归一为 string[]。
          const frameUrls = nodeResult.frames
            .map((f: any) => (typeof f === 'string' ? f : (f?.url || f?.path || f?.filePath || f?.thumbnail || '')))
            .filter(Boolean);
          mappers.setExtractedData({
            framePaths: frameUrls,
            frameCount: frameUrls.length,
            // 🎬 帧真实时间戳：frames 对象数组自带 timeMs 时优先派生，否则空数组
            frameTimeMs: Array.isArray(nodeResult.frameTimeMs) && nodeResult.frameTimeMs.length > 0
              ? nodeResult.frameTimeMs
              : nodeResult.frames.map((f: any) => (typeof f === 'number' ? f : (f?.timeMs ? Math.round(Number(f.timeMs)) : 0))),
          });
        }
        break;

      case PipelineNodeType.VISION: {
        /** 💥 统一 VLM 数据映射：兼容两种后端返回格式
         *  格式1（对象数组）: frames = [{ url, description, ... }]
         *  格式2（VisionExtractStrategy）: { sceneDescriptions: string, framePaths: string[] }
         *  关键修复：framePaths 是绝对路径，需通过 getSafeMediaUrl 转换为可显示的 URL
         *  🎭 P0 修复：用 spread 保留所有扩展字段（downstream/characters 等），
         *     避免 step3 消费时丢失结构化人物动作信息 */
        const frames = nodeResult.frames || nodeResult.frameDescriptions || [];
        if (Array.isArray(frames) && frames.length > 0 && typeof frames[0] === 'object') {
          mappers.setVlmFrames(frames.map((f: any) => ({
            ...f, // 保留 downstream/timeMs/timeStr/asrText/asrTime/emotion 等所有扩展字段
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
        /** 🛑 遵循"错就错，不兜底"：无条件写回，禁止 if(length>0) 守卫
         *  旧实现守卫会导致：当后端返回空数组（生成失败/生成为空）时，setScriptParagraphs 不被调用，
         *  残留旧文案被 UI 误显示为"已生成"，掩盖了重新生成失败的真实情况。空就是空，让 UI 显示"解说文案待生成"。 */
        /** ✅ 唯一主键统一：出生处(ScriptGenStrategy)已强制 seg_{idx} 全局唯一，此层仅透传、
         *  不做任何去重/追加后缀（防线收敛到唯一权威源头）。
         *  与工程载入 / 步骤内再生两条生产链同构同源：统一过 Normalizer 净化为判别联合契约
         *  （自动补 type / 毫秒时间轴，剥离已废弃的 duration(秒)/keepOriginalAudio 持久化键）。 */
        mappers.setScriptParagraphs(paragraphs.map((p: any) => {
          /** ✅ 身份键统一：主键即出生处唯一 id（Normalizer 亦断言存在），前端编辑/时间轴定位均按此对齐 */
          const uniqueId = p.id;
          return normalizeScriptParagraph({
            id: uniqueId,
            text: p.text || p.content || p.narration || '',
            shotId: p.shotId,
            emotion: p.emotion || '',
            characters: Array.isArray(p.characters) ? p.characters : (Array.isArray(p.anchoredCharacters) ? p.anchoredCharacters : undefined),
            /** 🎯 P1-5 链路修复：透传 ScriptGenStrategy 产出的时间锚 / 画面意图 / 原声标记。
             *  此前漏透传导致 scriptParagraphs 无 startMs/visualIntent 落库，
             *  步骤5 KM 时间锚（ANCHOR_BONUS）与画面意图语义匹配全部失效 → 匹配时间乱跳/短句错配。
             *  legacy 原声布尔由 Normalizer 折算为 type='original_audio' 判别字段。 */
            startMs: typeof p.startMs === 'number' ? p.startMs : undefined,
            durationMs: typeof p.durationMs === 'number' ? p.durationMs : undefined,
            visualIntent: typeof p.visualIntent === 'string' ? p.visualIntent : undefined,
            keepOriginalAudio: p.keepOriginalAudio === true,
            /** 🎙️ 原声保留段音频源透传：ScriptGenStrategy 生成的 ASR 精确时间窗（源坐标），
             *  步骤4 原声试听据此截取原片对应台词音频；缺失时 Normalizer 按 chunk 时间轴 fallback */
            audioSource: p.audioSource,
            editing: false
          });
        }));
        break;
      }

      case PipelineNodeType.TTS: {
        /** TTS 结果映射：无条件覆盖，禁止 if(length>0) 守卫
         *  旧实现的 if 守卫会导致：当后端返回空数组（如合成失败未触发 _failed）时，
         *  ttsResults 不被清空，残留的旧数据（含试听/上次失败产物）会被前端误匹配播放。
         *  遵循"错就错"原则：空就是空，让 UI 显示"待合成"，错误以原始形态暴露。
         */
        const ttsShots = nodeResult.shots || nodeResult.results || [];
        mappers.setTtsResults(ttsShots.map((r: any) => {
          /** 将本地绝对路径转为 magic://local/ URL，供前端 Audio 标签播放 */
          let audioUrl = r.audioUrl || r.audioPath || '';
          if (audioUrl && !audioUrl.startsWith('http') && !audioUrl.startsWith('magic://')) {
            audioUrl = `magic://local/${audioUrl.replace(/\\/g, '/')}`;
          }
          return {
            /** ✅ 身份键统一：id 出生处即段落唯一主键（后端保证必存在），消费端一律读 id；shotId 保留同值兼容 */
            id: r.id,
            shotId: r.id,
            audioUrl,
            duration: r.duration || 0,
            _failed: r._failed || false,
            _error: r._error || '',
          };
        }));
        mappers.setTtsProgress(100);
        break;
      }

      case PipelineNodeType.MATCH: {
        const matches = nodeResult.matches || nodeResult.results || [];
        /** ✅ 唯一主键统一：MATCH 结果 shotId 由 buildMatchQueries(s.id||s.shotId) 透传，出生处即全局唯一。
         *  此即前端 DragReorderList 的 React key，无需在此再做去重/追加后缀。 */
        if (matches.length > 0) {
          mappers.setMatchResults(matches.map((m: any) => {
            return {
              /** ✅ 身份键统一：id 出生处即段落唯一主键（后端保证必存在），此即前端 React key，消费端一律读 id */
              id: m.id,
              shotId: m.id,
              text: m.text || m.narration || '',
              keepOriginalAudio: m.keepOriginalAudio === true,
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
            };
          }));
        } else if (nodeResult.segments && nodeResult.segments.length > 0) {
          mappers.setMatchResults(nodeResult.segments.map((seg: any) => {
            return {
              /** ✅ 身份键统一：id 出生处即段落唯一主键（后端保证必存在），此即前端 React key，消费端一律读 id */
              id: seg.id,
              shotId: seg.id,
              text: seg.text || seg.narration || '',
              keepOriginalAudio: seg.keepOriginalAudio === true,
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
            };
          }));
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


