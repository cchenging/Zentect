// Module: editor/preview - Types 单元测试

import { describe, it, expect } from 'vitest';
import type {
  PreviewInput,
  PreviewOutput,
  PreviewCallbacks,
} from '../types';

describe('Preview Types', () => {
  describe('PreviewInput', () => {
    it('应包含 mediaPath 字段（可为 null）', () => {
      const input: PreviewInput = { mediaPath: null };
      expect(input.mediaPath).toBeNull();
    });

    it('mediaPath 为字符串时应可传递路径', () => {
      const input: PreviewInput = { mediaPath: 'C:/videos/demo.mp4' };
      expect(input.mediaPath).toBe('C:/videos/demo.mp4');
    });

    it('可选字段 startMs 应在传入时生效', () => {
      const input: PreviewInput = {
        mediaPath: '/video.mp4',
        startMs: 5000,
      };
      expect(input.startMs).toBe(5000);
    });

    it('可选字段 endMs 应在传入时生效', () => {
      const input: PreviewInput = {
        mediaPath: '/video.mp4',
        endMs: 30000,
      };
      expect(input.endMs).toBe(30000);
    });

    it('startMs 和 endMs 同时传入应构成区间', () => {
      const input: PreviewInput = {
        mediaPath: '/video.mp4',
        startMs: 10000,
        endMs: 60000,
      };
      expect(input.startMs).toBe(10000);
      expect(input.endMs).toBe(60000);
    });

    it('省略可选字段应允许', () => {
      const input: PreviewInput = { mediaPath: '/video.mp4' };
      expect(input.startMs).toBeUndefined();
      expect(input.endMs).toBeUndefined();
    });
  });

  describe('PreviewOutput', () => {
    it('应包含 currentTime 和 isPlaying 两个必填字段', () => {
      const output: PreviewOutput = { currentTime: 12.5, isPlaying: true };
      expect(output.currentTime).toBe(12.5);
      expect(output.isPlaying).toBe(true);
    });

    it('currentTime 为 0 应为合法', () => {
      const output: PreviewOutput = { currentTime: 0, isPlaying: false };
      expect(output.currentTime).toBe(0);
    });

    it('isPlaying=false 表示暂停状态', () => {
      const output: PreviewOutput = { currentTime: 5.0, isPlaying: false };
      expect(output.isPlaying).toBe(false);
    });
  });

  describe('PreviewCallbacks', () => {
    it('应包含两个可选的函数字段', () => {
      const cbs: PreviewCallbacks = {};
      expect(cbs.onTimeUpdate).toBeUndefined();
      expect(cbs.onImportClick).toBeUndefined();
    });

    it('onTimeUpdate 应接收 number 参数', () => {
      let captured = -1;
      const cbs: PreviewCallbacks = {
        onTimeUpdate: (time: number) => { captured = time; },
      };
      cbs.onTimeUpdate!(42.5);
      expect(captured).toBe(42.5);
    });

    it('onImportClick 应为无参回调', () => {
      let called = false;
      const cbs: PreviewCallbacks = {
        onImportClick: () => { called = true; },
      };
      cbs.onImportClick!();
      expect(called).toBe(true);
    });

    it('两个回调同时传入应共存', () => {
      let timeVal = 0;
      let importCalled = false;
      const cbs: PreviewCallbacks = {
        onTimeUpdate: (t) => { timeVal = t; },
        onImportClick: () => { importCalled = true; },
      };
      cbs.onTimeUpdate!(10);
      cbs.onImportClick!();
      expect(timeVal).toBe(10);
      expect(importCalled).toBe(true);
    });
  });
});
