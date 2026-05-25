// 📁 路径：src/renderer/src/pages/Home/index.tsx
// 首页 - V3 设计系统风格，对齐原型
import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Play, Search, LayoutGrid, List, FolderOpen } from 'lucide-react';
import { useProjectManager } from './hooks/useProjectManager';
import type { ProjectRecord } from './types';
import { RenameModal } from './components/RenameModal';
import { DeleteModal } from './components/DeleteModal';
import { API } from '../../api';
import { FrontendLogger } from '../../utils/logger';

export const Home: React.FC = () => {
  const navigate = useNavigate();

  const {
    filteredProjects, searchText, setSearchText,
    createProject, deleteProject, renameProject
  } = useProjectManager();

  const [renameVisible, setRenameVisible] = useState(false);
  const [currentEditProj, _setCurrentEditProj] = useState<ProjectRecord | null>(null);
  const [deleteVisible, setDeleteVisible] = useState(false);
  const [currentDeleteProj, _setCurrentDeleteProj] = useState<{ id: string; name: string } | null>(null);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    API.system.switchView('home');
    API.system.resizeWindow(1440, 900).catch(console.error);
  }, []);

  /** 创建新项目 */
  const handleCreateProject = async (typeCode: string = 'Auto') => {
    const traceId = FrontendLogger.generateTraceId();
    FrontendLogger.info('HomeManager', `User requested to create project`, traceId, { type: typeCode });
    const now = new Date();
    const smartName = `MO_${typeCode}_${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    try {
      const newId = await createProject(smartName);
      if (newId) navigate(`/editor/${newId}`);
    } catch (error: any) {
      FrontendLogger.error('HomeManager', `Failed to create project`, traceId, error.message);
    }
  };

  const handleProjectClick = useCallback((id: string) => navigate(`/editor/${id}`), [navigate]);
  const handleRenameConfirm = useCallback(async (id: string, newName: string) => { await renameProject(id, newName); }, [renameProject]);
  const handleDeleteConfirm = useCallback((id: string) => { deleteProject(id); setDeleteVisible(false); }, [deleteProject]);

  /** 切换搜索框 */
  const toggleSearch = () => {
    setSearchOpen(prev => !prev);
    if (searchOpen) setSearchText('');
  };

  /** 格式化日期 */
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
    <div className="flex flex-col h-full w-full bg-bg-primary text-foreground overflow-hidden [-webkit-app-region:no-drag]">

      <div className="flex-1 overflow-y-auto px-8 pt-8 pb-12">
        <div className="max-w-[996px]">

          {/* ===== Hero 开始创作卡片 ===== */}
          <div className="glass-card p-8 flex items-center justify-between gap-10 mb-8 hover:border-accent/40 transition-colors">
            <div className="flex flex-col items-start gap-3.5 shrink-0">
              <button
                onClick={() => handleCreateProject('Auto')}
                className="h-[60px] px-9 rounded-2xl bg-gradient-to-r from-accent to-accent-rose text-white text-lg font-bold flex items-center gap-2.5 shadow-lg shadow-accent/20 hover:shadow-accent/30 hover:-translate-y-0.5 active:scale-[0.97] transition-all cursor-pointer outline-none relative overflow-hidden"
              >
                <Play size={22} fill="currentColor" />
                开始创作
              </button>
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

          {/* ===== 项目列表区 ===== */}
          <div className="mt-2">
            {/* 标题行 */}
            <div className="flex items-center justify-between mb-4 gap-3">
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-lg font-bold">我的项目</span>
                <span className="text-[13px] text-muted-foreground font-normal">({filteredProjects.length})</span>
              </div>
              <div className="flex items-center gap-2.5 flex-1 justify-end">
                {/* 折叠搜索 */}
                <div className="flex items-center gap-2">
                  <button
                    onClick={toggleSearch}
                    className="w-[34px] h-[34px] rounded-[10px] flex items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer outline-none shrink-0"
                  >
                    <Search size={17} />
                  </button>
                  <div className={`overflow-hidden transition-all duration-250 ${searchOpen ? 'w-[240px] opacity-100' : 'w-0 opacity-0'}`}>
                    <div className="relative">
                      <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                      <input
                        value={searchText}
                        onChange={(e) => setSearchText(e.target.value)}
                        placeholder="搜索项目..."
                        className="w-full text-[13px] py-[7px] pl-8 pr-3 rounded-[10px] bg-bg-secondary border border-border/50 text-foreground placeholder-muted-foreground outline-none focus:border-accent/40"
                        autoFocus={searchOpen}
                      />
                    </div>
                  </div>
                </div>

                {/* 视图切换 */}
                <div className="flex gap-0.5 bg-bg-secondary rounded-[10px] p-[3px]">
                  <button
                    onClick={() => setViewMode('grid')}
                    className={`w-[30px] h-[28px] rounded-md flex items-center justify-center transition-colors cursor-pointer outline-none ${viewMode === 'grid' ? 'bg-white/5 text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                  >
                    <LayoutGrid size={15} />
                  </button>
                  <button
                    onClick={() => setViewMode('list')}
                    className={`w-[30px] h-[28px] rounded-md flex items-center justify-center transition-colors cursor-pointer outline-none ${viewMode === 'list' ? 'bg-white/5 text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                  >
                    <List size={15} />
                  </button>
                </div>
              </div>
            </div>

            {/* 项目内容 */}
            {filteredProjects.length === 0 ? (
              /* 空状态 */
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
              /* 网格视图 - 5列 */
              <div className="grid grid-cols-5 gap-4">
                {filteredProjects.map(proj => (
                  <div
                    key={proj.id}
                    onClick={() => handleProjectClick(proj.id)}
                    className="glass-card-sm overflow-hidden cursor-pointer hover:border-accent/40 hover:-translate-y-[3px] hover:shadow-lg hover:shadow-accent/10 transition-all group"
                  >
                    {/* 封面 */}
                    <div className="w-full aspect-video bg-bg-tertiary flex items-center justify-center relative overflow-hidden">
                      {proj.coverPath ? (
                        <img src={`atom://${proj.coverPath}`} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <Play size={36} className="text-muted-foreground opacity-40" />
                      )}
                      {proj.duration && (
                        <span className="absolute bottom-2 right-2 px-2 py-0.5 rounded bg-black/70 text-[11px] font-medium text-white">
                          {proj.duration}
                        </span>
                      )}
                    </div>
                    {/* 元信息 */}
                    <div className="px-3.5 py-3">
                      <div className="text-sm font-semibold truncate">{proj.name}</div>
                      <div className="text-xs text-muted-foreground mt-1">{formatDate(proj.createdAt || proj.updatedAt || '')}</div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              /* 列表视图 */
              <div className="flex flex-col gap-2">
                {filteredProjects.map(proj => (
                  <div
                    key={proj.id}
                    onClick={() => handleProjectClick(proj.id)}
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

      <RenameModal visible={renameVisible} project={currentEditProj} onClose={() => setRenameVisible(false)} onConfirm={handleRenameConfirm} />
      <DeleteModal visible={deleteVisible} projectId={currentDeleteProj?.id || null} projectName={currentDeleteProj?.name || ''} onClose={() => setDeleteVisible(false)} onConfirm={handleDeleteConfirm} />
    </div>
  );
};
