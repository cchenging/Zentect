// Home 模块 — Container 组件（持有状态/Hooks，传 Props 给 View）
import React, { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { HomeView } from './View';
import { useProjectManager } from './hooks/useProjectManager';
import { useWorkflowImport } from './hooks/useWorkflowImport';
import type { ProjectRecord } from '../types';
import { API } from '../../../../renderer/src/api';
import { FrontendLogger } from '../../../../renderer/src/utils/logger';
import { AppNotifier } from '../../../../renderer/src/core/AppNotifier';

export const HomeContainer: React.FC = () => {
  const navigate = useNavigate();

  const {
    filteredProjects, searchText, setSearchText,
    createProject, deleteProject, renameProject, duplicateProject
  } = useProjectManager();

  const { importWorkflow, isImporting } = useWorkflowImport();

  const [renameVisible, setRenameVisible] = useState(false);
  const [currentEditProj, setCurrentEditProj] = useState<ProjectRecord | null>(null);
  const [deleteVisible, setDeleteVisible] = useState(false);
  const [currentDeleteProj, setCurrentDeleteProj] = useState<{ id: string; name: string } | null>(null);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    API.system.switchView('home');
    API.system.resizeWindow(1280, 800).catch(console.error);
  }, []);

  const handleCreateProject = useCallback(async () => {
    const traceId = FrontendLogger.generateTraceId();
    FrontendLogger.info('HomeManager', 'User requested to create project', traceId);
    try {
      const newId = await createProject('video');
      if (newId) navigate(`/editor/${newId}`);
    } catch (error: any) {
      FrontendLogger.error('HomeManager', 'Failed to create project', traceId, error.message);
    }
  }, [createProject, navigate]);

  const handleProjectClick = useCallback((id: string, _type?: string) => {
    navigate(`/editor/${id}`);
  }, [navigate]);

  const handleRenameConfirm = useCallback(async (id: string, newName: string) => {
    await renameProject(id, newName);
    setRenameVisible(false);
  }, [renameProject]);

  const handleDeleteConfirm = useCallback((id: string) => {
    deleteProject(id);
    setDeleteVisible(false);
  }, [deleteProject]);

  const handleRenameClick = useCallback((proj: ProjectRecord) => {
    setCurrentEditProj(proj);
    setRenameVisible(true);
  }, []);

  const handleDeleteClick = useCallback((id: string, name: string) => {
    setCurrentDeleteProj({ id, name });
    setDeleteVisible(true);
  }, []);

  const handleExportClick = useCallback(async (id: string, name: string) => {
    try {
      const filePath = await API.project.exportProject(id);
      AppNotifier.success(`项目「${name}」已导出备份`);
      FrontendLogger.info('HomeManager', `Project exported: ${name}`, '', { filePath });
    } catch (err: any) {
      AppNotifier.error(err.message || '导出失败');
    }
  }, []);

  const toggleSearch = () => {
    setSearchOpen(prev => !prev);
    if (searchOpen) setSearchText('');
  };

  const formatDate = (dateStr: string) => {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (diffDays === 0) return '今天';
    if (diffDays === 1) return '昨天';
    if (diffDays < 7) return `${diffDays} 天前`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)} 周前`;
    return `${Math.floor(diffDays / 30)} 个月前`;
  };

  return (
    <HomeView
      filteredProjects={filteredProjects}
      searchText={searchText}
      onSearchChange={setSearchText}
      onCreateProject={handleCreateProject}
      onImportWorkflow={importWorkflow}
      isImporting={isImporting}
      onProjectClick={handleProjectClick}
      onRenameClick={handleRenameClick}
      onDuplicateProject={duplicateProject}
      onDeleteClick={handleDeleteClick}
      onExportClick={handleExportClick}
      renameVisible={renameVisible}
      currentEditProj={currentEditProj}
      onRenameClose={() => setRenameVisible(false)}
      onRenameConfirm={handleRenameConfirm}
      deleteVisible={deleteVisible}
      currentDeleteProj={currentDeleteProj}
      onDeleteClose={() => setDeleteVisible(false)}
      onDeleteConfirm={handleDeleteConfirm}
      viewMode={viewMode}
      onViewModeChange={setViewMode}
      searchOpen={searchOpen}
      onToggleSearch={toggleSearch}
      formatDate={formatDate}
    />
  );
};
