// Module: editor/storyboard - Types 单元测试

import { describe, it, expect } from 'vitest';
import type {
  StoryboardInput,
  StoryboardOutput,
  ShotCardProps,
} from '../types';
import type { MatchResult } from '../../../../shared/types/entities/editor';

function makeMatchResult(overrides: Partial<MatchResult> = {}): MatchResult {
  return {
    shotId: 'shot-001',
    mediaId: 'media-001',
    score: 0.9,
    confirmed: false,
    ...overrides,
  };
}

describe('Storyboard Types', () => {
  describe('StoryboardInput', () => {
    it('应包含 matchResults 和 projectId 两个必填字段', () => {
      const input: StoryboardInput = {
        matchResults: [makeMatchResult()],
        projectId: 'proj-abc',
      };
      expect(input.matchResults).toHaveLength(1);
      expect(input.projectId).toBe('proj-abc');
    });

    it('空 matchResults 应为合法输入', () => {
      const input: StoryboardInput = {
        matchResults: [],
        projectId: 'proj-empty',
      };
      expect(input.matchResults).toHaveLength(0);
    });

    it('多个匹配结果应被接受', () => {
      const input: StoryboardInput = {
        matchResults: [
          makeMatchResult({ shotId: 's1' }),
          makeMatchResult({ shotId: 's2' }),
          makeMatchResult({ shotId: 's3' }),
        ],
        projectId: 'proj-multi',
      };
      expect(input.matchResults).toHaveLength(3);
    });
  });

  describe('StoryboardOutput', () => {
    it('应包含 confirmedCount 和 totalCount 字段', () => {
      const output: StoryboardOutput = {
        confirmedCount: 3,
        totalCount: 5,
      };
      expect(output.confirmedCount).toBe(3);
      expect(output.totalCount).toBe(5);
    });

    it('confirmedCount=0 应为合法', () => {
      const output: StoryboardOutput = {
        confirmedCount: 0,
        totalCount: 10,
      };
      expect(output.confirmedCount).toBe(0);
    });

    it('全部确认 confirmedCount === totalCount 应为合法', () => {
      const output: StoryboardOutput = {
        confirmedCount: 10,
        totalCount: 10,
      };
      expect(output.confirmedCount).toBe(output.totalCount);
    });
  });

  describe('ShotCardProps', () => {
    it('应包含 shot/index/isSelected/回调等全部字段', () => {
      const props: ShotCardProps = {
        shot: makeMatchResult(),
        index: 0,
        isSelected: false,
        onSelect: (shotId: string) => {},
        onConfirm: (shotId: string) => {},
        onReplace: (shotId: string) => {},
      };
      expect(props.index).toBe(0);
      expect(props.isSelected).toBe(false);
      expect(typeof props.onSelect).toBe('function');
      expect(typeof props.onConfirm).toBe('function');
      expect(typeof props.onReplace).toBe('function');
    });

    it('isSelected=true 时应可传递', () => {
      const props: ShotCardProps = {
        shot: makeMatchResult({ shotId: 'selected-shot' }),
        index: 5,
        isSelected: true,
        onSelect: () => {},
        onConfirm: () => {},
        onReplace: () => {},
      };
      expect(props.isSelected).toBe(true);
    });

    it('onConfirm 应接收 shotId 字符串', () => {
      let captured = '';
      const props: ShotCardProps = {
        shot: makeMatchResult({ shotId: 'target' }),
        index: 0,
        isSelected: false,
        onSelect: () => {},
        onConfirm: (id) => { captured = id; },
        onReplace: () => {},
      };
      props.onConfirm('target');
      expect(captured).toBe('target');
    });

    it('onReplace 应接收 shotId 字符串', () => {
      let captured = '';
      const props: ShotCardProps = {
        shot: makeMatchResult({ shotId: 'to-replace' }),
        index: 0,
        isSelected: false,
        onSelect: () => {},
        onConfirm: () => {},
        onReplace: (id) => { captured = id; },
      };
      props.onReplace('to-replace');
      expect(captured).toBe('to-replace');
    });

    it('onSelect 应接收 shotId 字符串', () => {
      let captured = '';
      const props: ShotCardProps = {
        shot: makeMatchResult({ shotId: 'select-me' }),
        index: 3,
        isSelected: false,
        onSelect: (id) => { captured = id; },
        onConfirm: () => {},
        onReplace: () => {},
      };
      props.onSelect('select-me');
      expect(captured).toBe('select-me');
    });
  });
});
