// Module: settings/binding - Types 单元测试

import { describe, it, expect } from 'vitest';
import type { ProfileBinding, BindingInput } from '../types';

describe('Settings Binding Types', () => {
  describe('ProfileBinding', () => {
    it('应包含所有必填字段', () => {
      const binding: ProfileBinding = {
        taskType: 'visual',
        profileId: 'profile-001',
        modelName: 'gpt-4o',
        isActive: true,
      };

      expect(binding.taskType).toBe('visual');
      expect(binding.profileId).toBe('profile-001');
      expect(binding.modelName).toBe('gpt-4o');
      expect(binding.isActive).toBe(true);
    });

    it('profileId 可为 null（自动匹配）', () => {
      const binding: ProfileBinding = {
        taskType: 'script',
        profileId: null,
        modelName: 'claude-3.5',
        isActive: true,
      };

      expect(binding.profileId).toBeNull();
      expect(binding.taskType).toBe('script');
    });

    it('taskType 支持所有管线节点类型', () => {
      const taskTypes = ['visual', 'script', 'translate', 'helper', 'tts', 'audio', 'asr', 'sentiment'];

      for (const taskType of taskTypes) {
        const binding: ProfileBinding = {
          taskType,
          profileId: 'p1',
          modelName: 'test-model',
          isActive: false,
        };
        expect(binding.taskType).toBe(taskType);
      }
    });

    it('isActive 为 false 表示绑定未生效', () => {
      const binding: ProfileBinding = {
        taskType: 'tts',
        profileId: null,
        modelName: '',
        isActive: false,
      };

      expect(binding.isActive).toBe(false);
    });
  });

  describe('BindingInput', () => {
    it('应包含 bindings 和 apiProfiles', () => {
      const input: BindingInput = {
        bindings: [
          { taskType: 'visual', profileId: 'p1', modelName: 'gpt-4o', isActive: true },
        ],
        apiProfiles: [
          { id: 'p1', name: 'DeepSeek', models: ['deepseek-chat'] },
        ],
      };

      expect(input.bindings).toHaveLength(1);
      expect(input.apiProfiles).toHaveLength(1);
      expect(input.apiProfiles[0].id).toBe('p1');
      expect(input.apiProfiles[0].name).toBe('DeepSeek');
    });

    it('bindings 和 apiProfiles 可为空数组', () => {
      const input: BindingInput = {
        bindings: [],
        apiProfiles: [],
      };

      expect(input.bindings).toEqual([]);
      expect(input.apiProfiles).toEqual([]);
    });
  });
});
