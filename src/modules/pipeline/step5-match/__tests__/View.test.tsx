/**
 * @vitest-environment jsdom
 */

// Module: pipeline/step5-match - View 组件单元测试

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
import React from 'react';
import type { StepShotMatchingProps, MatchResult } from '../types';

// === Mocks ===

vi.mock('lucide-react', () => ({
  Check: (props: any) => React.createElement('span', { 'data-testid': 'icon-check', ...props }),
  RefreshCw: (props: any) => React.createElement('span', { 'data-testid': 'icon-refresh', ...props }),
  Film: (props: any) => React.createElement('span', { 'data-testid': 'icon-film', ...props }),
  X: (props: any) => React.createElement('span', { 'data-testid': 'icon-x', ...props }),
}));

vi.mock('../../../../renderer/src/utils/formatUrl', () => ({
  getSafeMediaUrl: (path: string) => `safe://${path || 'placeholder'}`,
}));

vi.mock('../../../../renderer/src/components/shared', () => ({
  Badge: ({ children, variant, className }: any) =>
    React.createElement('span', {
      'data-testid': `badge-${variant || 'default'}`,
      className,
    }, children),
  StatHeader: ({ value, unit, secondary }: any) =>
    React.createElement('div', { 'data-testid': 'stat-header' },
      React.createElement('span', { 'data-testid': 'stat-value' }, `${value}${unit}`),
      secondary && React.createElement('span', { 'data-testid': 'stat-secondary' }, secondary),
    ),
  EmptyState: ({ title, description }: any) =>
    React.createElement('div', { 'data-testid': 'empty-state' },
      React.createElement('h3', null, title),
      React.createElement('p', null, description),
    ),
}));

vi.mock('../../../../renderer/src/components/shared/DragReorderList', () => ({
  DragReorderList: ({ items, renderItem }: any) =>
    React.createElement('div', { 'data-testid': 'drag-list' },
      items.map((item: any, idx: number) =>
        React.createElement('div', {
          key: item.shotId || idx,
          'data-testid': `drag-item-${item.shotId || idx}`,
        }, renderItem(item, idx, false)),
      ),
    ),
}));

let StepShotMatchingView: React.FC<StepShotMatchingProps>;

beforeAll(async () => {
  const mod = await import('../frontend/View');
  StepShotMatchingView = mod.StepShotMatchingView;
});

// ---------- helpers ----------

function makeMatchResult(overrides: Partial<MatchResult> = {}): MatchResult {
  return {
    shotId: 'shot-001',
    mediaId: 'media-001',
    score: 0.9,
    confirmed: false,
    ...overrides,
  };
}

function makeProps(overrides: Partial<StepShotMatchingProps> = {}): StepShotMatchingProps {
  return {
    matchResults: [],
    videoChunks: [],
    mediaItems: [],
    hasBgm: false,
    isProcessing: false,
    onConfirm: vi.fn(),
    onReplace: vi.fn(),
    onRematch: vi.fn(),
    onReorder: vi.fn(),
    ...overrides,
  };
}

function renderView(overrides: Partial<StepShotMatchingProps> = {}) {
  return render(React.createElement(StepShotMatchingView, makeProps(overrides)));
}

// ---------- tests ----------

describe('StepShotMatchingView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  // === 空状态 ===

  describe('空状态', () => {
    it('无匹配结果时应显示 EmptyState', () => {
      renderView();
      expect(screen.getByTestId('empty-state')).toBeDefined();
    });

    it('应显示"智能匹配待生成"标题', () => {
      renderView();
      expect(screen.getByText('智能匹配待生成')).toBeDefined();
    });

    it('空状态时"重新匹配"按钮仍可见', () => {
      renderView();
      expect(screen.getByText('重新匹配')).toBeDefined();
    });
  });

  // === 有匹配结果 ===

  describe('有匹配结果', () => {
    it('应渲染 drag-list', () => {
      renderView({ matchResults: [makeMatchResult()] });
      expect(screen.getByTestId('drag-list')).toBeDefined();
    });

    it('两张卡片时应渲染两个 drag-item', () => {
      renderView({
        matchResults: [
          makeMatchResult({ shotId: 's1' }),
          makeMatchResult({ shotId: 's2' }),
        ],
      });
      expect(screen.getByTestId('drag-item-s1')).toBeDefined();
      expect(screen.getByTestId('drag-item-s2')).toBeDefined();
    });

    it('应显示拖拽提示文字', () => {
      renderView({ matchResults: [makeMatchResult()] });
      expect(screen.getByText('拖拽卡片可调整顺序')).toBeDefined();
    });

    it('应在 stat-header 中显示匹配数量', () => {
      renderView({ matchResults: [makeMatchResult()] });
      expect(screen.getByTestId('stat-header')).toBeDefined();
    });
  });

  // === 单卡片内按钮 ===

  describe('单卡片内按钮', () => {
    it('未确认卡片应同时显示"确认"和"替换"按钮', () => {
      renderView({ matchResults: [makeMatchResult({ confirmed: false })] });
      const item = screen.getByTestId('drag-item-shot-001');
      expect(within(item).getByText('确认')).toBeDefined();
      expect(within(item).getByText('替换')).toBeDefined();
    });

    it('已确认卡片应显示"已确认"且不显示操作按钮', () => {
      renderView({ matchResults: [makeMatchResult({ confirmed: true })] });
      const item = screen.getByTestId('drag-item-shot-001');
      expect(within(item).getByText('已确认')).toBeDefined();
      expect(within(item).queryByText('确认')).toBeNull();
      expect(within(item).queryByText('替换')).toBeNull();
    });

    it('点击"确认"应调用 onConfirm 传入 shotId', () => {
      const onConfirm = vi.fn();
      renderView({
        matchResults: [makeMatchResult({ shotId: 'target', confirmed: false })],
        onConfirm,
      });
      const item = screen.getByTestId('drag-item-target');
      fireEvent.click(within(item).getByText('确认'));
      expect(onConfirm).toHaveBeenCalledWith('target');
    });

    it('score 百分比 Badge 应显示正确数值', () => {
      renderView({ matchResults: [makeMatchResult({ shotId: 's1', score: 0.95 })] });
      const item = screen.getByTestId('drag-item-s1');
      expect(within(item).getByText('95%')).toBeDefined();
    });
  });

  // === BGM Badge ===

  describe('BGM Badge', () => {
    it('hasBgm=true 时应显示 BGM 标识', () => {
      renderView({ hasBgm: true });
      expect(screen.getByText('BGM')).toBeDefined();
    });

    it('hasBgm=false 时不应在 badge-success 中出现 BGM', () => {
      renderView({ hasBgm: false, matchResults: [makeMatchResult()] });
      const badges = screen.queryAllByTestId('badge-success');
      const bgmBadge = badges.find((b) => b.textContent === 'BGM');
      expect(bgmBadge).toBeUndefined();
    });
  });

  // === 重新匹配按钮 ===

  describe('重新匹配按钮', () => {
    it('点击应调用 onRematch', () => {
      const onRematch = vi.fn();
      renderView({ onRematch });
      fireEvent.click(screen.getByText('重新匹配'));
      expect(onRematch).toHaveBeenCalledTimes(1);
    });

    it('isProcessing=true 时显示"匹配中..."且按钮 disabled', () => {
      renderView({ isProcessing: true, matchResults: [makeMatchResult()] });
      const btn = screen.getByText('匹配中...') as HTMLButtonElement;
      expect(btn).toBeDefined();
      expect(btn.disabled).toBe(true);
    });

    it('isProcessing=false 时按钮可点击', () => {
      renderView({ isProcessing: false, matchResults: [makeMatchResult()] });
      const btn = screen.getByText('重新匹配') as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
    });
  });

  // === 替换弹窗 ===

  describe('替换弹窗', () => {
    it('点击"替换"应打开弹窗显示"选择视频片段"', () => {
      renderView({ matchResults: [makeMatchResult({ confirmed: false })] });
      const item = screen.getByTestId('drag-item-shot-001');
      fireEvent.click(within(item).getByText('替换'));
      expect(screen.getByText('选择视频片段')).toBeDefined();
    });

    it('弹窗关闭按钮可关闭弹窗', () => {
      renderView({ matchResults: [makeMatchResult({ confirmed: false })] });
      const item = screen.getByTestId('drag-item-shot-001');
      fireEvent.click(within(item).getByText('替换'));
      const closeBtn = screen.getByTestId('icon-x').parentElement!;
      fireEvent.click(closeBtn);
      expect(screen.queryByText('选择视频片段')).toBeNull();
    });

    it('无素材时应显示空状态提示', () => {
      renderView({
        matchResults: [makeMatchResult({ confirmed: false })],
        videoChunks: [],
        mediaItems: [],
      });
      const item = screen.getByTestId('drag-item-shot-001');
      fireEvent.click(within(item).getByText('替换'));
      expect(screen.getByText('暂无片段素材')).toBeDefined();
    });
  });

  // === Score 颜色 ===

  describe('score 边框颜色', () => {
    it('score >= 0.85 → border-l-accent-green', () => {
      renderView({ matchResults: [makeMatchResult({ shotId: 'high', score: 0.9 })] });
      const card = screen.getByTestId('drag-item-high');
      expect(card.querySelector('.border-l-accent-green')).toBeTruthy();
    });

    it('score 0.6~0.84 → border-l-warning', () => {
      renderView({ matchResults: [makeMatchResult({ shotId: 'mid', score: 0.7 })] });
      const card = screen.getByTestId('drag-item-mid');
      expect(card.querySelector('.border-l-warning')).toBeTruthy();
    });

    it('score < 0.6 → border-l-accent-rose', () => {
      renderView({ matchResults: [makeMatchResult({ shotId: 'low', score: 0.3 })] });
      const card = screen.getByTestId('drag-item-low');
      expect(card.querySelector('.border-l-accent-rose')).toBeTruthy();
    });
  });

  describe('score Badge', () => {
    it('score > 0.8 → badge-success', () => {
      renderView({ matchResults: [makeMatchResult({ shotId: 's1', score: 0.9 })] });
      const item = screen.getByTestId('drag-item-s1');
      expect(within(item).getByTestId('badge-success')).toBeDefined();
    });

    it('0.5 < score <= 0.8 → badge-warning', () => {
      renderView({ matchResults: [makeMatchResult({ shotId: 's2', score: 0.6 })] });
      const item = screen.getByTestId('drag-item-s2');
      expect(within(item).getByTestId('badge-warning')).toBeDefined();
    });

    it('score <= 0.5 → badge-danger', () => {
      renderView({ matchResults: [makeMatchResult({ shotId: 's3', score: 0.3 })] });
      const item = screen.getByTestId('drag-item-s3');
      expect(within(item).getByTestId('badge-danger')).toBeDefined();
    });
  });
});
