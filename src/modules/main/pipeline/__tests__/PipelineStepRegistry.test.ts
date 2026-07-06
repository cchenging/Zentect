import { describe, it, expect, beforeEach } from 'vitest';
import { PipelineStepRegistry } from '../PipelineStepRegistry';
import type { StepRegistryEntry } from '../PipelineStepRegistry';

describe('PipelineStepRegistry', () => {
  let registry: PipelineStepRegistry;

  beforeEach(() => {
    PipelineStepRegistry['instance'] = undefined as any;
    registry = PipelineStepRegistry.getInstance();
  });

  describe('单例模式', () => {
    it('多次调用 getInstance 返回同一个实例', () => {
      const r2 = PipelineStepRegistry.getInstance();
      expect(r2).toBe(registry);
    });
  });

  describe('内置步骤注册', () => {
    it('初始化后包含 7 个内置步骤', () => {
      expect(registry.count).toBe(7);
    });

    it('所有内置步骤默认启用', () => {
      const enabled = registry.getEnabled();
      expect(enabled).toHaveLength(7);
    });

    it('包含预期的步骤 ID', () => {
      const ids = registry.getAll().map(s => s.stepId);
      expect(ids).toContain('extract_frames');
      expect(ids).toContain('separate_audio');
      expect(ids).toContain('asr');
      expect(ids).toContain('face_detect');
      expect(ids).toContain('scene_detect');
      expect(ids).toContain('script_gen');
      expect(ids).toContain('tts_export');
    });

    it('script_gen 标记为 fatal', () => {
      const step = registry.get('script_gen');
      expect(step).toBeDefined();
      expect(step!.fatal).toBe(true);
    });

    it('tts_export defaultMaxRetries 为 0', () => {
      const step = registry.get('tts_export');
      expect(step).toBeDefined();
      expect(step!.defaultMaxRetries).toBe(0);
    });

    it('asr defaultMaxRetries 为 3', () => {
      const step = registry.get('asr');
      expect(step).toBeDefined();
      expect(step!.defaultMaxRetries).toBe(3);
    });
  });

  describe('has()', () => {
    it('对内置步骤返回 true', () => {
      expect(registry.has('extract_frames')).toBe(true);
    });

    it('对未注册步骤返回 false', () => {
      expect(registry.has('nonexistent_step')).toBe(false);
    });
  });

  describe('get()', () => {
    it('返回完整的 StepRegistryEntry 对象', () => {
      const entry = registry.get('separate_audio');
      expect(entry).toBeDefined();
      expect(entry!.stepId).toBe('separate_audio');
      expect(entry!.label).toBe('音频分离');
      expect(entry!.description).toBeTruthy();
    });

    it('对未注册步骤返回 undefined', () => {
      expect(registry.get('unknown')).toBeUndefined();
    });
  });

  describe('getOrdered()', () => {
    it('返回按注册顺序排列的步骤', () => {
      const ordered = registry.getOrdered();
      expect(ordered[0].stepId).toBe('extract_frames');
      expect(ordered[ordered.length - 1].stepId).toBe('tts_export');
    });
  });

  describe('register()', () => {
    it('成功注册新的自定义步骤', () => {
      const customStep: StepRegistryEntry = {
        stepId: 'custom_inference',
        label: '自定义推理',
        description: '执行自定义模型推理',
        defaultMaxRetries: 2,
        fatal: false,
        enabled: true,
      };
      registry.register(customStep);
      expect(registry.count).toBe(8);
      expect(registry.has('custom_inference')).toBe(true);
    });

    it('重复注册相同 stepId 抛出异常', () => {
      expect(() => {
        registry.register({
          stepId: 'extract_frames',
          label: '重复',
          description: 'dup',
          defaultMaxRetries: 1,
          fatal: false,
          enabled: true,
        });
      }).toThrow('已存在');
    });
  });

  describe('setExecutor()', () => {
    it('为已注册步骤设置执行器', () => {
      const executor = async () => ({ result: 'done' });
      registry.setExecutor('face_detect', executor);
      const entry = registry.get('face_detect');
      expect(entry!.executor).toBe(executor);
    });

    it('对未注册步骤设置执行器抛出异常', () => {
      expect(() => {
        registry.setExecutor('nonexistent', async () => ({}));
      }).toThrow('未注册');
    });
  });

  describe('remove()', () => {
    it('删除已注册步骤', () => {
      registry.remove('scene_detect');
      expect(registry.has('scene_detect')).toBe(false);
      expect(registry.count).toBe(6);
    });

    it('删除不存在的步骤返回 false', () => {
      expect(registry.remove('ghost')).toBe(false);
    });
  });

  describe('clear()', () => {
    it('清空所有步骤', () => {
      registry.clear();
      expect(registry.count).toBe(0);
      expect(registry.getAll()).toHaveLength(0);
    });
  });
});
