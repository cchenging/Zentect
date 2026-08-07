// Module: media/frames - SmartFramePostProcessor 纯函数单元测试
// 仅测试不依赖磁盘/sharp 读取的确定性纯函数（清晰度/去重/时序推导由 process 集成验证）

import { describe, it, expect } from 'vitest';
import { SmartFramePostProcessor } from '../backend/SmartFramePostProcessor';

describe('SmartFramePostProcessor.formatTimeMs', () => {
  it('应格式化毫秒为 mm:ss.SSS', () => {
    expect(SmartFramePostProcessor.formatTimeMs(4250)).toBe('00:04.250');
  });

  it('超过一分钟应进位', () => {
    expect(SmartFramePostProcessor.formatTimeMs(65400)).toBe('01:05.400');
  });

  it('负值应被钳制为 0', () => {
    expect(SmartFramePostProcessor.formatTimeMs(-1)).toBe('00:00.000');
  });
});

describe('SmartFramePostProcessor.hammingDistance', () => {
  it('相同哈希距离为 0', () => {
    expect(SmartFramePostProcessor.hammingDistance('1010', '1010')).toBe(0);
  });

  it('逐位不同数即汉明距离', () => {
    expect(SmartFramePostProcessor.hammingDistance('1011', '1000')).toBe(2);
  });

  it('长度不等返回最大值（视为不可比）', () => {
    expect(SmartFramePostProcessor.hammingDistance('101', '1011')).toBe(Number.MAX_SAFE_INTEGER);
  });
});