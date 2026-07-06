// Module: settings/binding - Service 单元测试

import { describe, it, expect } from 'vitest';
import { PIPELINE_NODES } from '../backend/BindingService';

describe('BindingService', () => {
  describe('PIPELINE_NODES', () => {
    it('应包含 6 个管线节点', () => {
      expect(PIPELINE_NODES).toHaveLength(6);
    });

    it('每个节点应有 taskType 和 label', () => {
      for (const node of PIPELINE_NODES) {
        expect(node.taskType).toBeDefined();
        expect(node.taskType.length).toBeGreaterThan(0);
        expect(node.label).toBeDefined();
        expect(node.label.length).toBeGreaterThan(0);
      }
    });

    it('audio 和 asr 节点应有 localOptions', () => {
      const audio = PIPELINE_NODES.find((n) => n.taskType === 'audio');
      const asr = PIPELINE_NODES.find((n) => n.taskType === 'asr');

      expect(audio).toBeDefined();
      expect(asr).toBeDefined();
      expect(audio!.localOptions).toBeDefined();
      expect(asr!.localOptions).toBeDefined();
      expect(audio!.localOptions!.length).toBeGreaterThan(0);
      expect(asr!.localOptions!.length).toBeGreaterThan(0);
    });

    it('visual、sentiment、script 节点应有 useModelPool=true', () => {
      const modelPoolNodes = PIPELINE_NODES.filter(
        (n) => n.taskType === 'visual' || n.taskType === 'sentiment' || n.taskType === 'script',
      );

      expect(modelPoolNodes).toHaveLength(3);
      for (const node of modelPoolNodes) {
        expect(node.useModelPool).toBe(true);
      }
    });

    it('全部 taskType 应唯一', () => {
      const types = PIPELINE_NODES.map((n) => n.taskType);
      const unique = new Set(types);
      expect(unique.size).toBe(types.length);
    });

    it('应包含所有预期的管线节点', () => {
      const expectedTypes = ['audio', 'asr', 'visual', 'sentiment', 'script', 'tts'];
      const actualTypes = PIPELINE_NODES.map((n) => n.taskType).sort();
      expect(actualTypes.sort()).toEqual(expectedTypes.sort());
    });
  });
});
