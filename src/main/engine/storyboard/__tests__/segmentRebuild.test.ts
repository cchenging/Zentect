import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StoryboardAgent, SegmentSummary } from '../StoryboardAgent';

const chunk = (o: Record<string, any>) => ({
  id: o.id, startMs: o.startMs, endMs: o.endMs,
  scene: o.scene, characters: o.characters || [], primarySubject: o.primary || '',
  shotScale: o.shot || '', description: o.desc || '',
});

const seg = (id: number, startMs: number, endMs: number): SegmentSummary => ({
  segmentId: id, startMs, endMs, parentIds: [], parentCount: 0, chunkCount: 0,
  locClass: '', locPurity: 0, locRaw: [], topChars: [], shotDist: {}, repDesc: '',
});

describe('场记单上游数据守卫（2026-10-22）', () => {
  it('场记单越出素材时段（旧视频残留）⇒ 判不符', () => {
    const chunks = [chunk({ id: 'c1', startMs: 224000, endMs: 500000 }),
      chunk({ id: 'c2', startMs: 2600000, endMs: 2702000 })];
    const stale = [seg(1, 65229, 400000), seg(2, 400000, 900000), seg(3, 2792219, 2834428)];
    expect(StoryboardAgent.segmentsLookStale(stale, chunks)).toBe(true);
    // 3 段里 2 段落在素材内（0.67 < 0.8）且第 3 段起点晚于素材末尾
  });

  it('场记单与素材时段相符 ⇒ 放行', () => {
    const chunks = [chunk({ id: 'c1', startMs: 224000, endMs: 500000 })];
    const ok = [seg(1, 200000, 400000), seg(2, 400000, 600000)];
    expect(StoryboardAgent.segmentsLookStale(ok, chunks)).toBe(false);
  });

  it('无切片时不做判断（维持旧行为）', () => {
    expect(StoryboardAgent.segmentsLookStale([seg(1, 0, 1000)], [])).toBe(false);
  });

  it('按场景标签/间隔断段，topChars 取人物频次并剔除 EMPTY 哨兵', () => {
    const chunks = [
      chunk({ id: 'a', startMs: 1000, endMs: 4000, scene: '客厅', characters: ['林夏'], shot: '中景', desc: '林夏坐在沙发' }),
      chunk({ id: 'b', startMs: 4000, endMs: 9000, scene: '客厅', characters: ['林夏', '陈默'], shot: '近景', desc: '林夏与陈默对话，气氛紧张' }),
      chunk({ id: 'c', startMs: 20000, endMs: 30000, scene: '街头', primary: 'EMPTY', shot: '全景', desc: '雨夜街道' }),
    ];
    const segs = StoryboardAgent.buildSegmentsFromChunks(chunks);
    expect(segs).toHaveLength(2);
    expect(segs.map((s) => s.segmentId)).toEqual([1, 2]);
    expect(segs[0].parentIds).toEqual(['a', 'b']);
    expect(segs[0].topChars).toEqual(['林夏', '陈默']);
    expect(segs[0].shotDist).toEqual({ 中景: 1, 近景: 1 });
    expect(segs[1].topChars).toEqual([]);
    expect(segs[1].repDesc).toBe('雨夜街道');
  });

  it('短于 8s 的碎段不入场（避免制造无意义段号）', () => {
    const chunks = [
      chunk({ id: 'a', startMs: 1000, endMs: 9000, scene: '客厅' }),
      chunk({ id: 'b', startMs: 9000, endMs: 14000, scene: '走廊' }), // 仅 5s
    ];
    const segs = StoryboardAgent.buildSegmentsFromChunks(chunks);
    expect(segs).toHaveLength(1);
    expect(segs[0].parentIds).toEqual(['a']);
  });
});

// ============================================================================
// 🎬 S1 场记单正规化（ensureSegments，2026-10-22）
//   根因：校验/重建此前只在 α 开单链路里跑，且只落项目目录；daemon 段域池仍读旧
//   `temp/scene-log/segments.json` ⇒ 同轮双真源错位。本组锁定正规化入口的四条契约：
//   ① 健康放行不改写；② 缺失即建；③ 越界即重建覆盖；④ 指针始终指向同一真源。
// ============================================================================
describe('S1 场记单正规化（ensureSegments）', () => {
  let root: string;
  let projectDir: string;
  let tempDir: string;

  /** 与素材时段相符的标准切片：客厅 1~9s（两片）+ 街头 20~30s（场景变化断段） */
  const chunks = () => [
    chunk({ id: 'a', startMs: 1000, endMs: 4000, scene: '客厅', characters: ['林夏'], shot: '中景' }),
    chunk({ id: 'b', startMs: 4000, endMs: 9000, scene: '客厅', characters: ['林夏', '陈默'], shot: '近景' }),
    chunk({ id: 'c', startMs: 20000, endMs: 30000, scene: '街头', primary: 'EMPTY', shot: '全景' }),
  ];

  const writeSegments = (segs: SegmentSummary[]) => {
    fs.writeFileSync(path.join(projectDir, 'segments.json'), JSON.stringify(segs, null, 2), 'utf-8');
  };
  const readPointer = () => {
    const file = path.join(tempDir, 'storyboard-segments');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8').trim() : '';
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'zentect-seg-'));
    projectDir = path.join(root, 'proj');
    tempDir = path.join(root, 'temp');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('健康场记单 ⇒ 放行不重建，仅把项目段域路径同步给 daemon', () => {
    const healthy = StoryboardAgent.buildSegmentsFromChunks(chunks());
    writeSegments(healthy);
    const before = fs.readFileSync(path.join(projectDir, 'segments.json'), 'utf-8');
    const res = StoryboardAgent.ensureSegments('p-test', chunks(), { projectDir, tempDir });
    expect(res.rebuilt).toBe(false);
    expect(res.reason).toBe('none');
    expect(res.segments).toHaveLength(2);
    expect(res.sourcePath).toBe(path.join(projectDir, 'segments.json'));
    // 不改写 S1 原产出
    expect(fs.readFileSync(path.join(projectDir, 'segments.json'), 'utf-8')).toBe(before);
    // daemon 指针指向同一真源（修复「S2 项目段域 / daemon 旧 temp 段域」双真源错位）
    expect(readPointer()).toBe(path.join(projectDir, 'segments.json'));
  });

  it('场记单缺失但素材切片可用 ⇒ 按切片重建并落盘（替代运行时兜底）', () => {
    const res = StoryboardAgent.ensureSegments('p-test', chunks(), { projectDir, tempDir });
    expect(res.rebuilt).toBe(true);
    expect(res.reason).toBe('missing');
    expect(res.segments).toHaveLength(2);
    expect(fs.existsSync(path.join(projectDir, 'segments.json'))).toBe(true);
    expect(readPointer()).toBe(path.join(projectDir, 'segments.json'));
  });

  it('场记单越出素材时段 ⇒ 重建并覆盖旧文件，段号/时段与当前切片一致', () => {
    writeSegments([seg(1, 0, 5000), seg(2, 5000000, 6000000)]);
    const res = StoryboardAgent.ensureSegments('p-test', chunks(), { projectDir, tempDir });
    expect(res.rebuilt).toBe(true);
    expect(res.reason).toBe('stale');
    const persisted = JSON.parse(fs.readFileSync(path.join(projectDir, 'segments.json'), 'utf-8'));
    expect(persisted).toHaveLength(2);
    expect(persisted[0].startMs).toBe(1000);
    expect(persisted[1].endMs).toBe(30000);
    expect(persisted.map((s: any) => s.segmentId)).toEqual([1, 2]);
  });

  it('无切片时不做正规化（维持旧行为），且无可用段域时清空 daemon 指针', () => {
    fs.writeFileSync(path.join(tempDir, 'storyboard-segments'), '/stale/path.json', 'utf-8');
    const res = StoryboardAgent.ensureSegments('p-test', [], { projectDir, tempDir });
    expect(res.rebuilt).toBe(false);
    expect(res.reason).toBe('none');
    expect(res.segments).toHaveLength(0);
    expect(readPointer()).toBe('');
  });
});
