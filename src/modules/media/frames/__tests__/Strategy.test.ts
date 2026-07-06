// Module: media/frames - Strategy 单元测试

import { describe, it, expect } from 'vitest';
import { buildExtractCommand } from '../backend/Strategy';
import type { FrameStrategy } from '../types';

describe('buildExtractCommand', () => {
  const baseConfig = {
    videoPath: 'C:/videos/test.mp4',
    outputPath: 'C:/frames/frame_%08d.jpg',
    strategy: 'VLM_OPTIMIZED' as FrameStrategy,
    fps: 2,
    sceneThreshold: 0.28,
    minFrameInterval: 4,
    width: 1024,
    quality: 3,
    threads: 4,
  };

  // ==================== VLM_OPTIMIZED 策略 ====================

  describe('VLM_OPTIMIZED 策略', () => {
    it('应包含场景检测 + 最小间隔兜底滤镜', () => {
      const args = buildExtractCommand({ ...baseConfig, strategy: 'VLM_OPTIMIZED' });
      const vfArg = args.find(a => a === '-vf') ? args[args.indexOf('-vf') + 1] : '';
      expect(vfArg).toContain('gt(scene');
      expect(vfArg).toContain('gte(t-prev_selected_t');
    });

    it('应包含 vsync=vfr', () => {
      const args = buildExtractCommand({ ...baseConfig, strategy: 'VLM_OPTIMIZED' });
      expect(args).toContain('-vsync');
      expect(args).toContain('vfr');
    });

    it('应包含输入和输出路径', () => {
      const args = buildExtractCommand({ ...baseConfig, strategy: 'VLM_OPTIMIZED' });
      expect(args).toContain(baseConfig.videoPath);
      expect(args).toContain(baseConfig.outputPath);
    });

    it('应包含 -y 覆盖标记', () => {
      const args = buildExtractCommand({ ...baseConfig, strategy: 'VLM_OPTIMIZED' });
      expect(args[0]).toBe('-y');
    });

    it('应包含自定义 sceneThreshold', () => {
      const args = buildExtractCommand({ ...baseConfig, strategy: 'VLM_OPTIMIZED', sceneThreshold: 0.5 });
      const vfArg = args.find(a => a === '-vf') ? args[args.indexOf('-vf') + 1] : '';
      expect(vfArg).toContain('0.5');
    });

    it('应包含自定义 minFrameInterval', () => {
      const args = buildExtractCommand({ ...baseConfig, strategy: 'VLM_OPTIMIZED', minFrameInterval: 10 });
      const vfArg = args.find(a => a === '-vf') ? args[args.indexOf('-vf') + 1] : '';
      expect(vfArg).toContain('10');
    });

    it('应包含缩放滤镜', () => {
      const args = buildExtractCommand({ ...baseConfig, strategy: 'VLM_OPTIMIZED', width: 800 });
      const vfArg = args.find(a => a === '-vf') ? args[args.indexOf('-vf') + 1] : '';
      expect(vfArg).toContain('scale=800:-1');
    });

    it('应包含线程参数', () => {
      const args = buildExtractCommand({ ...baseConfig, strategy: 'VLM_OPTIMIZED', threads: 8 });
      const idx = args.indexOf('-threads');
      expect(idx).not.toBe(-1);
      expect(args[idx + 1]).toBe('8');
    });

    it('inPoint 应添加 -ss 参数', () => {
      const args = buildExtractCommand({ ...baseConfig, strategy: 'VLM_OPTIMIZED', inPoint: 10 });
      const ssIdx = args.indexOf('-ss');
      expect(ssIdx).not.toBe(-1);
      expect(args[ssIdx + 1]).toBe('10');
    });

    it('outPoint 应添加 -to 参数', () => {
      const args = buildExtractCommand({ ...baseConfig, strategy: 'VLM_OPTIMIZED', outPoint: 60 });
      const toIdx = args.indexOf('-to');
      expect(toIdx).not.toBe(-1);
      expect(args[toIdx + 1]).toBe('60');
    });
  });

  // ==================== UNIFORM_FPS 策略 ====================

  describe('UNIFORM_FPS 策略', () => {
    it('应包含 fps 滤镜', () => {
      const args = buildExtractCommand({ ...baseConfig, strategy: 'UNIFORM_FPS', fps: 3 });
      const vfArg = args.find(a => a === '-vf') ? args[args.indexOf('-vf') + 1] : '';
      expect(vfArg).toContain('fps=3');
    });

    it('应包含缩放滤镜', () => {
      const args = buildExtractCommand({ ...baseConfig, strategy: 'UNIFORM_FPS' });
      const vfArg = args.find(a => a === '-vf') ? args[args.indexOf('-vf') + 1] : '';
      expect(vfArg).toContain('scale=1024:-1');
    });

    it('不应包含 vsync=vfr', () => {
      const args = buildExtractCommand({ ...baseConfig, strategy: 'UNIFORM_FPS' });
      expect(args).not.toContain('-vsync');
    });

    it('应包含输入路径在 -i 后', () => {
      const args = buildExtractCommand({ ...baseConfig, strategy: 'UNIFORM_FPS' });
      const iIdx = args.indexOf('-i');
      expect(iIdx).not.toBe(-1);
      expect(args[iIdx + 1]).toBe(baseConfig.videoPath);
    });
  });

  // ==================== FAST_KEYFRAME 策略 ====================

  describe('FAST_KEYFRAME 策略', () => {
    it('应包含关键帧 select 滤镜', () => {
      const args = buildExtractCommand({ ...baseConfig, strategy: 'FAST_KEYFRAME' });
      const vfArg = args.find(a => a === '-vf') ? args[args.indexOf('-vf') + 1] : '';
      expect(vfArg).toContain("eq(pict_type\\,I)");
    });

    it('应包含 -skip_frame nokey', () => {
      const args = buildExtractCommand({ ...baseConfig, strategy: 'FAST_KEYFRAME' });
      expect(args).toContain('-skip_frame');
      expect(args).toContain('nokey');
    });

    it('应包含 vsync=vfr', () => {
      const args = buildExtractCommand({ ...baseConfig, strategy: 'FAST_KEYFRAME' });
      expect(args).toContain('-vsync');
      expect(args).toContain('vfr');
    });
  });

  // ==================== PRECISE_SINGLE 策略 ====================

  describe('PRECISE_SINGLE 策略', () => {
    it('应包含 -vframes 1', () => {
      const args = buildExtractCommand({ ...baseConfig, strategy: 'PRECISE_SINGLE', timePoint: 45 });
      expect(args).toContain('-vframes');
      expect(args).toContain('1');
    });

    it('timePoint 应作为 seek 时间', () => {
      const args = buildExtractCommand({ ...baseConfig, strategy: 'PRECISE_SINGLE', timePoint: 30.5 });
      const ssIdx = args.indexOf('-ss');
      expect(ssIdx).not.toBe(-1);
      expect(args[ssIdx + 1]).toBe('30.5');
    });

    it('无 timePoint 时应使用 inPoint', () => {
      const args = buildExtractCommand({ ...baseConfig, strategy: 'PRECISE_SINGLE', inPoint: 15 });
      const ssIdx = args.indexOf('-ss');
      expect(args[ssIdx + 1]).toBe('15');
    });

    it('无线程参数（PRECISE_SINGLE 单帧无需多线程）', () => {
      const args = buildExtractCommand({ ...baseConfig, strategy: 'PRECISE_SINGLE', timePoint: 10 });
      expect(args).not.toContain('-threads');
    });

    it('不应包含 vsync=vfr', () => {
      const args = buildExtractCommand({ ...baseConfig, strategy: 'PRECISE_SINGLE', timePoint: 10 });
      expect(args).not.toContain('-vsync');
    });
  });

  // ==================== 参数验证 ====================

  describe('参数验证', () => {
    it('fps <= 0 应抛出异常（UNIFORM_FPS）', () => {
      expect(() =>
        buildExtractCommand({ ...baseConfig, strategy: 'UNIFORM_FPS', fps: 0 }),
      ).toThrow();
    });

    it('fps > 120 应抛出异常（UNIFORM_FPS）', () => {
      expect(() =>
        buildExtractCommand({ ...baseConfig, strategy: 'UNIFORM_FPS', fps: 121 }),
      ).toThrow();
    });

    it('sceneThreshold <= 0 应抛出异常', () => {
      expect(() =>
        buildExtractCommand({ ...baseConfig, sceneThreshold: 0 }),
      ).toThrow();
    });

    it('sceneThreshold > 1 应抛出异常', () => {
      expect(() =>
        buildExtractCommand({ ...baseConfig, sceneThreshold: 1.5 }),
      ).toThrow();
    });

    it('minFrameInterval <= 0 应抛出异常', () => {
      expect(() =>
        buildExtractCommand({ ...baseConfig, minFrameInterval: 0 }),
      ).toThrow();
    });

    it('width = 0 时不添加缩放滤镜（ScaleFilter 仅 width > 0 生效）', () => {
      const args = buildExtractCommand({ ...baseConfig, width: 0 });
      const vfArg = args.find(a => a === '-vf') ? args[args.indexOf('-vf') + 1] : '';
      expect(vfArg).not.toContain('scale=');
    });

    it('width = -1 时不添加缩放滤镜（负值跳过）', () => {
      const args = buildExtractCommand({ ...baseConfig, width: -1 });
      const vfArg = args.find(a => a === '-vf') ? args[args.indexOf('-vf') + 1] : '';
      expect(vfArg).not.toContain('scale=');
    });
  });

  // ==================== 画质映射 ====================

  describe('JPEG 画质映射', () => {
    it('quality=1（最高）应映射为 q:v=6', () => {
      const args = buildExtractCommand({ ...baseConfig, quality: 1 });
      const qvIdx = args.indexOf('-q:v');
      expect(qvIdx).not.toBe(-1);
      expect(args[qvIdx + 1]).toBe('6');
    });

    it('quality=3（默认）应映射为 q:v=4', () => {
      const args = buildExtractCommand({ ...baseConfig, quality: 3 });
      const qvIdx = args.indexOf('-q:v');
      expect(args[qvIdx + 1]).toBe('4');
    });

    it('quality=5（最低）应映射为 q:v=2', () => {
      const args = buildExtractCommand({ ...baseConfig, quality: 5 });
      const qvIdx = args.indexOf('-q:v');
      expect(args[qvIdx + 1]).toBe('2');
    });

    it('非法 quality 值应降级为 4', () => {
      const args = buildExtractCommand({ ...baseConfig, quality: 99 } as any);
      const qvIdx = args.indexOf('-q:v');
      expect(args[qvIdx + 1]).toBe('4');
    });
  });
});
