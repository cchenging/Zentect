// 📁 路径：src/modules/home/frontend/hooks/useProjectManager.ts
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useI18n } from '@renderer/store/useI18n';
import { API } from '@renderer/api';
import { AppNotifier } from '@renderer/core/AppNotifier';
import type { ProjectRecord } from '../../types';
import { FrontendLogger } from '@renderer/utils/logger';

/**
 * 项目管理 Hook
 * 负责项目列表获取、创建、删除等核心操作
 */
export const useProjectManager = () => {
  const { t } = useI18n();
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [searchText, setSearchText] = useState('');

  /** 获取工程列表 */
  const fetchProjects = useCallback(async () => {
    try {
      const result = await API.project.getList();
      if (result && Array.isArray(result)) {
        const mapped: ProjectRecord[] = result.map((item: any) => ({
          id: item.id,
          name: item.name,
          type: item.type,
          coverPath: item.cover || item.coverPath || null,
          duration: item.duration || null,
          step5Status: item.step5Status || null,
          createdAt: item.createdAt || item.created_at || '',
          updatedAt: item.updatedAt || item.updated_at || '',
          size: item.size || 0,
        }));
        setProjects(mapped);
      }
    } catch (e: any) {
      console.error('获取项目列表失败', e);
    }
  }, []);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  /** 过滤后的项目列表（按名称搜索） */
  const filteredProjects = useMemo(() => {
    if (!searchText.trim()) return projects;
    const keyword = searchText.toLowerCase();
    return projects.filter(p => p.name.toLowerCase().includes(keyword));
  }, [projects, searchText]);

  /** 创建工程 */
  const createProject = useCallback(async (type: string) => {
    const traceId = FrontendLogger.generateTraceId();
    FrontendLogger.info('ProjectManager', 'Creating new project', traceId, { type });
    try {
      // 💥 不要传 name，让后端接管命名规则
      const result = await API.project.create({ type });
      FrontendLogger.info('ProjectManager', 'Project created successfully', traceId, { newId: result.id, name: result.name });
      return result.id;
    } catch (e: any) {
      FrontendLogger.error('ProjectManager', 'Create project failed', traceId, e.message);
      // 💥 重新抛出错误，让上层处理（可能是项目名称验证问题）
      throw e;
    }
  }, []);

  /**
   * 删除工程
   * @param id 工程 ID
   */
  const executeDeleteProject = useCallback(async (id: string) => {
    const traceId = FrontendLogger.generateTraceId();
    FrontendLogger.warn('ProjectManager', 'Executing project deletion', traceId, { projectId: id });
    try {
      await API.project.delete(id);
      FrontendLogger.info('ProjectManager', 'Project deleted successfully', traceId, { projectId: id });
      AppNotifier.success(t.home?.delete_success || '项目及本地文件已彻底删除');
      fetchProjects();
    } catch (e: any) {
      FrontendLogger.error('ProjectManager', 'Delete project failed', traceId, e.message);
      AppNotifier.error('SYS_IPC_FAILED', t.home?.delete_error || '删除失败，文件可能被占用');
    }
  }, [fetchProjects, t]);

  /**
   * 复制工程
   * @param id 工程 ID
   */
  const duplicateProject = useCallback(async (id: string) => {
    const traceId = FrontendLogger.generateTraceId();
    FrontendLogger.info('ProjectManager', 'Duplicating project', traceId, { projectId: id });
    try {
      await API.project.duplicate(id);
      FrontendLogger.info('ProjectManager', 'Project duplicated successfully', traceId);
      AppNotifier.success(t.home?.duplicate_success || '项目已复制');
      fetchProjects();
    } catch (e: any) {
      FrontendLogger.error('ProjectManager', 'Duplicate project failed', traceId, e.message);
      AppNotifier.error('SYS_IPC_FAILED', t.home?.duplicate_error || '项目复制失败');
    }
  }, [fetchProjects, t]);

  /**
   * 重命名工程
   * @param id 工程 ID
   * @param newName 新名称
   */
  const renameProject = useCallback(async (id: string, newName: string) => {
    const traceId = FrontendLogger.generateTraceId();
    FrontendLogger.info('ProjectManager', 'Renaming project', traceId, { projectId: id, newName });
    try {
      await API.project.rename(id, newName);
      FrontendLogger.info('ProjectManager', 'Project renamed successfully', traceId);
      AppNotifier.success(t.home?.rename_success || '重命名成功');
      fetchProjects();
    } catch (e: any) {
      FrontendLogger.error('ProjectManager', 'Rename project failed', traceId, e.message);
      // 💥 重新抛出错误，让 RenameModal 优雅处理并显示
      throw e;
    }
  }, [fetchProjects, t]);

  /**
   * 导入工程
   */
  const importProject = useCallback(async () => {
    const traceId = FrontendLogger.generateTraceId();
    FrontendLogger.info('ProjectManager', 'Importing project', traceId);
    try {
      const newId = await API.project.import();
      if (newId) {
        FrontendLogger.info('ProjectManager', 'Project imported successfully', traceId, { newId });
        AppNotifier.success('工程导入成功并已注册到数据库');
        fetchProjects(); 
      }
    } catch (e: any) {
      FrontendLogger.warn('ProjectManager', 'Import project aborted or failed', traceId, e.message);
      console.warn('导入终止或失败', e);
    }
  }, [fetchProjects]);

  return {
    filteredProjects,
    searchText,
    setSearchText,
    createProject,
    deleteProject: executeDeleteProject,
    duplicateProject,
    renameProject,
    importProject
  };
};
