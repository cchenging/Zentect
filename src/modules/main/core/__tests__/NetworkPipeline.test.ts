// 📁 路径：src/main/core/__tests__/NetworkPipeline.test.ts
// Layer 4 脏数据清洗管道单元测试
import { describe, it, expect } from 'vitest';
import { NetworkPipeline } from '../NetworkPipeline';

describe('NetworkPipeline.sanitizeJson', () => {
  it('应剥离 ```json 标记', () => {
    const input = '```json\n{"key": "value"}\n```';
    const result = NetworkPipeline.sanitizeJson(input);
    expect(result).toBe('{"key": "value"}');
  });

  it('应剥离 ``` 标记', () => {
    const input = '```\n[1, 2, 3]\n```';
    const result = NetworkPipeline.sanitizeJson(input);
    expect(result).toBe('[1, 2, 3]');
  });

  it('应剥离前后废话文本', () => {
    const input = '这是生成的结果：\n{"key": "value"}\n以上是输出。';
    const result = NetworkPipeline.sanitizeJson(input);
    expect(result).toBe('{"key": "value"}');
  });

  it('应正确处理数组格式', () => {
    const input = '好的，以下是结果：\n[{"id": 1}, {"id": 2}]\n希望对你有帮助。';
    const result = NetworkPipeline.sanitizeJson(input);
    expect(result).toBe('[{"id": 1}, {"id": 2}]');
  });

  it('纯 JSON 输入应原样返回', () => {
    const input = '{"key": "value"}';
    const result = NetworkPipeline.sanitizeJson(input);
    expect(result).toBe('{"key": "value"}');
  });

  it('空字符串应原样返回', () => {
    expect(NetworkPipeline.sanitizeJson('')).toBe('');
  });

  it('null/undefined 应原样返回', () => {
    expect(NetworkPipeline.sanitizeJson(null as any)).toBe(null);
    expect(NetworkPipeline.sanitizeJson(undefined as any)).toBe(undefined);
  });
});

describe('NetworkPipeline.safeParseJson', () => {
  it('应正确解析带标记的 JSON', () => {
    const input = '```json\n{"name": "test"}\n```';
    const result = NetworkPipeline.safeParseJson(input);
    expect(result).toEqual({ name: 'test' });
  });

  it('解析失败应返回 null', () => {
    const result = NetworkPipeline.safeParseJson('not json at all');
    expect(result).toBeNull();
  });
});

describe('NetworkPipeline.strictParseJson', () => {
  it('应正确解析带标记的 JSON', () => {
    const input = '```json\n[1, 2, 3]\n```';
    const result = NetworkPipeline.strictParseJson(input);
    expect(result).toEqual([1, 2, 3]);
  });

  it('解析失败应抛出含 contract 标记的错误', () => {
    expect(() => NetworkPipeline.strictParseJson('not json')).toThrow();
    try {
      NetworkPipeline.strictParseJson('not json');
    } catch (e: any) {
      expect(e.message).toContain('contract');
      expect(e.isContractError).toBe(true);
    }
  });
});
