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
import { sanitizeSubtitleText, wrapSubtitleText } from '../../utils/TextContentFormatter';
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
      [makeShot({ keepOriginalAudio: false, aiText: '这是一段带标点的文案。' })],
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

describe('字幕行宽独立折行（渲染单位与 TTS/匹配单位解耦）', () => {
  const probeMap = new Map<string, VideoProbeResult>([[SOURCE_PATH, sourceProbe]]);

  it('wrapSubtitleText：安全宽内整条不折行', () => {
    expect(wrapSubtitleText('我爷爷不行了')).toBe('我爷爷不行了');
  });

  it('wrapSubtitleText：24 字碎片折成两行（16 + 8），不再挤一行', () => {
    // 断句器上限 24 字（TTS/匹配承载单位），字幕按 16 等效宽独立折行
    const s = '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯';
    expect(s.length).toBe(24);
    expect(wrapSubtitleText(s)).toBe('一二三四五六七八九十甲乙丙丁戊己\n庚辛壬癸子丑寅卯');
  });

  it('wrapSubtitleText：英文优先在空格处断行（不切碎单词）', () => {
    const lines = wrapSubtitleText('hello world foo bar baz qux quux corge grault').split('\n');
    expect(lines).toEqual(['hello world foo bar baz qux quux', 'corge grault']);
  });

  it('集成：24 字解说文案超出单行宽 → 拆成两条单行字幕，range 覆盖各自全长', () => {
    const aiText = '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯';
    const { texts } = assembleMaterials(
      [makeShot({ keepOriginalAudio: false, aiText })],
      SOURCE_PATH,
      probeMap,
      {},
    );
    expect(texts).toHaveLength(2);
    const first = JSON.parse((texts[0] as any).content);
    const second = JSON.parse((texts[1] as any).content);
    expect(first.text).toBe('一二三四五六七八九十甲乙丙丁戊己');
    expect(second.text).toBe('庚辛壬癸子丑寅卯');
    // 每条都是一行，range 覆盖自身全长
    expect(first.text).not.toContain('\n');
    expect(first.styles[0].range).toEqual([0, first.text.length]);
    // 素材名保持单行，不被换行符污染
    expect((texts[0] as any).name).not.toContain('\n');
  });

  it('集成：竖屏画布（1080×1920）行宽收紧到 12 等效宽，24 字拆成 12+12 两条', () => {
    const aiText = '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯';
    const { texts } = assembleMaterials(
      [makeShot({ keepOriginalAudio: false, aiText })],
      SOURCE_PATH,
      probeMap,
      { canvasSize: { width: 1080, height: 1920 } },
    );
    expect(texts).toHaveLength(2);
    expect(JSON.parse((texts[0] as any).content).text).toBe('一二三四五六七八九十甲乙');
    expect(JSON.parse((texts[1] as any).content).text).toBe('丙丁戊己庚辛壬癸子丑寅卯');
  });

  it('集成：原声段短台词（≤16 等效宽）保持单行，不回归', () => {
    const { texts } = assembleMaterials(
      [makeShot({ keepOriginalAudio: true, originalText: '我爷爷不行了' })],
      SOURCE_PATH,
      probeMap,
      {},
    );
    const content = JSON.parse((texts[0] as any).content);
    expect(content.text).toBe('我爷爷不行了');
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

// 🎙️ 原声段逐行字幕（2026-10-23）：直接消费 ASR 每行的 startMs/endMs，
// 按行生成多条字幕条，字幕随人声出现/消失，不再一条文本撑满整窗。
describe('原声段逐行字幕（ASR 时间点驱动）', () => {
  const probeMap = new Map<string, VideoProbeResult>([[SOURCE_PATH, sourceProbe]]);
  const cueShot = () =>
    makeShot({
      keepOriginalAudio: true,
      originalText: '秀恩爱死得快',
      duration: 4,
      audioDuration: 4,
      videoTimelineStartMs: 10_000,
      videoTimelineEndMs: 14_000,
      subtitleCues: [
        { text: '秀恩爱', startMs: 10_000, endMs: 11_200 },
        { text: '死得快', startMs: 11_500, endMs: 13_000 },
      ],
    });

  it('有逐行台词：按行生成多条字幕，偏移相对原声窗起点', () => {
    const { texts, shotRefs } = assembleMaterials([cueShot()], SOURCE_PATH, probeMap, {});
    expect(texts).toHaveLength(2);
    expect(shotRefs[0].textId).toBeUndefined();
    expect(shotRefs[0].textCues).toEqual([
      { textId: (texts[0] as any).id, offsetUs: 0, durationUs: 1_200_000 },
      { textId: (texts[1] as any).id, offsetUs: 1_500_000, durationUs: 1_500_000 },
    ]);
    expect(JSON.parse((texts[0] as any).content).text).toBe('秀恩爱');
    expect(JSON.parse((texts[1] as any).content).text).toBe('死得快');
  });

  it('轨道层：字幕 segment 的起止 = ASR 行时间点（相对段首偏移）', () => {
    const { shotRefs } = assembleMaterials([cueShot()], SOURCE_PATH, probeMap, {});
    const { tracks } = assembleTracks(shotRefs as ShotMaterialRef[]);
    const textSegments = tracks[3].segments as any[];
    expect(textSegments).toHaveLength(2);
    expect(textSegments[0].target_timerange).toEqual({ start: 0, duration: 1_200_000 });
    expect(textSegments[1].target_timerange).toEqual({ start: 1_500_000, duration: 1_500_000 });
  });

  it('逐行台词全部越界/过短 → 回退单条整段字幕', () => {
    const { texts, shotRefs } = assembleMaterials(
      [
        makeShot({
          keepOriginalAudio: true,
          originalText: '我爷爷不行了',
          duration: 4,
          audioDuration: 4,
          videoTimelineStartMs: 10_000,
          videoTimelineEndMs: 14_000,
          subtitleCues: [
            { text: '窗外', startMs: 20_000, endMs: 21_000 },
            { text: '嗯', startMs: 10_000, endMs: 10_050 },
          ],
        }),
      ],
      SOURCE_PATH,
      probeMap,
      {},
    );
    expect(shotRefs[0].textCues).toBeUndefined();
    expect(shotRefs[0].textId).toBeTruthy();
    expect(texts).toHaveLength(1);
    expect(JSON.parse((texts[0] as any).content).text).toBe('我爷爷不行了');
  });

  it('解说段不受影响：即使误带 subtitleCues 也不按行拆', () => {
    const { shotRefs } = assembleMaterials(
      [makeShot({ keepOriginalAudio: false, subtitleCues: [{ text: '误带', startMs: 1000, endMs: 2000 }] })],
      SOURCE_PATH,
      probeMap,
      {},
    );
    expect(shotRefs[0].textCues).toBeUndefined();
    expect(shotRefs[0].textId).toBeTruthy();
  });
});

// 🎙️ 长句按「换气级」短语拆条（2026-10-23）：整段一条字幕会从开口显示到音频结束，
// 这里验证解说段按标点切片、按字数分摊该段音频时长，实现「读到哪句显示哪句」。
describe('解说长句按换气级短语拆字幕', () => {
  const probeMap = new Map<string, VideoProbeResult>([[SOURCE_PATH, sourceProbe]]);
  const LONG = '翁月浅笑直言了解这类群体，姐姐便很少去公司，偶尔露面就被夸能干';

  it('三个逗号短语 → 三条字幕，偏移/时长按字数比例分摊且首尾贴合', () => {
    const { texts, shotRefs } = assembleMaterials(
      [makeShot({ keepOriginalAudio: false, aiText: LONG, duration: 5.4, audioDuration: 5.4 })],
      SOURCE_PATH,
      probeMap,
      {},
    );
    expect(texts).toHaveLength(3);
    expect(shotRefs[0].textId).toBeUndefined();
    const cues = shotRefs[0].textCues!;
    expect(cues).toHaveLength(3);
    // 清洗后字数 12 / 8 / 9，总时长 5.4s
    expect(cues[0].offsetUs).toBe(0);
    expect(cues[0].durationUs).toBe(2_234_483);
    expect(cues[1].offsetUs).toBe(2_234_483);
    expect(cues[1].durationUs).toBe(1_489_655);
    expect(cues[1].offsetUs + cues[1].durationUs).toBe(3_724_138);
    // 末片吸收余量，总时长严格等于段时长
    expect(cues[2].offsetUs + cues[2].durationUs).toBe(5_400_000);
    expect(JSON.parse((texts[0] as any).content).text).toBe('翁月浅笑直言了解这类群体');
    expect(JSON.parse((texts[1] as any).content).text).toBe('姐姐便很少去公司');
    expect(JSON.parse((texts[2] as any).content).text).toBe('偶尔露面就被夸能干');
  });

  it('轨道层：三条字幕依次显示、互不重叠、不超出段时长', () => {
    const { shotRefs } = assembleMaterials(
      [makeShot({ keepOriginalAudio: false, aiText: LONG, duration: 5.4, audioDuration: 5.4 })],
      SOURCE_PATH,
      probeMap,
      {},
    );
    const { tracks } = assembleTracks(shotRefs as ShotMaterialRef[]);
    const textSegments = tracks[3].segments as any[];
    expect(textSegments).toHaveLength(3);
    expect(textSegments[0].target_timerange).toEqual({ start: 0, duration: 2_234_483 });
    expect(textSegments[1].target_timerange).toEqual({ start: 2_234_483, duration: 1_489_655 });
    expect(textSegments[2].target_timerange).toEqual({ start: 3_724_138, duration: 1_675_862 });
  });

  it('单短语文案 → 维持单条整段字幕（不回归）', () => {
    const { texts, shotRefs } = assembleMaterials(
      [makeShot({ keepOriginalAudio: false, aiText: '他推开门走了进去。', duration: 3 })],
      SOURCE_PATH,
      probeMap,
      {},
    );
    expect(texts).toHaveLength(1);
    expect(shotRefs[0].textCues).toBeUndefined();
    expect(shotRefs[0].textId).toBeTruthy();
    expect(JSON.parse((texts[0] as any).content).text).toBe('他推开门走了进去');
  });

  it('无标点超长 → 按单行宽切成多条（不再一条铺满屏）', () => {
    const within = '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥';
    expect(within.length).toBe(32);
    const { shotRefs } = assembleMaterials(
      [makeShot({ keepOriginalAudio: false, aiText: within, duration: 4 })],
      SOURCE_PATH,
      probeMap,
      {},
    );
    // 32 字 = 2×16 行宽 → 切两条单行字幕
    expect(shotRefs[0].textCues?.length).toBe(2);
    const longer = within + '天地玄黄';
    const { shotRefs: refs2 } = assembleMaterials(
      [makeShot({ keepOriginalAudio: false, aiText: longer, duration: 6 })],
      SOURCE_PATH,
      probeMap,
      {},
    );
    expect(refs2[0].textCues?.length).toBe(3);
  });

  it('无标点长短语优先在句子重启词前断开（另一个女人／她还不知道）', () => {
    const text = '同一趟航班上还坐着另一个女人她还不知道';
    const { texts } = assembleMaterials(
      [makeShot({ keepOriginalAudio: false, aiText: text, duration: 3.4 })],
      SOURCE_PATH,
      probeMap,
      {},
    );
    const lines = texts.map((t) => JSON.parse((t as any).content).text);
    expect(lines).toEqual(['同一趟航班上还坐着另一个女人', '她还不知道']);
  });

  it('TTS 控制标记不进入字幕（[pause: 400ms] 不得残留为 pause 400ms）', () => {
    const text = '反而更可怕 [pause: 400ms] 他到底';
    const { texts } = assembleMaterials(
      [makeShot({ keepOriginalAudio: false, aiText: text, duration: 2.4 })],
      SOURCE_PATH,
      probeMap,
      {},
    );
    const all = texts.map((t) => JSON.parse((t as any).content).text).join('');
    expect(all).not.toMatch(/pause/i);
    expect(all).not.toMatch(/400/);
    expect(all).toContain('他到底');
  });
});

// 🎙️ 字幕切点吸附（2026-10-23，方案 2）：比例切点 → 配音真实静音（换气）中点。
describe('解说字幕切点按真实静音吸附', () => {
  const probeMap = new Map<string, VideoProbeResult>([[SOURCE_PATH, sourceProbe]]);
  const LONG = '翁月浅笑直言了解这类群体，姐姐便很少去公司，偶尔露面就被夸能干';
  const shot = (over: Partial<CompileShot> = {}) =>
    makeShot({ keepOriginalAudio: false, aiText: LONG, duration: 5.4, audioDuration: 5.4, ...over });

  it('静音中点给出时：比例切点 2234/3724ms → 吸附到 2222/3854ms', () => {
    const pauseHints = new Map<string, any[]>([
      ['seg_normal', [
        { startMs: 2070, endMs: 2374 },  // 换气 1：中点 2222
        { startMs: 3712, endMs: 3996 },  // 换气 2：中点 3854
      ]],
    ]);
    const { shotRefs } = assembleMaterials(
      [shot({ id: 'seg_normal' })],
      SOURCE_PATH,
      probeMap,
      { pauseHints },
    );
    const cues = shotRefs[0].textCues!;
    expect(cues).toHaveLength(3);
    expect(cues[0].durationUs).toBe(2_222_000);
    expect(cues[1].offsetUs).toBe(2_222_000);
    expect(cues[1].durationUs).toBe(1_632_000);
    expect(cues[2].offsetUs).toBe(3_854_000);
    // 吸附只移动切点，首尾仍严格贴合段时长
    expect(cues[2].offsetUs + cues[2].durationUs).toBe(5_400_000);
  });

  it('静音距切点超过 700ms → 保持原比例切点（不硬拖）', () => {
    const pauseHints = new Map<string, any[]>([
      ['seg_normal', [{ startMs: 50, endMs: 500 }]],
    ]);
    const { shotRefs } = assembleMaterials(
      [shot({ id: 'seg_normal' })],
      SOURCE_PATH,
      probeMap,
      { pauseHints },
    );
    const cues = shotRefs[0].textCues!;
    expect(cues[0].durationUs).toBe(2_234_483);
    expect(cues[1].offsetUs).toBe(2_234_483);
  });

  it('只有一处静音 → 仅吸附最近的那个切点，其余保持比例', () => {
    const pauseHints = new Map<string, any[]>([
      ['seg_normal', [{ startMs: 4000, endMs: 4400 }]], // 中点 4200，只近第 2 个切点
    ]);
    const { shotRefs } = assembleMaterials(
      [shot({ id: 'seg_normal' })],
      SOURCE_PATH,
      probeMap,
      { pauseHints },
    );
    const cues = shotRefs[0].textCues!;
    expect(cues[0].durationUs).toBe(2_234_483);       // 第 1 个切点未动
    expect(cues[1].offsetUs + cues[1].durationUs).toBe(4_200_000); // 第 2 个切点吸附
  });

  it('无 pauseHints（ffmpeg 不可用/文件缺失）→ 回退纯比例切点，不抛错', () => {
    const { shotRefs } = assembleMaterials(
      [shot({ id: 'seg_normal' })],
      SOURCE_PATH,
      probeMap,
      {},
    );
    expect(shotRefs[0].textCues![0].durationUs).toBe(2_234_483);
    expect(shotRefs[0].textCues![1].offsetUs).toBe(2_234_483);
  });

  it('吸附后轨道层仍连续无重叠', () => {
    const pauseHints = new Map<string, any[]>([
      ['seg_normal', [{ startMs: 2070, endMs: 2374 }, { startMs: 3712, endMs: 3996 }]],
    ]);
    const { shotRefs } = assembleMaterials(
      [shot({ id: 'seg_normal' })],
      SOURCE_PATH,
      probeMap,
      { pauseHints },
    );
    const { tracks } = assembleTracks(shotRefs as ShotMaterialRef[]);
    const segs = tracks[3].segments as any[];
    expect(segs).toHaveLength(3);
    expect(segs[1].target_timerange.start).toBe(segs[0].target_timerange.start + segs[0].target_timerange.duration);
    expect(segs[2].target_timerange.start).toBe(segs[1].target_timerange.start + segs[1].target_timerange.duration);
  });
});

// 回归：素材时长必须取「素材文件真实时长」，否则 segment.source_timerange 用源坐标（可达数千秒）
// 会远超素材声明时长，被剪映钳制到错误帧（全片画面被拉到源片头部附近）。
describe('视频素材时长（回归：源窗越界钳制）', () => {
  const probeMap = new Map<string, VideoProbeResult>([[SOURCE_PATH, sourceProbe]]);

  it('普通解说段：素材时长 = 源视频真实时长（而非目标时长），源窗不越界', () => {
    const { videos, shotRefs } = assembleMaterials([makeShot()], SOURCE_PATH, probeMap, {});
    const mat = videos[0] as any;
    // 修复前为 totalTargetUs(3s)，源起点 1s 尚可；一旦源坐标较深即被钳制
    expect(mat.duration).toBe(sourceProbe.durationSec * MICRO);
    expect(mat.path).toBe(SOURCE_PATH);
    expect(shotRefs[0].sourceStartUs + (shotRefs[0].sourceDurationUs ?? 0)).toBeLessThanOrEqual(mat.duration);
  });

  it('原声段：素材时长取源真实时长，深源窗（500s）起点不被越界钳制', () => {
    const { videos, shotRefs } = assembleMaterials(
      [makeShot({ keepOriginalAudio: true, videoTimelineStartMs: 500_000, videoTimelineEndMs: 510_000 })],
      SOURCE_PATH,
      probeMap,
      {},
    );
    const mat = videos[0] as any;
    // 修复前 mat.duration = 目标时长(3s) < 源起点 500s → 剪映把源起点钳到素材头部
    expect(mat.duration).toBe(sourceProbe.durationSec * MICRO);
    expect(shotRefs[0].sourceStartUs).toBe(500_000 * 1000);
    expect(shotRefs[0].sourceStartUs).toBeLessThan(mat.duration);
  });
});
