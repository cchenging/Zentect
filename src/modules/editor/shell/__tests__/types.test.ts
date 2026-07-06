// Module: editor/shell - Types 单元测试

import { describe, it, expect } from 'vitest';
import type {
  EditorShellInput,
  EditorShellOutput,
  StepInfo,
  MediaTab,
} from '../types';

describe('Shell Types', () => {
  describe('EditorShellInput', () => {
    it('应包含 projectId、currentStep、isAutoMode 三个必填字段', () => {
      const input: EditorShellInput = {
        projectId: 'proj-001',
        currentStep: 2,
        isAutoMode: false,
      };
      expect(input.projectId).toBe('proj-001');
      expect(input.currentStep).toBe(2);
      expect(input.isAutoMode).toBe(false);
    });

    it('currentStep 为 0 应为合法值', () => {
      const input: EditorShellInput = {
        projectId: 'proj-002',
        currentStep: 0,
        isAutoMode: true,
      };
      expect(input.currentStep).toBe(0);
    });

    it('isAutoMode=true 表示自动模式', () => {
      const input: EditorShellInput = {
        projectId: 'proj-003',
        currentStep: 1,
        isAutoMode: true,
      };
      expect(input.isAutoMode).toBe(true);
    });
  });

  describe('EditorShellOutput', () => {
    it('应包含 currentStep、isAutoMode、leftPanelWidth 三个必填字段', () => {
      const output: EditorShellOutput = {
        currentStep: 3,
        isAutoMode: false,
        leftPanelWidth: 30,
      };
      expect(output.currentStep).toBe(3);
      expect(output.isAutoMode).toBe(false);
      expect(output.leftPanelWidth).toBe(30);
    });

    it('leftPanelWidth 边界值 0 应为合法', () => {
      const output: EditorShellOutput = {
        currentStep: 0,
        isAutoMode: false,
        leftPanelWidth: 0,
      };
      expect(output.leftPanelWidth).toBe(0);
    });

    it('leftPanelWidth 边界值 100 应为合法', () => {
      const output: EditorShellOutput = {
        currentStep: 5,
        isAutoMode: true,
        leftPanelWidth: 100,
      };
      expect(output.leftPanelWidth).toBe(100);
    });

    it('isAutoMode 应正确传递 true', () => {
      const output: EditorShellOutput = {
        currentStep: 1,
        isAutoMode: true,
        leftPanelWidth: 50,
      };
      expect(output.isAutoMode).toBe(true);
    });
  });

  describe('StepInfo', () => {
    it('应包含 key 和 label 字段', () => {
      const step: StepInfo = { key: 1, label: '素材导入' };
      expect(step.key).toBe(1);
      expect(step.label).toBe('素材导入');
    });

    it('key 为 0 应为合法值', () => {
      const step: StepInfo = { key: 0, label: '起始' };
      expect(step.key).toBe(0);
    });

    it('label 空字符串应为合法', () => {
      const step: StepInfo = { key: 99, label: '' };
      expect(step.label).toBe('');
    });
  });

  describe('MediaTab', () => {
    it('应包含 key 和 label 字段', () => {
      const tab: MediaTab = { key: 'video', label: '视频' };
      expect(tab.key).toBe('video');
      expect(tab.label).toBe('视频');
    });

    it('key 和 label 可为不同字符串', () => {
      const tab: MediaTab = { key: 'audio_lib', label: '音频素材库' };
      expect(tab.key).toBe('audio_lib');
      expect(tab.label).toBe('音频素材库');
    });

    it('空字符串 key 和 label 应为合法', () => {
      const tab: MediaTab = { key: '', label: '' };
      expect(tab.key).toBe('');
      expect(tab.label).toBe('');
    });
  });
});
