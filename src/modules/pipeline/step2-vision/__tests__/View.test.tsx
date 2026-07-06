// Module: pipeline/step2-vision - View 单元测试

/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

afterEach(cleanup);
import React from 'react';
import { StepVisionDescriptionView } from '../frontend/View';
import type { VlmFrame } from '../../../../shared/types/entities/editor';

// ========== 固定测试数据 ==========

function makeFrame(
  overrides: Partial<VlmFrame> = {},
): VlmFrame {
  return {
    url: '/frames/test.jpg',
    description: '默认描述',
    editing: false,
    confirmed: false,
    ...overrides,
  };
}

function makeProps(overrides: Partial<{
  vlmFrames: VlmFrame[];
  onUpdateDescription: (index: number, description: string) => void;
  onSetEditing: (index: number, editing: boolean) => void;
  onGoToStep1: () => void;
}> = {}) {
  return {
    vlmFrames: [] as VlmFrame[],
    onUpdateDescription: vi.fn(),
    onSetEditing: vi.fn(),
    ...overrides,
  };
}

// ========== 渲染测试 ==========

describe('StepVisionDescriptionView', () => {
  describe('空状态', () => {
    it('vlmFrames 为空时应显示 VLM 画面描述标题', () => {
      const props = makeProps({ vlmFrames: [] });
      render(<StepVisionDescriptionView {...props} />);
      expect(screen.getByText('VLM 画面描述')).toBeTruthy();
    });

    it('空状态时 EmptyState 应提示生成相关内容', () => {
      const props = makeProps({ vlmFrames: [] });
      render(<StepVisionDescriptionView {...props} />);
      expect(screen.getByText('VLM 画面描述待生成')).toBeTruthy();
      expect(
        screen.getByText('执行素材分析后，VLM 画面描述将在此展示，支持逐帧编辑和修正'),
      ).toBeTruthy();
    });

    it('onGoToStep1 未传时不显示"前往素材分析"按钮', () => {
      const props = makeProps({ vlmFrames: [], onGoToStep1: undefined });
      render(<StepVisionDescriptionView {...props} />);
      expect(screen.queryByText('前往素材分析')).toBeNull();
    });

    it('onGoToStep1 传入时应显示"前往素材分析"按钮', () => {
      const onGoToStep1 = vi.fn();
      const props = makeProps({ vlmFrames: [], onGoToStep1 });
      render(<StepVisionDescriptionView {...props} />);
      const btn = screen.getByText('前往素材分析');
      expect(btn).toBeTruthy();
      fireEvent.click(btn);
      expect(onGoToStep1).toHaveBeenCalledTimes(1);
    });
  });

  describe('帧列表渲染', () => {
    it('应渲染所有帧的描述', () => {
      const frames = [
        makeFrame({ url: '/a.jpg', description: '帧A' }),
        makeFrame({ url: '/b.jpg', description: '帧B' }),
        makeFrame({ url: '/c.jpg', description: '帧C' }),
      ];
      const props = makeProps({ vlmFrames: frames });
      render(<StepVisionDescriptionView {...props} />);

      expect(screen.getByText('帧A')).toBeTruthy();
      expect(screen.getByText('帧B')).toBeTruthy();
      expect(screen.getByText('帧C')).toBeTruthy();
    });

    it('帧无描述时应显示"点击添加描述"', () => {
      const frames = [makeFrame({ description: '' })];
      const props = makeProps({ vlmFrames: frames });
      render(<StepVisionDescriptionView {...props} />);
      expect(screen.getByText('点击添加描述')).toBeTruthy();
    });

    it('StatHeader 应显示分析帧数和已确认帧数', () => {
      const frames = [
        makeFrame({ confirmed: true }),
        makeFrame({ confirmed: false }),
        makeFrame({ confirmed: true }),
      ];
      const props = makeProps({ vlmFrames: frames });
      render(<StepVisionDescriptionView {...props} />);

      expect(screen.getByText(/帧已分析/)).toBeTruthy();
      const confirmedText = screen.getByText((content) =>
        content.includes('已确认') && content.includes('2') && content.includes('帧'),
      );
      expect(confirmedText).toBeTruthy();
    });

    it('帧数标签"帧 N"应正确显示数量', () => {
      const frames = [
        makeFrame({ description: '第一帧' }),
        makeFrame({ description: '第二帧' }),
      ];
      const props = makeProps({ vlmFrames: frames });
      render(<StepVisionDescriptionView {...props} />);

      // "帧 1" 和 "帧 2" 在界面中会出现多次（缩略图内和标签）
      const allFrame1 = screen.getAllByText('帧 1');
      const allFrame2 = screen.getAllByText('帧 2');
      expect(allFrame1.length).toBeGreaterThanOrEqual(1);
      expect(allFrame2.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('故事脉络', () => {
    it('所有帧描述非空时应显示故事脉络区块', () => {
      const frames = [
        makeFrame({ description: '清晨，太阳升起。' }),
        makeFrame({ description: '人物走进画面。' }),
      ];
      const props = makeProps({ vlmFrames: frames });
      render(<StepVisionDescriptionView {...props} />);

      expect(screen.getByText('故事脉络')).toBeTruthy();
      const textContent = document.body.textContent || '';
      expect(textContent).toContain('清晨，太阳升起。');
      expect(textContent).toContain('人物走进画面。');
    });

    it('部分帧描述为空时仅拼接非空描述', () => {
      const frames = [
        makeFrame({ description: '开头' }),
        makeFrame({ description: '' }),
        makeFrame({ description: '结尾' }),
      ];
      const props = makeProps({ vlmFrames: frames });
      render(<StepVisionDescriptionView {...props} />);

      expect(screen.getByText('故事脉络')).toBeTruthy();
      const textContent = document.body.textContent || '';
      expect(textContent).toContain('开头');
      expect(textContent).toContain('结尾');
    });

    it('所有帧描述均为空时不显示故事脉络', () => {
      const frames = [
        makeFrame({ description: '' }),
        makeFrame({ description: '' }),
      ];
      const props = makeProps({ vlmFrames: frames });
      render(<StepVisionDescriptionView {...props} />);
      expect(screen.queryByText('故事脉络')).toBeNull();
    });
  });

  describe('编辑交互', () => {
    it('点击描述文本应触发 onSetEditing(idx, true)', () => {
      const onSetEditing = vi.fn();
      const frames = [makeFrame({ description: '可编辑描述', confirmed: false })];
      const props = makeProps({ vlmFrames: frames, onSetEditing });
      render(<StepVisionDescriptionView {...props} />);

      fireEvent.click(screen.getAllByText('可编辑描述')[0]);
      expect(onSetEditing).toHaveBeenCalledWith(0, true);
    });

    it('点击"点击添加描述"应触发 onSetEditing(idx, true)', () => {
      const onSetEditing = vi.fn();
      const frames = [makeFrame({ description: '', confirmed: false })];
      const props = makeProps({ vlmFrames: frames, onSetEditing });
      render(<StepVisionDescriptionView {...props} />);

      fireEvent.click(screen.getByText('点击添加描述'));
      expect(onSetEditing).toHaveBeenCalledWith(0, true);
    });

    it('editing=true 时应显示 textarea 而非纯文本', () => {
      const frames = [makeFrame({ description: '编辑中文本', editing: true })];
      const props = makeProps({ vlmFrames: frames });
      render(<StepVisionDescriptionView {...props} />);

      const textarea = screen.getByDisplayValue('编辑中文本') as HTMLTextAreaElement;
      expect(textarea.tagName).toBe('TEXTAREA');
    });

    it('textarea 输入变更应触发 onUpdateDescription', () => {
      const onUpdateDescription = vi.fn();
      const frames = [makeFrame({ description: '旧描述文本', editing: true })];
      const props = makeProps({ vlmFrames: frames, onUpdateDescription });
      render(<StepVisionDescriptionView {...props} />);

      const textarea = screen.getByDisplayValue('旧描述文本') as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: '新描述文本' } });
      expect(onUpdateDescription).toHaveBeenCalledWith(0, '新描述文本');
    });

    it('textarea 失焦应触发 onSetEditing(idx, false)', () => {
      const onSetEditing = vi.fn();
      const frames = [makeFrame({ description: '失焦测试文本', editing: true })];
      const props = makeProps({ vlmFrames: frames, onSetEditing });
      render(<StepVisionDescriptionView {...props} />);

      const textarea = screen.getByDisplayValue('失焦测试文本') as HTMLTextAreaElement;
      fireEvent.blur(textarea);
      expect(onSetEditing).toHaveBeenCalledWith(0, false);
    });
  });

  describe('缩略图渲染', () => {
    it('帧无 url 时应显示占位文字而非图片', () => {
      const frames = [makeFrame({ url: '', description: '无图片帧' })];
      const props = makeProps({ vlmFrames: frames });
      const { container } = render(<StepVisionDescriptionView {...props} />);

      const thumbImgs = container.querySelectorAll('.w-\\[100px\\].h-\\[68px\\] img');
      expect(thumbImgs.length).toBe(0);
      expect(screen.getAllByText('无图片帧').length).toBeGreaterThanOrEqual(1);
    });

    it('帧有 url 时应渲染 img 标签', () => {
      const frames = [makeFrame({ url: '/frames/test.jpg' })];
      const props = makeProps({ vlmFrames: frames });
      const { container } = render(<StepVisionDescriptionView {...props} />);

      const thumbImgs = container.querySelectorAll('.w-\\[100px\\].h-\\[68px\\] img');
      expect(thumbImgs.length).toBeGreaterThanOrEqual(1);
    });
  });
});
