/* eslint-disable @typescript-eslint/no-explicit-any */
// 🎬 S3 正式 cutover：消费/剪辑改道档位 env 解析单测。
// 规格：docs/designs/2026-09-18-B系列实施规格.md §10（ZENTECT_KM_STORYBOARD_MODE=off|shadow|on，缺省 on 正式启用）
import { describe, expect, it } from 'vitest';
import { resolveStoryboardMode, STORYBOARD_MODE_ENV } from '../StoryboardAgent';

/** 允许测试内改写 process.env 的档位值，测完还原（避免污染其它用例）。 */
function withMode(value: string | undefined, fn: () => void) {
  const g = globalThis as unknown as { process?: { env?: Record<string, string | undefined> } };
  const proc = g.process!;
  const prev = proc.env ? proc.env[STORYBOARD_MODE_ENV] : undefined;
  if (proc.env) {
    if (value === undefined) delete proc.env[STORYBOARD_MODE_ENV];
    else proc.env[STORYBOARD_MODE_ENV] = value;
  }
  try {
    fn();
  } finally {
    if (proc.env) {
      if (prev === undefined) delete proc.env[STORYBOARD_MODE_ENV];
      else proc.env[STORYBOARD_MODE_ENV] = prev;
    }
  }
}

describe('S3 消费档位 env 解析（resolveStoryboardMode）', () => {
  it('显式 on → on（正式启用）', () => {
    withMode('on', () => expect(resolveStoryboardMode()).toBe('on'));
  });

  it('显式 shadow → shadow（双轨对照，B6）', () => {
    withMode('shadow', () => expect(resolveStoryboardMode()).toBe('shadow'));
  });

  it('显式 off → off（完全旁路）', () => {
    withMode('off', () => expect(resolveStoryboardMode()).toBe('off'));
  });

  it('未设置 → 缺省 on（正式 cutover 默认启用）', () => {
    withMode(undefined, () => expect(resolveStoryboardMode()).toBe('on'));
  });

  it('未知值/大小写混合 → 回退 on', () => {
    withMode('  ON ', () => expect(resolveStoryboardMode()).toBe('on'));
    withMode('bogus', () => expect(resolveStoryboardMode()).toBe('on'));
  });
});