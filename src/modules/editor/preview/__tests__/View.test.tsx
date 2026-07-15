/**
 * @vitest-environment jsdom
 */

// Module: editor/preview - View 组件单元测试

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';

// === Mocks ===

/** 动态控制 activePlaySource 的 mock 值 */
let mockActivePlaySource: any = null;

vi.mock('../../stores/usePlayerStore', () => ({
  usePlayerStore: (selector?: (state: any) => any) => {
    const state = { activePlaySource: mockActivePlaySource };
    return selector ? selector(state) : state;
  },
}));

vi.mock('../frontend/components/Player', () => ({
  Player: () => React.createElement('div', { 'data-testid': 'player' }, 'Player'),
}));

vi.mock('../frontend/components/PlayerControls', () => ({}));

vi.mock('../frontend/components/VideoCanvas', () => ({}));

vi.mock('lucide-react', () => ({}));

// === Tests ===

import PreviewMonitor from '../frontend/View';

function renderView(props: Record<string, unknown> = {}) {
  return render(React.createElement(PreviewMonitor, props));
}

describe('PreviewMonitor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActivePlaySource = null;
  });

  afterEach(() => {
    cleanup();
  });

  // === 无素材状态 ===

  describe('无素材（activePlaySource=null）', () => {
    it('应显示导入引导文案', () => {
      renderView();
      expect(screen.getByText('导入视频素材开始创作')).toBeDefined();
    });

    it('应显示 SVG 占位图标', () => {
      const { container } = renderView();
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
      expect(svg!.getAttribute('viewBox')).toBe('0 0 24 24');
    });
  });

  // === 有 onImportClick 回调 ===

  describe('导入按钮（onImportClick）', () => {
    it('activePlaySource=null 且传入 onImportClick 时应显示"导入视频素材"按钮', () => {
      const onImportClick = vi.fn();
      renderView({ onImportClick });
      expect(screen.getByText('导入视频素材')).toBeDefined();
    });

    it('点击"导入视频素材"应调用 onImportClick', () => {
      const onImportClick = vi.fn();
      renderView({ onImportClick });
      fireEvent.click(screen.getByText('导入视频素材'));
      expect(onImportClick).toHaveBeenCalledTimes(1);
    });

    it('不传 onImportClick 时应不显示按钮', () => {
      renderView();
      expect(screen.queryByText('导入视频素材')).toBeNull();
    });
  });

  // === 有素材状态 ===

  describe('有素材（activePlaySource 非 null）', () => {
    it('应渲染 Player 组件', () => {
      mockActivePlaySource = { type: 'video', filePath: '/videos/demo.mp4' };
      renderView();
      expect(screen.getByTestId('player')).toBeDefined();
    });

    it('activePlaySource 有值时不应显示导入引导文案', () => {
      mockActivePlaySource = { type: 'video', filePath: '/videos/demo.mp4' };
      renderView();
      expect(screen.queryByText('导入视频素材开始创作')).toBeNull();
    });
  });

  // === displayName ===

  describe('displayName', () => {
    it('displayName 应为 PreviewMonitor', () => {
      expect(PreviewMonitor.displayName).toBe('PreviewMonitor');
    });
  });
});
