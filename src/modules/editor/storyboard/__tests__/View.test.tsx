/**
 * @vitest-environment jsdom
 */

// Module: editor/storyboard - View 组件单元测试（ShotCard）

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import type { Shot, Role } from '../../../../shared/types';

// === Mocks ===

vi.mock('@dnd-kit/sortable', () => ({
  useSortable: ({ id }: { id: string }) => ({
    attributes: { 'data-dnd-attributes': id },
    listeners: { 'data-dnd-listeners': id },
    setNodeRef: () => {},
    transform: null,
    transition: null,
    isDragging: false,
  }),
}));

vi.mock('@dnd-kit/utilities', () => ({
  CSS: {
    Transform: { toString: () => '' },
  },
}));

vi.mock('lucide-react', () => ({
  GripVertical: (props: any) => React.createElement('span', { 'data-testid': 'icon-grip', ...props }),
}));

vi.mock('../../../../../renderer/src/utils/formatUrl', () => ({
  getSafeMediaUrl: (path: string) => path ? `safe://${path}` : '',
}));

vi.mock('../../../../../renderer/src/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: any) => React.createElement('div', { 'data-testid': 'dropdown-menu' }, children),
  DropdownMenuContent: ({ children, ...props }: any) =>
    React.createElement('div', { 'data-testid': 'dropdown-content', ...props }, children),
  DropdownMenuItem: ({ children, onClick, className, ...props }: any) =>
    React.createElement('button', { 'data-testid': 'dropdown-item', onClick, className, ...props }, children),
  DropdownMenuTrigger: ({ children, asChild }: any) =>
    React.createElement('div', { 'data-testid': 'dropdown-trigger' }, asChild ? children : null),
}));

// === Test data ===

function makeShot(overrides: Partial<Shot> = {}): Shot {
  return {
    id: 'shot-001',
    mediaId: 'media-001',
    imagePath: '/images/shot1.jpg',
    text: '原始台词',
    start: 0,
    end: 5,
    duration: 5,
    ...overrides,
  };
}

function makeRole(overrides: Partial<Role> = {}): Role {
  return {
    id: 'role-001',
    name: '主角',
    ...overrides,
  };
}

// === Tests ===

let ShotCard: React.FC<any>;

beforeAll(async () => {
  const mod = await import('../frontend/components/ShotCard');
  ShotCard = mod.default;
});

function renderCard(overrides: Record<string, unknown> = {}) {
  return render(React.createElement(ShotCard, {
    shot: makeShot(),
    index: 0,
    isSelected: false,
    roles: [],
    onSelect: vi.fn(),
    onDelete: vi.fn(),
    onSave: vi.fn(),
    ...overrides,
  }));
}

describe('ShotCard (storyboard View)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  // === 基础渲染 ===

  describe('基础渲染', () => {
    it('应渲染卡片容器', () => {
      const { container } = renderCard();
      const card = container.querySelector('.rounded-lg');
      expect(card).toBeTruthy();
    });

    it('应显示拖拽手柄图标', () => {
      renderCard();
      expect(screen.getByTestId('icon-grip')).toBeDefined();
    });

    it('应显示 dropdow-menu', () => {
      renderCard();
      expect(screen.getByTestId('dropdown-menu')).toBeDefined();
    });

    it('无封面时应显示"暂无画面"', () => {
      renderCard({ shot: makeShot({ coverPath: '', imagePath: '' }) });
      expect(screen.getByText('暂无画面')).toBeDefined();
    });

    it('有 aiText 时应显示 aiText', () => {
      renderCard({ shot: makeShot({ aiText: 'AI生成的台词内容' }) });
      expect(screen.getByText('AI生成的台词内容')).toBeDefined();
    });

    it('无 aiText 但有 text 时应显示 text', () => {
      renderCard({ shot: makeShot({ text: '手写台词' }) });
      expect(screen.getByText('手写台词')).toBeDefined();
    });

    it('无台词时应显示"未配置台词"', () => {
      renderCard({ shot: makeShot({ aiText: '', text: '' }) });
      expect(screen.getByText('未配置台词')).toBeDefined();
    });
  });

  // === 角色标签 ===

  describe('角色标签', () => {
    it('shot 有 roleId 且匹配角色时应显示角色名', () => {
      const roles = [makeRole({ id: 'role-hero', name: '英雄' })];
      renderCard({ shot: makeShot({ roleId: 'role-hero' }), roles });
      expect(screen.getByText('英雄')).toBeDefined();
    });

    it('shot 有 linkedRoleId 时也应按角色匹配', () => {
      const roles = [makeRole({ id: 'role-npc', name: '路人甲' })];
      renderCard({ shot: makeShot({ roleId: '', linkedRoleId: 'role-npc' }), roles });
      expect(screen.getByText('路人甲')).toBeDefined();
    });

    it('roleId 不匹配时不应显示角色名', () => {
      const roles = [makeRole({ id: 'role-other', name: '其他' })];
      const { container } = renderCard({ shot: makeShot({ roleId: 'role-unknown', linkedRoleId: '' }), roles });
      // 不应该有角色标签文本
      const roleSpans = Array.from(container.querySelectorAll('span'))
        .filter(s => s.textContent === '其他');
      expect(roleSpans).toHaveLength(0);
    });
  });

  // === 选中状态 ===

  describe('选中状态', () => {
    it('isSelected=true 时应添加 ring 样式', () => {
      const { container } = renderCard({ isSelected: true });
      const card = container.querySelector('.ring-2');
      expect(card).toBeTruthy();
    });

    it('isSelected=false 时应无 ring 样式', () => {
      const { container } = renderCard({ isSelected: false });
      const card = container.querySelector('.ring-2');
      expect(card).toBeNull();
    });

    it('点击卡片应调用 onSelect', () => {
      const onSelect = vi.fn();
      const { container } = renderCard({ onSelect });
      const card = container.querySelector('.rounded-lg')!;
      fireEvent.click(card);
      expect(onSelect).toHaveBeenCalledTimes(1);
    });
  });

  // === 时长和情绪 ===

  describe('时长和情绪', () => {
    it('有 duration 时应显示时长（秒）', () => {
      renderCard({ shot: makeShot({ duration: 10 }) });
      expect(screen.getByText('10s')).toBeDefined();
    });

    it('有 audioEmotion 时应显示情绪', () => {
      renderCard({ shot: makeShot({ audioEmotion: 'happy' }) });
      expect(screen.getByText('happy')).toBeDefined();
    });

    it('同时有 duration 和 emotion 应同时显示', () => {
      renderCard({ shot: makeShot({ duration: 8, audioEmotion: 'sad' }) });
      expect(screen.getByText('8s')).toBeDefined();
      expect(screen.getByText('sad')).toBeDefined();
    });
  });

  // === 删除 ===

  describe('删除镜头', () => {
    it('dropdown 中应包含"删除镜头"选项', () => {
      renderCard();
      expect(screen.getByText('删除镜头')).toBeDefined();
    });

    it('点击"删除镜头"应调用 onDelete', () => {
      const onDelete = vi.fn();
      renderCard({ onDelete });
      fireEvent.click(screen.getByText('删除镜头'));
      expect(onDelete).toHaveBeenCalledTimes(1);
    });
  });

  // === 状态指示器 ===

  describe('状态指示器', () => {
    it('有 aiText 和 coverPath 时状态为 completed（绿色）', () => {
      const { container } = renderCard({
        shot: makeShot({ aiText: '台词', coverPath: '/cover.jpg' }),
      });
      const dot = container.querySelector('.bg-green-500');
      expect(dot).toBeTruthy();
    });

    it('有 text 但无 coverPath 时状态为 processing（蓝色）', () => {
      const { container } = renderCard({
        shot: makeShot({ text: '台词', aiText: '', coverPath: '' }),
      });
      const dot = container.querySelector('.bg-blue-500');
      expect(dot).toBeTruthy();
    });

    it('无 text 无 coverPath 时状态为 pending（灰色）', () => {
      const { container } = renderCard({
        shot: makeShot({ text: '', aiText: '', coverPath: '' }),
      });
      const dot = container.querySelector('.bg-gray-500');
      expect(dot).toBeTruthy();
    });
  });

  // === index ===

  describe('index', () => {
    it('index 应正确传递', () => {
      renderCard({ index: 5 });
      // 间接验证：卡片应该正常渲染
      expect(screen.getByTestId('dropdown-menu')).toBeDefined();
    });
  });
});
