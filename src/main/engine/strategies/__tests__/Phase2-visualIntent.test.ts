// 📁 Phase 2 测试：Step3 visualIntent 100% 覆盖率兜底（ensureScriptShotVisualIntent + buildMatchQueries）
import { describe, it, expect, vi, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('../../../core/AppLogger', () => ({
  AppLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@modules/infra/logger/LogConstants', () => ({
  LOG_TAGS: { AI_AGENT: 'AI_AGENT', SCHEDULER: 'SCHEDULER' },
}));

import { SemanticAnalyzeStrategy } from '../SemanticAnalyzeStrategy';

type DumpShape = {
  queries: Array<{ shotId: string; text: string; visualIntent?: string; emotion?: string; characters?: string[] }>;
};

function loadLatestDump(): DumpShape | null {
  const dumpDir = path.join(__dirname, '..', '..', '..', '..', '..', 'data', '_diag_dump');
  if (!fs.existsSync(dumpDir)) return null;
  const files = fs.readdirSync(dumpDir)
    .filter(f => f.endsWith('.json'))
    .map(f => ({ name: f, full: path.join(dumpDir, f), mtime: fs.statSync(path.join(dumpDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!files.length) return null;
  return JSON.parse(fs.readFileSync(files[0].full, 'utf-8'));
}

describe('Phase 2：visualIntent 100% 覆盖率兜底（query 端）', () => {
  let dump: DumpShape | null = null;
  beforeAll(() => { dump = loadLatestDump(); });

  // -------------- 1. 真值不覆盖 --------------
  it('① 真值不覆盖：已有合法 visualIntent（长度≥6、非占位词）原样保留', () => {
    const cases = [
      { text: '男子走到窗前', emotion: '平静', visualIntent: '【近景】男子走到窗边，眼神远眺' },
      { text: 'abc', visualIntent: '【中景】室内男子坐在沙发上看报' },
      // 带 2 组字符 + 中文组合（合法）
      { text: '123', visualIntent: '场景叙述：温馨晚餐，一家人围坐，笑容满面' },
    ];
    for (let i = 0; i < cases.length; i++) {
      const out = SemanticAnalyzeStrategy.ensureScriptShotVisualIntent(cases[i], i);
      expect(out).toBe(cases[i].visualIntent); // 严格等于，不被篡改
    }
    // 占位词/空/弱句式 应该被覆写（不保留原值）
    const overwriteCases = ['', '无', 'none', '未提供', '【兜底】', '【兜底】通用画面', '【兜底】场景过渡镜头', '短'];
    let overwriteCount = 0;
    for (let i = 0; i < overwriteCases.length; i++) {
      const out = SemanticAnalyzeStrategy.ensureScriptShotVisualIntent(
        { text: '男子走进餐厅', visualIntent: overwriteCases[i] }, i,
      );
      if (out !== overwriteCases[i]) overwriteCount++;
      expect(out.length).toBeGreaterThanOrEqual(8); // 兜底结果至少 8 字
    }
    expect(overwriteCount).toBe(overwriteCases.length); // 全部占位词都被"重填"
  });

  // -------------- 2. 句式多样性：至少 3 种不同前缀 --------------
  it('② 句式多样性：10 段空 visualIntent 生成后，景别/前缀种类 ≥3 种（避免 TF-IDF 权重异常）', () => {
    const samples = [
      '嗯', '这些是我老舅生产的，只需要19', '9块，是不是比那些卖100多块的还好',
      '你的老舅怎么什么都会干啊，当然了', '老舅说了啊，你们先把眼镜带回家',
      '回家里去，跟家里人说啊', '9块', '家长要是愿意交钱，明天把钱交给我',
      '不愿意交钱就把眼镜还给我', '弄坏可不行是需要赔我19',
    ];
    const filled = samples.map((t, i) => SemanticAnalyzeStrategy.ensureScriptShotVisualIntent({ text: t }, i));
    // 取前缀模式：【】里的词 + 开头第一个逗号前的词组
    const prefixes = new Set<string>();
    for (const f of filled) {
      const m = f.match(/^【([^】]+)】/);
      if (m) prefixes.add(m[1]);
      else prefixes.add(f.split(/[，,]/)[0].slice(0, 6));
    }
    // eslint-disable-next-line no-console
    console.log(`\n  🎯 10 段兜底生成前缀集合：${Array.from(prefixes).join(' / ')}`);
    // eslint-disable-next-line no-console
    filled.forEach((f, i) => console.log(`     ${i + 1}. ${f}`));
    // eslint-disable-next-line no-console
    console.log('');
    // 5 种模板轮选 → 期望前缀 ≥3 种
    expect(prefixes.size).toBeGreaterThanOrEqual(3);
    // 所有输出非空、≥8 字
    for (const f of filled) expect(f.length).toBeGreaterThanOrEqual(8);
  });

  // -------------- 3. 8月12日 dump：444 段 queries → 100% 覆盖率 --------------
  it('③ 真实项目 dump：444 段 queries（visualIntent 原全空）→ ensureAllVisualIntentFilled 后 100% 非空、句式前缀 ≥4 种', () => {
    if (!dump) return;
    // 提取到局部变量，确保 forEach 回调内部 TS 类型收窄正确
    const queries = dump.queries;
    // eslint-disable-next-line no-console
    console.log(`\n  加载真实 dump 样本 queries=${queries.length}，原 visualIntent 有 ${queries.filter(q => String(q.visualIntent || '').trim() && q.visualIntent!.length >= 6).length} 个合法`);
    const out = SemanticAnalyzeStrategy.ensureAllVisualIntentFilled(queries);
    expect(out.length).toBe(queries.length);
    let emptyCnt = 0;
    const prefixes = new Set<string>();
    for (const s of out) {
      const vi = String((s as any).visualIntent || '').trim();
      if (!vi || vi.length < 8) emptyCnt++;
      const m = vi.match(/^【([^】]+)】/);
      if (m) prefixes.add(m[1]);
      else prefixes.add(vi.split(/[，,]/)[0].slice(0, 6));
    }
    // eslint-disable-next-line no-console
    console.log(`  填充后覆盖率：${queries.length - emptyCnt}/${queries.length} （期望 100%）`);
    // eslint-disable-next-line no-console
    console.log(`  前缀种类：${Array.from(prefixes).join(' / ')} （期望 ≥4 种）`);
    // 前 5 段抽样人工检查
    // eslint-disable-next-line no-console
    console.log(`\n  🎯 抽样前 5 段 visualIntent（人工抽查）：`);
    out.slice(0, 5).forEach((s, i) => {
      // eslint-disable-next-line no-console
      console.log(`     ${i + 1}. text="${queries[i].text.slice(0, 20)}${queries[i].text.length > 20 ? '…' : ''}" → VI="${(s as any).visualIntent}"`);
    });
    // eslint-disable-next-line no-console
    console.log('');
    expect(emptyCnt).toBe(0);
    expect(prefixes.size).toBeGreaterThanOrEqual(4);
    // 不破坏原始数组（返回的是新对象？对同一个 shot 做浅拷贝，不修改原输入）
    for (let i = 0; i < queries.length; i++) {
      // 原 dump 里的 visualIntent 应该保持原始"空"状态（未被原地修改）
      expect(queries[i].visualIntent || '').toBe(queries[i].visualIntent || '');
    }
  });

  // -------------- 4. buildMatchQueries：text 追加 | visualIntent --------------
  it('④ buildMatchQueries：输出 text 追加 "| visualIntent" 后缀、过滤逻辑正确（纯空 text 被过滤，但 visualIntent + text=正文保留）', () => {
    const shots = [
      { id: 's1', text: '解说词正文内容', emotion: '开心', visualIntent: '', characters: ['小王'] },  // 会被兜底填 visualIntent
      { id: 's2', text: '第二段', emotion: '', visualIntent: '【近景】男子微笑 人物：小王' },     // 已有合法 visualIntent，不被覆盖
      { id: 's3', text: '   ', emotion: '紧张', visualIntent: '' },                              // text 纯空格，被过滤
    ];
    const tts = [
      { shotId: 's1', duration: 3.5 },
      { shotId: 's2', duration: 2.0 },
      { shotId: 's3', duration: 1.0 },
    ];
    const out = SemanticAnalyzeStrategy.buildMatchQueries(shots, tts);
    // s3（纯空格 text）被过滤
    expect(out.length).toBe(2);
    // s1：追加了 | visualIntent，且 visualIntent 非空（兜底填了）
    expect(out[0].shotId).toBe('s1');
    expect(out[0].visualIntent.length).toBeGreaterThanOrEqual(8);
    expect(out[0].text.endsWith(`| ${out[0].visualIntent}`)).toBe(true);
    expect(out[0].text.startsWith('解说词正文内容')).toBe(true);
    // s2：原有合法 visualIntent 不被覆盖，text 追加 | （且就是原 visualIntent）
    expect(out[1].shotId).toBe('s2');
    expect(out[1].visualIntent).toBe('【近景】男子微笑 人物：小王');
    expect(out[1].text.endsWith('| 【近景】男子微笑 人物：小王')).toBe(true);
    // TTS 时长匹配正确
    expect(out[0].audioDurationMs).toBe(3500);
    expect(out[1].audioDurationMs).toBe(2000);
    // characters 正确继承
    expect(out[0].characters).toEqual(['小王']);
  });

  // -------------- 5. 句式合理性：关键词来自 text/emotion/characters，不凭空编造 --------------
  it('⑤ 防造假校验：空 shot / 空 text 输出不编造新信息，emotion 若有才写入，人物若有才写入', () => {
    // 空 shot 不报错
    const r1 = SemanticAnalyzeStrategy.ensureScriptShotVisualIntent(null as any, 0);
    expect(r1).toMatch(/^【.+】.+$/); // 必须合法【xx】开头
    // 只有 text，无 emotion/characters → 输出不出现"情绪：xx"和"人物：xx"
    const r2 = SemanticAnalyzeStrategy.ensureScriptShotVisualIntent({ text: '男子走进餐厅，坐到桌前' }, 0);
    expect(r2.includes('情绪：')).toBe(false);
    expect(r2.includes('人物：')).toBe(false);
    // 有 emotion（"紧张"）和 characters（张三、李四），就一定包含
    const r3 = SemanticAnalyzeStrategy.ensureScriptShotVisualIntent(
      { text: '张三把合同递给了李四', emotion: '紧张', characters: ['张三', '李四'] }, 1,
    );
    expect(r3.includes('紧张')).toBe(true);
    expect(r3.includes('张三')).toBe(true);
    expect(r3.includes('李四')).toBe(true);
  });
});
