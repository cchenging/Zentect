// 📁 路径: src/renderer/src/pages/editor/components/top-bar/index.tsx
// 编辑器顶部工具栏 - V3 原型对齐
// Logo + 项目名(可编辑) + 保存状态 + 导出按钮 + 设置按钮 + 窗口控制
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Settings as SettingsIcon, Loader2 } from 'lucide-react';
import { useEditorStore } from '../../../../store/useStore';
import { useI18n } from '../../../../store/useI18n';
import { WindowControls } from '../../../../components/window-controls';
import { ExportModal } from './components/ExportModal';

/** 保存状态指示器 */
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

/**
 * 编辑器顶部工具栏
 * V3 原型对齐：Logo(返回首页) + 可编辑项目名 + 保存状态 + 导出 + 设置 + 窗口控制
 */
export const TopBar: React.FC = React.memo(() => {
  const navigate = useNavigate();
  const { t } = useI18n();
  const projectName = useEditorStore((s) => s.projectName) || t.editor?.unnamed_project || '未命名项目';
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(projectName);

  /** 开始编辑项目名 */
  const startEditing = () => {
    setEditValue(projectName);
    setIsEditing(true);
  };

  /** 确认编辑 */
  const confirmEdit = () => {
    // TODO: 调用 API 更新项目名
    setIsEditing(false);
  };

  return (
    <>
      <header className="h-[52px] w-full bg-bg-primary border-b border-border/50 flex items-center justify-between px-3 shrink-0 select-none relative z-40 [-webkit-app-region:drag]">
        {/* 左侧：Logo(返回) + 项目名 + 保存状态 */}
        <div className="flex items-center gap-3 [-webkit-app-region:no-drag]">
          {/* Logo 返回首页 */}
          <button
            onClick={() => navigate('/')}
            className="w-7 h-7 rounded-lg bg-gradient-to-br from-accent to-accent-purple flex items-center justify-center text-white font-bold text-[11px] shrink-0 hover:brightness-110 transition-all cursor-pointer outline-none shadow-sm shadow-accent/20"
            title="返回首页"
          >
            Z
          </button>

          {/* 项目名（可编辑） */}
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

        {/* 右侧：导出 + 设置 + 窗口控制 */}
        <div className="flex items-center gap-2 [-webkit-app-region:no-drag]">
          {/* 导出按钮 */}
          <ExportModal />

          {/* 设置按钮 */}
          <button
            onClick={() => navigate('/settings')}
            className="h-8 w-8 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted rounded-lg transition-colors cursor-pointer outline-none"
            title={t.nav?.settings || '设置'}
          >
            <SettingsIcon size={16} />
          </button>

          <div className="w-px h-4 bg-border/50 mx-0.5" />

          {/* 窗口控制 */}
          <WindowControls
            btnClassName="h-[30px] w-[46px] flex items-center justify-center bg-transparent border-none rounded-md transition-colors cursor-pointer outline-none text-muted-foreground"
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
