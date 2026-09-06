// 📁 路径：src/modules/export/jianying/backend/core/assemblers/__tests__/MaterialsAssembler.unmatched.test.ts
// 未匹配镜头「末帧定格」装配单测：
//   - 有 TTS 配音但无切片/时间窗的镜头（unmatched=true）应被导出；
//   - 视频素材时长 = 源视频真实时长；segment 源定时范围 start=末帧、duration=0（剪映定格该帧）；
//   - 配音 / 字幕素材照常生成。

import { describe, it, expect } from 'vitest';
import type { CompileShot } from '../../../../types';
import { assembleMaterials, type ShotMaterialRef } from '../MaterialsAssembler';
import { assembleTracks } from '../TracksAssembler';
import type { VideoProbeResult } from '../../utils/FfprobeProber';

/** 源视频探针：时长 600s、30fps → 末帧约位于 599.966s 处 */
const SOURCE_DURATION_SEC = 600;
const SOURCE_FPS = 30;
const sourceProbe: VideoProbeResult = {
  width: 1920,
  height: 1080,
  hasAudio: true,
  durationSec: SOURCE_DURATION_SEC,
  formatName: 'mp4',
  codecName: 'h264',
  fps: SOURCE_FPS,
};
const SOURCE_PATH = '/media/source.mp4';
const MICRO = 1_000_000;
const LAST_FRAME_START_US = Math.round(SOURCE_DURATION_SEC * MICRO) - Math.round(MICRO / SOURCE_FPS);

/** 构造一个未匹配镜头（有配音，无切片/时间窗） */
function makeUnmatchedShot(over: Partial<CompileShot> = {}): CompileShot {
  return {
    id: 'seg_unmatched',
    text: '解说文案',
    originalText: '解说文案',
    aiText: '解说文案',
    start: 0,
    end: 3,
    duration: 3,
    audioDuration: 3,
    audioPath: '/audio/tts.wav',
    chunkData: null,
    unmatched: true,
    ...over,
  } as CompileShot;
}

describe('MaterialsAssembler - 未匹配镜头末帧定格', () => {
  const probeMap = new Map<string, VideoProbeResult>([[SOURCE_PATH, sourceProbe]]);

  it('未匹配镜头：视频素材时长=源视频真实时长，segment 源定时 range duration=0（定格）', () => {
    const { videos, shotRefs } = assembleMaterials(
      [makeUnmatchedShot()],
      SOURCE_PATH,
      probeMap,
      {},
    );

    // 1. 镜头引用：标记 unmatched，源时长 0，源起点 = 末帧位置
    expect(shotRefs).toHaveLength(1);
    const ref = shotRefs[0];
    expect(ref.unmatched).toBe(true);
    expect(ref.durationUs).toBe(3 * MICRO);
    expect(ref.sourceDurationUs).toBe(0);
    expect(ref.sourceStartUs).toBe(LAST_FRAME_START_US);

    // 2. 视频素材：duration = 源视频真实时长（末帧起点落在其内，不被剪映钳制到错误帧）
    expect(videos).toHaveLength(1);
    expect((videos[0] as any).duration).toBe(SOURCE_DURATION_SEC * MICRO);
    expect((videos[0] as any).path).toBe(SOURCE_PATH);
  });

  it('轨道层：未匹配镜头输出独立视频 segment，源定时 range duration=0', () => {
    const { shotRefs } = assembleMaterials([makeUnmatchedShot()], SOURCE_PATH, probeMap, {});
    const { tracks } = assembleTracks(shotRefs as ShotMaterialRef[]);
    const videoSegments = tracks[0].segments as any[];

    // 无 sceneGroupId → 独立 segment（不合并）
    expect(videoSegments).toHaveLength(1);
    const seg = videoSegments[0];
    expect(seg.source_timerange.duration).toBe(0);
    expect(seg.source_timerange.start).toBe(LAST_FRAME_START_US);
    // 目标时长 = 配音时长
    expect(seg.target_timerange.duration).toBe(3 * MICRO);
  });

  it('未匹配镜头：配音音频 + 字幕素材照常生成', () => {
    const { audios, texts, shotRefs } = assembleMaterials(
      [makeUnmatchedShot()],
      SOURCE_PATH,
      probeMap,
      {},
    );
    const ref = shotRefs[0];
    // TTS 音频素材
    expect(ref.audioId).toBeTruthy();
    expect(audios.some((a) => (a as any).id === ref.audioId)).toBe(true);
    // 字幕素材
    expect(ref.textId).toBeTruthy();
    expect(texts.some((t) => (t as any).id === ref.textId)).toBe(true);
  });
});