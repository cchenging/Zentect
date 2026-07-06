// Module: media/frames - Types 单元测试

import { describe, it, expect } from 'vitest';
import {
  FRAME_STRATEGIES,
} from '../types';
import type {
  FrameStrategy,
  FrameExtractInput,
  FrameExtractOutput,
  FrameExtractionTelemetry,
} from '../types';

describe('Media Frames Types', () => {
  describe('FRAME_STRATEGIES 常量', () => {
    it('应包含全部四种策略', () => {
      expect(FRAME_STRATEGIES.VLM_OPTIMIZED).toBe('VLM_OPTIMIZED');
      expect(FRAME_STRATEGIES.UNIFORM_FPS).toBe('UNIFORM_FPS');
      expect(FRAME_STRATEGIES.FAST_KEYFRAME).toBe('FAST_KEYFRAME');
      expect(FRAME_STRATEGIES.PRECISE_SINGLE).toBe('PRECISE_SINGLE');
    });

    it('所有常量值应与自身名称一致', () => {
      const entries = Object.entries(FRAME_STRATEGIES);
      for (const [key, value] of entries) {
        expect(key).toBe(value);
      }
    });

    it('应为 const 断言（只读）', () => {
      expect(FRAME_STRATEGIES).toBeDefined();
      expect(Object.keys(FRAME_STRATEGIES)).toHaveLength(4);
    });
  });

  describe('FrameExtractInput', () => {
    it('应接受必填字段 videoPath 和 mode', () => {
      const input: FrameExtractInput = {
        videoPath: 'C:/videos/test.mp4',
        mode: 'VLM_OPTIMIZED',
      };
      expect(input.videoPath).toBe('C:/videos/test.mp4');
      expect(input.mode).toBe('VLM_OPTIMIZED');
    });

    it('应接受所有可选参数', () => {
      const input: FrameExtractInput = {
        videoPath: 'C:/videos/test.mp4',
        mode: 'UNIFORM_FPS',
        sceneThreshold: 0.35,
        minFrameInterval: 6,
        fps: 2,
        scale: 1920,
        quality: 2,
        timePoint: 30.5,
        inPoint: 10.0,
        outPoint: 120.0,
      };
      expect(input.sceneThreshold).toBe(0.35);
      expect(input.minFrameInterval).toBe(6);
      expect(input.fps).toBe(2);
      expect(input.scale).toBe(1920);
      expect(input.quality).toBe(2);
      expect(input.timePoint).toBe(30.5);
      expect(input.inPoint).toBe(10.0);
      expect(input.outPoint).toBe(120.0);
    });

    it('可选字段缺失时类型系统应接受', () => {
      const input: FrameExtractInput = {
        videoPath: '/videos/minimal.mp4',
        mode: 'FAST_KEYFRAME',
      };
      expect(input.sceneThreshold).toBeUndefined();
      expect(input.minFrameInterval).toBeUndefined();
      expect(input.fps).toBeUndefined();
      expect(input.scale).toBeUndefined();
      expect(input.quality).toBeUndefined();
      expect(input.timePoint).toBeUndefined();
      expect(input.inPoint).toBeUndefined();
      expect(input.outPoint).toBeUndefined();
    });

    it('mode 应为任意 FrameStrategy 值', () => {
      const modes: FrameStrategy[] = ['VLM_OPTIMIZED', 'UNIFORM_FPS', 'FAST_KEYFRAME', 'PRECISE_SINGLE'];
      for (const mode of modes) {
        const input: FrameExtractInput = { videoPath: '/v.mp4', mode };
        expect(input.mode).toBe(mode);
      }
    });
  });

  describe('FrameExtractOutput', () => {
    it('应包含 framePaths 和 frameCount', () => {
      const output: FrameExtractOutput = {
        framePaths: ['/frames/frame_00000001.jpg', '/frames/frame_00000002.jpg'],
        frameCount: 2,
      };
      expect(output.framePaths).toHaveLength(2);
      expect(output.frameCount).toBe(2);
    });

    it('空帧结果应为合法结构', () => {
      const output: FrameExtractOutput = {
        framePaths: [],
        frameCount: 0,
      };
      expect(output.framePaths).toHaveLength(0);
      expect(output.frameCount).toBe(0);
    });
  });

  describe('FrameExtractionTelemetry', () => {
    it('应包含 files 和完整 metrics', () => {
      const telemetry: FrameExtractionTelemetry = {
        files: ['/out/frame_00000001.jpg', '/out/frame_00000002.jpg'],
        metrics: {
          durationMs: 1234,
          frameCount: 42,
          totalSizeMB: 3.14,
          processingFps: 34.05,
        },
      };
      expect(telemetry.files).toHaveLength(2);
      expect(telemetry.metrics.durationMs).toBe(1234);
      expect(telemetry.metrics.frameCount).toBe(42);
      expect(telemetry.metrics.totalSizeMB).toBeCloseTo(3.14);
      expect(telemetry.metrics.processingFps).toBeCloseTo(34.05);
    });

    it('空遥测应为合法结构', () => {
      const telemetry: FrameExtractionTelemetry = {
        files: [],
        metrics: {
          durationMs: 0,
          frameCount: 0,
          totalSizeMB: 0,
          processingFps: 0,
        },
      };
      expect(telemetry.files).toHaveLength(0);
      expect(telemetry.metrics.frameCount).toBe(0);
    });
  });
});
