// 📁 路径：src/main/engine/export/JianyingCompiler.ts
import { Shot } from '../../../shared/types';
import * as crypto from 'crypto';

export class JianyingCompiler {
  private static readonly MICRO_SECOND = 1000000; // 剪映微秒单位

  /**
   * 🌟 核心：生成符合剪映标准的文本内容 JSON
   */
  private static formatTextContent(text: string): string {
    const textObj = {
      text: text,
      styles: [{ fill: { alpha: 1.0, color: [1.0, 1.0, 1.0] }, size: 8.0 }]
    };
    return JSON.stringify(textObj); // 剪映要求这里是字符串化的 JSON
  }

  static compile(_projectId: string, shots: Shot[], _mediaPath: string, _bgmPath?: string): any {
    const draftId = crypto.randomUUID().toUpperCase();
    const safeMediaPath = (_mediaPath || '').replace(/\\/g, '/');

    // 1. 真相源：所有物理材质和虚拟材质的容器
    const materials = {
      videos: [] as any[],
      audios: [] as any[],
      texts: [] as any[],
      material_animations: [],
      material_colors: []
    };

    // 2. 轨道逻辑：严格区分 4 轨
    const videoTrack = { id: crypto.randomUUID(), type: 'video', segments: [] as any[] };
    const bgmTrack   = { id: crypto.randomUUID(), type: 'audio', segments: [] as any[] };
    const ttsTrack   = { id: crypto.randomUUID(), type: 'audio', segments: [] as any[] };
    const textTrack  = { id: crypto.randomUUID(), type: 'text',  segments: [] as any[] };

    let globalOffset = 0;

    // -- BGM 轨道（整片一条，降音铺底） --
    if (_bgmPath) {
      const bgmMatId = crypto.randomUUID();
      const totalDuration = shots.reduce((sum, s) => sum + Math.round((s.audioDuration || (s.end - s.start)) * this.MICRO_SECOND), 0);
      materials.audios.push({
        id: bgmMatId,
        path: (_bgmPath || '').replace(/\\/g, '/'),
        type: 'audio',
        duration: totalDuration,
      });
      bgmTrack.segments.push({
        id: crypto.randomUUID(),
        material_id: bgmMatId,
        target_timerange: { start: 0, duration: totalDuration },
        source_timerange: { start: 0, duration: totalDuration },
        extra_material_refs: [bgmMatId],
        volume: 0.3, // BGM 降音至 30%
      });
    }

    shots.forEach((shot, _index) => {
      // 物理单位转换
      const durationUs = Math.round((shot.audioDuration || (shot.end - shot.start)) * this.MICRO_SECOND);
      
      // 为每个 Shot 生成唯一的材质 ID
      const vMatId = crypto.randomUUID();
      const aMatId = crypto.randomUUID();
      const tMatId = crypto.randomUUID();

      // --- A. 视频材质 (映射原始视频切片) ---
      materials.videos.push({
        id: vMatId,
        path: safeMediaPath, // 使用统一媒体路径替代 shot.filePath
        type: 'video',
        duration: durationUs,
        local_id: ""
      });

      videoTrack.segments.push({
        id: crypto.randomUUID(),
        material_id: vMatId,
        target_timerange: { start: globalOffset, duration: durationUs },
        source_timerange: { start: 0, duration: durationUs },
        track_id: videoTrack.id,
        extra_material_refs: [vMatId] // 🌟 关键：引用链补齐
      });

      // --- B. AI 配音音频 (TTS 轨) ---
      if (shot.audioPath) {
        const cleanAudioPath = shot.audioPath.replace('file://', '').replace(/\\/g, '/');
        materials.audios.push({
          id: aMatId,
          path: cleanAudioPath,
          type: 'audio',
          duration: durationUs
        });

        ttsTrack.segments.push({
          id: crypto.randomUUID(),
          material_id: aMatId,
          target_timerange: { start: globalOffset, duration: durationUs },
          source_timerange: { start: 0, duration: durationUs },
          extra_material_refs: [aMatId]
        });
      }

      // --- C. AI 字幕 (修正后的双重转义逻辑) ---
      const contentText = shot.aiText || shot.originalText || '';
      if (contentText) {
        materials.texts.push({
          id: tMatId,
          content: this.formatTextContent(contentText), // 🌟 使用修正后的文本协议
          type: 'text'
        });

        textTrack.segments.push({
          id: crypto.randomUUID(),
          material_id: tMatId,
          target_timerange: { start: globalOffset, duration: durationUs },
          extra_material_refs: [tMatId]
        });
      }

      globalOffset += durationUs; // 推进时间轴
    });

    // 3. 构建完整的草稿包（4 轨：视频 + BGM + TTS + 字幕）
    return {
      version: 6,
      id: draftId,
      fps: 30,
      duration: globalOffset,
      materials,
      tracks: [videoTrack, bgmTrack, ttsTrack, textTrack],
      canvas_config: { height: 1080, width: 1920, ratio: "16:9" }
    };
  }
}
