// Module: pipeline/step3-script - Types 单元测试

import { describe, it, expect } from 'vitest';
import type {
  Step3Input,
  Step3Output,
  StepScriptGenerationProps,
} from '../types';
import type {
  ScriptParagraph,
  PipelineParams,
  VlmFrame,
} from '../../../shared/types/entities/editor';

describe('Step3 Types', () => {
  // ==================== Step3Input ====================

  describe('Step3Input', () => {
    it('合法输入应包含所有必填字段', () => {
      const input: Step3Input = {
        vlmFrames: [
          { url: '/frame1.png', description: '城市夜景', editing: false, confirmed: true },
          { url: '/frame2.png', description: '人物特写', editing: false, confirmed: true },
        ],
        scriptStyle: '正经科普',
        speechRate: 4.5,
        pipelineParams: { R: 50, S: 50, T: 50, P: 50 },
      };

      expect(input.vlmFrames).toHaveLength(2);
      expect(input.scriptStyle).toBe('正经科普');
      expect(input.speechRate).toBe(4.5);
      expect(input.pipelineParams.R).toBe(50);
    });

    it('空 vlmFrames 数组应为合法输入', () => {
      const input: Step3Input = {
        vlmFrames: [],
        scriptStyle: '情感叙事',
        speechRate: 3.5,
        pipelineParams: { R: 30, S: 70, T: 80, P: 40 },
      };

      expect(input.vlmFrames).toHaveLength(0);
    });

    it('speechRate 应接受边界值 0', () => {
      const input: Step3Input = {
        vlmFrames: [{ url: '/f.png', description: 'test', editing: false, confirmed: false }],
        scriptStyle: '悬疑推理',
        speechRate: 0,
        pipelineParams: { R: 0, S: 0, T: 0, P: 0 },
      };

      expect(input.speechRate).toBe(0);
    });

    it('pipelineParams 应接受极端值 0 和 100', () => {
      const minInput: Step3Input = {
        vlmFrames: [],
        scriptStyle: '轻松幽默',
        speechRate: 4.5,
        pipelineParams: { R: 0, S: 0, T: 0, P: 0 },
      };
      expect(minInput.pipelineParams.R).toBe(0);

      const maxInput: Step3Input = {
        vlmFrames: [],
        scriptStyle: '赛博现实主义',
        speechRate: 4.5,
        pipelineParams: { R: 100, S: 100, T: 100, P: 100 },
      };
      expect(maxInput.pipelineParams.P).toBe(100);
    });
  });

  // ==================== Step3Output ====================

  describe('Step3Output', () => {
    it('应包含 scriptParagraphs 数组', () => {
      const output: Step3Output = {
        scriptParagraphs: [
          { id: 's_01', shotId: 's_01', text: '这是第一段解说', duration: 3.5, editing: false },
          { id: 's_02', shotId: 's_02', text: '这是第二段解说', duration: 4.0, editing: false },
        ],
      };

      expect(output.scriptParagraphs).toHaveLength(2);
      expect(output.scriptParagraphs[0].text).toBe('这是第一段解说');
    });

    it('空输出在未生成时合法', () => {
      const output: Step3Output = {
        scriptParagraphs: [],
      };

      expect(output.scriptParagraphs).toHaveLength(0);
    });

    it('单段输出应有合法字段', () => {
      const output: Step3Output = {
        scriptParagraphs: [
          {
            id: 's_01',
            shotId: 's_01',
            text: '欢迎收看本期节目',
            duration: 2.5,
            emotion: '热情',
            editing: false,
            cleanText: '欢迎收看本期节目',
            audioSafeText: '欢迎收看本期节目',
          },
        ],
      };

      expect(output.scriptParagraphs[0].emotion).toBe('热情');
      expect(output.scriptParagraphs[0].cleanText).toBeTruthy();
    });
  });

  // ==================== ScriptParagraph ====================

  describe('ScriptParagraph', () => {
    it('必填字段 id / text / editing 必须存在', () => {
      const p: ScriptParagraph = {
        id: 'para_001',
        text: '测试文案',
        editing: false,
      };

      expect(p.id).toBe('para_001');
      expect(p.text).toBeTruthy();
      expect(p.editing).toBe(false);
    });

    it('可选字段 shotId / duration / emotion 可为 undefined', () => {
      const p: ScriptParagraph = {
        id: 'p1',
        text: 'hello',
        editing: true,
      };

      expect(p.shotId).toBeUndefined();
      expect(p.duration).toBeUndefined();
      expect(p.emotion).toBeUndefined();
    });

    it('audioSafeText / cleanText 可选字段存在时应正常访问', () => {
      const p: ScriptParagraph = {
        id: 'p2',
        text: '原始文案',
        editing: false,
        cleanText: '清洗后文案',
        audioSafeText: 'TTS 安全文案',
      };

      expect(p.cleanText).toBe('清洗后文案');
      expect(p.audioSafeText).toBe('TTS 安全文案');
    });
  });

  // ==================== PipelineParams ====================

  describe('PipelineParams', () => {
    it('四个字段应均为 number 类型', () => {
      const params: PipelineParams = { R: 60, S: 40, T: 75, P: 55 };

      expect(typeof params.R).toBe('number');
      expect(typeof params.S).toBe('number');
      expect(typeof params.T).toBe('number');
      expect(typeof params.P).toBe('number');
    });

    it('边界值应允许整数和浮点数', () => {
      const params: PipelineParams = { R: 33.3, S: 0, T: 100, P: 87.5 };

      expect(params.R).toBe(33.3);
      expect(params.S).toBe(0);
      expect(params.T).toBe(100);
      expect(params.P).toBe(87.5);
    });
  });

  // ==================== VlmFrame ====================

  describe('VlmFrame', () => {
    it('应包含 url / description / editing / confirmed 字段', () => {
      const frame: VlmFrame = {
        url: 'file:///frames/001.jpg',
        description: '夕阳下的海滩',
        editing: false,
        confirmed: true,
      };

      expect(frame.url).toBeTruthy();
      expect(frame.description).toBe('夕阳下的海滩');
      expect(frame.editing).toBe(false);
      expect(frame.confirmed).toBe(true);
    });

    it('description 可为空字符串', () => {
      const frame: VlmFrame = {
        url: '/test.png',
        description: '',
        editing: false,
        confirmed: false,
      };

      expect(frame.description).toBe('');
    });
  });

  // ==================== StepScriptGenerationProps ====================

  describe('StepScriptGenerationProps (View Props)', () => {
    it('应包含所有 View 需要的回调函数', () => {
      const props: StepScriptGenerationProps = {
        scriptParagraphs: [],
        scriptStyle: '正经科普',
        speechRate: 4.5,
        pipelineParams: { R: 50, S: 50, T: 50, P: 50 },
        vlmFrames: [],
        isGenerating: false,
        onSetScriptStyle: () => {},
        onSetSpeechRate: () => {},
        onSetPipelineParams: () => {},
        onUpdateParagraph: () => {},
        onUpdateParagraphEmotion: () => {},
        onSetScriptParagraphs: () => {},
        onRegenerate: () => {},
        onMatchVision: () => {},
      };

      expect(props.scriptStyle).toBe('正经科普');
      expect(props.isGenerating).toBe(false);
      expect(typeof props.onRegenerate).toBe('function');
      expect(typeof props.onMatchVision).toBe('function');
      expect(typeof props.onSetScriptStyle).toBe('function');
      expect(typeof props.onSetSpeechRate).toBe('function');
      expect(typeof props.onUpdateParagraph).toBe('function');
      expect(typeof props.onUpdateParagraphEmotion).toBe('function');
    });

    it('isGenerating 为 true 时应正常传递', () => {
      const props: StepScriptGenerationProps = {
        scriptParagraphs: [{ id: 's1', text: '文案', editing: false }],
        scriptStyle: '情感叙事',
        speechRate: 3.0,
        pipelineParams: { R: 30, S: 70, T: 80, P: 20 },
        vlmFrames: [{ url: '/a.jpg', description: 'test', editing: false, confirmed: true }],
        isGenerating: true,
        onSetScriptStyle: () => {},
        onSetSpeechRate: () => {},
        onSetPipelineParams: () => {},
        onUpdateParagraph: () => {},
        onUpdateParagraphEmotion: () => {},
        onSetScriptParagraphs: () => {},
        onRegenerate: () => {},
        onMatchVision: () => {},
      };

      expect(props.isGenerating).toBe(true);
    });
  });
});
