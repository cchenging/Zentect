// 📁 路径：src/main/core/__tests__/MultiChannelPipeline.test.ts
// Layer 4 进阶: AI 通道熔断自动切换单元测试
import { describe, it, expect, vi } from 'vitest';
import { MultiChannelPipeline } from '../MultiChannelPipeline';
import { AppError, ErrorCode } from '../../../modules/infra/error/AppError';

describe('MultiChannelPipeline', () => {
  it('主通道成功时应直接返回结果', async () => {
    const result = await MultiChannelPipeline.executeWithFailover(
      () => Promise.resolve('primary-ok'),
      () => Promise.resolve('fallback-ok')
    );
    expect(result).toBe('primary-ok');
  });

  it('主通道失败时应重试指定次数', async () => {
    let callCount = 0;
    const result = await MultiChannelPipeline.executeWithFailover(
      () => {
        callCount++;
        if (callCount < 3) throw new Error('temporary failure');
        return Promise.resolve('primary-recovered');
      },
      () => Promise.resolve('fallback-ok'),
      2
    );
    expect(result).toBe('primary-recovered');
    expect(callCount).toBe(3); // 初始1次 + 2次重试
  });

  it('主通道重试耗尽后应切换到备用通道', async () => {
    const result = await MultiChannelPipeline.executeWithFailover(
      () => Promise.reject(new Error('primary always fails')),
      () => Promise.resolve('fallback-ok'),
      0 // 不重试，直接切换
    );
    expect(result).toBe('fallback-ok');
  });

  it('双通道全灭时应抛出 AppError', async () => {
    await expect(
      MultiChannelPipeline.executeWithFailover(
        () => Promise.reject(new Error('primary down')),
        () => Promise.reject(new Error('fallback down')),
        0
      )
    ).rejects.toThrow('All LLM channels exhausted');
  });

  it('双通道全灭时错误码应为 AI_PROCESS_FAILED', async () => {
    try {
      await MultiChannelPipeline.executeWithFailover(
        () => Promise.reject(new Error('primary down')),
        () => Promise.reject(new Error('fallback down')),
        0
      );
    } catch (error: any) {
      expect(error).toBeInstanceOf(AppError);
      expect(error.code).toBe(ErrorCode.AI_PROCESS_FAILED);
    }
  });
});
