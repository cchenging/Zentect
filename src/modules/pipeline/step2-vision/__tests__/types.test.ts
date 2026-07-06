// Module: pipeline/step2-vision - Types 单元测试

import { describe, it, expect } from 'vitest';
import type {
  Step2Input,
  Step2Output,
  StepVisionDescriptionProps,
} from '../types';
import type { VlmFrame } from '../../../../shared/types/entities/editor';

describe('Step2 Vision Types', () => {
  describe('Step2Input', () => {
    it('合法输入应包含 framePaths 和 asrText', () => {
      const input: Step2Input = {
        framePaths: ['/frames/1.jpg', '/frames/2.jpg'],
        asrText: '你好，欢迎使用 Zentect。',
      };
      expect(input.framePaths).toHaveLength(2);
      expect(input.asrText).toBeTruthy();
    });

    it('framePaths 可为空数组', () => {
      const input: Step2Input = {
        framePaths: [],
        asrText: '',
      };
      expect(input.framePaths).toHaveLength(0);
      expect(input.asrText).toBe('');
    });

    it('asrText 可包含多行文本', () => {
      const input: Step2Input = {
        framePaths: ['/frames/1.jpg'],
        asrText: '第一行\n第二行\n第三行',
      };
      expect(input.asrText).toContain('\n');
      expect(input.asrText.split('\n')).toHaveLength(3);
    });
  });

  describe('Step2Output', () => {
    it('应包含 vlmFrames 和 storyLine', () => {
      const output: Step2Output = {
        vlmFrames: [
          { url: '/frames/1.jpg', description: '画面：远景山景', editing: false, confirmed: false },
        ],
        storyLine: '故事开始于一个宁静的清晨。',
      };
      expect(output.vlmFrames).toHaveLength(1);
      expect(output.storyLine).toBeTruthy();
    });

    it('空结果应为合法输出', () => {
      const output: Step2Output = {
        vlmFrames: [],
        storyLine: '',
      };
      expect(output.vlmFrames).toHaveLength(0);
      expect(output.storyLine).toBe('');
    });

    it('vlmFrames 中每帧应包含四个必填字段', () => {
      const frame: VlmFrame = {
        url: '/frames/f1.jpg',
        description: '特写：人物表情',
        editing: true,
        confirmed: true,
      };
      expect(frame.url).toBeTruthy();
      expect(typeof frame.description).toBe('string');
      expect(typeof frame.editing).toBe('boolean');
      expect(typeof frame.confirmed).toBe('boolean');
    });

    it('多帧输出应保持顺序', () => {
      const output: Step2Output = {
        vlmFrames: [
          { url: '/f1.jpg', description: '帧1', editing: false, confirmed: true },
          { url: '/f2.jpg', description: '帧2', editing: false, confirmed: false },
          { url: '/f3.jpg', description: '帧3', editing: true, confirmed: false },
        ],
        storyLine: '帧1\n帧2\n帧3',
      };
      expect(output.vlmFrames[0].description).toBe('帧1');
      expect(output.vlmFrames[2].description).toBe('帧3');
    });
  });

  describe('VlmFrame', () => {
    it('所有字段应有正确的类型', () => {
      const frame: VlmFrame = {
        url: '/path/to/frame.jpg',
        description: '画面描述内容',
        editing: false,
        confirmed: false,
      };
      expect(typeof frame.url).toBe('string');
      expect(typeof frame.description).toBe('string');
      expect(typeof frame.editing).toBe('boolean');
      expect(typeof frame.confirmed).toBe('boolean');
    });

    it('editing 为 true 表示帧处于编辑状态', () => {
      const editing: VlmFrame = {
        url: '/f.jpg', description: '描述', editing: true, confirmed: false,
      };
      expect(editing.editing).toBe(true);
    });

    it('confirmed 为 true 表示帧已确认', () => {
      const confirmed: VlmFrame = {
        url: '/f.jpg', description: '描述', editing: false, confirmed: true,
      };
      expect(confirmed.confirmed).toBe(true);
    });

    it('description 可为空字符串', () => {
      const frame: VlmFrame = {
        url: '/f.jpg', description: '', editing: false, confirmed: false,
      };
      expect(frame.description).toBe('');
    });
  });

  describe('StepVisionDescriptionProps', () => {
    it('应包含 vlmFrames 和三个回调', () => {
      const props: StepVisionDescriptionProps = {
        vlmFrames: [],
        onUpdateDescription: () => {},
        onSetEditing: () => {},
        onGoToStep1: () => {},
      };
      expect(Array.isArray(props.vlmFrames)).toBe(true);
      expect(typeof props.onUpdateDescription).toBe('function');
      expect(typeof props.onSetEditing).toBe('function');
      expect(typeof props.onGoToStep1).toBe('function');
    });

    it('onGoToStep1 为可选字段', () => {
      const props: StepVisionDescriptionProps = {
        vlmFrames: [],
        onUpdateDescription: () => {},
        onSetEditing: () => {},
      };
      expect(props.onGoToStep1).toBeUndefined();
    });

    it('vlmFrames 应可携带已确认和未确认的帧混合', () => {
      const props: StepVisionDescriptionProps = {
        vlmFrames: [
          { url: '/f1.jpg', description: '已确认', editing: false, confirmed: true },
          { url: '/f2.jpg', description: '未确认', editing: false, confirmed: false },
          { url: '/f3.jpg', description: '', editing: true, confirmed: false },
        ],
        onUpdateDescription: () => {},
        onSetEditing: () => {},
      };
      const confirmedCount = props.vlmFrames.filter((f) => f.confirmed).length;
      expect(confirmedCount).toBe(1);
      expect(props.vlmFrames[2].editing).toBe(true);
    });
  });
});
