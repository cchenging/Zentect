// Module: shared/utils - safeParseVlmJson 单元测试
// 验证鲁棒 JSON 提取器对各视觉大模型返回格式差异的容错处理

import { describe, it, expect } from 'vitest';
import { safeParseVlmJson } from '../jsonUtils';

describe('safeParseVlmJson', () => {
  it('应解析纯 JSON 对象', () => {
    const raw = '{"frames":[{"action":"走"}]}';
    expect(safeParseVlmJson<any>(raw)).toEqual({ frames: [{ action: '走' }] });
  });

  it('应剥离 Markdown 代码块标记（```json ... ```）', () => {
    const raw = '```json\n{"frames":[{"action":"跑"}]}\n```';
    expect(safeParseVlmJson<any>(raw)).toEqual({ frames: [{ action: '跑' }] });
  });

  it('应剥离不带 json 语言的代码块标记（``` ... ```）', () => {
    const raw = '```\n{"frames":[{"action":"跳"}]}\n```';
    expect(safeParseVlmJson<any>(raw)).toEqual({ frames: [{ action: '跳' }] });
  });

  it('应截断 JSON 前后的解释性废话', () => {
    const raw = '好的，以下是分析结果：\n{"frames":[{"action":"笑"}]}\n希望这些信息对你有帮助！';
    expect(safeParseVlmJson<any>(raw)).toEqual({ frames: [{ action: '笑' }] });
  });

  it('应解析裸数组（兼容旧版返回格式）', () => {
    const raw = '[{"action":"读"},{"action":"写"}]';
    expect(safeParseVlmJson<any>(raw)).toEqual([{ action: '读' }, { action: '写' }]);
  });

  it('内容为空时应抛错', () => {
    expect(() => safeParseVlmJson('')).toThrow('VLM 返回内容为空');
    expect(() => safeParseVlmJson('   ')).toThrow('VLM 返回内容为空');
    expect(() => safeParseVlmJson(null as any)).toThrow('VLM 返回内容为空');
  });

  it('非法 JSON 时应抛错（错就错，不降级）', () => {
    expect(() => safeParseVlmJson('这不是 JSON')).toThrow('未按规范返回合法 JSON');
  });

  it('只有代码块标记无内容时应抛错', () => {
    expect(() => safeParseVlmJson('```json\n```')).toThrow('未按规范返回合法 JSON');
  });
});