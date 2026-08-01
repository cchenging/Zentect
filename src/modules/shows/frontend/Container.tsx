// 📁 路径: src/modules/shows/frontend/Container.tsx
// 🎬 P2 优化 — 剧集管理容器组件（状态管理 + API 调用）
// 职责：拉取剧集列表、创建/编辑/删除、加载剧集下项目摘要

import React, { useState, useCallback, useEffect } from 'react';
import { ShowsView } from './View';
import { API } from '@renderer/api';
import { AppNotifier } from '@renderer/core/AppNotifier';
import { FrontendLogger } from '@renderer/utils/logger';

/** 剧集记录（与后端 Show 接口对齐） */
interface ShowRecord {
  id: string;
  name: string;
  coverPath?: string;
  description?: string;
  episodeCount: number;
  createTime?: string;
  updateTime?: string;
}

/** 剧集下项目摘要（轻量结构，用于详情对话框） */
interface ShowProjectSummary {
  id: string;
  name: string;
  episodeNumber: number | null;
  coverPath: string | null;
  duration: string | null;
  status: string;
  updateTime: string;
}

/** 编辑对话框模式 */
type EditMode = 'create' | 'edit';

/**
 * 剧集管理容器组件
 * 管理剧集列表状态 + CRUD 操作 + 详情对话框数据
 */
export const ShowsContainer: React.FC = () => {
  const [shows, setShows] = useState<ShowRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<ShowRecord | null>(null);
  const [projects, setProjects] = useState<ShowProjectSummary[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [editVisible, setEditVisible] = useState(false);
  const [editMode, setEditMode] = useState<EditMode>('create');
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [saving, setSaving] = useState(false);

  /** 拉取剧集列表 */
  const refreshList = useCallback(async () => {
    try {
      const list = await API.shows.list();
      setShows(Array.isArray(list) ? list : []);
    } catch (e: any) {
      FrontendLogger.error('Shows', '加载剧集列表失败', '', e.message);
      AppNotifier.error('加载剧集列表失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshList();
  }, [refreshList]);

  /** 打开创建对话框 */
  const handleOpenCreate = useCallback(() => {
    setEditMode('create');
    setEditName('');
    setEditDescription('');
    setEditVisible(true);
  }, []);

  /** 打开编辑对话框 */
  const handleOpenEdit = useCallback((show: ShowRecord) => {
    setEditMode('edit');
    setEditName(show.name);
    setEditDescription(show.description || '');
    setEditVisible(true);
  }, []);

  /** 保存创建/编辑 */
  const handleSave = useCallback(async () => {
    if (!editName.trim()) {
      AppNotifier.warn('请输入剧集名称');
      return;
    }
    setSaving(true);
    try {
      if (editMode === 'create') {
        await API.shows.create(editName.trim(), { description: editDescription.trim() || undefined });
        AppNotifier.success('剧集已创建');
      } else if (selected) {
        await API.shows.update(selected.id, { name: editName.trim(), description: editDescription.trim() || undefined });
        AppNotifier.success('剧集已更新');
      }
      setEditVisible(false);
      await refreshList();
    } catch (e: any) {
      AppNotifier.error('保存失败: ' + e.message);
    } finally {
      setSaving(false);
    }
  }, [editMode, editName, editDescription, selected, refreshList]);

  /** 删除剧集 */
  const handleDelete = useCallback(async (show: ShowRecord) => {
    if (!confirm(`确定删除剧集「${show.name}」吗？\n该剧集下 ${show.episodeCount} 个项目将解除关联（项目本身不删除）。`)) {
      return;
    }
    try {
      const result = await API.shows.delete(show.id);
      AppNotifier.success(`已删除剧集（解除 ${result.unbindCount} 个项目关联）`);
      if (selected?.id === show.id) {
        setSelected(null);
        setProjects([]);
      }
      await refreshList();
    } catch (e: any) {
      AppNotifier.error('删除失败: ' + e.message);
    }
  }, [selected, refreshList]);

  /** 点击剧集卡片 → 打开详情对话框，加载剧集下项目 */
  const handleSelect = useCallback(async (show: ShowRecord) => {
    setSelected(show);
    setProjects([]);
    setProjectsLoading(true);
    try {
      const list = await API.shows.findProjects(show.id);
      setProjects(Array.isArray(list) ? list : []);
    } catch (e: any) {
      FrontendLogger.warn('Shows', '加载剧集项目失败', '', e.message);
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  /** 关闭详情对话框 */
  const handleClose = useCallback(() => {
    setSelected(null);
    setProjects([]);
  }, []);

  /** 关闭编辑对话框 */
  const handleEditClose = useCallback(() => {
    setEditVisible(false);
  }, []);

  return (
    <ShowsView
      shows={shows}
      loading={loading}
      selected={selected}
      projects={projects}
      projectsLoading={projectsLoading}
      editVisible={editVisible}
      editMode={editMode}
      editName={editName}
      editDescription={editDescription}
      saving={saving}
      onSelect={handleSelect}
      onClose={handleClose}
      onOpenCreate={handleOpenCreate}
      onOpenEdit={handleOpenEdit}
      onSave={handleSave}
      onDelete={handleDelete}
      onEditClose={handleEditClose}
      onEditName={setEditName}
      onEditDescription={setEditDescription}
    />
  );
};
