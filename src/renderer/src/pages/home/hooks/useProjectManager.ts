// 📁 路径：src/renderer/src/pages/Home/hooks/useProjectManager.ts
import { useState, useEffect, useMemo, useCallback } from 'react';
import { useI18n } from '../../../store/useI18n';
import { API } from '../../../api'; 
import { AppNotifier } from '../../../core/AppNotifier';
import type { ProjectRecord } from '../types';
// 💥 注入：引入全局大一统日志
import { FrontendLogger } from '../../../utils/logger';

/**
 * 工程管理器 Hook
 * 负责工程列表的管理、创建、删除、重命名等操作
 */
export const useProjectManager = () => {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [searchText, setSearchText] = useState('');
  const { t } = useI18n();

  /**
   * 加载工程列表
   */
  const fetchProjects = useCallback(async () => {
    const traceId = FrontendLogger.generateTraceId();
    FrontendLogger.info('ProjectManager', 'Fetching projects from database', traceId);
    try {
      const list = await API.project.getList();
      setProjects(list || []);
      FrontendLogger.info('ProjectManager', 'Projects fetched successfully', traceId, { count: list?.length });
    } catch (e: any) {
      FrontendLogger.error('ProjectManager', 'Fetch projects failed', traceId, e.message);
      AppNotifier.error('SYS_IPC_FAILED', t.home?.fetch_failed || '读取工程列表失败，请检查底层引擎连接');
    }
  }, [t]);

  useEffect(() => { fetchProjects(); }, [fetchProjects]);

  /**
   * 根据搜索文本过滤工程列表
   */
  const filteredProjects = useMemo(() => {
    if (!searchText) return projects;
    return projects.filter(p => p.name.toLowerCase().includes(searchText.toLowerCase()));
  }, [projects, searchText]);

  /**
   * 创建新工程
   * @param type 工程类型 (video/workflow)
   * @returns 新工程 ID
   */
  const createProject = async (type: string = 'video'): Promise<string | null> => {
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
  };

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
