// Module: media/frames - Types 单元测试
// P0 · 契约收拢：2 枚举（AUTO_ADAPTIVE | UNIFORM_FPS）+ 历史兼容别名。

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
// P0 · 抽帧契约共享层唯一真源
import {
  normalizeFrameStrategy,
  DENSITY_PRESET_CONFIG,
} from '../../../../shared/contracts/capabilities';

describe('Media Frames Types（P0 · 2 枚举收拢 + 历史兼容别名）', () => {
  describe('FRAME_STRATEGIES 常量', () => {
    it('应包含 2 个新枚举 + 3 个历史兼容别名（共 5 键）', () => {
      const keys = Object.keys(FRAME_STRATEGIES);
      expect(keys).toContain('AUTO_ADAPTIVE');
      expect(keys).toContain('UNIFORM_FPS');
      expect(keys).toContain('VLM_OPTIMIZED');
      expect(keys).toContain('FAST_KEYFRAME');
      expect(keys).toContain('PRECISE_SINGLE');
      expect(keys).toHaveLength(5);
    });

    it('P0 · 兼容别名归一化：VLM_OPTIMIZED / FAST_KEYFRAME / PRECISE_SINGLE → 取值为 AUTO_ADAPTIVE（收拢核心不变式）', () => {
      expect(FRAME_STRATEGIES.VLM_OPTIMIZED).toBe('AUTO_ADAPTIVE');
      expect(FRAME_STRATEGIES.FAST_KEYFRAME).toBe('AUTO_ADAPTIVE');
      expect(FRAME_STRATEGIES.PRECISE_SINGLE).toBe('AUTO_ADAPTIVE');
      expect(FRAME_STRATEGIES.AUTO_ADAPTIVE).toBe('AUTO_ADAPTIVE');
      expect(FRAME_STRATEGIES.UNIFORM_FPS).toBe('UNIFORM_FPS');
    });

    it('新旧值通过 normalizeFrameStrategy 全部映射成功', () => {
      expect(normalizeFrameStrategy(FRAME_STRATEGIES.AUTO_ADAPTIVE)).toBe('AUTO_ADAPTIVE');
      expect(normalizeFrameStrategy(FRAME_STRATEGIES.UNIFORM_FPS)).toBe('UNIFORM_FPS');
      expect(normalizeFrameStrategy(FRAME_STRATEGIES.VLM_OPTIMIZED)).toBe('AUTO_ADAPTIVE');
      expect(normalizeFrameStrategy(FRAME_STRATEGIES.FAST_KEYFRAME)).toBe('AUTO_ADAPTIVE');
      expect(normalizeFrameStrategy(FRAME_STRATEGIES.PRECISE_SINGLE)).toBe('AUTO_ADAPTIVE');
    });
  });

  describe('DensityPreset · 3 档参数约束（framesPerMinute / minFrameInterval / sceneThreshold）', () => {
    it('sparse → standard → dense：framesPerMinute 严格递增（抽帧越来越密）', () => {
      const sp = DENSITY_PRESET_CONFIG.sparse.framesPerMinute;
      const st = DENSITY_PRESET_CONFIG.standard.framesPerMinute;
      const dn = DENSITY_PRESET_CONFIG.dense.framesPerMinute;
      expect(sp).toBeLessThan(st);
      expect(st).toBeLessThan(dn);
    });
    it('sparse → standard → dense：minFrameInterval 严格递减（最小间隔越小 = 越密）', () => {
      const sp = DENSITY_PRESET_CONFIG.sparse.minFrameInterval;
      const st = DENSITY_PRESET_CONFIG.standard.minFrameInterval;
      const dn = DENSITY_PRESET_CONFIG.dense.minFrameInterval;
      expect(sp).toBeGreaterThan(st);
      expect(st).toBeGreaterThan(dn);
    });
    it('典型 2 小时电影 × standard 档 → 2400 张预算（解决"2000+ 爆 Token"）', () => {
      const total = 120 * DENSITY_PRESET_CONFIG.standard.framesPerMinute;
      expect(total).toBe(120 * 20);
      expect(total).toBeLessThanOrEqual(2640); // 含 10% 容差
    });
  });

  describe('FrameExtractInput', () => {
    it('应接受必填字段 videoPath 和 mode（新 2 枚举合法）', () => {
      const input: FrameExtractInput = {
        videoPath: 'C:/videos/test.mp4',
        mode: 'AUTO_ADAPTIVE',
      };
      expect(input.videoPath).toBe('C:/videos/test.mp4');
      expect(input.mode).toBe('AUTO_ADAPTIVE');
    });

    it('P0 · mode 为 FrameStrategy | string：历史旧字符串（VLM_OPTIMIZED 等）也合法（不崩溃）', () => {
      const inputOld: FrameExtractInput = {
        videoPath: 'C:/videos/old.mp4',
        mode: 'VLM_OPTIMIZED',
      };
      const inputOld2: FrameExtractInput = {
        videoPath: '/videos/minimal.mp4',
        mode: 'FAST_KEYFRAME',
      };
      expect(normalizeFrameStrategy(String(inputOld.mode))).toBe('AUTO_ADAPTIVE');
      expect(inputOld2.sceneThreshold).toBeUndefined();
    });

    it('应接受所有可选参数 + densityPreset（P0 新）', () => {
      const input: FrameExtractInput = {
        videoPath: 'C:/videos/test.mp4',
        mode: 'UNIFORM_FPS',
        densityPreset: 'dense',
        sceneThreshold: 0.35,
        minFrameInterval: 6,
        fps: 2,
        scale: 1920,
        quality: 2,
        timePoint: 30.5,
        inPoint: 10.0,
        outPoint: 120.0,
      };
      expect(input.densityPreset).toBe('dense');
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
        mode: 'AUTO_ADAPTIVE',
      };
      expect(input.densityPreset).toBeUndefined();
      expect(input.sceneThreshold).toBeUndefined();
      expect(input.minFrameInterval).toBeUndefined();
      expect(input.fps).toBeUndefined();
      expect(input.scale).toBeUndefined();
      expect(input.quality).toBeUndefined();
      expect(input.timePoint).toBeUndefined();
      expect(input.inPoint).toBeUndefined();
      expect(input.outPoint).toBeUndefined();
    });

    it('mode 在类型层支持 FrameStrategy 2 枚举；字符串别名由 normalizeFrameStrategy 兜底', () => {
      // 严格类型：FrameStrategy 只能是 AUTO_ADAPTIVE / UNIFORM_FPS
      const strictModes: FrameStrategy[] = ['AUTO_ADAPTIVE', 'UNIFORM_FPS'];
      for (const mode of strictModes) {
        const input: FrameExtractInput = { videoPath: '/v.mp4', mode };
        expect(input.mode).toBe(mode);
      }
      // 兼容字符串别名（FrameExtractInput.mode 放宽为 string）
      const legacy: (FrameStrategy | string)[] = ['VLM_OPTIMIZED', 'FAST_KEYFRAME', 'PRECISE_SINGLE'];
      for (const mode of legacy) {
        const normalized = normalizeFrameStrategy(String(mode));
        expect(['AUTO_ADAPTIVE', 'UNIFORM_FPS']).toContain(normalized);
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
