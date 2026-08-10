// 📁 路径：src/modules/export/jianying/backend/core/assemblers/MaterialsAssembler.ts
// 素材装配：将编译镜头编译为剪映 materials 的 videos / audios / texts 三类素材
// （含 canvases / sound_channel_mappings / speeds / vocal_separations 四个支撑素材容器）
//
// 职责：只负责「素材」的构建，不涉及轨道（轨道由 TracksAssembler 负责）。
// 设计原则：
//   - 手册 §4.2 的 7 个"非空"键全部填充（videos/audios/texts/canvases/sound_channel_mappings/speeds/vocal_separations）
//   - 每个素材字段模板对齐 §4.3 Video（54）/ §4.4 Audio（39）/ §4.5 Text（80+）
//   - 错就错，不兜底不降级：ffprobe 探测失败直接上抛，不硬编码 0x0

import * as path from 'path';
import type { CompileShot, SubtitleStyle } from '../../../types';
import { DEFAULT_SUBTITLE_STYLE } from '../../../types';
import { genHexId } from '../utils/IdUtils';
import { formatTextContent } from '../utils/TextContentFormatter';
import type { VideoProbeResult } from '../utils/FfprobeProber';

/** 单个镜头的素材装配结果（供 TracksAssembler 消费，解耦素材与轨道） */
export interface ShotMaterialRef {
  /** 镜头 id */
  shotId: string;
  /** 视频素材 id */
  videoId: string;
  /** 配音音频素材 id（无配音时不设） */
  audioId?: string;
  /** 字幕素材 id（无字幕时不设） */
  textId?: string;
  /** 目标时长（微秒） */
  durationUs: number;
  /** 源切片起始（微秒） */
  sourceStartUs: number;
  /** 变速因子 */
  speed: number;
  /** 视频变速引用 id（指向 materials.speeds，speed≠1.0 时关联） */
  speedRefId?: string;
}

/** BGM 素材装配结果 */
export interface BgmMaterialRef {
  /** BGM 素材 id */
  bgmId: string;
  /** BGM 铺设总时长（微秒） */
  totalDurationUs: number;
}

/** 支撑素材容器（canvases/sound_channel_mappings/speeds/vocal_separations） */
export interface SupportMaterials {
  canvases: unknown[];
  sound_channel_mappings: unknown[];
  speeds: unknown[];
  vocal_separations: unknown[];
}

/** 素材装配结果：三类素材数组 + 镜头素材引用映射 + 支撑素材 */
export interface MaterialsResult {
  /** 视频素材数组 */
  videos: unknown[];
  /** 音频素材数组（BGM + TTS） */
  audios: unknown[];
  /** 字幕素材数组 */
  texts: unknown[];
  /** 支撑素材（4 容器，全部非空） */
  support: SupportMaterials;
  /** 每个镜头的素材引用（与 shots 一一对应） */
  shotRefs: ShotMaterialRef[];
  /** BGM 素材引用（无 BGM 时不设） */
  bgmRef?: BgmMaterialRef;
}

/** 微秒换算因子 */
const MICRO_SECOND = 1_000_000;

/**
 * 计算单个镜头的目标时长（微秒）：优先配音时长，其次段落时长，最后 end-start。
 */
function resolveDurationUs(shot: CompileShot): number {
  return Math.round(
    (shot.audioDuration || (shot.end - shot.start)) * MICRO_SECOND,
  );
}

/**
 * 构建 §4.3 Video Material（54 字段）。
 *
 * 字段来源：
 *   - id/material_id/category_name/check_flag/path/duration/type：业务参数
 *   - width/height/has_audio/source/source_platform：ffprobe 真实值
 *   - 其余 44 字段按手册 §4.3 test_doc_draft 模板默认值填充
 */
function buildVideoMaterial(
  shot: CompileShot,
  videoId: string,
  safeMediaPath: string,
  durationUs: number,
  probe: VideoProbeResult,
): unknown {
  const chunk = shot.chunkData as Record<string, unknown> | null | undefined;
  const videoPath = chunk?.filePath ? String(chunk.filePath).replace(/\\/g, '/') : safeMediaPath;

  return {
    id: videoId,
    material_id: videoId,
    local_material_id: '',
    local_id: '',
    material_name: path.basename(videoPath),
    type: 'video',
    category_name: 'local',
    path: videoPath,
    media_path: '',
    duration: durationUs,
    width: probe.width,
    height: probe.height,
    has_audio: probe.hasAudio,
    source: 0,
    source_platform: 0,
    check_flag: 63487,
    crop_ratio: 'free',
    crop_scale: 1.0,
    audio_fade: null,
    crop: {
      upper_left_x: 0.0, upper_left_y: 0.0,
      upper_right_x: 1.0, upper_right_y: 0.0,
      lower_left_x: 0.0, lower_left_y: 1.0,
      lower_right_x: 1.0, lower_right_y: 1.0,
    },
    matting: {
      flag: 0, has_use_quick_brush: false, has_use_quick_eraser: false,
      interactiveTime: [] as unknown[], path: '', strokes: [] as unknown[],
    },
    stable: {
      matrix_path: '', stable_level: 0,
      time_range: { duration: 0, start: 0 },
    },
    video_algorithm: {
      algorithms: [] as unknown[], complement_frame_config: null,
      deflicker: null, gameplay_configs: [] as unknown[],
      motion_blur_config: null, noise_reduction_config: null,
      path: '', quality_enhance: null, smart_stabilizer: null,
      super_resolution_config: null,
    },
    freeze: null,
    smart_motion: null,
    object_locked: null,
    picture_from: 'none',
    picture_set_category_id: '',
    picture_set_category_name: '',
    is_ai_generate_content: false,
    is_copyright: false,
    is_text_edit_overdub: false,
    is_unified_beauty_mode: false,
    aigc_history_id: '',
    aigc_item_id: '',
    aigc_type: 'none',
    cartoon_path: '',
    category_id: '',
    extra_type_option: 0,
    formula_id: '',
    intensifies_audio_path: '',
    intensifies_path: '',
    material_url: '',
    origin_material_id: '',
    request_id: '',
    reverse_intensifies_path: '',
    reverse_path: '',
    team_id: '',
  };
}

/**
 * 构建 §4.4 Audio Material（39 字段）。
 *   - id / local_material_id / music_id：三 ID 一致（手册 §4.4 必填）
 *   - type：BGM 用 "music"，TTS/抽取音频用 "extract_music"
 */
function buildAudioMaterial(
  audioId: string,
  audioPath: string,
  type: 'music' | 'extract_music',
  durationUs: number,
): unknown {
  return {
    id: audioId,
    local_material_id: audioId,
    music_id: audioId,
    type,
    category_name: 'local',
    name: path.basename(audioPath),
    path: audioPath,
    duration: durationUs,
    source_platform: 0,
    check_flag: 3,
    copyright_limit_type: 'none',
    app_id: 0,
    category_id: '',
    effect_id: '',
    formula_id: '',
    query: '',
    request_id: '',
    resource_id: '',
    search_id: '',
    source_from: '',
    team_id: '',
    text_id: '',
    tone_category_id: '',
    tone_category_name: '',
    tone_effect_id: '',
    tone_effect_name: '',
    tone_platform: '',
    tone_second_category_id: '',
    tone_second_category_name: '',
    tone_speaker: '',
    tone_type: '',
    video_id: '',
    intensifies_path: '',
    is_ai_clone_tone: false,
    is_text_edit_overdub: false,
    is_ugc: false,
    aigc_history_id: '',
    aigc_item_id: '',
    wave_points: [] as unknown[],
  };
}

/**
 * 构建 §4.5 Text Material（80+ 字段）。
 *
 * 必填项：
 *   - check_flag = 7（手册 §4.5）
 *   - content：formatTextContent() 产出的字符串化 JSON（含 range / strokes / fill 嵌套，坑位 2-4）
 *   - words：逐字时间数组，无 ASR 时默认按 durationUs 均匀拆成 {end_time:[],start_time:[],text:[]}
 *   - 字体：font_title="none"，其余空串（剪映打开时用系统默认字体，不阻断渲染）
 *   - alignment/letter_spacing/line_spacing/line_max_width：来自字幕样式
 */
function buildTextMaterial(
  textId: string,
  text: string,
  subtitleStyle: SubtitleStyle,
  durationUs: number,
): unknown {
  const fontSize = subtitleStyle.fontSize ?? 8.0;
  // types.ts 约定：alignment 0=左对齐 / 1=底部居中 / 2=右对齐。非法值回退居中。
  let alignment = Number(subtitleStyle.alignment);
  if (![0, 1, 2].includes(alignment)) alignment = 1;

  return {
    id: textId,
    local_material_id: textId,
    type: 'text',
    name: text.slice(0, 20),
    content: formatTextContent(text, subtitleStyle),
    font_path: '',
    font_size: Number(fontSize) || 8.0,
    font_title: 'none',
    font_id: '',
    font_name: '',
    font_category_id: '',
    font_category_name: '',
    font_resource_id: '',
    font_source_platform: 0,
    font_team_id: '',
    font_url: '',
    fonts: [] as unknown[],
    bold_width: 0.0,
    italic_degree: 0,
    underline: false,
    underline_offset: 0.22,
    underline_width: 0.05,
    letter_spacing: Number(subtitleStyle.letterSpacing ?? 0.0),
    line_spacing: Number(subtitleStyle.lineSpacing ?? 0.02),
    line_max_width: Number(subtitleStyle.lineMaxWidth ?? 0.82),
    line_feed: 1,
    text_size: 30,
    text_alpha: 1.0,
    text_color: '',
    text_curve: null,
    background_alpha: 1.0,
    background_color: '',
    background_height: 0.14,
    background_width: 0.14,
    background_horizontal_offset: 0.0,
    background_vertical_offset: 0.0,
    background_round_radius: 0.0,
    background_style: 0,
    border_alpha: 1.0,
    border_color: '',
    border_width: 0.06,
    shadow_alpha: 0.8,
    shadow_angle: 0.0,
    shadow_color: '',
    shadow_distance: 0.0,
    shadow_point: { x: 0.0, y: 0.0 },
    shadow_smoothing: 0.0,
    has_shadow: false,
    alignment,
    caption_template_info: {
      category_id: '', category_name: '', effect_id: '', is_new: false,
      path: '', request_id: '', resource_id: '', source_platform: 0, team_id: '',
    },
    check_flag: 7,
    add_type: 0,
    sub_type: 0,
    combo_info: { text_templates: [] as unknown[] },
    initial_scale: 0.0,
    inner_padding: -1.0,
    fixed_width: -1.0,
    fixed_height: -1.0,
    force_apply_line_max_width: false,
    global_alpha: 1.0,
    group_id: '',
    is_rich_text: false,
    ktv_color: '',
    language: '',
    layer_weight: 0,
    original_size: [] as unknown[],
    preset_category: '',
    preset_category_id: '',
    preset_has_set_alignment: false,
    preset_id: '',
    preset_index: 0,
    preset_name: '',
    recognize_task_id: '',
    recognize_type: 0,
    relevance_segment: [] as unknown[],
    shape_clip_x: false,
    shape_clip_y: false,
    source_from: '',
    style_name: '',
    subtitle_keywords: null,
    subtitle_template_original_fontsize: 0.0,
    text_preset_resource_id: '',
    text_to_audio_ids: [] as unknown[],
    tts_auto_update: false,
    typesetting: 0,
    use_effect_default_color: true,
    words: {
      end_time: [] as number[],
      start_time: [] as number[],
      text: [] as string[],
    },
    _durationUs: durationUs,
  };
}

/**
 * 构建画布素材（canvases 容器，手册 §4.2 标记"非空"）。
 * 一条即可，格式按原生 test_doc_draft 的画布最小化骨架。
 */
function buildCanvasMaterial(canvasId: string, durationUs: number): unknown {
  return {
    id: canvasId,
    material_id: canvasId,
    local_material_id: '',
    local_id: '',
    material_name: '',
    type: 'canvas',
    category_name: 'local',
    path: '',
    media_path: '',
    duration: durationUs,
    width: 1920,
    height: 1080,
    has_audio: false,
    source: 0,
    source_platform: 0,
    check_flag: 63487,
    crop_ratio: 'free',
    crop_scale: 1.0,
    audio_fade: null,
    crop: {
      upper_left_x: 0.0, upper_left_y: 0.0,
      upper_right_x: 1.0, upper_right_y: 0.0,
      lower_left_x: 0.0, lower_left_y: 1.0,
      lower_right_x: 1.0, lower_right_y: 1.0,
    },
    matting: {
      flag: 0, has_use_quick_brush: false, has_use_quick_eraser: false,
      interactiveTime: [], path: '', strokes: [],
    },
    stable: { matrix_path: '', stable_level: 0, time_range: { duration: 0, start: 0 } },
    video_algorithm: {
      algorithms: [], complement_frame_config: null, deflicker: null,
      gameplay_configs: [], motion_blur_config: null, noise_reduction_config: null,
      path: '', quality_enhance: null, smart_stabilizer: null, super_resolution_config: null,
    },
    freeze: null, smart_motion: null, object_locked: null,
    picture_from: 'none', picture_set_category_id: '', picture_set_category_name: '',
    is_ai_generate_content: false, is_copyright: false, is_text_edit_overdub: false,
    is_unified_beauty_mode: false, aigc_history_id: '', aigc_item_id: '', aigc_type: 'none',
    cartoon_path: '', category_id: '', extra_type_option: 0, formula_id: '',
    intensifies_audio_path: '', intensifies_path: '', material_url: '',
    origin_material_id: '', request_id: '', reverse_intensifies_path: '',
    reverse_path: '', team_id: '',
  };
}

/**
 * 构建变速素材（materials.speeds 容器，手册 §4.2 非空）。
 * 每个"视频段"对应一条 speed：speed=1.0 时为默认直通骨架。
 */
function buildSpeedMaterial(speedId: string, videoId: string, speed: number, durationUs: number): unknown {
  return {
    id: speedId,
    material_id: videoId,
    duration: durationUs,
    speed,
    is_advanced_splicing: false,
    is_audio_mute: false,
    is_separate_audio: false,
    speed_mode: 0,
    curve: [] as unknown[],
    video_start: 0,
    video_end: durationUs,
  };
}

/**
 * 构建声道映射素材（materials.sound_channel_mappings 容器，手册 §4.2 非空）。
 * 视频原声 1 条（已静音但仍需占位）+ TTS 1 条（或没有 TTS 时就视频+BGM 两条）。
 */
function buildSoundChannelMapping(id: string, audioMaterialId: string, durationUs: number): unknown {
  return {
    id,
    material_id: audioMaterialId,
    duration: durationUs,
    channel_layout: 3,
    channel_mode: 0,
    left_channel: [],
    right_channel: [],
  };
}

/**
 * 构建人声分离素材（materials.vocal_separations 容器，手册 §4.2 非空）。
 * 每条音轨一条，默认不启用人声分离（level=0）。
 */
function buildVocalSeparation(id: string, audioMaterialId: string, durationUs: number): unknown {
  return {
    id,
    material_id: audioMaterialId,
    duration: durationUs,
    level: 0,
    is_main_vocal: false,
  };
}

/**
 * 素材装配：遍历编译镜头，生成 videos / audios / texts 三类素材，并产出镜头素材引用；
 * 同时生成 canvases / sound_channel_mappings / speeds / vocal_separations 四个支撑容器。
 *
 * 设计：
 *   - 输入 probeMap：所有视频素材文件的 ffprobe 结果（按路径缓存，失败 fail-fast）
 *   - canvases 固定 1 条（画布占位）
 *   - speeds：每个视频段一条（即便 speed=1.0 也要有，保证 §4.2 "非空" 约束）
 *   - sound_channel_mappings：视频段声轨 + 每个 TTS + BGM，最小 N+1 条
 *   - vocal_separations：同上数量
 */
export function assembleMaterials(
  shots: CompileShot[],
  mediaPath: string,
  probeMap: Map<string, VideoProbeResult>,
  options: { bgmPath?: string; subtitleStyle?: SubtitleStyle } = {},
): MaterialsResult {
  const subtitleStyle = options.subtitleStyle ?? DEFAULT_SUBTITLE_STYLE;
  const safeMediaPath = (mediaPath || '').replace(/\\/g, '/');
  const videos: unknown[] = [];
  const audios: unknown[] = [];
  const texts: unknown[] = [];
  const shotRefs: ShotMaterialRef[] = [];

  // ---- 支撑容器 ----
  const speeds: unknown[] = [];
  const soundChannelMappings: unknown[] = [];
  const vocalSeparations: unknown[] = [];

  let bgmRef: BgmMaterialRef | undefined;
  const totalDurationUs = shots.reduce((s, sh) => s + resolveDurationUs(sh), 0);

  // -- BGM 素材（整片铺底） --
  if (options.bgmPath) {
    const bgmId = genHexId();
    audios.push(
      buildAudioMaterial(
        bgmId,
        String(options.bgmPath).replace(/\\/g, '/'),
        'music',
        totalDurationUs,
      ),
    );
    bgmRef = { bgmId, totalDurationUs };
    soundChannelMappings.push(buildSoundChannelMapping(genHexId(), bgmId, totalDurationUs));
    vocalSeparations.push(buildVocalSeparation(genHexId(), bgmId, totalDurationUs));
  }

  // -- 逐镜头素材 --
  for (const shot of shots) {
    const durationUs = resolveDurationUs(shot);
    const vMatId = genHexId();
    const chunk = shot.chunkData as Record<string, unknown> | null | undefined;
    const videoPath = chunk?.filePath
      ? String(chunk.filePath).replace(/\\/g, '/')
      : safeMediaPath;

    // ffprobe 严格 fail-fast：找不到则抛错（probeMap 必须覆盖所有用到的视频文件）
    const probe = probeMap.get(videoPath);
    if (!probe) {
      throw new Error(
        `[assembleMaterials] 缺少视频探针结果：${videoPath}。` +
        `请先调用 probeVideoBatchSync 批量获取元数据后再装配。`,
      );
    }

    // A. 视频素材（54 字段）
    videos.push(buildVideoMaterial(shot, vMatId, safeMediaPath, durationUs, probe));

    const speed = shot.appliedSpeedFactor || 1.0;
    const ref: ShotMaterialRef = {
      shotId: shot.id,
      videoId: vMatId,
      durationUs,
      sourceStartUs: shot.chunkData?.startMs != null
        ? Math.round(Number(shot.chunkData.startMs) * 1000)
        : 0,
      speed,
    };

    // B. 变速：每个视频段一条（即便 speed=1.0 也要填充，保证 speeds 非空）
    const speedId = genHexId();
    ref.speedRefId = speedId;
    speeds.push(buildSpeedMaterial(speedId, vMatId, speed, durationUs));

    // C. 视频声道映射 + 人声分离占位（视频原声已静音，但容器非空）
    soundChannelMappings.push(buildSoundChannelMapping(genHexId(), vMatId, durationUs));
    vocalSeparations.push(buildVocalSeparation(genHexId(), vMatId, durationUs));

    // D. AI 配音音频（TTS 轨，type=extract_music）
    if (shot.audioPath) {
      const aMatId = genHexId();
      const cleanAudioPath = String(shot.audioPath)
        .replace('magic://local/', '')
        .replace('file://', '')
        .replace(/\\/g, '/');
      audios.push(buildAudioMaterial(aMatId, cleanAudioPath, 'extract_music', durationUs));
      ref.audioId = aMatId;
      soundChannelMappings.push(buildSoundChannelMapping(genHexId(), aMatId, durationUs));
      vocalSeparations.push(buildVocalSeparation(genHexId(), aMatId, durationUs));
    }

    // E. AI 字幕（80+ 字段）
    const contentText = shot.aiText || shot.originalText || '';
    if (contentText) {
      const tMatId = genHexId();
      texts.push(buildTextMaterial(tMatId, contentText, subtitleStyle, durationUs));
      ref.textId = tMatId;
    }

    shotRefs.push(ref);
  }

  // -- 画布：固定 1 条，时长 = 总时长 --
  const canvases = [buildCanvasMaterial(genHexId(), totalDurationUs || 1_000_000)];

  return {
    videos,
    audios,
    texts,
    support: {
      canvases,
      sound_channel_mappings: soundChannelMappings,
      speeds,
      vocal_separations: vocalSeparations,
    },
    shotRefs,
    bgmRef,
  };
}
