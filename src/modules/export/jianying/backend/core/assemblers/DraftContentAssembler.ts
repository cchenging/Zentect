// 📁 路径：src/modules/export/jianying/backend/core/assemblers/DraftContentAssembler.ts
// 草稿内容装配：构建剪映 v360000 draft_content.json 的 28 根级字段骨架 + 45 个 materials 键
//
// 职责：组装剪映草稿的顶层结构（根级字段 + materials 容器 + keyframes + config），
// 并整合素材装配（MaterialsAssembler）与轨道装配（TracksAssembler）的产物。
// 4 个"非空"支撑容器（canvases / sound_channel_mappings / speeds / vocal_separations）
// 由 MaterialsAssembler.assembleMaterials 产出 support，再合并到 45 键容器。

import type { CompileShot, SubtitleStyle } from '../../../types';
import { DEFAULT_SUBTITLE_STYLE } from '../../../types';
import { genDraftUuid } from '../utils/IdUtils';
import type { VideoProbeResult } from '../utils/FfprobeProber';
import { assembleMaterials } from './MaterialsAssembler';
import { assembleTracks } from './TracksAssembler';

/** 剪映平台标记（与 pyJianYingDraft 原生草稿一致） */
const PLATFORM = {
  app_id: 3704,
  app_source: 'lv',
  app_version: '5.9.0',
  os: 'windows',
};

/** 空数组工厂：materials 与 keyframes 中大量空子键 */
const emptyArrays = () => [] as unknown[];

/**
 * 构建 45 个键的 materials 真相源容器（剪映原生完整键）。
 * 其中 7 个非空键来自 MaterialsAssembler：videos / audios / texts / canvases /
 * sound_channel_mappings / speeds / vocal_separations，其余 38 键留空数组。
 */
function buildMaterialsContainer(
  videos: unknown[],
  audios: unknown[],
  texts: unknown[],
  canvases: unknown[],
  soundChannelMappings: unknown[],
  speeds: unknown[],
  vocalSeparations: unknown[],
): Record<string, unknown> {
  return {
    ai_translates: emptyArrays(),
    audio_balances: emptyArrays(),
    audio_effects: emptyArrays(),
    audio_fades: emptyArrays(),
    audio_track_indexes: emptyArrays(),
    audios,
    beats: emptyArrays(),
    canvases,
    chromas: emptyArrays(),
    color_curves: emptyArrays(),
    digital_humans: emptyArrays(),
    drafts: emptyArrays(),
    effects: emptyArrays(),
    flowers: emptyArrays(),
    green_screens: emptyArrays(),
    handwrites: emptyArrays(),
    hsl: emptyArrays(),
    images: emptyArrays(),
    log_color_wheels: emptyArrays(),
    loudnesses: emptyArrays(),
    manual_deformations: emptyArrays(),
    masks: emptyArrays(),
    material_animations: emptyArrays(),
    material_colors: emptyArrays(),
    multi_language_refs: emptyArrays(),
    placeholders: emptyArrays(),
    plugin_effects: emptyArrays(),
    primary_color_wheels: emptyArrays(),
    realtime_denoises: emptyArrays(),
    shapes: emptyArrays(),
    smart_crops: emptyArrays(),
    smart_relights: emptyArrays(),
    sound_channel_mappings: soundChannelMappings,
    speeds,
    stickers: emptyArrays(),
    tail_leaders: emptyArrays(),
    text_templates: emptyArrays(),
    texts,
    time_marks: emptyArrays(),
    transitions: emptyArrays(),
    video_effects: emptyArrays(),
    video_trackings: emptyArrays(),
    videos,
    vocal_beautifys: emptyArrays(),
    vocal_separations: vocalSeparations,
  };
}

/** 构建 keyframes 容器（8 个空数组子键）。 */
function buildKeyframesContainer(): Record<string, unknown> {
  return {
    adjusts: emptyArrays(),
    audios: emptyArrays(),
    effects: emptyArrays(),
    filters: emptyArrays(),
    handwrites: emptyArrays(),
    stickers: emptyArrays(),
    texts: emptyArrays(),
    videos: emptyArrays(),
  };
}

/** 构建 config 容器（24 个配置子字段）。 */
function buildConfigContainer(): Record<string, unknown> {
  return {
    adjust_max_index: 1,
    attachment_info: emptyArrays(),
    combination_max_index: 1,
    export_range: null,
    extract_audio_last_index: 1,
    lyrics_recognition_id: '',
    lyrics_sync: true,
    lyrics_taskinfo: emptyArrays(),
    maintrack_adsorb: true,
    material_save_mode: 0,
    multi_language_current: 'none',
    multi_language_list: emptyArrays(),
    multi_language_main: 'none',
    multi_language_mode: 'none',
    original_sound_last_index: 1,
    record_audio_last_index: 1,
    sticker_max_index: 1,
    subtitle_keywords_config: null,
    subtitle_recognition_id: '',
    subtitle_sync: true,
    subtitle_taskinfo: emptyArrays(),
    system_font_list: emptyArrays(),
    video_mute: false,
    zoom_info_params: null,
  };
}

/**
 * 草稿内容装配：编译镜头数组为剪映 v360000 draft_content 对象。
 *
 * 内部整合素材装配（assembleMaterials，需要 ffprobe probeMap 严格校验）
 * 与轨道装配（assembleTracks），产出 28 根级字段 + materials + tracks。
 *
 * @param shots 编译后的镜头数据
 * @param mediaPath 源视频文件路径（chunkData 缺失时回退源）
 * @param probeMap  所有视频文件的 ffprobe 结果（按绝对路径缓存；缺失会抛错 fail-fast）
 * @param bgmPath 背景音乐路径（可选）
 * @param subtitleStyle 字幕样式（缺省用默认样式）
 * @returns 剪映 v360000 草稿 JSON 对象
 */
/**
 * 从 ffprobe 结果推断画布尺寸：画布跟随源视频真实分辨率，实现横竖屏自适应。
 * 优先级：首镜头切片(chunkData.filePath) → 源 mediaPath；均取不到时兜底 1920×1080。
 * @param shots     编译镜头
 * @param mediaPath 源视频路径
 * @param probeMap  视频探针结果（按路径缓存）
 * @returns 画布宽×高
 */
function resolveCanvasSize(
  shots: CompileShot[],
  mediaPath: string,
  probeMap: Map<string, VideoProbeResult>,
): { width: number; height: number } {
  // 优先首镜头切片，否则源视频；probeMap 的 key 统一为正斜杠物理路径
  const chunkPath = shots[0]?.chunkData?.filePath as string | undefined;
  const primary = chunkPath
    ? String(chunkPath).replace(/\\/g, '/')
    : String(mediaPath || '').replace(/\\/g, '/');
  const probe = probeMap.get(primary);
  if (probe?.width && probe?.height) {
    return { width: probe.width, height: probe.height };
  }
  // 兜底：取任意一个可用探针
  for (const p of probeMap.values()) {
    if (p?.width && p?.height) return { width: p.width, height: p.height };
  }
  return { width: 1920, height: 1080 };
}

export function assembleDraftContent(
  shots: CompileShot[],
  mediaPath: string,
  probeMap: Map<string, VideoProbeResult>,
  bgmPath?: string,
  subtitleStyle: SubtitleStyle = DEFAULT_SUBTITLE_STYLE,
): Record<string, unknown> {
  // ✅ 横竖屏自适应：画布尺寸跟随源视频真实分辨率（canvas_config 与画布素材都引用）
  const canvasSize = resolveCanvasSize(shots, mediaPath, probeMap);
  // 是否竖屏（宽 < 高）。竖屏画布更窄更高，字号需放大、位置偏移需单独处理。
  const isPortrait = canvasSize.height > canvasSize.width;
  // 字幕字号是相对画布宽度的比例（基准 1920 宽）。
  // 画布变窄（竖屏）时不改字号会显得偏小，这里按宽比 1920/画布宽 放大，保证不同画布下观感一致。
  // 横屏:1920 宽是基准，按横屏专用字号（fontSizeLandscape，缺省回退 fontSize）取比例，避免 3.5 偏小。
  // 位置偏移：竖屏画布更高，同一 verticalOffset 会抬得比横屏更高，故竖屏换算更小值保持距底部视觉一致。
  const baseFontSize = subtitleStyle.fontSize ?? DEFAULT_SUBTITLE_STYLE.fontSize;
  const baseVerticalOffset = subtitleStyle.verticalOffset ?? DEFAULT_SUBTITLE_STYLE.verticalOffset;
  // 横屏：字号可独立放大贴近易读（横向条幅缺窄画布的占比补足）；位置贴近底部（垂直偏移取极小值，y 贴近 -0.85）
  const fontSize = isPortrait
    ? baseFontSize * (1920 / Math.max(canvasSize.width, 1))
    : (subtitleStyle.fontSizeLandscape ?? baseFontSize) * (1920 / Math.max(canvasSize.width, 1));
  const verticalOffset = isPortrait
    ? (subtitleStyle.verticalOffsetPortrait ??
      baseVerticalOffset * (canvasSize.width / Math.max(canvasSize.height, 1)))
    // 横屏贴近底部基准 -0.85，加一个正值让字幕往上抬（不透底即可读）。
    // 值越大抬得越高；如需再调，直接改此常量或接入配置。
    : 0.12;
  // 传给装配的样式：字号与位置都按方向决定；其余字段透传原样式
  const effectiveSubtitleStyle = {
    ...subtitleStyle,
    fontSize,
    verticalOffset,
  };

  // 1. 素材装配（含支撑 4 容器，字段齐全；画布尺寸随源视频横竖屏，字幕用方向自适应字号）
  const materialsResult = assembleMaterials(shots, mediaPath, probeMap, {
    bgmPath,
    subtitleStyle: effectiveSubtitleStyle,
    canvasSize,
  });

  // 2. 轨道装配（字幕 segment 用同一方向自适应样式，保证字号与位置都随横竖屏生效）
  const tracksResult = assembleTracks(
    materialsResult.shotRefs,
    materialsResult.bgmRef,
    effectiveSubtitleStyle,
  );

  // 3. 组装 28 根级字段骨架（键序对齐 template.tmp，Jianying 8.9.0 对此敏感）
  return {
    canvas_config: { width: canvasSize.width, height: canvasSize.height, ratio: 'original' },
    color_space: 0,
    config: buildConfigContainer(),
    cover: null,
    create_time: 0,
    duration: tracksResult.totalDurationUs,
    extra_info: null,
    fps: 30,
    free_render_index_mode_on: false,
    group_container: null,
    id: genDraftUuid(),
    keyframe_graph_list: [],
    keyframes: buildKeyframesContainer(),
    last_modified_platform: PLATFORM,
    materials: buildMaterialsContainer(
      materialsResult.videos,
      materialsResult.audios,
      materialsResult.texts,
      materialsResult.support.canvases,
      materialsResult.support.sound_channel_mappings,
      materialsResult.support.speeds,
      materialsResult.support.vocal_separations,
    ),
    mutable_config: null,
    name: '',
    new_version: '110.0.1',
    platform: PLATFORM,
    relationships: [],
    render_index_track_mode_on: false,
    retouch_cover: null,
    source: 'default',
    static_cover_image_path: '',
    time_marks: null,
    tracks: tracksResult.tracks,
    update_time: 0,
    version: 360000,
  };
}
