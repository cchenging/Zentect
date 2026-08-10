// 📁 路径：src/modules/export/jianying/backend/core/assemblers/DraftContentAssembler.ts
// 草稿内容装配：构建剪映 v360000 draft_content.json 的 28 根级字段骨架 + 45 个 materials 键
//
// 职责：组装剪映草稿的顶层结构（根级字段 + materials 容器 + keyframes + config），
// 并整合素材装配（MaterialsAssembler）与轨道装配（TracksAssembler）的产物。

import type { CompileShot } from '../../../types';
import type { SubtitleStyle } from '../../../types';
import { DEFAULT_SUBTITLE_STYLE } from '../../../types';
import { genDraftUuid } from '../utils/IdUtils';
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
 *
 * @param videos 视频素材数组
 * @param audios 音频素材数组
 * @param texts 字幕素材数组
 * @returns 完整 materials 容器
 */
function buildMaterialsContainer(
  videos: unknown[],
  audios: unknown[],
  texts: unknown[],
): Record<string, unknown> {
  return {
    ai_translates: emptyArrays(),
    audio_balances: emptyArrays(),
    audio_effects: emptyArrays(),
    audio_fades: emptyArrays(),
    audio_track_indexes: emptyArrays(),
    audios,
    beats: emptyArrays(),
    canvases: emptyArrays(),
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
    sound_channel_mappings: emptyArrays(),
    speeds: emptyArrays(),
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
    vocal_separations: emptyArrays(),
  };
}

/**
 * 构建 keyframes 容器（8 个空数组子键）。
 *
 * @returns keyframes 对象
 */
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

/**
 * 构建 config 容器（24 个配置子字段）。
 *
 * @returns config 对象
 */
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
 * 内部整合素材装配（assembleMaterials）与轨道装配（assembleTracks），
 * 产出 28 根级字段 + materials + tracks 的完整草稿结构。
 *
 * @param shots 编译后的镜头数据
 * @param mediaPath 源视频文件路径（chunkData 缺失时回退源）
 * @param bgmPath 背景音乐路径（可选）
 * @param subtitleStyle 字幕样式（缺省用默认样式）
 * @returns 剪映 v360000 草稿 JSON 对象
 */
export function assembleDraftContent(
  shots: CompileShot[],
  mediaPath: string,
  bgmPath?: string,
  subtitleStyle: SubtitleStyle = DEFAULT_SUBTITLE_STYLE,
): Record<string, unknown> {
  // 1. 素材装配
  const materialsResult = assembleMaterials(shots, mediaPath, bgmPath, subtitleStyle);

  // 2. 轨道装配
  const tracksResult = assembleTracks(
    materialsResult.shotRefs,
    materialsResult.bgmRef,
    subtitleStyle,
  );

  // 3. 组装 28 根级字段骨架
  return {
    version: 360000,
    id: genDraftUuid(),
    name: '',
    source: 'default',
    fps: 30,
    duration: tracksResult.totalDurationUs,
    canvas_config: { width: 1920, height: 1080, ratio: 'original' },
    color_space: 0,
    create_time: 0,
    update_time: 0,
    new_version: '110.0.0',
    platform: PLATFORM,
    last_modified_platform: PLATFORM,
    relationships: [],
    keyframe_graph_list: [],
    retouch_cover: null,
    static_cover_image_path: '',
    cover: null,
    extra_info: null,
    mutable_config: null,
    group_container: null,
    time_marks: null,
    free_render_index_mode_on: false,
    render_index_track_mode_on: false,
    keyframes: buildKeyframesContainer(),
    config: buildConfigContainer(),
    materials: buildMaterialsContainer(
      materialsResult.videos,
      materialsResult.audios,
      materialsResult.texts,
    ),
    tracks: tracksResult.tracks,
  };
}