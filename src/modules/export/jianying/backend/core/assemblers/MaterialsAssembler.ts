// 📁 路径：src/modules/export/jianying/backend/core/assemblers/MaterialsAssembler.ts
// 素材装配：将编译镜头编译为剪映 materials 的 videos / audios / texts 三类素材
//
// 职责：只负责「素材」的构建，不涉及轨道（轨道由 TracksAssembler 负责）。
// 设计原则：每个素材只做一件事；素材与轨道通过中间产物（materialId 映射）解耦。

import * as path from 'path';
import type { CompileShot } from '../../../types';
import type { SubtitleStyle } from '../../../types';
import { DEFAULT_SUBTITLE_STYLE } from '../../../types';
import { genHexId } from '../utils/IdUtils';
import { formatTextContent } from '../utils/TextContentFormatter';

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
}

/** BGM 素材装配结果 */
export interface BgmMaterialRef {
  /** BGM 素材 id */
  bgmId: string;
  /** BGM 铺设总时长（微秒） */
  totalDurationUs: number;
}

/** 素材装配结果：三类素材数组 + 镜头素材引用映射 */
export interface MaterialsResult {
  /** 视频素材数组 */
  videos: unknown[];
  /** 音频素材数组（BGM + TTS） */
  audios: unknown[];
  /** 字幕素材数组 */
  texts: unknown[];
  /** 每个镜头的素材引用（与 shots 一一对应） */
  shotRefs: ShotMaterialRef[];
  /** BGM 素材引用（无 BGM 时不设） */
  bgmRef?: BgmMaterialRef;
}

/** 空数组工厂：materials 中大量空子键 */
const emptyArrays = () => [] as unknown[];

/**
 * 微秒换算因子
 */
const MICRO_SECOND = 1_000_000;

/**
 * 计算单个镜头的目标时长（微秒）：优先配音让时长，其次段落时长，最后 end-start。
 *
 * @param shot 编译镜头
 * @returns 目标时长（微秒）
 */
function resolveDurationUs(shot: CompileShot): number {
  return Math.round(
    (shot.audioDuration || (shot.end - shot.start)) * MICRO_SECOND,
  );
}

/**
 * 构建视频素材（优先使用切片源，缺失回退源视频）。
 *
 * @param shot 编译镜头
 * @param videoId 素材 id
 * @param safeMediaPath 源视频（正斜杠）
 * @param durationUs 目标时长（微秒）
 * @returns 视频素材对象
 */
function buildVideoMaterial(
  shot: CompileShot,
  videoId: string,
  safeMediaPath: string,
  durationUs: number,
): unknown {
  const chunk = shot.chunkData as Record<string, unknown> | null | undefined;
  const videoPath = chunk?.filePath ? String(chunk.filePath).replace(/\\/g, '/') : safeMediaPath;

  return {
    id: videoId,
    local_material_id: '',
    material_id: videoId,
    material_name: path.basename(videoPath),
    path: videoPath,
    media_path: '',
    type: 'video',
    duration: durationUs,
    category_name: 'local',
    check_flag: 63487,
    crop_ratio: 'free',
    crop_scale: 1.0,
    audio_fade: null,
    crop: {
      upper_left_x: 0.0,
      upper_left_y: 0.0,
      upper_right_x: 1.0,
      upper_right_y: 0.0,
      lower_left_x: 0.0,
      lower_left_y: 1.0,
      lower_right_x: 1.0,
      lower_right_y: 1.0,
    },
  };
}

/**
 * 构建音频素材（BGM 用 type 'music'，TTS 用 type 'extract_music'）。
 *
 * @param audioId 素材 id
 * @param audioPath 音频绝对路径（已脱水）
 * @param type 素材类型
 * @param durationUs 时长（微秒）
 * @returns 音频素材对象
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
    path: audioPath,
    type,
    duration: durationUs,
    name: path.basename(audioPath),
    source_platform: 0,
    category_name: 'local',
    check_flag: 3,
    copyright_limit_type: 'none',
    effect_id: '',
    formula_id: '',
    app_id: 0,
    category_id: '',
    wave_points: emptyArrays(),
  };
}

/**
 * 构建字幕素材（content 为字符串化 JSON）。
 *
 * @param textId 素材 id
 * @param text 字幕文案
 * @param subtitleStyle 字幕样式
 * @returns 字幕素材对象
 */
function buildTextMaterial(
  textId: string,
  text: string,
  subtitleStyle: SubtitleStyle,
): unknown {
  return {
    id: textId,
    local_material_id: textId,
    content: formatTextContent(text, subtitleStyle),
    type: 'text',
    name: text.slice(0, 20),
  };
}

/**
 * 素材装配：遍历编译镜头，生成 videos / audios / texts 三类素材，并产出镜头素材引用。
 *
 * BGM 轨整片铺底（降音至 30%），其素材 id 通过 bgmRef 返回。
 *
 * @param shots 编译镜头数组
 * @param mediaPath 源视频路径（chunkData 缺失时回退源）
 * @param bgmPath 背景音乐路径（可选）
 * @param subtitleStyle 字幕样式（缺省用默认样式）
 * @returns 素材装配结果
 */
export function assembleMaterials(
  shots: CompileShot[],
  mediaPath: string,
  bgmPath?: string,
  subtitleStyle: SubtitleStyle = DEFAULT_SUBTITLE_STYLE,
): MaterialsResult {
  const safeMediaPath = (mediaPath || '').replace(/\\/g, '/');
  const videos: unknown[] = [];
  const audios: unknown[] = [];
  const texts: unknown[] = [];
  const shotRefs: ShotMaterialRef[] = [];

  let bgmRef: BgmMaterialRef | undefined;

  // -- BGM 素材（整片铺底） --
  if (bgmPath) {
    const bgmId = genHexId();
    const totalDurationUs = shots.reduce(
      (sum, s) => sum + resolveDurationUs(s),
      0,
    );
    audios.push(
      buildAudioMaterial(
        bgmId,
        (bgmPath || '').replace(/\\/g, '/'),
        'music',
        totalDurationUs,
      ),
    );
    bgmRef = { bgmId, totalDurationUs };
  }

  // -- 逐镜头素材 --
  for (const shot of shots) {
    const durationUs = resolveDurationUs(shot);
    const vMatId = genHexId();

    // A. 视频素材
    videos.push(buildVideoMaterial(shot, vMatId, safeMediaPath, durationUs));

    const ref: ShotMaterialRef = {
      shotId: shot.id,
      videoId: vMatId,
      durationUs,
      sourceStartUs: shot.chunkData?.startMs != null
        ? Math.round(Number(shot.chunkData.startMs) * 1000)
        : 0,
      speed: shot.appliedSpeedFactor || 1.0,
    };

    // B. AI 配音音频（TTS 轨）
    if (shot.audioPath) {
      const aMatId = genHexId();
      const cleanAudioPath = String(shot.audioPath)
        .replace('magic://local/', '')
        .replace('file://', '')
        .replace(/\\/g, '/');
      audios.push(
        buildAudioMaterial(aMatId, cleanAudioPath, 'extract_music', durationUs),
      );
      ref.audioId = aMatId;
    }

    // C. AI 字幕
    const contentText = shot.aiText || shot.originalText || '';
    if (contentText) {
      const tMatId = genHexId();
      texts.push(buildTextMaterial(tMatId, contentText, subtitleStyle));
      ref.textId = tMatId;
    }

    shotRefs.push(ref);
  }

  return { videos, audios, texts, shotRefs, bgmRef };
}