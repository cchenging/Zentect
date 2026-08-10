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
  const bgmTrack = createTrack('audio', 'audio');
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
  for (const ref of shotRefs) {
    // A. 视频主轨
    videoTrack.segments.push(
      buildVideoSegment(
        ref.videoId,
        globalOffset,
        ref.durationUs,
        ref.sourceStartUs,
        ref.speed,
      ),
    );

    // B. AI 配音轨（TTS）
    if (ref.audioId) {
      ttsTrack.segments.push(
        buildAudioSegment(ref.audioId, globalOffset, ref.durationUs, 1, 1.0),
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

  return {
    tracks: [videoTrack, bgmTrack, ttsTrack, textTrack],
    totalDurationUs: globalOffset,
  };
}