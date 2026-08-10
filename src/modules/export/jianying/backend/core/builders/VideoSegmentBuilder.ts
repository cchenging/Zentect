// 📁 路径：src/modules/export/jianying/backend/core/builders/VideoSegmentBuilder.ts
// 视频轨 segment 构建

import { genHexId } from '../utils/IdUtils';

/**
 * 构建视频轨 segment（含 source_timerange 切片 + clip/uniform_scale/hdr_settings/render_index）。
 *
 * @param materialId 素材 id
 * @param targetStart 时间线起始（微秒）
 * @param duration 时长（微秒）
 * @param sourceStart 源切片起始（微秒）
 * @param speed 变速因子
 * @returns 视频 segment 对象
 */
export function buildVideoSegment(
  materialId: string,
  targetStart: number,
  duration: number,
  sourceStart: number,
  speed: number,
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
    source_timerange: { start: sourceStart, duration },
    speed,
    volume: 1.0,
    extra_material_refs: [materialId],
    is_tone_modify: false,
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