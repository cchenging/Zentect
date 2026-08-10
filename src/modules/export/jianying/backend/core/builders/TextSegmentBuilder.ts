// 📁 路径：src/modules/export/jianying/backend/core/builders/TextSegmentBuilder.ts
// 字幕轨 segment 构建

import type { SubtitleStyle } from '../../../types';
import { DEFAULT_SUBTITLE_STYLE } from '../../../types';
import { genHexId } from '../utils/IdUtils';

/**
 * 构建字幕轨 segment（subs，clip 为最小结构）。
 *
 * 按技术手册 §4.7/§4.8/§8.1：
 *  - text segment 的 source_timerange 必须显式为 null（缺省/非 null 会导致剪映打开卡死，坑位 1）
 *  - text segment 需含 uniform_scale（{on:true,value:1}）
 *  - clip.transform.y 接入 verticalOffset：底部基准 -0.85，verticalOffset 为距底部的向上偏移（坑位 5）
 *  - hdr_settings 必须为 null，render_index=2
 *  - enable_adjust / enable_lut 必须为 false（Text 不启用颜色/调色调节，§4.7 差异表）
 *  - 补齐 intensifies_audio: false
 *
 * @param materialId 素材 id
 * @param targetStart 时间线起始（微秒）
 * @param duration 时长（微秒）
 * @param subtitleStyle 字幕样式
 * @returns 字幕 segment 对象
 */
export function buildTextSegment(
  materialId: string,
  targetStart: number,
  duration: number,
  subtitleStyle: SubtitleStyle = DEFAULT_SUBTITLE_STYLE,
): object {
  return {
    enable_adjust: false,
    enable_color_correct_adjust: false,
    enable_color_curves: false,
    enable_color_match_adjust: false,
    enable_color_wheels: false,
    enable_lut: false,
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
    source_timerange: null,
    speed: 1.0,
    volume: 1.0,
    extra_material_refs: [materialId],
    is_tone_modify: false,
    intensifies_audio: false,
    clip: {
      alpha: 1.0,
      flip: { horizontal: false, vertical: false },
      rotation: 0.0,
      scale: { x: 1.0, y: 1.0 },
      transform: { x: 0.0, y: -0.85 + (subtitleStyle.verticalOffset || 0) },
    },
    uniform_scale: { on: true, value: 1.0 },
    hdr_settings: null,
    render_index: 2,
  };
}