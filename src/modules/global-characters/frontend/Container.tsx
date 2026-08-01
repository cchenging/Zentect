// 📁 路径: src/modules/global-characters/frontend/Container.tsx
// 🎬 P3 全局人物档案 — 容器组件（状态管理 + API 调用）
// 集成 P3-2（列表展示）+ P3-1（确认/纠正回写）

import React, { useState, useCallback, useEffect } from 'react';
import { GlobalCharactersView } from './View';
import { API } from '@renderer/api';
import { AppNotifier } from '@renderer/core/AppNotifier';
import { FrontendLogger } from '@renderer/utils/logger';
import type { GlobalCharacter } from '../../../shared/types/entities/editor';

/** 详情对话框中关联的本地角色记录 */
interface LocalRoleRow {
  id: string;
  name: string;
  project_id: string;
  avatar: string | null;
  pronoun: string;
  description: string | null;
  voice_id: string | null;
  global_character_id: string | null;
}

/**
 * 全局人物档案容器组件
 * 职责：拉取列表、管理选中态、编辑/删除/解绑回调
 */
export const GlobalCharactersContainer: React.FC = () => {
  const [characters, setCharacters] = useState<GlobalCharacter[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<GlobalCharacter | null>(null);
  const [localRoles, setLocalRoles] = useState<LocalRoleRow[]>([]);
  const [localRolesLoading, setLocalRolesLoading] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editPronoun, setEditPronoun] = useState('');
  const [editVoiceId, setEditVoiceId] = useState('');
  const [saving, setSaving] = useState(false);

  /** 拉取全局人物列表 */
  const refreshList = useCallback(async () => {
    try {
      const list = await API.globalCharacters.list();
      setCharacters(Array.isArray(list) ? list : []);
    } catch (e: any) {
      FrontendLogger.error('GlobalCharacters', '加载列表失败', '', e.message);
      AppNotifier.error('加载全局人物列表失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshList();
  }, [refreshList]);

  /** 点击某全局人物 → 打开详情对话框，加载关联本地角色 */
  const handleSelect = useCallback(async (char: GlobalCharacter) => {
    setSelected(char);
    setEditName(char.name || '');
    setEditDescription(char.description || '');
    setEditPronoun(char.pronoun || '');
    setEditVoiceId(char.voiceId || '');
    setLocalRoles([]);

    // 加载关联的本地角色（跨项目）
    setLocalRolesLoading(true);
    try {
      const roles = await API.globalCharacters.findLocalRoles(char.id);
      setLocalRoles(Array.isArray(roles) ? roles : []);
    } catch (e: any) {
      FrontendLogger.warn('GlobalCharacters', '加载关联角色失败', '', e.message);
    } finally {
      setLocalRolesLoading(false);
    }
  }, []);

  /** P3-1 保存编辑（确认/纠正全局人物信息） */
  const handleSave = useCallback(async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await API.globalCharacters.update(selected.id, {
        name: editName,
        description: editDescription,
        pronoun: editPronoun,
        voiceId: editVoiceId,
      });
      AppNotifier.success('全局人物信息已更新');
      // 刷新列表 + 更新选中态
      await refreshList();
      setSelected((prev) => prev ? {
        ...prev,
        name: editName,
        description: editDescription,
        pronoun: editPronoun,
        voiceId: editVoiceId,
      } : prev);
    } catch (e: any) {
      AppNotifier.error('保存失败: ' + e.message);
    } finally {
      setSaving(false);
    }
  }, [selected, editName, editDescription, editPronoun, editVoiceId, refreshList]);

  /** P3-1 解绑错误的本地角色关联（纠正匹配错误） */
  const handleUnbindRole = useCallback(async (roleId: string) => {
    try {
      await API.globalCharacters.unbind(roleId);
      setLocalRoles((prev) => prev.filter((r) => r.id !== roleId));
      AppNotifier.success('已解除关联');
    } catch (e: any) {
      AppNotifier.error('解绑失败: ' + e.message);
    }
  }, []);

  /** 删除全局人物（同时解绑所有本地角色） */
  const handleDelete = useCallback(async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const result = await API.globalCharacters.delete(selected.id);
      AppNotifier.success(`已删除全局人物（解除 ${result.unbindCount} 个角色关联）`);
      setSelected(null);
      await refreshList();
    } catch (e: any) {
      AppNotifier.error('删除失败: ' + e.message);
    } finally {
      setSaving(false);
    }
  }, [selected, refreshList]);

  /** 关闭详情对话框 */
  const handleClose = useCallback(() => {
    setSelected(null);
    setLocalRoles([]);
  }, []);

  return (
    <GlobalCharactersView
      characters={characters}
      loading={loading}
      selected={selected}
      localRoles={localRoles}
      localRolesLoading={localRolesLoading}
      editName={editName}
      editDescription={editDescription}
      editPronoun={editPronoun}
      editVoiceId={editVoiceId}
      saving={saving}
      onSelect={handleSelect}
      onClose={handleClose}
      onSave={handleSave}
      onUnbindRole={handleUnbindRole}
      onDelete={handleDelete}
      onEditName={setEditName}
      onEditDescription={setEditDescription}
      onEditPronoun={setEditPronoun}
      onEditVoiceId={setEditVoiceId}
    />
  );
};
