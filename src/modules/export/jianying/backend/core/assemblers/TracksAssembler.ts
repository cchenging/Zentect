// 📁 路径：src/modules/export/jianying/backend/core/assemblers/TracksAssembler.ts
// 轨道装配：消费素材装配结果，构建剪映 4 条轨道（main 视频 / audio BGM / audio TTS / subs 字幕）
//
// 职责：只负责「轨道 + segment」的构建，素材由 MaterialsAssembler 提供。
// 轨道与素材通过中间产物（ShotMaterialRef / BgmMaterialRef）解耦。

import type { SubtitleStyle } from '../../../types';
import { DEFAULT_SUBTITLE_STYLE } from '../../../types';
import { genHexId } from '../utils/IdUtils';
import { buildVideoSegment } from '../builders/VideoSegmentBuilder';
import { buildAudioSegment } from '../builders/AudioSegmentBuilder';
import { buildTextSegment } from '../builders/TextSegmentBuilder';
import type { ShotMaterialRef, BgmMaterialRef } from './MaterialsAssembler';

/** TTS 配音音量：放大至 1.8，避免"配音听不见"（BGM 仅 0.3 铺底不抢声） */
const TTS_VOLUME = 1.8;

/**
 * 创建一条剪映轨道的基础结构。
 *
 * @param type 轨道类型（video / audio / text）
 * @param name 轨道名（main / audio / subs）
 * @returns 空轨道对象
 */
function createTrack(type: string, name: string): any {
  return {
    id: genHexId(),
    attribute: 0,
    flag: 0,
    name,
    type,
    is_default_name: false,
    segments: [] as any[],
  };
}

/** 轨道装配结果：4 条轨道 + 总时长（微秒） */
export interface TracksResult {
  /** 轨道数组（main / bgm / tts / subs） */
  tracks: any[];
  /** 时间线总时长（微秒） */
  totalDurationUs: number;
}

/**
 * 轨道装配：基于素材装配结果构建 4 条轨道及全部 segment。
 *
 * 时间轴按镜头顺序累加 globalOffset，BGM 轨整片铺底。
 *
 * @param shotRefs 镜头素材引用（与 shots 一一对应）
 * @param bgmRef BGM 素材引用（可选）
 * @param subtitleStyle 字幕样式（缺省用默认样式）
 * @returns 轨道装配结果
 */
export function assembleTracks(
  shotRefs: ShotMaterialRef[],
  bgmRef?: BgmMaterialRef,
  subtitleStyle: SubtitleStyle = DEFAULT_SUBTITLE_STYLE,
): TracksResult {
  const videoTrack = createTrack('video', 'main');
  // 剪映按轨道 name 识别/合并音频轨，同名会让 BGM 与配音被当成同一条音轨。
  // 这里用不同 name 区分：BGM 命 "bgm"、配音命 "audio"，保证剪映渲染出两条独立音轨。
  const bgmTrack = createTrack('audio', 'bgm');
  const ttsTrack = createTrack('audio', 'audio');
  const textTrack = createTrack('text', 'subs');

  let globalOffset = 0;

  // -- BGM 轨道（整片铺底，降音至 30%） --
  if (bgmRef) {
    bgmTrack.segments.push(
      buildAudioSegment(bgmRef.bgmId, 0, bgmRef.totalDurationUs, 1, 0.3),
    );
  }

  // -- 逐镜头轨道 --
  // 🎬 阶段 A：同一 sceneGroupId 的连续兄弟段合并为单个视频 clip。
  // 合并后仅 1 条视频 segment：source_timerange 从组首源起点起、时长 = 组内各成员真实源时长累加；
  // target_timerange 时长 = 各成员目标时长累加（已按各自 speed 换算，用户评审隐患2）；
  // speed 取组首段。TTS 配音与字幕仍逐段保留（配音/字幕逐句，不受合并影响）。
  let openVideo: {
    ref: ShotMaterialRef;
    targetStart: number;
    totalTargetUs: number;
    totalSourceUs: number;
    sourceStartUs: number;
    speed: number;
    keepOriginalAudio: boolean;
  } | null = null;

  const flushVideo = () => {
    if (!openVideo) return;
    // 🎬 阶段 A：合并 clip 的 speed 用「源总时长 / 目标总时长」整体换算。
    // 组内各成员已按各自 speed 换算过 target 时长，speed 不整体换算则
    // source_timerange.duration 与 target_timerange.duration 比例不自洽（用户评审隐患2）。
    const totalTargetUs = openVideo.totalTargetUs;
    const totalSourceUs = openVideo.totalSourceUs;
    const mergedSpeed =
      totalTargetUs > 0 && totalSourceUs > 0 ? totalSourceUs / totalTargetUs : openVideo.speed;
    videoTrack.segments.push(
      buildVideoSegment(
        openVideo.ref.videoId,
        openVideo.targetStart,
        totalTargetUs,
        openVideo.sourceStartUs,
        mergedSpeed,
        openVideo.keepOriginalAudio,
        totalSourceUs,
      ),
    );
    openVideo = null;
  };

  for (const ref of shotRefs) {
    const isContinuation =
      !!openVideo &&
      !!ref.sceneGroupId &&
      openVideo.ref.sceneGroupId === ref.sceneGroupId;

    if (isContinuation && openVideo) {
      // 同组兄弟段：并入当前打开的 clip，不新增 segment
      openVideo.totalTargetUs += ref.durationUs;
      openVideo.totalSourceUs += ref.sourceDurationUs ?? ref.durationUs;
    } else {
      flushVideo();
      openVideo = {
        ref,
        targetStart: globalOffset,
        totalTargetUs: ref.durationUs,
        totalSourceUs: ref.sourceDurationUs ?? ref.durationUs,
        sourceStartUs: ref.sourceStartUs,
        speed: ref.speed,
        keepOriginalAudio: ref.keepOriginalAudio === true,
      };
    }

    // B. AI 配音轨（TTS，放大音量避免听不清）
    if (ref.audioId) {
      ttsTrack.segments.push(
        buildAudioSegment(ref.audioId, globalOffset, ref.durationUs, 1, TTS_VOLUME, TTS_VOLUME),
      );
    }

    // C. 字幕轨
    if (ref.textId) {
      textTrack.segments.push(
        buildTextSegment(ref.textId, globalOffset, ref.durationUs, subtitleStyle),
      );
    }

    globalOffset += ref.durationUs;
  }
  flushVideo();

  return {
    tracks: [videoTrack, bgmTrack, ttsTrack, textTrack],
    totalDurationUs: globalOffset,
  };
}