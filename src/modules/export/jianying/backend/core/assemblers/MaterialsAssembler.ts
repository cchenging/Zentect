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
import { formatTextContent, sanitizeSubtitleText, stripTtsControlMarkers, wrapSubtitleText } from '../utils/TextContentFormatter';
import {
  SUBTITLE_LINE_WIDTH_LIMIT,
  SUBTITLE_LINE_WIDTH_LIMIT_PORTRAIT,
} from '../../../../../../shared/utils/subtitleLayout';
import type { VideoProbeResult } from '../utils/FfprobeProber';
import type { PauseInterval } from '../utils/AudioPauseProber';

/** 原声段逐行字幕条引用：offsetUs = 相对本镜头目标起点的显示偏移 */
export interface SubtitleCueRef {
  /** 字幕素材 id */
  textId: string;
  /** 相对镜头目标起点的偏移（微秒） */
  offsetUs: number;
  /** 显示时长（微秒） */
  durationUs: number;
}

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
  /**
   * 🎙️ 原声段逐行字幕：存在时轨道层按条生成多段字幕（每行只在自己的 ASR 起止时间内显示）；
   * 缺省 = 退回单条字幕（textId 覆盖整段）。
   */
  textCues?: SubtitleCueRef[];
  /** 目标时长（微秒） */
  durationUs: number;
  /** 源切片起始（微秒） */
  sourceStartUs: number;
  /** 源切片时长（微秒，来自 chunkData.endMs-startMs；缺省退化为 durationUs） */
  sourceDurationUs?: number;
  /** 变速因子 */
  speed: number;
  /** 是否保留原片原声（原声段音量开足，不配 TTS 配音） */
  keepOriginalAudio?: boolean;
  /** 视频变速引用 id（指向 materials.speeds，speed≠1.0 时关联） */
  speedRefId?: string;
  /** 🎬 阶段 A：所属合并组 id（同一物理镜头内源时间连续的兄弟段共享，轨道层据此合并为单 clip） */
  sceneGroupId?: string;
  /** 未匹配镜头：视频轨用源视频末帧定格（sourceStartUs=末帧位置、sourceDurationUs=0） */
  unmatched?: boolean;
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
 * 末帧定格：计算源视频"末帧"的源时间起点（微秒）。
 * 剪映 source_timerange.duration=0 时定格 start 处那一帧；start 应落在源视频最后一帧的可显示位置，
 * 即总时长前移一帧时长，避免正好压在视频末尾（末尾余帧可能空帧）。
 */
function lastFrameStartUs(probe: VideoProbeResult): number {
  const oneFrameUs = probe.fps > 0 ? Math.round(MICRO_SECOND / probe.fps) : 33_333;
  return Math.max(0, Math.round(probe.durationSec * MICRO_SECOND) - oneFrameUs);
}

/**
 * 计算单个镜头的目标时长（微秒）：优先配音时长，其次段落时长，最后 end-start。
 */
function resolveDurationUs(shot: CompileShot): number {
  return Math.round(
    (shot.audioDuration || (shot.end - shot.start)) * MICRO_SECOND,
  );
}

/**
 * 计算单个镜头的源切片时长（微秒）：优先 chunkData 的 endMs-startMs（源时间轴真实长度），
 * 无切片数据时退化为目标时长。
 * 🎙️ 原声段（第五轮）：源时长 = ASR 精确台词窗时长（videoTimelineEndMs - videoTimelineStartMs），
 * 与 source in/out、轨道槽三窗同长，保证 speeds 素材与 segment.speed=1 自洽（组内 speed 一致性）。
 */
function resolveSourceDurationUs(shot: CompileShot): number {
  if (
    shot.keepOriginalAudio === true &&
    typeof shot.videoTimelineStartMs === 'number' &&
    typeof shot.videoTimelineEndMs === 'number' &&
    shot.videoTimelineEndMs > shot.videoTimelineStartMs
  ) {
    return Math.round((shot.videoTimelineEndMs - shot.videoTimelineStartMs) * 1000);
  }
  const chunk = shot.chunkData as Record<string, unknown> | null | undefined;
  if (
    chunk &&
    typeof chunk.startMs === 'number' &&
    typeof chunk.endMs === 'number'
  ) {
    return Math.round((chunk.endMs - chunk.startMs) * 1000);
  }
  return resolveDurationUs(shot);
}

/**
 * 🔧 E域（§10.2.6 动作1）：解析"裁剪优先、变速兜底"的源窗决策。
 *
 * 补丁12（变速恒定 1.00x + 物理截取）/ 补丁15（出入点避高动态）的物理落点。
 * 规则：
 *   - 源时长 ≥ 目标时长 → 变速锁定 1.00x，在源窗内选高光子窗对齐目标（纯子窗裁剪）：
 *       · 默认取源窗**靠后**段（解说语料多聚焦后半段动作高潮，出点↔入点优先对齐句尾），
 *         子窗时长为目标时长（不越源窗右界）。
 *       · 动作未落点允许源窗起点前移 ≤300ms（Drop Lead-in，削除起手准备段，叠补丁7 弹性腔）。
 *   - 源时长 < 目标时长 → **禁止线性拉伸**：回退全窗 + speed 恒 1.00x（2026-10-15 慢放修复）。
 *     上游硬不变量「交付窗长 ≥ 配音时长」（solver 侧供给硬过滤 + 重排落点换片）生效后，本分支
 *     即为**欠覆盖残差**（不该出现的数据缺陷）：此时如实按 1.00x 放原始源窗，缺料差额由剪映
 *     自身的「源范围不足槽长 ⇒ 末帧保持」承担，绝不靠放慢画面把 0.2s 素材撑满 3s 槽。
 *     ⚠️ 本函数只被**单成员组**调用（见下）；多成员合并组根本不经此处，其 speed 由轨道层按
 *     「源总时长 / 目标总时长」派生 ⇒ 慢放修复必须同时在 TracksAssembler 落同样下限。
 *   - isExactSpeed 哨兵（动作2）：为 true 时强制 speed=1.00x、只准子窗裁剪，杜绝 linear stretch。
 *
 * @param chunkData 切片数据（startMs/endMs/motionScore，源坐标）
 * @param sourceStartMs 源切片起始（毫秒，已含原声 ASR 窗或普通段 chunk 窗）
 * @param sourceDurMs 源窗长度（毫秒）
 * @param targetDurMs 目标时长（毫秒）
 * @param isExactSpeed 哨兵：纯裁剪段禁止拉伸
 * @returns { sourceStartUs, sourceDurationUs, speed } 裁剪/变速后的源窗与变速因子（微秒）
 */
function resolveCutWindow(
  chunkData: Record<string, unknown> | null | undefined,
  sourceStartMs: number,
  sourceDurMs: number,
  targetDurMs: number,
  isExactSpeed: boolean,
): { sourceStartUs: number; sourceDurationUs: number; speed: number } {
  const ckStart = Number(chunkData?.startMs ?? NaN);
  const ceilingEndUs = Math.round(Math.max(sourceStartMs + sourceDurMs, Number(chunkData?.endMs ?? NaN)) * 1000);

  // —— 子窗靠后裁剪（动作落点对齐句尾）——
  if (isExactSpeed || (sourceDurMs >= targetDurMs && targetDurMs > 0)) {
    // 子窗右端默认顶到源窗末（句尾对齐）；有效 endMs 时以其为上界。
    const canUseEnd = Number.isFinite(ckStart) && Number.isFinite(Number(chunkData?.endMs ?? NaN));
    const rightEndUs = canUseEnd
      ? Math.round(Number(chunkData?.endMs) * 1000)
      : ceilingEndUs;
    const rightEndUsClamped = Math.min(rightEndUs, Math.round((sourceStartMs + sourceDurMs) * 1000));
    const subStartUs = Math.max(
      Math.round(sourceStartMs * 1000),
      rightEndUsClamped - Math.round(targetDurMs * 1000),
    );
    // 丢起手准备段（Drop Lead-in）：动作未落点时源窗起点前移 ≤300ms，缓解「起手僵直」。
    const leadInDropUs = Math.min(300 * 1000, Math.max(0, subStartUs - Math.round(sourceStartMs * 1000)));
    const finalStartUs = subStartUs - leadInDropUs;
    return {
      sourceStartUs: finalStartUs,
      sourceDurationUs: Math.round(targetDurMs * 1000),
      speed: 1.0,
    };
  }

  // —— 欠覆盖残差（源窗 < 目标）：回退全窗 + 1.00x，**禁止线性拉伸** ——
  //   上游「交付窗长 ≥ 配音时长」硬不变量下该分支不该出现；出现即如实暴露（源窗原样、不放慢）。
  return {
    sourceStartUs: Math.round(sourceStartMs * 1000),
    sourceDurationUs: Math.round(sourceDurMs * 1000),
    speed: 1.0,
  };
}

/**
 * 🎬 阶段 A：视频素材合并组。
 * 同一物理镜头内源时间连续的兄弟段（sceneGroupId 相同）共享一个视频素材，
 * 轨道层据此输出单个连续 clip，消除假转场与物理接缝。
 */
interface ShotGroup {
  /** 合并组 id（= 首段 sceneGroupId；无组标记的独立段自成组） */
  groupId: string;
  /** 组首镜头下标 */
  leadIndex: number;
  /** 组首镜头（决定素材 path/probe/变速） */
  leadShot: CompileShot;
  /** 组内成员下标 */
  memberIndices: number[];
  /** 整组目标时长（微秒，各成员 target 累加，已按各自 speed 换算） */
  totalTargetUs: number;
  /** 整组源切片时长（微秒，各成员真实源时长累加） */
  totalSourceUs: number;
  /** 组首变速因子 */
  leadSpeed: number;
  /** 组视频素材路径 */
  videoPath: string;
  /** 组视频素材 ffprobe 结果 */
  probe: VideoProbeResult;
}

/**
 * 🎬 阶段 A：按 sceneGroupId 将镜头序列分组。
 * 未标记 sceneGroupId 的独立段各成一组（行为与旧版逐镜头素材完全一致）。
 * 返回 { groups, shotGids }，shotGids[i] 给出 shots[i] 所属组 id。
 */
function buildSceneGroups(
  shots: CompileShot[],
  probeMap: Map<string, VideoProbeResult>,
  safeMediaPath: string,
): { groups: Map<string, ShotGroup>; shotGids: string[] } {
  const groups = new Map<string, ShotGroup>();
  const shotGids: string[] = new Array(shots.length);
  let soloSeq = 0;

  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i];
    const gid = shot.sceneGroupId;
    if (gid && groups.has(gid)) {
      const g = groups.get(gid)!;
      g.memberIndices.push(i);
      g.totalTargetUs += resolveDurationUs(shot);
      g.totalSourceUs += resolveSourceDurationUs(shot);
      shotGids[i] = gid;
    } else {
      const chunk = shot.chunkData as Record<string, unknown> | null | undefined;
      /** 🎙️ 原声段素材强制源视频（2026-09-04 阶段1-防线 F）：原声段视频窗=ASR 精确台词窗（源坐标），
       *  可能落在任意源位置、常跨多个 3s 切片或 body 裁剪文件边界——只有源视频整片能保证任意窗可裁；
       *  若沿用承载切片 filePath（body 文件/短切片），源坐标窗口会超素材边界。 */
      const videoPath = shot.keepOriginalAudio === true
        ? safeMediaPath
        : (chunk?.filePath ? String(chunk.filePath).replace(/\\/g, '/') : safeMediaPath);
      // ffprobe 严格 fail-fast：找不到则抛错（probeMap 必须覆盖所有用到的视频文件）
      const probe = probeMap.get(videoPath);
      if (!probe) {
        throw new Error(
          `[assembleMaterials] 缺少视频探针结果：${videoPath}。` +
          `请先调用 probeVideoBatchSync 批量获取元数据后再装配。`,
        );
      }
      const key = gid || `solo_${(soloSeq++).toString(36)}_${i}`;
      groups.set(key, {
        groupId: key,
        leadIndex: i,
        leadShot: shot,
        memberIndices: [i],
        totalTargetUs: resolveDurationUs(shot),
        totalSourceUs: resolveSourceDurationUs(shot),
        /** 🎙️ 原声段恒原速（第五轮）：leadSpeed 兜底路径与主循环 speed 同口径，原声段强制 1.0 */
        leadSpeed: shot.keepOriginalAudio === true ? 1.0 : (shot.appliedSpeedFactor || 1.0),
        videoPath,
        probe,
      });
      shotGids[i] = key;
    }
  }

  return { groups, shotGids };
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
  /** 🎙️ 原声段素材强制源视频（2026-09-04 阶段1-防线 F）：与 group 创建同规则（见上），保证原声段 video 素材=源整片 */
  const videoPath = shot.keepOriginalAudio === true
    ? safeMediaPath
    : (chunk?.filePath ? String(chunk.filePath).replace(/\\/g, '/') : safeMediaPath);

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
    crop_scale: 1,
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
    // 素材名取单行（折行后的 \n 会污染剪映素材名显示）
    name: text.replace(/\n+/g, ' ').slice(0, 20),
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
 * 切点吸附上限（毫秒）：比例切点距最近静音中点超过该距离，视为与真实换气无关，保持原切点。
 * 实测最长偏差约 580ms，取 700ms 可覆盖「逗号处实际没停顿」的句子。
 */
const SNAP_MAX_DISTANCE_MS = 700;
/** 吸附后每条字幕的最短显示时长（毫秒），防止切点被拖到相邻切点旁造成一闪而过 */
const SNAP_MIN_CUE_MS = 250;

/**
 * 字幕切点吸附：把按字数比例算出的切点移到「真实静音（换气）中点」。
 *
 * 规则：
 *  - 每个切点找最近的、未被占用的静音中点；超过 SNAP_MAX_DISTANCE_MS 则不动；
 *  - 吸附后必须与前后切点保持 SNAP_MIN_CUE_MS 以上间隔，且不越过下一切点的原始位置（防级联漂移）；
 *  - 任何一个切点非法（<= 前一切点）则整体回退原始比例切点，保证不产出重叠字幕。
 *
 * @param cues   比例切点（offset 相对镜头起点，微秒，首尾贴合整段）
 * @param pauses 配音静音区间（毫秒）；空/缺省 → 原样返回
 */
function snapCueCuts(
  cues: Array<{ content: string; offsetUs: number; durationUs: number }>,
  pauses: PauseInterval[] | undefined,
): Array<{ content: string; offsetUs: number; durationUs: number }> {
  if (!pauses || pauses.length === 0 || cues.length < 2) return cues;
  const last = cues[cues.length - 1];
  const totalMs = (last.offsetUs + last.durationUs) / 1000;
  if (!(totalMs > 0)) return cues;

  // 静音中点作为换气位置；首尾不参与（切点本身已贴在 0 / 段尾）
  const mids = pauses
    .filter((p) => Number.isFinite(p.startMs) && Number.isFinite(p.endMs) && p.endMs > p.startMs)
    .map((p) => Math.round((p.startMs + Math.min(p.endMs, totalMs)) / 2))
    .filter((m) => m > SNAP_MIN_CUE_MS && m < totalMs - SNAP_MIN_CUE_MS);
  if (mids.length === 0) return cues;

  const used = new Set<number>();
  /** 新切点（微秒）：未吸附的切点保留原始微秒精度，避免毫秒取整带来的额外偏差 */
  const cutsUs: number[] = [];
  let prevUs = 0;
  for (let i = 1; i < cues.length; i++) {
    const origUs = cues[i].offsetUs;
    const origMs = Math.round(origUs / 1000);
    const nextOrigMs = i + 1 < cues.length ? Math.round(cues[i + 1].offsetUs / 1000) : totalMs;
    let cutUs = origUs;
    let snapped = false;

    let bestIdx = -1;
    let bestDist = Infinity;
    for (let j = 0; j < mids.length; j++) {
      if (used.has(j)) continue;
      const d = Math.abs(mids[j] - origMs);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = j;
      }
    }
    if (bestIdx >= 0 && bestDist <= SNAP_MAX_DISTANCE_MS) {
      const candidate = mids[bestIdx];
      const lower = prevUs + SNAP_MIN_CUE_MS * 1000;
      const upper = nextOrigMs * 1000 - SNAP_MIN_CUE_MS * 1000;
      if (candidate * 1000 >= lower && candidate * 1000 <= upper) {
        cutUs = candidate * 1000;
        snapped = true;
        used.add(bestIdx);
      }
    }

    if (snapped && cutUs < prevUs + SNAP_MIN_CUE_MS * 1000) {
      cutUs = prevUs + SNAP_MIN_CUE_MS * 1000;
    }
    if (cutUs <= prevUs || cutUs >= totalMs * 1000 - SNAP_MIN_CUE_MS * 1000) {
      return cues; // 异常：回退原始配比
    }
    cutsUs.push(cutUs);
    prevUs = cutUs;
  }

  const totalUs = Math.round(totalMs * 1000);
  const rebuilt = cues.map((cue, i) => {
    const startUs = i === 0 ? 0 : cutsUs[i - 1];
    const endUs = i === cues.length - 1 ? totalUs : cutsUs[i];
    return {
      content: cue.content,
      offsetUs: startUs,
      durationUs: endUs - startUs,
    };
  });
  return rebuilt.every((c) => c.durationUs > 0) ? rebuilt : cues;
}

/** 句子重启词：在这些字之前断开，比按字数硬切更自然（实测「…另一个女人／她还不知道」） */
const CLAUSE_RESTART_CHAR = /[却但而可还竟偏原这那又就]/;
/** 主语代词优先：断在「她/他/它」前，句子读起来才像重新起头 */
const SUBJECT_PRONOUN_CHAR = /[她他它]/;

/**
 * 把超出一行宽的字幕短语再切短（2026-10-25，修「一条字幕 19 字铺满屏」）。
 *
 * 优先断在主语代词（她/他/它）前，其次断在「句子重启词」（却/但/而/可/还…）前，
 * 且保证切出的头片不少于行宽的 60%，避免切出「同一趟」这种过短碎片；
 * 没有合适断点时按行宽硬切。
 *
 * @param clean     已清洗（无标点）的字幕短语
 * @param lineLimit 单行等效宽度
 * @returns 每片 ≤ lineLimit 等效宽（末片可能更短）
 */
function splitLongCue(clean: string, lineLimit: number): string[] {
  if (clean.length <= lineLimit) return [clean];
  const out: string[] = [];
  let rest = clean;
  while (rest.length > lineLimit) {
    const minHead = Math.ceil(lineLimit * 0.6);
    let cut = lineLimit;
    for (const probe of [SUBJECT_PRONOUN_CHAR, CLAUSE_RESTART_CHAR]) {
      for (let i = lineLimit; i >= minHead; i--) {
        if (probe.test(rest[i] || '')) {
          cut = i;
          break;
        }
      }
      if (cut !== lineLimit) break;
    }
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * 函数级中文注释：把一段解说按「换气级」标点切成多条字幕（2026-10-23，修「一长条显示到音频结束」）。
 *
 * 背景：解说段原先整段只生成一条字幕素材，剪映里从开口一直显示到音频结束；而断句器只作用于
 * LLM 原始分镜，章节重生成/编辑器等路径可能留下 >24 字长段落（实测 seg_28 32 字含两个逗号），
 * 播放时就是一大坨文字。这里在导出层按标点切短语、按显示字数比例分摊该段音频时长，
 * 实现「读到哪句显示哪句，换气后切下一句」。
 *
 * 切分口径：
 *  - 优先在句号级（。！？；）与逗号级（，、）后切分，破折号/省略号/冒号同样算换气点，标点本身在清洗阶段去掉；
 *  - 单片仍超过一行宽时，在「句子重启词」处再切开，避免出现 19 字铺满屏的单条字幕；
 *  - 清洗后为空的片（纯符号）直接丢弃。
 * 时长分配：
 *  - 按清洗后字数比例分摊整段音频时长，前缀和铺排、末片吸收余量，片间不重叠且首尾贴合；
 *  - 估算不足 120ms 的碎片并入前一片，避免一闪而过。
 *
 * @param rawText     原始字幕文案（含标点）
 * @param durationUs  本镜头目标时长（微秒）
 * @param lineLimit   字幕行宽（等效显示宽度）
 * @param pauses      配音静音区间（毫秒）：给出时把比例切点吸附到真实换气点
 * @returns 逐片内容 + 相对镜头起点的偏移/时长；不足 2 片时返回空数组（调用方回退单条整段字幕）
 */
function buildClauseCuePlans(
  rawText: string,
  durationUs: number,
  lineLimit: number,
  pauses?: PauseInterval[],
): Array<{ content: string; offsetUs: number; durationUs: number }> {
  if (!rawText || durationUs <= 0) return [];
  // ⚠️ 必须先剥 TTS 控制标记再按标点切分：标记内含冒号/括号，先切就会切出「[pause:」「400ms]」两片，
  //    清洗后方括号消失，只剩「pause」「400ms」残留在字幕上（2026-10-25 实测草稿）。
  const rawPhrases = stripTtsControlMarkers(String(rawText))
    // 破折号/省略号/冒号同样是换气点（实测「另一个女人——她还不知道」整条显示，2026-10-25）
    .split(/(?<=[。！？!?；;，,、—…：:])/)
    .map((s) => s.trim())
    .filter(Boolean);

  // 单条字幕上限 = 一行宽（横屏 16 / 竖屏 12 等效宽）。超过一行宽的短语在句子重启词处再切，
  // 不允许出现「一条字幕 19 字铺满屏、一直显示到该段配音结束」。
  const cleaned: string[] = [];
  for (const phrase of rawPhrases) {
    const clean = sanitizeSubtitleText(phrase);
    if (!clean) continue;
    for (const piece of splitLongCue(clean, lineLimit)) cleaned.push(piece);
  }
  if (cleaned.length < 2) return [];

  const weighted = cleaned.map((content) => ({ content, weight: Math.max(1, content.length) }));
  const totalWeight = weighted.reduce((sum, p) => sum + p.weight, 0);
  // 估算过短的片并入前片（避免一闪而过）；首片过短则保留（没有前片可并）
  const merged: Array<{ content: string; weight: number }> = [];
  for (const piece of weighted) {
    const estUs = Math.round((durationUs * piece.weight) / totalWeight);
    const prev = merged[merged.length - 1];
    if (prev && estUs < 120_000) {
      prev.content += piece.content;
      prev.weight += piece.weight;
    } else {
      merged.push({ ...piece });
    }
  }
  if (merged.length < 2) return [];

  const mergedWeight = merged.reduce((sum, p) => sum + p.weight, 0);
  const cues: Array<{ content: string; offsetUs: number; durationUs: number }> = [];
  let cursor = 0;
  merged.forEach((piece, i) => {
    const isLast = i === merged.length - 1;
    const durUs = isLast
      ? durationUs - cursor
      : Math.round((durationUs * piece.weight) / mergedWeight);
    if (durUs <= 0) return;
    cues.push({
      content: wrapSubtitleText(piece.content, lineLimit),
      offsetUs: cursor,
      durationUs: durUs,
    });
    cursor += durUs;
  });
  const snapped = snapCueCuts(cues, pauses);
  return snapped.length >= 2 ? snapped : [];
}

/**
 * 构建画布占位素材（materials.canvases 容器，手册 §4.2 标记"非空"，一条即可）。
 * @param canvasId 画布素材 id
 * @param durationUs 总时长（微秒）
 * @param size 画布尺寸（宽×高）；跟随源视频分辨率，横竖屏自适应，默认兜底 1920×1080
 */
function buildCanvasMaterial(
  canvasId: string,
  durationUs: number,
  size: { width: number; height: number } = { width: 1920, height: 1080 },
): unknown {
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
    width: size.width,
    height: size.height,
    has_audio: false,
    source: 0,
    source_platform: 0,
    check_flag: 63487,
    crop_ratio: 'free',
    crop_scale: 1,
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
  options: {
    bgmPath?: string;
    subtitleStyle?: SubtitleStyle;
    /** 画布尺寸（宽×高）：跟随源视频分辨率，缺省 1920×1080 */
    canvasSize?: { width: number; height: number };
    /**
     * 配音静音区间（按镜头 id）：用于把解说字幕切点吸附到真实换气点。
     * 缺省 = 纯字数比例切点（历史行为）。
     */
    pauseHints?: Map<string, PauseInterval[]>;
  } = {},
): MaterialsResult {
  const subtitleStyle = options.subtitleStyle ?? DEFAULT_SUBTITLE_STYLE;
  // 🎬 字幕行宽随画幅取向：竖屏画布更窄，行宽收紧到 12 等效宽（横屏 16）。
  // 与 DraftContentAssembler 的 isPortrait 同判据（宽 < 高即竖屏）；无画布尺寸时按横屏处理。
  const subtitleLineLimit =
    options.canvasSize && options.canvasSize.height > options.canvasSize.width
      ? SUBTITLE_LINE_WIDTH_LIMIT_PORTRAIT
      : SUBTITLE_LINE_WIDTH_LIMIT;
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

  // -- 逐镜头素材（🎬 阶段 A：同物理镜头连续兄弟段共享一个视频素材，轨道层合并为单 clip） --
  // 按 sceneGroupId 分组：同组（同一物理镜头内源时间连续的兄弟段）共用一个视频素材，
  // 消除假转场与物理接缝；未标记分组的独立段自成一组（与旧版逐镜头行为完全一致）。
  const { groups, shotGids } = buildSceneGroups(shots, probeMap, safeMediaPath);
  const groupVideoId = new Map<string, string>();
  const groupSpeedId = new Map<string, string>();
  for (const [gid, g] of groups) {
    // 素材时长恒取「素材文件真实时长」（ffprobe durationSec）：
    //   schema v2 起普通段 chunk.filePath 与原声段素材均指向源视频整片，segment.source_timerange
    //   一律用源坐标（如 3844.84s）。若素材时长 = 目标时长（几秒），source 起点会远超素材时长，
    //   被剪映钳制到错误帧（全片每段画面都被拉到源片头部附近 → 「原声/画面全排在一起」）。
    //   末帧定格（未匹配镜头）分支原本即为此口径，现统一到全部组，杜绝越界钳制。
    const groupAssetDurationUs = Math.round(g.probe.durationSec * MICRO_SECOND);

    // A. 组视频素材（54 字段）：整组一个素材，duration = 素材时长（未匹配=源视频真实时长）
    const vMatId = genHexId();
    videos.push(buildVideoMaterial(g.leadShot, vMatId, safeMediaPath, groupAssetDurationUs, g.probe));

    // B. 组变速：整组一条（即便 speed=1.0 也要填充，保证 speeds 非空）。
    // 🎬 阶段 A：speed 用「源总时长 / 目标总时长」整体换算，与轨道层合并 clip 的 segment.speed 保持一致，
    // 避免组内成员 appliedSpeedFactor 不一致时素材 speeds 与 segment 速度映射错乱（用户评审隐患2）。
    const groupSpeed =
      g.totalTargetUs > 0 && g.totalSourceUs > 0 ? g.totalSourceUs / g.totalTargetUs : g.leadSpeed;
    const speedId = genHexId();
    speeds.push(buildSpeedMaterial(speedId, vMatId, groupSpeed, groupAssetDurationUs));

    // C. 组视频声道映射 + 人声分离占位（视频原声已静音，但容器非空）
    soundChannelMappings.push(buildSoundChannelMapping(genHexId(), vMatId, groupAssetDurationUs));
    vocalSeparations.push(buildVocalSeparation(genHexId(), vMatId, groupAssetDurationUs));

    groupVideoId.set(gid, vMatId);
    groupSpeedId.set(gid, speedId);
  }

  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i];
    const gid = shotGids[i];
    const g = groups.get(gid)!;
    const durationUs = resolveDurationUs(shot);
    const chunk = shot.chunkData as Record<string, unknown> | null | undefined;
    const vMatId = groupVideoId.get(gid)!;
    /** 🎙️ 原声段恒原速（第五轮）：原声段时长=ASR 台词真实时间窗，套用 KM/组变速会破坏台词听感
     *  （用户反馈：原声有的变速过快、有的太慢）。此处双保险——旧项目落库的变速值也在消费端拦下。 */
    let speed = shot.keepOriginalAudio === true ? 1.0 : (shot.appliedSpeedFactor || 1.0);

    /** 🎙️ 原声段源窗（第五轮）：直用 ASR 精确台词窗 videoTimelineStartMs/EndMs（与 chunk 同坐标系，
     *  素材=源视频完整文件可直接取窗）。此前用 chunk.startMs（3s 切片头）导致：
     *  ① 台词头部被切（实测 seg_7：ASR 窗 679000~681000ms，切片头 679640ms，头 640ms 台词丢失）；
     *  ② ASR 窗跨切片时（10.5s 窗 > 3s chunk）画面被截成 3s 后定格。
     *  解说段维持 chunk 窗口 + 变速（KM 语义不变）。 */
    let sourceStartUs: number;
    if (shot.keepOriginalAudio === true
      && typeof shot.videoTimelineStartMs === 'number'
      && typeof shot.videoTimelineEndMs === 'number'
      && shot.videoTimelineEndMs > shot.videoTimelineStartMs) {
      sourceStartUs = Math.round(shot.videoTimelineStartMs * 1000);
    } else {
      // 素材同源直取（2026-09-05 模式 A）：普通段素材 = chunk.filePath（schema v2 数据恒=源视频+源坐标；
      //  兼容遗留 body 文件产物 body 坐标——两种均与各自素材同参照），取窗 = chunk.startMs 直接可用，
      //  无需任何 body/源 坐标换算。chunk 缺失/无起点时回退 videoTimelineStartMs（源），杜绝取到 0。
      const ckStart = Number(chunk?.startMs ?? NaN);
      sourceStartUs = Number.isFinite(ckStart) && ckStart >= 0
        ? Math.round(ckStart * 1000)
        : Math.round((Number(shot.videoTimelineStartMs) || 0) * 1000);
    }
    let sourceDurationUs = resolveSourceDurationUs(shot);
    if (shot.unmatched === true) {
      // 末帧定格：源 = 源视频末帧，source 时长 0 → 剪映定格该帧（配合素材时长=源视频真实时长）
      sourceStartUs = lastFrameStartUs(g.probe);
      sourceDurationUs = 0;
    }

    // 🔧 E域（§10.2.6 动作1/3）：普通解说段走"裁剪优先、变速兜底"决策（补丁12/15 物理落点）。
    //   约束：
    //   - keepOriginalAudio（原声段回归）与 unmatched（末帧定格）分支不触碰，保持各自既有源窗逻辑。
    //   - 仅对**单成员组**施加裁剪：多成员合并组（sceneGroupId 同父连续兄弟段）依赖逐段 chunk 全窗+组变速
    //     保证源时间连续、无假转场，若逐段独立裁剪会产生源窗交叠/缝隙，破坏阶段 A 的合并连续性保证；
    //     且合并 clip 的 speed 由「源总时长/目标总时长」自洽派生（其下限钳制见 TracksAssembler）。
    //   结果用函数返回值覆盖源起点/源时长/变速（speed ∈ {1.00x 或 ≥1.0 的快进}，无慢放）。
    if (
      shot.keepOriginalAudio !== true
      && shot.unmatched !== true
      && g.memberIndices.length === 1
      && chunk
      && typeof chunk.startMs === 'number'
    ) {
      const cut = resolveCutWindow(
        chunk,
        sourceStartUs / 1000,
        sourceDurationUs / 1000,
        durationUs / 1000,
        shot.isExactSpeed === true,
      );
      sourceStartUs = cut.sourceStartUs;
      sourceDurationUs = cut.sourceDurationUs;
      speed = cut.speed;
    }

    const ref: ShotMaterialRef = {
      shotId: shot.id,
      videoId: vMatId,
      durationUs,
      sourceStartUs,
      sourceDurationUs,
      speed,
      keepOriginalAudio: shot.keepOriginalAudio === true,
      // 组内非首段共享首段视频素材；轨道层依据 sceneGroupId 合并为单 clip
      sceneGroupId: shot.sceneGroupId || undefined,
      unmatched: shot.unmatched === true,
    };
    ref.speedRefId = groupSpeedId.get(gid)!;

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
    // 原声段（keepOriginalAudio）：字幕只显示原声台词（originalText=段落文本，分析阶段已剥"原声："前缀），
    //   不显示 AI 解说词；解说段维持 AI 文案优先（aiText）。
    // 🎙️ 原声段逐行字幕（2026-10-23）：段落携带 asrSubLines 时，按 ASR 每行各自的起止时间生成多条字幕条，
    //   字幕随人声出现/消失，不再一条文本撑满整窗；无逐行数据则退回单条整段字幕。
    // 统一按行业规范清洗标点（sanitizeSubtitleText），素材 name 与 content 同步干净；
    // 再按字幕自身行宽独立折行（wrapSubtitleText）——字幕是渲染单位，与 TTS 承载/匹配单位
    // （断句器 ≤24 字碎片）解耦：24 字碎片折成两行，不整条挤一行挤出安全框。
    const winStartMs = typeof shot.videoTimelineStartMs === 'number' ? shot.videoTimelineStartMs : null;
    if (
      shot.keepOriginalAudio === true
      && winStartMs !== null
      && Array.isArray(shot.subtitleCues)
      && shot.subtitleCues.length > 0
    ) {
      const cueRefs: SubtitleCueRef[] = [];
      for (const cue of shot.subtitleCues) {
        const cleanCue = sanitizeSubtitleText(String(cue.text || ''));
        const cueContent = cleanCue ? wrapSubtitleText(cleanCue, subtitleLineLimit) : '';
        if (!cueContent) continue;
        /** 源坐标 → 镜头目标时间轴偏移（原声段恒 1.0×，无需按 speed 换算） */
        const offsetUs = Math.max(0, Math.min(Math.round((cue.startMs - winStartMs) * 1000), durationUs));
        const cueDurUs = Math.min(Math.round((cue.endMs - cue.startMs) * 1000), durationUs - offsetUs);
        if (cueDurUs < 100_000) continue; // 短于 0.1s 的字幕条人眼不可读，丢弃
        const cueMatId = genHexId();
        texts.push(buildTextMaterial(cueMatId, cueContent, subtitleStyle, cueDurUs));
        cueRefs.push({ textId: cueMatId, offsetUs, durationUs: cueDurUs });
      }
      if (cueRefs.length > 0) ref.textCues = cueRefs;
    }
    if (!ref.textCues) {
      const rawSubtitleText = shot.keepOriginalAudio === true
        ? (shot.originalText || shot.text || '')
        : (shot.aiText || shot.originalText || '');
      // 🎙️ 长句按「换气级」短语拆多条字幕（2026-10-23）：整段一条会从开口显示到音频结束，
      //   观众看到的是通篇连写的一大段；这里按标点切片 + 按字数分摊该段时长，读到哪句显示哪句。
      const clauseCues = buildClauseCuePlans(
        rawSubtitleText,
        durationUs,
        subtitleLineLimit,
        options.pauseHints?.get(shot.id),
      );
      if (clauseCues.length > 0) {
        const cueRefs: SubtitleCueRef[] = [];
        for (const cue of clauseCues) {
          const cueMatId = genHexId();
          texts.push(buildTextMaterial(cueMatId, cue.content, subtitleStyle, cue.durationUs));
          cueRefs.push({ textId: cueMatId, offsetUs: cue.offsetUs, durationUs: cue.durationUs });
        }
        ref.textCues = cueRefs;
      } else {
        const cleanSubtitleText = rawSubtitleText ? sanitizeSubtitleText(rawSubtitleText) : '';
        const contentText = cleanSubtitleText ? wrapSubtitleText(cleanSubtitleText, subtitleLineLimit) : '';
        if (contentText) {
          const tMatId = genHexId();
          texts.push(buildTextMaterial(tMatId, contentText, subtitleStyle, durationUs));
          ref.textId = tMatId;
        }
      }
    }

    shotRefs.push(ref);
  }

  // -- 画布：固定 1 条，时长 = 总时长，尺寸跟随源视频分辨率（横竖屏自适应） --
  const canvases = [
    buildCanvasMaterial(genHexId(), totalDurationUs || 1_000_000, options.canvasSize),
  ];

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
