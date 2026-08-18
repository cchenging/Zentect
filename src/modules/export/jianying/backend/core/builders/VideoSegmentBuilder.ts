// 📁 路径：src/modules/export/jianying/backend/core/builders/VideoSegmentBuilder.ts
// 视频轨 segment 构建

import { genHexId } from '../utils/IdUtils';

/**
 * 原声段音量：保留原片原声并适当放大（0.9），避免"听不清"。
 * 原声段（keepOriginalAudio）不配 TTS 配音，原声完全由视频段自身承载，故可开足音量。
 */
const ORIGINAL_AUDIO_VOLUME = 0.9;

/**
 * 普通解说段视频音量：静音（配音由 TTS 独立音轨承载，避免与原片原声叠加）。
 */
const MUTED_VOLUME = 0;

/**
 * 构建视频轨 segment（含 source_timerange 切片 + clip/uniform_scale/hdr_settings/render_index）。
 *
 * 说明：普通解说段视频原声静音（volume=0），配音由 TTS 独立音轨承载；
 * 原声段落（keepOriginalAudio=true）视频原声保留并放大（volume=0.9），该段不配 TTS。
 *
 * @param materialId 素材 id
 * @param targetStart 时间线起始（微秒）
 * @param duration 时长（微秒，目标时长）
 * @param sourceStart 源切片起始（微秒）
 * @param speed 变速因子
 * @param keepOriginalAudio 是否保留原片原声（true=原声段，volume 开足；false=静音由 TTS 承载）
 * @param sourceDuration 源切片时长（微秒，缺省=duration。
 *   🎬 阶段 A：合并兄弟段为单 clip 时，source 与 target 时长各自累加，可不同）
 * @returns 视频 segment 对象
 */
export function buildVideoSegment(
  materialId: string,
  targetStart: number,
  duration: number,
  sourceStart: number,
  speed: number,
  keepOriginalAudio = false,
  sourceDuration?: number,
): object {
  // 原声段保留原片原声并适当放大；普通段静音（TTS 配音由独立音轨承载）
  const volume = keepOriginalAudio ? ORIGINAL_AUDIO_VOLUME : MUTED_VOLUME;
  const srcDuration = sourceDuration ?? duration;
  return {
    enable_adjust: true,
    enable_color_correct_adjust: false,
    enable_color_curves: true,
    enable_color_match_adjust: false,
    enable_color_wheels: true,
    enable_lut: true,
    enable_smart_color_adjust: false,
    last_nonzero_volume: keepOriginalAudio ? ORIGINAL_AUDIO_VOLUME : 1.0,
    reverse: false,
    track_attribute: 0,
    track_render_index: 0,
    visible: true,
    id: genHexId(),
    material_id: materialId,
    target_timerange: { start: targetStart, duration },
    common_keyframes: [],
    keyframe_refs: [],
    source_timerange: { start: sourceStart, duration: srcDuration },
    speed,
    volume,
    extra_material_refs: [materialId],
    is_tone_modify: false,
    intensifies_audio: false,
    clip: {
      alpha: 1.0,
      flip: { horizontal: false, vertical: false },
      rotation: 0.0,
      scale: { x: 1.0, y: 1.0 },
      transform: { x: 0.0, y: 0.0 },
    },
    uniform_scale: { on: true, value: 1.0 },
    hdr_settings: { intensity: 1.0, mode: 1, nits: 1000 },
    render_index: 0,
  };
}