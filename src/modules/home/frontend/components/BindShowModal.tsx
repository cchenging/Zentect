// 📁 路径: src/modules/home/frontend/components/BindShowModal.tsx
// 🎬 P3-3 项目关联剧集对话框 — 把项目绑定到某剧集（设置 show_id + episode_number）

import React, { useState, useEffect } from 'react';
import { Film, X, Loader2, Check, Unlink } from 'lucide-react';
import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import { API } from '@renderer/api';
import { AppNotifier } from '@renderer/core/AppNotifier';
import type { ProjectRecord } from '../../types';

/** 剧集选项（来自 API.shows.list） */
interface ShowOption {
  id: string;
  name: string;
  episodeCount: number;
}

interface BindShowModalProps {
  project: ProjectRecord;
  onClose: () => void;
  onBound: () => void;
}

/**
 * 项目关联剧集对话框
 * - 列出所有剧集供选择
 * - 支持设置集数（默认自动递增）
 * - 已关联时显示当前关联信息 + 解绑按钮
 */
export const BindShowModal: React.FC<BindShowModalProps> = ({ project, onClose, onBound }) => {
  const [shows, setShows] = useState<ShowOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedShowId, setSelectedShowId] = useState<string>('');
  const [episodeNumber, setEpisodeNumber] = useState<string>('');
  const [saving, setSaving] = useState(false);

  /** 加载剧集列表 */
  useEffect(() => {
    (async () => {
      try {
        const list = await API.shows.list();
        const opts = Array.isArray(list) ? list.map((s: any) => ({ id: s.id, name: s.name, episodeCount: s.episodeCount })) : [];
        setShows(opts);
        // 若项目已关联剧集，预选
        if (project.showId) {
          setSelectedShowId(project.showId);
          setEpisodeNumber(project.episodeNumber ? String(project.episodeNumber) : '');
        }
      } catch (e: any) {
        AppNotifier.error('加载剧集列表失败: ' + e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [project.showId, project.episodeNumber]);

  /** 确认绑定 */
  const handleBind = async () => {
    if (!selectedShowId) {
      AppNotifier.warn('请选择剧集');
      return;
    }
    setSaving(true);
    try {
      const epNum = episodeNumber ? parseInt(episodeNumber, 10) : undefined;
      await API.shows.bindProject(project.id, selectedShowId, epNum);
      AppNotifier.success('已关联到剧集');
      onBound();
      onClose();
    } catch (e: any) {
      AppNotifier.error('关联失败: ' + e.message);
    } finally {
      setSaving(false);
    }
  };

  /** 解绑 */
  const handleUnbind = async () => {
    setSaving(true);
    try {
      await API.shows.unbindProject(project.id);
      AppNotifier.success('已解除剧集关联');
      onBound();
      onClose();
    } catch (e: any) {
      AppNotifier.error('解绑失败: ' + e.message);
    } finally {
      setSaving(false);
    }
  };

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
            <h2 className="text-sm font-semibold text-foreground">关联到剧集</h2>
          </div>
          <button onClick={onClose} className="w-6 h-6 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
            <X size={14} />
          </button>
        </div>

        {/* 内容 */}
        <div className="flex-1 p-5 space-y-4">
          <div className="text-xs text-muted-foreground">
            项目：<span className="text-foreground font-medium">{project.name}</span>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={20} className="animate-spin text-muted-foreground" />
            </div>
          ) : shows.length === 0 ? (
            <div className="text-center py-8 text-sm text-muted-foreground">
              暂无剧集，请先在剧集管理中创建
            </div>
          ) : (
            <>
              {/* 剧集选择列表 */}
              <div>
                <label className="text-xs text-muted-foreground mb-2 block">选择剧集</label>
                <div className="max-h-[200px] overflow-y-auto space-y-1.5">
                  {shows.map((show) => (
                    <div
                      key={show.id}
                      onClick={() => setSelectedShowId(show.id)}
                      className={`flex items-center gap-2.5 p-2.5 rounded-lg border cursor-pointer transition-colors ${
                        selectedShowId === show.id
                          ? 'border-accent/50 bg-accent/5'
                          : 'border-border/40 hover:border-border hover:bg-muted/30'
                      }`}
                    >
                      <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                        selectedShowId === show.id ? 'border-accent' : 'border-muted-foreground/30'
                      }`}>
                        {selectedShowId === show.id && <Check size={10} className="text-accent" />}
                      </div>
                      <span className="text-sm text-foreground flex-1 truncate">{show.name}</span>
                      <span className="text-xs text-muted-foreground">{show.episodeCount} 集</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* 集数输入 */}
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">集数（留空自动递增）</label>
                <Input
                  type="number"
                  min="1"
                  value={episodeNumber}
                  onChange={(e) => setEpisodeNumber(e.target.value)}
                  placeholder="自动递增"
                />
              </div>
            </>
          )}
        </div>

        {/* 底部按钮 */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-border/50">
          {project.showId ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleUnbind}
              disabled={saving || loading}
              className="text-red-500 hover:text-red-600 hover:bg-red-500/10"
            >
              <Unlink size={13} className="mr-1.5" />
              解除关联
            </Button>
          ) : <div />}
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>取消</Button>
            <Button size="sm" onClick={handleBind} disabled={saving || loading || !selectedShowId}>
              {saving ? <Loader2 size={13} className="mr-1.5 animate-spin" /> : <Check size={13} className="mr-1.5" />}
              确认关联
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};
