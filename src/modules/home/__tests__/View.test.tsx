/**
 * @vitest-environment jsdom
 */

// Module: home - View 组件单元测试

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';

// === Mocks ===

vi.mock('../../types', () => ({}));

vi.mock('../../../../renderer/src/components/ParticleEngine', () => ({
  ParticleEngine: (props: any) =>
    React.createElement('div', { 'data-testid': 'particle-engine', ...props }),
}));

vi.mock('../frontend/components/ProjectCard', () => ({
  ProjectCard: (props: any) =>
    React.createElement(
      'div',
      { 'data-testid': 'project-card', 'data-project-id': props.project.id },
      props.project.name,
    ),
}));

vi.mock('../frontend/components/RenameModal', () => ({
  RenameModal: (props: any) =>
    props.visible
      ? React.createElement('div', { 'data-testid': 'rename-modal' }, 'RenameModal')
      : null,
}));

vi.mock('../frontend/components/DeleteModal', () => ({
  DeleteModal: (props: any) =>
    props.visible
      ? React.createElement('div', { 'data-testid': 'delete-modal' }, 'DeleteModal')
      : null,
}));

vi.mock('lucide-react', () => ({
  Play: (props: any) => React.createElement('span', { 'data-testid': 'icon-play', ...props }),
  Search: (props: any) =>
    React.createElement('span', { 'data-testid': 'icon-search', ...props }),
  LayoutGrid: (props: any) =>
    React.createElement('span', { 'data-testid': 'icon-grid', ...props }),
  List: (props: any) => React.createElement('span', { 'data-testid': 'icon-list', ...props }),
  FolderOpen: (props: any) =>
    React.createElement('span', { 'data-testid': 'icon-folder', ...props }),
  Upload: (props: any) =>
    React.createElement('span', { 'data-testid': 'icon-upload', ...props }),
}));

// === Tests ===

import { HomeView } from '../frontend/View';

const defaultProps = {
  filteredProjects: [] as any[],
  searchText: '',
  onSearchChange: vi.fn(),
  onCreateProject: vi.fn(),
  onImportWorkflow: vi.fn(),
  isImporting: false,
  onProjectClick: vi.fn(),
  onRenameClick: vi.fn(),
  onDuplicateProject: vi.fn(),
  onDeleteClick: vi.fn(),
  onExportClick: vi.fn(),
  renameVisible: false,
  currentEditProj: null as any,
  onRenameClose: vi.fn(),
  onRenameConfirm: vi.fn() as any,
  deleteVisible: false,
  currentDeleteProj: null as any,
  onDeleteClose: vi.fn(),
  onDeleteConfirm: vi.fn(),
  viewMode: 'grid' as const,
  onViewModeChange: vi.fn(),
  searchOpen: false,
  onToggleSearch: vi.fn(),
  formatDate: (d: string) => d,
};

function renderView(props: Record<string, unknown> = {}) {
  return render(React.createElement(HomeView, { ...defaultProps, ...props }));
}

describe('HomeView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  // === 基础渲染 ===

  describe('基础渲染', () => {
    it('应渲染 ParticleEngine', () => {
      renderView();
      expect(screen.getByTestId('particle-engine')).toBeDefined();
    });

    it('应显示"开始创作"按钮', () => {
      renderView();
      expect(screen.getByText('开始创作')).toBeDefined();
    });

    it('应显示"导入工作流"按钮', () => {
      renderView();
      expect(screen.getByText('导入工作流')).toBeDefined();
    });

    it('应显示"我的项目"标题', () => {
      renderView();
      expect(screen.getByText('我的项目')).toBeDefined();
    });

    it('应显示项目计数', () => {
      renderView({ filteredProjects: [] });
      expect(screen.getByText('(0)')).toBeDefined();
    });
  });

  // === 空状态 ===

  describe('空状态（无项目）', () => {
    it('应显示空状态图标', () => {
      renderView({ filteredProjects: [] });
      expect(screen.getByTestId('icon-folder')).toBeDefined();
    });

    it('应显示"还没有项目"文案', () => {
      renderView({ filteredProjects: [], searchText: '' });
      expect(screen.getByText('还没有项目')).toBeDefined();
    });

    it('searchText 非空时应显示"没有找到匹配的项目"', () => {
      renderView({ filteredProjects: [], searchText: 'xxx' });
      expect(screen.getByText('没有找到匹配的项目')).toBeDefined();
    });
  });

  // === Grid 视图 ===

  describe('Grid 视图', () => {
    const projects = [
      {
        id: '1',
        name: '项目A',
        coverPath: null,
        duration: null,
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
      },
      {
        id: '2',
        name: '项目B',
        coverPath: null,
        duration: null,
        createdAt: '2026-01-02',
        updatedAt: '2026-01-02',
      },
    ];

    it('应渲染 ProjectCard 组件', () => {
      renderView({ filteredProjects: projects, viewMode: 'grid' });
      const cards = screen.getAllByTestId('project-card');
      expect(cards.length).toBe(2);
    });

    it('应传递正确的项目名称', () => {
      renderView({ filteredProjects: projects, viewMode: 'grid' });
      expect(screen.getByText('项目A')).toBeDefined();
      expect(screen.getByText('项目B')).toBeDefined();
    });

    it('应显示正确的项目计数', () => {
      renderView({ filteredProjects: projects, viewMode: 'grid' });
      expect(screen.getByText('(2)')).toBeDefined();
    });
  });

  // === List 视图 ===

  describe('List 视图', () => {
    const projects = [
      {
        id: '1',
        name: '列表项目',
        coverPath: null,
        duration: '03:00',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
      },
    ];

    it('应渲染列表项', () => {
      renderView({ filteredProjects: projects, viewMode: 'list' });
      expect(screen.getByText('列表项目')).toBeDefined();
    });

    it('应显示 duration 信息', () => {
      renderView({ filteredProjects: projects, viewMode: 'list' });
      expect(screen.getByText(/03:00/)).toBeDefined();
    });

    it('应调用 formatDate 格式化日期', () => {
      const formatDate = vi.fn(() => '格式化日期');
      renderView({ filteredProjects: projects, viewMode: 'list', formatDate });
      expect(formatDate).toHaveBeenCalled();
    });
  });

  // === 按钮交互 ===

  describe('按钮交互', () => {
    it('点击"开始创作"应调用 onCreateProject', () => {
      const onCreateProject = vi.fn();
      renderView({ onCreateProject });
      fireEvent.click(screen.getByText('开始创作'));
      expect(onCreateProject).toHaveBeenCalledTimes(1);
    });

    it('点击"导入工作流"应调用 onImportWorkflow', () => {
      const onImportWorkflow = vi.fn();
      renderView({ onImportWorkflow });
      fireEvent.click(screen.getByText('导入工作流'));
      expect(onImportWorkflow).toHaveBeenCalledTimes(1);
    });

    it('isImporting=true 时导入按钮应显示"导入中..."', () => {
      renderView({ isImporting: true });
      expect(screen.getByText('导入中...')).toBeDefined();
    });

    it('isImporting=true 时导入按钮应禁用', () => {
      renderView({ isImporting: true });
      const btn = screen.getByText('导入中...');
      expect((btn as HTMLButtonElement).disabled).toBe(true);
    });
  });

  // === 搜索 ===

  describe('搜索', () => {
    it('searchOpen=false 时搜索输入框容器应有 w-0 类', () => {
      const { container } = renderView({ searchOpen: false });
      const input = container.querySelector('input[placeholder="搜索项目..."]');
      expect(input).toBeTruthy();
      // 输入框的父级容器应有 w-0 类（视觉隐藏）
      const wrapper = input!.closest('.w-0');
      expect(wrapper).toBeTruthy();
    });

    it('searchOpen=true 时搜索输入框应可见', () => {
      renderView({ searchOpen: true });
      expect(screen.getByPlaceholderText('搜索项目...')).toBeDefined();
    });

    it('点击搜索图标应调用 onToggleSearch', () => {
      const onToggleSearch = vi.fn();
      renderView({ onToggleSearch });
      // 有两个 Search 图标（hero 区 + 搜索栏），取第一个（搜索切换按钮）
      const searchIcons = screen.getAllByTestId('icon-search');
      const searchBtn = searchIcons[0].parentElement!;
      fireEvent.click(searchBtn);
      expect(onToggleSearch).toHaveBeenCalledTimes(1);
    });

    it('输入搜索文本应调用 onSearchChange', () => {
      const onSearchChange = vi.fn();
      renderView({ searchOpen: true, onSearchChange });
      const input = screen.getByPlaceholderText('搜索项目...');
      fireEvent.change(input, { target: { value: '测试' } });
      expect(onSearchChange).toHaveBeenCalledWith('测试');
    });
  });

  // === 视图模式切换 ===

  describe('视图模式切换', () => {
    it('点击 Grid 按钮应调用 onViewModeChange("grid")', () => {
      const onViewModeChange = vi.fn();
      renderView({ viewMode: 'list', onViewModeChange });
      fireEvent.click(screen.getByTestId('icon-grid').parentElement!);
      expect(onViewModeChange).toHaveBeenCalledWith('grid');
    });

    it('点击 List 按钮应调用 onViewModeChange("list")', () => {
      const onViewModeChange = vi.fn();
      renderView({ viewMode: 'grid', onViewModeChange });
      fireEvent.click(screen.getByTestId('icon-list').parentElement!);
      expect(onViewModeChange).toHaveBeenCalledWith('list');
    });
  });

  // === 模态框 ===

  describe('模态框', () => {
    it('renameVisible=true 时应渲染 RenameModal', () => {
      renderView({
        renameVisible: true,
        currentEditProj: {
          id: '1',
          name: 'test',
          coverPath: null,
          duration: null,
          createdAt: '',
          updatedAt: '',
        },
      });
      expect(screen.getByTestId('rename-modal')).toBeDefined();
    });

    it('renameVisible=false 时应不渲染 RenameModal', () => {
      renderView({ renameVisible: false });
      expect(screen.queryByTestId('rename-modal')).toBeNull();
    });

    it('deleteVisible=true 时应渲染 DeleteModal', () => {
      renderView({
        deleteVisible: true,
        currentDeleteProj: { id: '1', name: 'test' },
      });
      expect(screen.getByTestId('delete-modal')).toBeDefined();
    });

    it('deleteVisible=false 时应不渲染 DeleteModal', () => {
      renderView({ deleteVisible: false });
      expect(screen.queryByTestId('delete-modal')).toBeNull();
    });
  });

  // === 项目点击 ===

  describe('项目列表点击', () => {
    it('点击列表项应调用 onProjectClick', () => {
      const onProjectClick = vi.fn();
      const projects = [
        {
          id: '1', name: '列表项目', coverPath: null, duration: '03:00',
          createdAt: '2026-01-01', updatedAt: '2026-01-01',
        },
      ];
      renderView({ filteredProjects: projects, viewMode: 'list', onProjectClick });
      const listItem = screen.getByText('列表项目').closest('.cursor-pointer')!;
      fireEvent.click(listItem);
      expect(onProjectClick).toHaveBeenCalledWith('1', undefined);
    });
  });
});
