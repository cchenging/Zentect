// 📁 路径: src/modules/shows/frontend/View.tsx
// 🎬 P2 优化 — 剧集管理视图组件（纯展示）
// 包含：剧集卡片网格 + 创建/编辑对话框 + 详情对话框（展示剧集下项目列表）

import React from 'react';
import { Film, Plus, Edit3, Trash2, X, Loader2, Check, Calendar, Layers } from 'lucide-react';
import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import { Textarea } from '@renderer/components/ui/textarea';
import { Skeleton } from '@renderer/components/ui/skeleton';

/** 剧集记录 */
interface ShowRecord {
  id: string;
  name: string;
  coverPath?: string;
  description?: string;
  episodeCount: number;
  createTime?: string;
  updateTime?: string;
}

/** 剧集下项目摘要 */
interface ShowProjectSummary {
  id: string;
  name: string;
  episodeNumber: number | null;
  coverPath: string | null;
  duration: string | null;
  status: string;
  updateTime: string;
}

/** 编辑模式 */
type EditMode = 'create' | 'edit';

/** ShowsView 属性 */
export interface ShowsViewProps {
  shows: ShowRecord[];
  loading: boolean;
  selected: ShowRecord | null;
  projects: ShowProjectSummary[];
  projectsLoading: boolean;
  editVisible: boolean;
  editMode: EditMode;
  editName: string;
  editDescription: string;
  saving: boolean;
  onSelect: (show: ShowRecord) => void;
  onClose: () => void;
  onOpenCreate: () => void;
  onOpenEdit: (show: ShowRecord) => void;
  onSave: () => void;
  onDelete: (show: ShowRecord) => void;
  onEditClose: () => void;
  onEditName: (v: string) => void;
  onEditDescription: (v: string) => void;
}

/**
 * 剧集管理视图
 * 卡片网格 + 创建/编辑/详情对话框
 */
export const ShowsView: React.FC<ShowsViewProps> = (props) => {
  const {
    shows, loading, selected, projects, projectsLoading,
    editVisible, editMode, editName, editDescription, saving,
    onSelect, onClose, onOpenCreate, onOpenEdit, onSave, onDelete,
    onEditClose, onEditName, onEditDescription,
  } = props;

  return (
    <div className="h-full overflow-y-auto bg-background">
      {/* 页面标题栏 */}
      <div className="sticky top-0 z-10 bg-background/80 backdrop-blur-sm border-b border-border/50 px-8 py-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Film size={22} className="text-accent" />
            <h1 className="text-lg font-semibold text-foreground">剧集管理</h1>
            <span className="text-sm text-muted-foreground">({shows.length})</span>
          </div>
          <Button size="sm" onClick={onOpenCreate} className="gap-1.5">
            <Plus size={14} />
            新建剧集
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mt-1.5 ml-9">
          组织跨集项目 — 创建剧集后，在项目卡片菜单中把项目关联到剧集，实现剧集级人物复用与统一管理
        </p>
      </div>

      {/* 内容区 */}
      <div className="px-8 py-6">
        {loading ? (
          <ShowGridSkeleton />
        ) : shows.length === 0 ? (
          <EmptyState onCreate={onOpenCreate} />
        ) : (
          <div className="grid grid-cols-4 gap-4">
            {shows.map((show) => (
              <ShowCard
                key={show.id}
                show={show}
                onClick={() => onSelect(show)}
                onEdit={() => onOpenEdit(show)}
                onDelete={() => onDelete(show)}
              />
            ))}
          </div>
        )}
      </div>

      {/* 编辑/创建对话框 */}
      {editVisible && (
        <EditDialog
          mode={editMode}
          name={editName}
          description={editDescription}
          saving={saving}
          onName={onEditName}
          onDescription={onEditDescription}
          onClose={onEditClose}
          onSave={onSave}
        />
      )}

      {/* 详情对话框 */}
      {selected && (
        <DetailDialog
          show={selected}
          projects={projects}
          projectsLoading={projectsLoading}
          onClose={onClose}
        />
      )}
    </div>
  );
};

/** 剧集卡片 */
const ShowCard: React.FC<{
  show: ShowRecord;
  onClick: () => void;
  onEdit: () => void;
  onDelete: () => void;
}> = ({ show, onClick, onEdit, onDelete }) => {
  return (
    <div
      onClick={onClick}
      className="group glass-card p-4 cursor-pointer hover:border-accent/40 transition-all [-webkit-app-region:no-drag]"
    >
      {/* 封面区 */}
      <div className="aspect-video rounded-lg bg-gradient-to-br from-accent/10 to-accent-purple/10 flex items-center justify-center mb-3 relative">
        <Film size={32} className="text-accent/40" />
        {/* 集数角标 */}
        <div className="absolute top-2 right-2 px-2 py-0.5 rounded-md bg-black/40 backdrop-blur-sm text-white text-[11px] font-medium">
          {show.episodeCount} 集
        </div>
      </div>

      {/* 信息区 */}
      <div className="space-y-1">
        <div className="text-sm font-semibold text-foreground truncate" title={show.name}>
          {show.name}
        </div>
        {show.description && (
          <div className="text-xs text-muted-foreground line-clamp-2">{show.description}</div>
        )}
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
          <Calendar size={11} />
          <span>{formatDate(show.updateTime || show.createTime || '')}</span>
        </div>
      </div>

      {/* 悬浮操作按钮 */}
      <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={onEdit}
          title="编辑"
          className="w-6 h-6 flex items-center justify-center bg-black/30 hover:bg-black/60 backdrop-blur-sm text-white rounded-md transition-colors"
        >
          <Edit3 size={12} />
        </button>
        <button
          onClick={onDelete}
          title="删除"
          className="w-6 h-6 flex items-center justify-center bg-black/30 hover:bg-red-500/80 backdrop-blur-sm text-white rounded-md transition-colors"
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
};

/** 创建/编辑对话框 */
const EditDialog: React.FC<{
  mode: EditMode;
  name: string;
  description: string;
  saving: boolean;
  onName: (v: string) => void;
  onDescription: (v: string) => void;
  onClose: () => void;
  onSave: () => void;
}> = ({ mode, name, description, saving, onName, onDescription, onClose, onSave }) => {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-[420px] bg-card rounded-2xl border border-border/50 shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/50">
          <div className="flex items-center gap-2">
            <Film size={16} className="text-accent" />
            <h2 className="text-sm font-semibold text-foreground">
              {mode === 'create' ? '新建剧集' : '编辑剧集'}
            </h2>
          </div>
          <button onClick={onClose} className="w-6 h-6 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
            <X size={14} />
          </button>
        </div>

        {/* 内容 */}
        <div className="flex-1 p-5 space-y-4">
          <div>
            <label className="text-xs text-muted-foreground mb-1.5 block">剧集名称 *</label>
            <Input
              value={name}
              onChange={(e) => onName(e.target.value)}
              placeholder="如：我的短剧第一季"
              autoFocus
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1.5 block">描述（可选）</label>
            <Textarea
              value={description}
              onChange={(e) => onDescription(e.target.value)}
              placeholder="剧集简介、题材、风格等"
              rows={3}
            />
          </div>
        </div>

        {/* 底部按钮 */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border/50">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>取消</Button>
          <Button size="sm" onClick={onSave} disabled={saving || !name.trim()}>
            {saving ? <Loader2 size={13} className="mr-1.5 animate-spin" /> : <Check size={13} className="mr-1.5" />}
            {mode === 'create' ? '创建' : '保存'}
          </Button>
        </div>
      </div>
    </div>
  );
};

/** 详情对话框（展示剧集下项目列表） */
const DetailDialog: React.FC<{
  show: ShowRecord;
  projects: ShowProjectSummary[];
  projectsLoading: boolean;
  onClose: () => void;
}> = ({ show, projects, projectsLoading, onClose }) => {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-[560px] max-h-[80vh] bg-card rounded-2xl border border-border/50 shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/50">
          <div className="flex items-center gap-2.5 min-w-0">
            <Film size={16} className="text-accent shrink-0" />
            <h2 className="text-sm font-semibold text-foreground truncate">{show.name}</h2>
            <span className="text-xs text-muted-foreground shrink-0">({show.episodeCount} 集)</span>
          </div>
          <button onClick={onClose} className="w-6 h-6 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0">
            <X size={14} />
          </button>
        </div>

        {/* 描述 */}
        {show.description && (
          <div className="px-5 py-3 border-b border-border/50 bg-muted/20">
            <p className="text-xs text-muted-foreground leading-relaxed">{show.description}</p>
          </div>
        )}

        {/* 项目列表 */}
        <div className="flex-1 overflow-y-auto p-5">
          <div className="flex items-center gap-2 mb-3">
            <Layers size={14} className="text-muted-foreground" />
            <span className="text-xs font-medium text-foreground">剧集下项目</span>
            <span className="text-xs text-muted-foreground">({projects.length})</span>
          </div>

          {projectsLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={20} className="animate-spin text-muted-foreground" />
            </div>
          ) : projects.length === 0 ? (
            <div className="text-center py-8 text-sm text-muted-foreground">
              暂无关联项目，请在首页项目卡片菜单中选择「关联剧集」
            </div>
          ) : (
            <div className="space-y-1.5">
              {projects.map((proj) => (
                <div
                  key={proj.id}
                  className="flex items-center gap-3 p-2.5 rounded-lg border border-border/40 hover:bg-muted/30 transition-colors"
                >
                  {/* 集数徽章 */}
                  <div className="w-8 h-8 rounded-md bg-accent/10 flex items-center justify-center shrink-0">
                    <span className="text-xs font-semibold text-accent">
                      {proj.episodeNumber ?? '?'}
                    </span>
                  </div>
                  {/* 项目信息 */}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-foreground truncate">{proj.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {proj.duration && `${proj.duration} · `}更新于 {formatDate(proj.updateTime)}
                    </div>
                  </div>
                  {/* 状态标签 */}
                  <span className="text-[11px] text-muted-foreground/70 shrink-0">{proj.status}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

/** 空状态 */
const EmptyState: React.FC<{ onCreate: () => void }> = ({ onCreate }) => (
  <div className="text-center py-16">
    <div className="w-16 h-16 mx-auto mb-4 bg-bg-secondary rounded-full flex items-center justify-center">
      <Film size={28} className="text-muted-foreground" />
    </div>
    <div className="text-base font-semibold text-muted-foreground mb-2">还没有剧集</div>
    <div className="text-sm text-muted-foreground leading-relaxed mb-4">
      创建剧集后，可以把多个项目组织到同一剧集下<br />
      实现跨集人物复用与统一管理
    </div>
    <Button size="sm" onClick={onCreate} className="gap-1.5">
      <Plus size={14} />
      创建第一个剧集
    </Button>
  </div>
);

/** 卡片网格骨架屏 */
const ShowGridSkeleton: React.FC = () => (
  <div className="grid grid-cols-4 gap-4">
    {Array.from({ length: 4 }).map((_, i) => (
      <div key={i} className="glass-card p-4">
        <Skeleton className="aspect-video rounded-lg mb-3" />
        <Skeleton className="h-3.5 w-3/4 mb-2" />
        <Skeleton className="h-2.5 w-1/2" />
      </div>
    ))}
  </div>
);

/** 日期格式化（与首页保持一致） */
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
