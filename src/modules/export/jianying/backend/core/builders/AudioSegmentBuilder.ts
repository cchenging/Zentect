// 📁 路径：src/modules/export/jianying/backend/core/builders/AudioSegmentBuilder.ts
// 音频轨 segment 构建

import { genHexId } from '../utils/IdUtils';

/**
 * 构建音频轨 segment。
 *
 * 按技术手册 §4.7：audio segment 的 clip/hdr_settings 必须为 null（坑位 12），
 * source_timerange 为 {start:0,duration:N}，render_index=1。
 *
 * @param materialId 素材 id
 * @param targetStart 时间线起始（微秒）
 * @param duration 时长（微秒）
 * @param speed 变速因子
 * @param volume 音量（BGM 0.3 / TTS 1.0）
 * @returns 音频 segment 对象
 */
export function buildAudioSegment(
  materialId: string,
  targetStart: number,
  duration: number,
  speed: number,
  volume: number,
): object {
  return {
    enable_adjust: true,
    enable_color_correct_adjust: false,
    enable_color_curves: true,
    enable_color_match_adjust: false,
    enable_color_wheels: true,
    enable_lut: true,
    enable_smart_color_adjust: false,
    last_nonzero_volume: 1.0,
    reverse: false,
    track_attribute: 0,
    track_render_index: 0,
    visible: true,
    id: genHexId(),
    material_id: materialId,
    target_timerange: { start: targetStart, duration },
    common_keyframes: [],
    keyframe_refs: [],
    source_timerange: { start: 0, duration },
    speed,
    volume,
    extra_material_refs: [materialId],
    is_tone_modify: false,
    clip: null,
    hdr_settings: null,
    render_index: 1,
  };
}