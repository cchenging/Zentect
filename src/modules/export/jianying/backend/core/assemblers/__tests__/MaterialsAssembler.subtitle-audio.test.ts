// 📁 路径：src/modules/export/jianying/backend/core/assemblers/__tests__/MaterialsAssembler.subtitle-audio.test.ts
// 第四轮回归：原声段音量放大 + 原声段字幕只显原声台词 + 字幕去标点（行业规范）
//   - 原声段（keepOriginalAudio=true）视频 segment volume=1.5（剪映 1.0=原片音量）；
//   - 原声段字幕文本 = originalText（原声台词），不取 aiText（AI 解说词）；
//   - 全部字幕经 sanitizeSubtitleText 清洗（无中英文标点）。

import { describe, it, expect } from 'vitest';
import type { CompileShot } from '../../../../types';
import { assembleMaterials, type ShotMaterialRef } from '../MaterialsAssembler';
import { assembleTracks } from '../TracksAssembler';
import { buildVideoSegment } from '../../builders/VideoSegmentBuilder';
import { sanitizeSubtitleText } from '../../utils/TextContentFormatter';
import type { VideoProbeResult } from '../../utils/FfprobeProber';

const SOURCE_PATH = '/media/source.mp4';
const MICRO = 1_000_000;
const sourceProbe: VideoProbeResult = {
  width: 1920,
  height: 1080,
  hasAudio: true,
  durationSec: 600,
  formatName: 'mp4',
  codecName: 'h264',
  fps: 30,
};

/** 构造正常匹配段（有切片，可指定原声/解说属性） */
function makeShot(over: Partial<CompileShot> = {}): CompileShot {
  return {
    id: 'seg_normal',
    text: '我爷爷不行了',
    originalText: '我爷爷不行了',
    aiText: '这是一段AI解说词',
    start: 1,
    end: 4,
    duration: 3,
    audioDuration: 3,
    chunkData: { filePath: SOURCE_PATH, startMs: 1000, endMs: 4000 },
    ...over,
  } as CompileShot;
}

describe('原声段音量（VideoSegmentBuilder）', () => {
  it('原声段：volume=1.5 且 last_nonzero_volume=1.5（原片音量放大 50%）', () => {
    const seg = buildVideoSegment('mat', 0, 3 * MICRO, 1 * MICRO, 1.0, true) as any;
    expect(seg.volume).toBe(1.5);
    expect(seg.last_nonzero_volume).toBe(1.5);
  });

  it('解说段：volume=0（静音，配音由 TTS 承载，不被误放大）', () => {
    const seg = buildVideoSegment('mat', 0, 3 * MICRO, 1 * MICRO, 1.0, false) as any;
    expect(seg.volume).toBe(0);
  });
});

describe('原声段字幕内容（MaterialsAssembler 分流）', () => {
  const probeMap = new Map<string, VideoProbeResult>([[SOURCE_PATH, sourceProbe]]);

  it('原声段：字幕只显示原声台词（originalText），不显示 AI 解说词', () => {
    const { texts, shotRefs } = assembleMaterials(
      [makeShot({ keepOriginalAudio: true, originalText: '我爷爷不行了', aiText: '这是AI解说的乱七八糟内容' })],
      SOURCE_PATH,
      probeMap,
      {},
    );
    expect(shotRefs[0].textId).toBeTruthy();
    const content = JSON.parse((texts[0] as any).content);
    expect(content.text).toBe('我爷爷不行了');
    expect(content.text).not.toContain('AI');
  });

  it('解说段：字幕仍取 AI 文案（aiText 优先，不回归）', () => {
    const { texts } = assembleMaterials(
      [makeShot({ keepOriginalAudio: false, aiText: '这是AI解说文案' })],
      SOURCE_PATH,
      probeMap,
      {},
    );
    const content = JSON.parse((texts[0] as any).content);
    expect(content.text).toBe('这是AI解说文案');
  });
});

describe('字幕去标点（行业规范）', () => {
  it('sanitizeSubtitleText：中英文标点/符号全清除，文字数字与空格保留', () => {
    expect(sanitizeSubtitleText('你好，世界！这不行啊。')).toBe('你好世界这不行啊');
    expect(sanitizeSubtitleText('Hello, world! "quoted" (ok)')).toBe('Hello world quoted ok');
    expect(sanitizeSubtitleText('完成度100%，加油！')).toBe('完成度100加油');
    expect(sanitizeSubtitleText('引号""书名号《x》省略号…破折号——')).toBe('引号书名号x省略号破折号');
    // 空值安全
    expect(sanitizeSubtitleText('')).toBe('');
  });

  it('集成：带标点的解说文案进入剪映 content 后无任何标点', () => {
    const probeMap = new Map<string, VideoProbeResult>([[SOURCE_PATH, sourceProbe]]);
    const { texts } = assembleMaterials(
      [makeShot({ keepOriginalAudio: false, aiText: '这，是一段。带标点的文案！' })],
      SOURCE_PATH,
      probeMap,
      {},
    );
    const material = texts[0] as any;
    const content = JSON.parse(material.content);
    expect(content.text).toBe('这是一段带标点的文案');
    // 素材 name 同步干净
    expect(material.name).not.toMatch(/[\p{P}\p{S}]/u);
  });
});

describe('轨道层集成（TracksAssembler 透传音量）', () => {
  it('原声段在视频轨的 segment volume=1.5', () => {
    const probeMap = new Map<string, VideoProbeResult>([[SOURCE_PATH, sourceProbe]]);
    const { shotRefs } = assembleMaterials(
      [makeShot({ keepOriginalAudio: true })],
      SOURCE_PATH,
      probeMap,
      {},
    );
    const { tracks } = assembleTracks(shotRefs as ShotMaterialRef[]);
    const videoSegments = tracks[0].segments as any[];
    expect(videoSegments).toHaveLength(1);
    expect(videoSegments[0].volume).toBe(1.5);
  });
});
