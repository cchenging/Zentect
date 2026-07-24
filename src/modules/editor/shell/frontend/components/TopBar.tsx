// Module: editor/shell/frontend/components/TopBar
// 原 editor/components/top-bar/index.tsx — 已迁移

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Settings as SettingsIcon, Loader2 } from 'lucide-react';
import { useEditorStore } from '@renderer/store/useStore';
import { useProjectStore } from '@modules/editor/stores/useProjectStore';
import { useI18n } from '@renderer/store/useI18n';
import { WindowControls } from '@renderer/components/window-controls';
import { ExportModal } from './ExportModal';
import { API } from '@renderer/api';
import { AppNotifier } from '@renderer/core/AppNotifier';

const SaveStatus: React.FC = () => {
  const saveStatus = useEditorStore((s) => s.saveStatus);
  const lastSavedTime = useEditorStore((s) => s.lastSavedTime);

  if (saveStatus !== 'saving' && saveStatus !== 'saved') return null;

  return (
    <div className="flex items-center gap-1.5 [-webkit-app-region:no-drag]">
      {saveStatus === 'saving' && <Loader2 size={12} className="animate-spin text-accent" />}
      {saveStatus === 'saved' && <div className="w-1.5 h-1.5 rounded-full bg-accent-green" />}
      <span className="text-[11px] text-muted-foreground">
        {saveStatus === 'saving' ? '保存中...' : `已保存${lastSavedTime ? ` ${lastSavedTime}` : ''}`}
      </span>
    </div>
  );
};

export const TopBar: React.FC = React.memo(() => {
  const navigate = useNavigate();
  const { t } = useI18n();
  const projectName = useProjectStore((s) => s.projectName) || t.editor?.unnamed_project || '未命名项目';
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(projectName);

  const startEditing = () => {
    setEditValue(projectName);
    setIsEditing(true);
  };

  const confirmEdit = async () => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== projectName) {
      const projectId = useProjectStore.getState().projectId;
      if (projectId) {
        try {
          await API.project.rename(projectId, trimmed);
          useProjectStore.getState().setProjectMeta(projectId, trimmed);
        } catch (err: any) {
          AppNotifier.error(`项目名更新失败: ${err.message || '未知错误'}`);
        }
      }
    }
    setIsEditing(false);
  };

  return (
    <>
      <header className="h-[40px] w-full bg-bg-primary border-b border-border/50 flex items-center justify-between pl-3 pr-1 shrink-0 select-none relative z-40 [-webkit-app-region:drag]">
        <div className="flex items-center gap-3 [-webkit-app-region:no-drag]">
          <button
            onClick={() => navigate('/')}
            className="w-7 h-7 rounded-lg bg-gradient-to-br from-accent to-accent-purple flex items-center justify-center text-white font-bold text-[11px] shrink-0 hover:brightness-110 transition-all cursor-pointer outline-none shadow-sm shadow-accent/20"
            title="返回首页"
          >
            Z
          </button>

          {isEditing ? (
            <input
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={confirmEdit}
              onKeyDown={(e) => { if (e.key === 'Enter') confirmEdit(); if (e.key === 'Escape') setIsEditing(false); }}
              className="w-[200px] h-7 px-2 rounded-md bg-bg-secondary border border-accent/40 text-[14px] font-semibold text-foreground outline-none"
              autoFocus
            />
          ) : (
            <button
              onClick={startEditing}
              className="text-[14px] font-semibold text-foreground hover:text-accent transition-colors cursor-pointer outline-none max-w-[200px] truncate"
            >
              {projectName}
            </button>
          )}

          <SaveStatus />
        </div>

        <div className="flex items-center gap-0.5 [-webkit-app-region:no-drag]">
          <ExportModal />

          <button
            onClick={() => navigate('/settings')}
            className="w-[30px] h-[30px] flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors cursor-pointer outline-none"
            title={t.nav?.settings || '设置'}
          >
            <SettingsIcon size={16} />
          </button>

          <div className="w-[1px] h-3 bg-border mx-1" />

          <WindowControls
            hoverBgClassName="hover:bg-muted hover:text-foreground"
            closeHoverBgClassName="hover:bg-accent-rose hover:text-white"
            onClose={() => navigate('/')}
            closeTitle="返回首页"
          />
        </div>
      </header>
    </>
  );
});

TopBar.displayName = 'TopBar';
