// Module: pipeline/step4-tts - Types 单元测试

import { describe, it, expect } from 'vitest';
import type { TTSEngine, Step4Input, Step4Output, TTSResult, VoiceOption, Step4State, TtsVoiceOption } from '../types';

describe('Step4 Types', () => {
  describe('TTSEngine', () => {
    it('所有引擎类型应被类型系统接受', () => {
      const engines: TTSEngine[] = ['moss', 'edge', 'doubao', 'fish', 'sovits'];
      expect(engines).toHaveLength(5);
      expect(new Set(engines).size).toBe(5);
    });
  });

  describe('Step4Input', () => {
    it('合法输入应包含所有必填字段', () => {
      const input: Step4Input = {
        scriptParagraphs: [{ id: 's1', text: '你好', editing: false }],
        engine: 'edge',
        voiceId: 'zh-CN-XiaoxiaoNeural',
        speechRate: 1.0,
      };
      expect(input.engine).toBe('edge');
      expect(input.scriptParagraphs).toHaveLength(1);
      expect(input.voiceId).toBeTruthy();
      expect(input.speechRate).toBe(1.0);
    });

    it('空剧本文本段落数组应为合法输入', () => {
      const input: Step4Input = {
        scriptParagraphs: [],
        engine: 'moss',
        voiceId: 'Junhao',
        speechRate: 1.0,
      };
      expect(input.scriptParagraphs).toHaveLength(0);
    });

    it('speechRate 应接受边界值 0', () => {
      const input: Step4Input = {
        scriptParagraphs: [],
        engine: 'edge',
        voiceId: '',
        speechRate: 0,
      };
      expect(input.speechRate).toBe(0);
    });
  });

  describe('Step4Output', () => {
    it('应包含 results 数组和统计字段', () => {
      const output: Step4Output = {
        results: [{ shotId: 'shot1', audioUrl: '/audio/1.mp3' }],
        successCount: 1,
        failedCount: 0,
      };
      expect(output.results).toHaveLength(1);
      expect(output.successCount).toBe(1);
      expect(output.failedCount).toBe(0);
    });

    it('failedCount 应与 results 中 _failed 标记一致', () => {
      const results: TTSResult[] = [
        { shotId: 'a', audioUrl: '/a.mp3' },
        { shotId: 'b', _failed: true, _error: '合成失败' },
        { shotId: 'c', _failed: true, _error: '网络超时' },
      ];
      const failedCount = results.filter((r) => r._failed).length;
      expect(failedCount).toBe(2);
    });
  });

  describe('TTSResult', () => {
    it('成功结果应含 shotId 和 audioUrl', () => {
      const res: TTSResult = { shotId: 'shot_1', audioUrl: 'file:///output/1.wav' };
      expect(res.shotId).toBe('shot_1');
      expect(res.audioUrl).toBeTruthy();
      expect(res._failed).toBeUndefined();
    });

    it('失败结果应有 _failed 标记和 _error 说明', () => {
      const res: TTSResult = { shotId: 'shot_99', _failed: true, _error: '引擎不可用' };
      expect(res._failed).toBe(true);
      expect(res._error).toBe('引擎不可用');
      expect(res.audioUrl).toBeUndefined();
    });

    it('空音色ID时 audioUrl 可为空', () => {
      const res: TTSResult = { shotId: 's' };
      expect(res.audioUrl).toBeUndefined();
      expect(res._failed).toBeUndefined();
    });
  });

  describe('VoiceOption', () => {
    it('应包含 id / name / lang 三字段', () => {
      const voice: VoiceOption = { id: 'zh-CN-Xiaoxiao', name: '晓晓', lang: 'zh-CN' };
      expect(voice.id).toBeTruthy();
      expect(voice.name).toBeTruthy();
      expect(voice.lang).toBeTruthy();
    });
  });

  describe('Step4State', () => {
    it('初始状态所有值应为合法默认值', () => {
      const state: Step4State = {
        ttsEngine: 'edge',
        ttsVoiceId: '',
        ttsProgress: 0,
        ttsResults: [],
      };
      expect(state.ttsProgress).toBe(0);
      expect(state.ttsResults).toHaveLength(0);
    });

    it('进度应能反映到 100', () => {
      const state: Step4State = {
        ttsEngine: 'doubao',
        ttsVoiceId: 'v1',
        ttsProgress: 100,
        ttsResults: [{ shotId: 's1', audioUrl: '/audio/1.mp3' }],
      };
      expect(state.ttsProgress).toBe(100);
    });
  });

  describe('TtsVoiceOption (UI 层)', () => {
    it('应与 VoiceOption 结构兼容', () => {
      const opt: TtsVoiceOption = { id: 'edge-zh', name: 'Edge 中文女声', lang: 'zh-CN' };
      // 验证字段存在
      expect(opt.id).toBe('edge-zh');
      expect(opt.name).toContain('Edge');
      expect(opt.lang).toBe('zh-CN');
    });
  });
});
