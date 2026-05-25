/** V1.3 B5: 解说稿精修面板（RightPanel 嵌入组件）
 *  从 StepReview 的 w-[360px] 右栏迁移至此
 *  通过 Zustand store 与中栏播放器双向同步
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Loader2, Edit3, SkipForward } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { API } from '../../../api';

/** 解说稿段落结构 */
interface ScriptParagraph {
  shotId: string;
  text: string;
  startTime: number;
  endTime: number;
  dirty?: boolean;
}

interface ScriptPanelProps {
  projectId: string;
  currentTime?: number;
  mediaPath?: string;
  onSeekTo?: (time: number) => void;
}

export const ScriptPanel: React.FC<ScriptPanelProps> = ({
  projectId,
  currentTime = 0,
  onSeekTo,
}) => {
  const scriptScrollRef = useRef<HTMLDivElement>(null);
  const [paragraphs, setParagraphs] = useState<ScriptParagraph[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [editingIndex, setEditingIndex] = useState(-1);
  const [editText, setEditText] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** 加载项目解说稿数据 */
  const loadScriptData = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const data: any = await API.project.loadData(projectId);
      const shots = data?.shots || [];

      if (shots.length === 0) {
        setParagraphs([]);
        setLoading(false);
        return;
      }

      const items: ScriptParagraph[] = shots
        .map((s: any) => ({
          shotId: s.id || '',
          text: s.aiText || s.ttsText || s.text || s.originalText || '',
          startTime: s.start ?? 0,
          endTime: s.end ?? (s.start ?? 0) + (s.duration ?? 0),
        }))
        .filter(p => p.text.trim().length > 0);

      setParagraphs(items);
    } catch {
      setError('加载解说稿失败');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { loadScriptData(); }, [loadScriptData]);

  /** 播放器时间同步：自动高亮当前段落 */
  useEffect(() => {
    if (paragraphs.length === 0) return;
    const idx = paragraphs.findIndex(
      (p, i) => currentTime >= p.startTime && currentTime < (paragraphs[i + 1]?.startTime ?? Infinity)
    );
    if (idx !== activeIndex) {
      setActiveIndex(idx);
      if (idx >= 0 && scriptScrollRef.current) {
        const el = scriptScrollRef.current.querySelector(`[data-index="${idx}"]`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }, [currentTime, paragraphs, activeIndex]);

  const formatTime = (s: number) => {
    if (!s || isNaN(s)) return '00:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  };

  const handleSeekTo = (time: number) => {
    onSeekTo?.(time);
  };

  const startEdit = (index: number) => {
    setEditingIndex(index);
    setEditText(paragraphs[index].text);
  };

  const saveEdit = async (index: number) => {
    const updated = [...paragraphs];
    updated[index] = { ...updated[index], text: editText, dirty: true };
    setParagraphs(updated);
    setEditingIndex(-1);
    setEditText('');

    try {
      await API.project.updateScriptDelta(projectId, [
        { shotId: updated[index].shotId, text: editText },
      ]);
    } catch (err: any) {
      console.error('保存解说稿失败:', err);
    }
  };

  const cancelEdit = () => {
    setEditingIndex(-1);
    setEditText('');
  };

  void paragraphs.some(p => p.dirty);

  return (
    <div className="flex flex-col gap-3 h-full">
      <div className="flex items-center justify-between shrink-0">
        <h3 className="text-sm font-medium">解说稿</h3>
        <span className="text-xs text-muted-foreground">
          {paragraphs.length > 0 ? `共 ${paragraphs.length} 段` : ''}
        </span>
      </div>
      <div
        ref={scriptScrollRef}
        className="flex-1 overflow-y-auto space-y-3 pr-1"
        style={{ scrollbarWidth: 'thin' }}
      >
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 size={20} className="text-muted-foreground animate-spin" />
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-error">{error}</p>
          </div>
        ) : paragraphs.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-muted-foreground">暂无解说稿</p>
          </div>
        ) : (
          paragraphs.map((p, i) => (
            <div
              key={p.shotId || i}
              data-index={i}
              className={`rounded-lg border p-3 transition-colors cursor-pointer ${
                i === activeIndex
                  ? 'border-primary bg-primary/5'
                  : p.dirty
                    ? 'border-amber-500/50 bg-amber-500/5'
                    : 'border-border/50 hover:border-border'
              }`}
              onClick={() => handleSeekTo(p.startTime)}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-muted-foreground font-mono">
                  {formatTime(p.startTime)}
                  {p.dirty && <span className="ml-2 text-amber-500">已修改</span>}
                </span>
                <div className="flex items-center gap-1">
                  <SkipForward
                    size={14}
                    className="text-muted-foreground hover:text-foreground cursor-pointer"
                    onClick={(e) => { e.stopPropagation(); handleSeekTo(p.startTime); }}
                  />
                  <Edit3
                    size={14}
                    className="text-muted-foreground hover:text-foreground cursor-pointer"
                    onClick={(e) => { e.stopPropagation(); startEdit(i); }}
                  />
                </div>
              </div>
              {editingIndex === i ? (
                <div className="space-y-2" onClick={e => e.stopPropagation()}>
                  <textarea
                    className="w-full rounded-md border border-border bg-bg-main p-2 text-sm text-foreground resize-none focus:outline-none focus:ring-1 focus:ring-primary"
                    rows={3}
                    value={editText}
                    onChange={e => setEditText(e.target.value)}
                    autoFocus
                  />
                  <div className="flex gap-2 justify-end">
                    <Button variant="ghost" size="sm" onClick={cancelEdit}>取消</Button>
                    <Button variant="default" size="sm" onClick={() => saveEdit(i)}>保存</Button>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground leading-relaxed line-clamp-3">
                  {p.text}
                </p>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
};