/**
 * @vitest-environment jsdom
 */

// Module: editor/shell - View 组件单元测试（TopBar）

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';

// === Mocks ===

const mockNavigate = vi.fn();

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('lucide-react', () => ({
  Settings: (props: any) => React.createElement('span', { 'data-testid': 'icon-settings', ...props }),
  Loader2: (props: any) => React.createElement('span', { 'data-testid': 'icon-loader', ...props }),
}));

vi.mock('../../../../../renderer/src/store/useStore', () => {
  const store = {
    projectName: '测试项目',
    projectId: 'proj-test-001',
    saveStatus: 'saved',
    lastSavedTime: '12:00',
    setProjectMeta: vi.fn(),
  };
  return {
    useEditorStore: (selector: any) => {
      if (typeof selector === 'function') return selector(store);
      return store;
    },
  };
});

vi.mock('../../../../../renderer/src/store/useI18n', () => ({
  useI18n: () => ({
    t: {
      editor: { unnamed_project: '未命名项目' },
      nav: { settings: '设置' },
    },
  }),
}));

vi.mock('../../../../../renderer/src/components/window-controls', () => ({
  WindowControls: (props: any) =>
    React.createElement('div', {
      'data-testid': 'window-controls',
      onClick: props.onClose,
    }, 'WindowControls'),
}));

vi.mock('../frontend/components/ExportModal', () => ({
  ExportModal: () => React.createElement('div', { 'data-testid': 'export-modal' }, 'ExportModal'),
}));

vi.mock('../../../../../renderer/src/api', () => ({
  API: {
    project: {
      rename: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

vi.mock('../../../../../renderer/src/core/AppNotifier', () => ({
  AppNotifier: {
    error: vi.fn(),
  },
}));

// === Tests ===

let TopBar: React.FC;

beforeAll(async () => {
  const mod = await import('../frontend/components/TopBar');
  TopBar = mod.TopBar;
});

function renderTopBar() {
  return render(React.createElement(TopBar));
}

describe('TopBar (shell View)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  // === 基础渲染 ===

  describe('基础渲染', () => {
    it('应渲染 header 元素', () => {
      const { container } = renderTopBar();
      const header = container.querySelector('header');
      expect(header).toBeTruthy();
    });

    it('应显示项目名称', () => {
      renderTopBar();
      expect(screen.getByText('测试项目')).toBeDefined();
    });

    it('应显示 Z 按钮（返回首页）', () => {
      renderTopBar();
      expect(screen.getByText('Z')).toBeDefined();
    });

    it('应渲染 ExportModal', () => {
      renderTopBar();
      expect(screen.getByTestId('export-modal')).toBeDefined();
    });

    it('应渲染设置图标按钮', () => {
      renderTopBar();
      expect(screen.getByTestId('icon-settings')).toBeDefined();
    });

    it('应渲染 WindowControls', () => {
      renderTopBar();
      expect(screen.getByTestId('window-controls')).toBeDefined();
    });
  });

  // === 导航 ===

  describe('导航', () => {
    it('点击 Z 按钮应导航到首页', () => {
      renderTopBar();
      fireEvent.click(screen.getByText('Z'));
      expect(mockNavigate).toHaveBeenCalledWith('/');
    });

    it('点击设置图标应导航到设置页', () => {
      renderTopBar();
      const settingsBtn = screen.getByTestId('icon-settings').parentElement!;
      fireEvent.click(settingsBtn);
      expect(mockNavigate).toHaveBeenCalledWith('/settings');
    });

    it('WindowControls onClose 应导航到首页', () => {
      renderTopBar();
      fireEvent.click(screen.getByTestId('window-controls'));
      expect(mockNavigate).toHaveBeenCalledWith('/');
    });
  });

  // === 保存状态 ===

  describe('保存状态', () => {
    it('saveStatus=saved 时应显示已保存状态', () => {
      renderTopBar();
      expect(screen.getByText(/已保存/)).toBeDefined();
    });
  });

  // === displayName ===

  describe('displayName', () => {
    it('应为 TopBar', () => {
      expect(TopBar.displayName).toBe('TopBar');
    });
  });
});
