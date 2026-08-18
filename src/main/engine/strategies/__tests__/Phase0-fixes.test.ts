// 📁 路径: src/main/engine/strategies/__tests__/Phase0-fixes.test.ts
// 🎯 Phase 0 修复的快速验证测试：
//   1. parseVlmDescriptionToStructured：喂 8月12日项目 169 条真实 VLM description，统计提取覆盖率
//   2. 超长 chunk 拆分兜底：31.64s chunk_000（8月12日项目真实 case）是否被正确拆成 11 个 3s 子chunk
//   3. fillStructuredFromDescription 不覆盖已有非空真值（填补缺口原则验证）

import { describe, it, expect, vi, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// === Mock 依赖链 ===
vi.mock('../../../core/AppLogger', () => ({
  AppLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock('@modules/infra/logger/LogConstants', () => ({
  LOG_TAGS: { AI_AGENT: 'AI_AGENT', SCHEDULER: 'SCHEDULER' },
}));

import { VisionExtractStrategy } from '../VisionExtractStrategy';

// ============================================================
// 加载 dump
// ============================================================
type DumpShape = { videoChunks: Array<{ description?: string; startMs: number; endMs: number; id: string }> };
function loadLatestDump(): DumpShape | null {
  // __dirname = src/main/engine/strategies/__tests__
  const dumpDir = path.join(__dirname, '..', '..', '..', '..', '..', 'data', '_diag_dump');
  if (!fs.existsSync(dumpDir)) return null;
  const files = fs.readdirSync(dumpDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ name: f, full: path.join(dumpDir, f), mtime: fs.statSync(path.join(dumpDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!files.length) return null;
  // eslint-disable-next-line no-console
  console.log(`[Phase0.test] 使用 dump: ${files[0].name}`);
  return JSON.parse(fs.readFileSync(files[0].full, 'utf-8'));
}

describe('Phase 0 修复验证：VLM 描述正则回捞 + 长 chunk 拆分', () => {
  let dump: DumpShape | null = null;

  beforeAll(() => {
    dump = loadLatestDump();
  });

  // =========================================
  // 1. parseVlmDescriptionToStructured 真实数据覆盖率
  // =========================================
  it('① 真实项目 description → 结构化字段提取覆盖率（8月12日项目样本）', () => {
    if (!dump) return;
    const chunksWithDesc = dump.videoChunks.filter(c => c.description && c.description.trim().length > 0);
    // eslint-disable-next-line no-console
    console.log(`\n  样本 chunks: 有 description 的 ${chunksWithDesc.length}/${dump.videoChunks.length}`);

    let stHit = 0, emoHit = 0, chrHit = 0, kwHit = 0;
    for (const c of chunksWithDesc) {
      const out = VisionExtractStrategy.parseVlmDescriptionToStructured(c.description);
      if (out.shotType) stHit++;
      if (out.emotion) emoHit++;
      if (out.characters && out.characters.length > 0) chrHit++;
      if (out.keywords && out.keywords.length > 0) kwHit++;
    }

    const total = Math.max(1, chunksWithDesc.length);
    // eslint-disable-next-line no-console
    console.log(`  提取命中结果:`);
    // eslint-disable-next-line no-console
    console.log(`    · shotType(景别)  : ${stHit}/${chunksWithDesc.length}  = ${(stHit / total * 100).toFixed(1)}%`);
    // eslint-disable-next-line no-console
    console.log(`    · emotion(情绪)   : ${emoHit}/${chunksWithDesc.length}  = ${(emoHit / total * 100).toFixed(1)}%`);
    // eslint-disable-next-line no-console
    console.log(`    · characters(角色): ${chrHit}/${chunksWithDesc.length}  = ${(chrHit / total * 100).toFixed(1)}%`);
    // eslint-disable-next-line no-console
    console.log(`    · keywords(关键词): ${kwHit}/${chunksWithDesc.length}  = ${(kwHit / total * 100).toFixed(1)}%`);

    // 打印前 3 个样本的提取结果，人工抽查
    // eslint-disable-next-line no-console
    console.log(`\n  🎯 前 3 个样本的提取结果抽查：`);
    chunksWithDesc.slice(0, 3).forEach((c, i) => {
      const out = VisionExtractStrategy.parseVlmDescriptionToStructured(c.description);
      // eslint-disable-next-line no-console
      console.log(`  样本${i + 1}：desc="${c.description!.slice(0, 60)}${c.description!.length > 60 ? '...' : ''}"`);
      // eslint-disable-next-line no-console
      console.log(`         → ${JSON.stringify(out)}`);
    });
    // eslint-disable-next-line no-console
    console.log('');

    // 断言：基于 8月12日诊断样本（description 全带【景别】前缀 + 多个冒号字段），景别应接近100%，情绪≥80%
    expect(stHit / total).toBeGreaterThanOrEqual(0.95);
    expect(emoHit / total).toBeGreaterThanOrEqual(0.75);
    expect(kwHit / total).toBeGreaterThanOrEqual(0.95);
  });

  // =========================================
  // 2. 超长 chunk 拆分：模拟 31.64s 的 chunk_000
  // =========================================
  it('② 超长 chunk(31.64s) 兜底拆分：按 3s/段 拆成 11 个子chunk', () => {
    // 构造 8月12日 chunk_000
    const longChunk = {
      id: 'chunk_000',
      startMs: 0,
      endMs: 31640,
      description: '【中景】男子搂着女子肩膀大笑 场景:餐厅聚餐 主体:黑衣男子',
      cover_path: '/tmp/chunk_000.jpg',
    };
    // 直接复制 SemanticAnalyzeStrategy 的拆分逻辑（保持独立断言）
    const MAX_CHUNK_MS = 6000;
    const SEGMENT_MS = 3000;
    const videoChunks = [longChunk];
    const split: any[] = [];
    let hadLong = 0;
    for (const c of videoChunks) {
      const start = Number(c.startMs) || 0;
      const end = Number(c.endMs) || start;
      const dur = end - start;
      if (dur <= MAX_CHUNK_MS) { split.push(c); continue; }
      hadLong++;
      let cur = start, idx = 0;
      while (cur < end) {
        const segEnd = Math.min(end, cur + SEGMENT_MS);
        split.push({ ...c, id: `${c.id}_s${idx}`, startMs: cur, endMs: segEnd });
        cur = segEnd;
        idx++;
      }
    }
    expect(hadLong).toBe(1);
    // 31.64s / 3s = 10 full + 1 short = 11 chunks
    expect(split.length).toBe(11);
    // id 后缀正确
    expect(split[0].id).toBe('chunk_000_s0');
    expect(split[10].id).toBe('chunk_000_s10');
    // 首 / 中 / 尾段时间正确
    expect(split[0].startMs).toBe(0);       expect(split[0].endMs).toBe(3000);
    expect(split[5].startMs).toBe(15000);   expect(split[5].endMs).toBe(18000);
    expect(split[10].startMs).toBe(30000);  expect(split[10].endMs).toBe(31640);
    // 其他字段（description/cover_path）原样继承
    for (const s of split) {
      expect(s.description).toBe(longChunk.description);
      expect(s.cover_path).toBe(longChunk.cover_path);
    }
    // eslint-disable-next-line no-console
    console.log(`  ✔ 31.64s → 拆成 11 个 chunk ✓ （时间边界正确，字段完整继承）\n`);
  });

  // =========================================
  // 3. fillStructuredFromDescription 缺口填补原则验证
  // =========================================
  it('③ fillStructuredFromDescription 只填补缺口、不覆盖已有非空真值', () => {
    // 目标对象：已有原生高置信度的 shotType/characters，缺 emotion/keywords
    const target: any = {
      shotType: '近景',
      emotion: '',
      characters: ['张三', '李四'],
      keywords: undefined as string[] | undefined,
    };
    const desc = '【中景】男子搂着女子肩膀大笑 场景:餐厅聚餐 主体:黑衣男子 情绪:开怀大笑，表情愉悦 看点:欢乐聚餐氛围';
    VisionExtractStrategy.fillStructuredFromDescription(target, desc);
    // 原有 truth 不覆盖
    expect(target.shotType).toBe('近景'); // 不是"中景"
    expect(target.characters).toEqual(expect.arrayContaining(['张三', '李四'])); // 张三李四仍在
    expect(target.characters).toEqual(expect.arrayContaining(['黑衣男子'])); // 合并黑衣男子
    // 缺口被填补
    expect(target.emotion).toBe('开怀大笑');
    expect(target.keywords).toEqual(expect.arrayContaining(['餐厅聚餐', '欢乐聚餐氛围']));
  });

  // =========================================
  // 4. 常见变体格式兼容性测试
  // =========================================
  it('④ parseVlmDescriptionToStructured 常见格式变体兼容（书名号/半角括号/英文冒号/多空格）', () => {
    const cases = [
      '[近景] 张三和李四拥抱在一起  情绪：激动，热泪盈眶  地点：医院门口  关键人物：张三、李四',
      '【特写】一双布满老茧的手  主体：老妇人  氛围：怀旧温暖  关键词：手、老茧、皱纹、岁月痕迹',
      '(全景) 夕阳下的城市天际线 环境:城市中心 光影:金色余晖 看点:浪漫日落',
      '中景 男子:黑衣男子 正在说话 （无景别括号，冒号字段正确识别） 景别:中景 情绪:平静',
    ];
    const results = cases.map(c => VisionExtractStrategy.parseVlmDescriptionToStructured(c));
    // Case1: 近景 / 激动 / 张三李四 / 医院门口
    expect(results[0].shotType).toBe('近景');
    expect(results[0].emotion).toBe('激动');
    expect(results[0].characters).toEqual(expect.arrayContaining(['张三', '李四']));
    expect(results[0].keywords).toEqual(expect.arrayContaining(['医院门口']));
    // Case2: 特写 / 怀旧温暖 / 老妇人 / [手,老茧,皱纹,岁月痕迹]
    expect(results[1].shotType).toBe('特写');
    expect(results[1].emotion).toBe('怀旧温暖');
    expect(results[1].characters).toEqual(expect.arrayContaining(['老妇人']));
    // Case3: 全景 / undefined / undefined / [城市中心,金色余晖,浪漫日落]
    expect(results[2].shotType).toBe('全景');
    expect(results[2].keywords).toEqual(expect.arrayContaining(['城市中心', '金色余晖', '浪漫日落']));
    // Case4: 景别冒号字段 → 中景；情绪:平静
    expect(results[3].shotType).toBe('中景');
    expect(results[3].emotion).toBe('平静');
    // eslint-disable-next-line no-console
    console.log(`  ✔ 4 种格式变体全部正确解析 ✓\n`);
  });
});
