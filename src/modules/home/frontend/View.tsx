// Home 模块 — 纯 View 组件（不访问 Store / API / Hooks）
import React from 'react';
import { Play, Search, LayoutGrid, List, FolderOpen, Upload } from 'lucide-react';
import type { ProjectRecord } from '../../types';
import { ProjectCard } from './components/ProjectCard';
import { RenameModal } from './components/RenameModal';
import { DeleteModal } from './components/DeleteModal';
import { ParticleEngine } from '../../../../renderer/src/components/ParticleEngine';

export interface HomeViewProps {
  filteredProjects: ProjectRecord[];
  searchText: string;
  onSearchChange: (text: string) => void;
  onCreateProject: () => void;
  onImportWorkflow: () => void;
  isImporting: boolean;
  onProjectClick: (id: string, type?: string) => void;
  onRenameClick: (proj: ProjectRecord) => void;
  onDuplicateProject: (id: string) => void;
  onDeleteClick: (id: string, name: string) => void;
  onExportClick: (id: string, name: string) => void;
  renameVisible: boolean;
  currentEditProj: ProjectRecord | null;
  onRenameClose: () => void;
  onRenameConfirm: (id: string, newName: string) => Promise<void> | void;
  deleteVisible: boolean;
  currentDeleteProj: { id: string; name: string } | null;
  onDeleteClose: () => void;
  onDeleteConfirm: (id: string) => void;
  viewMode: 'grid' | 'list';
  onViewModeChange: (mode: 'grid' | 'list') => void;
  searchOpen: boolean;
  onToggleSearch: () => void;
  formatDate: (dateStr: string) => string;
}

export const HomeView: React.FC<HomeViewProps> = ({
  filteredProjects, searchText, onSearchChange,
  onCreateProject, onImportWorkflow, isImporting,
  onProjectClick, onRenameClick, onDuplicateProject, onDeleteClick, onExportClick,
  renameVisible, currentEditProj, onRenameClose, onRenameConfirm,
  deleteVisible, currentDeleteProj, onDeleteClose, onDeleteConfirm,
  viewMode, onViewModeChange, searchOpen, onToggleSearch, formatDate,
}) => {
  return (
    <div className="flex flex-col h-full w-full bg-bg-primary text-foreground overflow-hidden relative [-webkit-app-region:no-drag]">
      <ParticleEngine className="w-full h-full" />

      <div className="flex-1 overflow-y-auto px-6 pt-4 pb-12">
        <div className="w-full">

          {/* Hero 开始创作卡片 */}
          <div className="glass-card p-6 flex items-center justify-between gap-10 mb-6 hover:border-accent/40 transition-colors">
            <div className="flex flex-col items-start gap-3.5 shrink-0">
              <div className="flex items-center gap-3">
                <button
                  onClick={onCreateProject}
                  className="h-[60px] px-9 rounded-2xl bg-gradient-to-r from-accent to-accent-rose text-white text-lg font-bold flex items-center gap-2.5 shadow-lg shadow-accent/20 hover:shadow-accent/30 hover:-translate-y-0.5 active:scale-[0.97] transition-all cursor-pointer outline-none relative overflow-hidden animate-button-pulse"
                >
                  <Play size={22} fill="currentColor" />
                  开始创作
                </button>
                <button
                  onClick={onImportWorkflow}
                  disabled={isImporting}
                  className="h-[60px] px-7 rounded-2xl border border-border/50 bg-bg-secondary/50 text-foreground text-sm font-semibold flex items-center gap-2 hover:border-accent/40 hover:bg-bg-secondary transition-all cursor-pointer outline-none disabled:opacity-50"
                  title="导入本地工作流文件（.json）"
                >
                  <Upload size={19} />
                  {isImporting ? '导入中...' : '导入工作流'}
                </button>
              </div>
              <span className="text-[13px] text-muted-foreground">点击创建新项目，进入创作工作台</span>
            </div>
            <div className="flex-1 text-right">
              <div className="text-[26px] font-extrabold leading-tight bg-gradient-to-r from-foreground via-accent to-accent-rose bg-clip-text text-transparent">
                用 AI，让创作更简单
              </div>
              <div className="text-[15px] text-muted-foreground mt-1.5 leading-relaxed">
                导入视频素材，AI 自动完成分析、编剧、配音、剪辑<br />你只需专注于创意决策
              </div>
            </div>
          </div>

          {/* 项目列表区 */}
          <div className="mt-2">
            <div className="flex items-center justify-between mb-4 gap-3">
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-lg font-bold">我的项目</span>
                <span className="text-[13px] text-muted-foreground font-normal">({filteredProjects.length})</span>
              </div>
              <div className="flex items-center gap-2.5 flex-1 justify-end">
                <div className="flex items-center gap-2">
                  <button
                    onClick={onToggleSearch}
                    className="w-[34px] h-[34px] rounded-[10px] flex items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer outline-none shrink-0"
                  >
                    <Search size={17} />
                  </button>
                  <div className={`overflow-hidden transition-all duration-250 ${searchOpen ? 'w-[240px] opacity-100' : 'w-0 opacity-0'}`}>
                    <div className="relative">
                      <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                      <input
                        value={searchText}
                        onChange={(e) => onSearchChange(e.target.value)}
                        placeholder="搜索项目..."
                        className="w-full text-[13px] py-[7px] pl-8 pr-3 rounded-[10px] bg-bg-secondary border border-border/50 text-foreground placeholder-muted-foreground outline-none focus:border-accent/40"
                        autoFocus={searchOpen}
                      />
                    </div>
                  </div>
                </div>

                <div className="flex gap-0.5 bg-bg-secondary rounded-[10px] p-[3px]">
                  <button
                    onClick={() => onViewModeChange('grid')}
                    className={`w-[30px] h-[28px] rounded-md flex items-center justify-center transition-colors cursor-pointer outline-none ${viewMode === 'grid' ? 'bg-white/5 text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                  >
                    <LayoutGrid size={15} />
                  </button>
                  <button
                    onClick={() => onViewModeChange('list')}
                    className={`w-[30px] h-[28px] rounded-md flex items-center justify-center transition-colors cursor-pointer outline-none ${viewMode === 'list' ? 'bg-white/5 text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                  >
                    <List size={15} />
                  </button>
                </div>
              </div>
            </div>

            {filteredProjects.length === 0 ? (
              <div className="text-center py-12">
                <div className="w-16 h-16 mx-auto mb-4 bg-bg-secondary rounded-full flex items-center justify-center">
                  <FolderOpen size={28} className="text-muted-foreground" />
                </div>
                <div className="text-base font-semibold text-muted-foreground mb-2">
                  {searchText ? '没有找到匹配的项目' : '还没有项目'}
                </div>
                <div className="text-sm text-muted-foreground leading-relaxed">
                  {searchText ? '试试其他关键词' : '点击上方「开始创作」按钮创建你的第一个项目'}
                </div>
              </div>
            ) : viewMode === 'grid' ? (
              <div className="grid grid-cols-5 gap-x-4 gap-y-8">
                {filteredProjects.map(proj => (
                  <ProjectCard
                    key={proj.id}
                    project={proj}
                    onClick={(id) => onProjectClick(id, proj.type)}
                    onRename={onRenameClick}
                    onDuplicate={onDuplicateProject}
                    onDelete={onDeleteClick}
                    onExport={onExportClick}
                  />
                ))}
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {filteredProjects.map(proj => (
                  <div
                    key={proj.id}
                    onClick={() => onProjectClick(proj.id, proj.type)}
                    className="flex items-center gap-4 px-4 py-3 glass-card-sm cursor-pointer hover:border-accent/40 hover:bg-muted/30 transition-all"
                  >
                    <div className="w-12 h-9 rounded-md bg-bg-tertiary flex items-center justify-center shrink-0">
                      <Play size={18} className="text-muted-foreground opacity-50" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{proj.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {proj.duration && `${proj.duration} · `}{formatDate(proj.createdAt || proj.updatedAt || '')}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <RenameModal visible={renameVisible} project={currentEditProj} onClose={onRenameClose} onConfirm={onRenameConfirm} />
      <DeleteModal visible={deleteVisible} projectId={currentDeleteProj?.id || null} projectName={currentDeleteProj?.name || ''} onClose={onDeleteClose} onConfirm={onDeleteConfirm} />
    </div>
  );
};
