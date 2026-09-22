// Module: pipeline/step3-script - breakLongParagraphs 爆破切分器单元测试
// 重点覆盖：子句对父段落 characters（期望角色名单）的继承

import { describe, it, expect } from 'vitest';
import { breakLongParagraphs } from '../frontend/breakLongParagraphs';
import {
  countCompleteSentences,
  resolveScriptMatchUnitMode,
  summarizeScriptMatchUnits,
} from '../../../../shared/utils/scriptMatchUnit';

describe('breakLongParagraphs 爆破切分器', () => {
  // ==================== 短句直接保留 ====================

  it('字数 <= 18 的短句应原样保留（含角色名单继承）', () => {
    const result = breakLongParagraphs([
      { id: 'p1', text: '高启强走进房间', duration: 3, characters: ['role_1'] },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('p1');
    expect(result[0].text).toBe('高启强走进房间');
    expect(result[0].characters).toEqual(['role_1']);
  });

  it('短句无 characters 时返回 undefined（合法透传，不兜底）', () => {
    const result = breakLongParagraphs([
      { id: 'p1', text: '简短一句话', duration: 2 },
    ]);
    expect(result[0].characters).toBeUndefined();
  });

  // ==================== 长句拆分 ====================

  it('字数 > 18 的长句按标点拆分为子句，且每个子句继承父段落角色名单', () => {
    const longText = '谁能想到，这个在菜市场被按在地上摩擦的卖鱼佬，三年后竟然成了全省最大。';
    const result = breakLongParagraphs([
      { id: 'p1', text: longText, duration: 4, characters: ['role_1', 'role_2'] },
    ]);
    // 长句应被拆分出多个子句
    expect(result.length).toBeGreaterThan(1);
    // 每个子句都必须继承父段落角色名单
    result.forEach((sub) => {
      expect(sub.characters).toEqual(['role_1', 'role_2']);
    });
    // 子句 id 使用父 id 前缀
    expect(result[0].id.startsWith('p1_sub_')).toBe(true);
  });

  it('长句拆分后拼接文本内容应与原文一致（去标点保留）', () => {
    const longText = '他推开门，目光扫过昏暗的走廊，最终停在角落。';
    const result = breakLongParagraphs([{ id: 'p1', text: longText, duration: 4 }]);
    const joined = result.map((s) => s.text).join('');
    // 切分只按标点拆分，不丢字
    expect(joined.replace(/[，。]/g, '')).toBe(longText.replace(/[，。]/g, ''));
  });

  // ==================== 时长分配 ====================

  it('每个子句时长至少 1.2 秒', () => {
    const longText = '这是一个非常长的句子用来测试切分时长的分配逻辑，确保每个子句都有合理时长。';
    const result = breakLongParagraphs([{ id: 'p1', text: longText, duration: 3 }]);
    result.forEach((sub) => {
      expect(sub.duration).toBeGreaterThanOrEqual(1.2);
    });
  });

  // ==================== 角色继承边界 ====================

  it('混合输入：短句与长句各自保留/继承自己的角色名单', () => {
    const result = breakLongParagraphs([
      { id: 'p1', text: '短句', duration: 2, characters: ['role_1'] },
      { id: 'p2', text: '这是一个超过十八个字符的长段落需要被拆分处理确保准确性', duration: 4, characters: ['role_2', 'role_3'] },
    ]);
    // 第一段短句保留
    expect(result[0].characters).toEqual(['role_1']);
    // 第二段所有子句继承 role_2/role_3
    const secondParas = result.filter((s) => s.id.startsWith('p2_sub_'));
    expect(secondParas.length).toBeGreaterThan(0);
    secondParas.forEach((sub) => {
      expect(sub.characters).toEqual(['role_2', 'role_3']);
    });
  });

  it('空数组入参返回空数组', () => {
    expect(breakLongParagraphs([])).toEqual([]);
  });

  // ==================== 小数保护 ====================

  it('包含小数（如 19.9）的文本不应被半角小数点切分', () => {
    const result = breakLongParagraphs([
      { id: 'p1', text: '价格只要19.9元，赶紧下单吧。', duration: 3 },
    ]);
    // 小数不能被硬切成 "19." + "9"：拼接后必须还原为 "19.9"
    const joined = result.map((s) => s.text).join('');
    expect(joined).toContain('19.9');
    // 任何子句都不应以残留下的小数点片段结尾（如 "19."），这才是被切断的标志
    result.forEach((s) => {
      expect(s.text).not.toMatch(/\d\.\s*$/);
    });
  });

  it('多个小数同时保护，且不影响英文句点断句', () => {
    const result = breakLongParagraphs([
      { id: 'p1', text: '涨幅3.5倍，成本1.2万元。这是第二句。', duration: 4 },
    ]);
    const joined = result.map((s) => s.text).join('');
    expect(joined).toContain('3.5');
    expect(joined).toContain('1.2');
    // 句号后应正常断句（"这是第二句。"应独立成段）
    expect(result.some((s) => s.text.includes('这是第二句'))).toBe(true);
  });
});

// ==================== 匹配单位：一个完整句 = 一个匹配单位（ZENTECT_SCRIPT_MATCH_UNIT） ====================
// 样例取自真实线上请求 temp/p1-req.json 的 seg_0 母句（一个完整句被逗号切成 3 个碎片）。
describe('breakLongParagraphs 匹配单位（sentence / legacy）', () => {
  const SAMPLE_SENTENCE = '谁能想到，这个被朋友送上飞机的女孩，刚落地上海就变成了无家可归的穷光蛋。';

  it('legacy 档（默认）：不写 matchUnitId，产物与现状一致', () => {
    const out = breakLongParagraphs([{ id: 'seg_0', text: SAMPLE_SENTENCE, duration: 6 }]);
    expect(out.length).toBeGreaterThan(1);
    out.forEach((s) => expect(s.matchUnitId).toBeUndefined());
  });

  it('sentence 档：同一完整句的全部碎片共享同一个 matchUnitId（= 母句 id）', () => {
    const out = breakLongParagraphs(
      [{ id: 'seg_0', text: SAMPLE_SENTENCE, duration: 6 }],
      { matchUnit: 'sentence' },
    );
    expect(out.length).toBeGreaterThan(1);
    out.forEach((s) => expect(s.matchUnitId).toBe('seg_0'));
  });

  it('sentence 档：同一母段落内的多个完整句 → 各自独立的匹配单位 id', () => {
    const out = breakLongParagraphs(
      [{ id: 'seg_7', text: '第一句话特别长而且没有逗号，需要被逗号切开看看。第二句话很短。', duration: 6 }],
      { matchUnit: 'sentence' },
    );
    const units = Array.from(new Set(out.map((s) => s.matchUnitId)));
    expect(units).toEqual(['seg_7_s1', 'seg_7_s2']);
  });

  it('sentence 档把碎片率压到 ≤20%（真实样例口径）', () => {
    const input = { id: 'seg_0', text: SAMPLE_SENTENCE, duration: 6 };
    const legacyShots = breakLongParagraphs([input]);
    const sentenceShots = breakLongParagraphs([input], { matchUnit: 'sentence' });
    const sentences = countCompleteSentences(input.text);
    expect(sentences).toBe(1); // 母句本身是一个完整句

    const legacy = summarizeScriptMatchUnits(legacyShots, sentences);
    const sentence = summarizeScriptMatchUnits(sentenceShots, sentences);

    // legacy：每个碎片各算一个匹配单位 ⇒ 碎片率 = (3 − 1) / 3 ≈ 66.7%
    expect(legacy.clauses).toBe(3);
    expect(legacy.matchUnits).toBe(3);
    expect(legacy.fragmentRate).toBeGreaterThan(0.5);
    // sentence：一个完整句只算一个匹配单位 ⇒ 碎片率 0%
    expect(sentence.clauses).toBe(3);
    expect(sentence.matchUnits).toBe(1);
    expect(sentence.fragmentRate).toBe(0);
  });

  it('开关缺省为 legacy（线上行为零变化）', () => {
    expect(resolveScriptMatchUnitMode()).toBe('legacy');
  });
});