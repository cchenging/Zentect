// Module: home - Types 单元测试

import { describe, it, expect } from 'vitest';
import type {
  ProjectRecord,
  Project,
  HomeListInput,
  HomeListOutput,
} from '../types';

describe('Home Types', () => {
  describe('ProjectRecord', () => {
    it('应包含 id、name、coverPath、duration、createdAt、updatedAt 必填字段', () => {
      const record: ProjectRecord = {
        id: 'proj-001',
        name: '测试项目',
        coverPath: null,
        duration: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
      };
      expect(record.id).toBe('proj-001');
      expect(record.name).toBe('测试项目');
      expect(record.coverPath).toBeNull();
      expect(record.duration).toBeNull();
      expect(record.createdAt).toBe('2026-01-01T00:00:00Z');
      expect(record.updatedAt).toBe('2026-01-02T00:00:00Z');
    });

    it('可选字段 type 应在传入时生效', () => {
      const record: ProjectRecord = {
        id: 'proj-002',
        name: '视频项目',
        type: 'video',
        coverPath: '/covers/demo.png',
        duration: '05:30',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
      };
      expect(record.type).toBe('video');
    });

    it('可选字段 size 应在传入时生效', () => {
      const record: ProjectRecord = {
        id: 'proj-003',
        name: '大项目',
        coverPath: null,
        duration: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
        size: 1048576,
      };
      expect(record.size).toBe(1048576);
    });

    it('coverPath 为字符串时应可传递', () => {
      const record: ProjectRecord = {
        id: 'proj-004',
        name: '有封面项目',
        coverPath: '/covers/thumb.jpg',
        duration: '02:15',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
      };
      expect(record.coverPath).toBe('/covers/thumb.jpg');
    });

    it('duration 为字符串时应可传递', () => {
      const record: ProjectRecord = {
        id: 'proj-005',
        name: '长视频',
        coverPath: null,
        duration: '12:34:56',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
      };
      expect(record.duration).toBe('12:34:56');
    });

    it('省略可选字段应允许', () => {
      const record: ProjectRecord = {
        id: 'proj-006',
        name: '最小项目',
        coverPath: null,
        duration: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
      };
      expect(record.type).toBeUndefined();
      expect(record.size).toBeUndefined();
    });
  });

  describe('Project', () => {
    it('应为 ProjectRecord 的类型别名', () => {
      const proj: Project = {
        id: 'proj-007',
        name: '别名测试',
        coverPath: null,
        duration: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
      };
      expect(proj.id).toBe('proj-007');
      expect(proj.name).toBe('别名测试');
    });

    it('应兼容 ProjectRecord 的可选字段', () => {
      const proj: Project = {
        id: 'proj-008',
        name: '完整别名',
        type: 'audio',
        coverPath: '/covers/audio.png',
        duration: '03:45',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
        size: 512000,
      };
      expect(proj.type).toBe('audio');
      expect(proj.size).toBe(512000);
    });
  });

  describe('HomeListInput', () => {
    it('应包含 searchQuery 和 viewMode 两个必填字段', () => {
      const input: HomeListInput = {
        searchQuery: '',
        viewMode: 'grid',
      };
      expect(input.searchQuery).toBe('');
      expect(input.viewMode).toBe('grid');
    });

    it('viewMode 可为 list', () => {
      const input: HomeListInput = {
        searchQuery: '测试',
        viewMode: 'list',
      };
      expect(input.viewMode).toBe('list');
    });

    it('searchQuery 可为非空字符串', () => {
      const input: HomeListInput = {
        searchQuery: '我的项目',
        viewMode: 'grid',
      };
      expect(input.searchQuery).toBe('我的项目');
    });

    it('viewMode 仅接受 grid 或 list', () => {
      const gridInput: HomeListInput = { searchQuery: '', viewMode: 'grid' };
      const listInput: HomeListInput = { searchQuery: '', viewMode: 'list' };
      expect(gridInput.viewMode).toBe('grid');
      expect(listInput.viewMode).toBe('list');
    });
  });

  describe('HomeListOutput', () => {
    it('应包含 projects 和 totalCount 字段', () => {
      const output: HomeListOutput = {
        projects: [],
        totalCount: 0,
      };
      expect(output.projects).toEqual([]);
      expect(output.totalCount).toBe(0);
    });

    it('projects 应为 ProjectRecord 数组', () => {
      const project: ProjectRecord = {
        id: 'p1',
        name: '项目1',
        coverPath: null,
        duration: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
      };
      const output: HomeListOutput = {
        projects: [project],
        totalCount: 1,
      };
      expect(output.projects.length).toBe(1);
      expect(output.totalCount).toBe(1);
    });

    it('totalCount 应与 projects 长度一致', () => {
      const output: HomeListOutput = {
        projects: [
          {
            id: 'a', name: 'A',
            coverPath: null, duration: null,
            createdAt: '', updatedAt: '',
          },
          {
            id: 'b', name: 'B',
            coverPath: null, duration: null,
            createdAt: '', updatedAt: '',
          },
        ],
        totalCount: 2,
      };
      expect(output.projects.length).toBe(2);
      expect(output.totalCount).toBe(2);
    });
  });
});
