// 📁 路径：src/renderer/src/pages/editor/components/left-panel/MediaPool.tsx
// 媒体素材库面板 - 支持导入、搜索、过滤、拖拽到时间轴、右键删除
import React, { useState, useMemo, useEffect } from 'react';
import { Search, Loader2 } from 'lucide-react';
import { AppIcon } from '../../../../components/app-icon';
import { useEditorStore } from '../../../../store/useStore';
import { useTaskStore } from '../../../../store/useTaskStore';
import { getSafeMediaUrl } from '../../../../utils/formatUrl';
import { AppNotifier } from '../../../../core/AppNotifier';
import { useI18n } from '../../../../store/useI18n';
import { VirtuosoGrid } from 'react-virtuoso';
import { API } from '../../../../api';
import { Input } from '../../../../components/ui/input';
import { Button } from '../../../../components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../../../../components/ui/dialog';
import { FrontendLogger } from '../../../../utils/logger';
import { DICT } from '../../../../../../shared/locales/dictionary';

export const MediaPool: React.FC = () => {
  const { projectId, mediaItems, addMediaItems, selectItem, selectedItemId, setActivePlaySource, setGlobalFocusMode, setCurrentTime, extractedData } = useEditorStore();
  const { t } = useI18n();
  const tasks = useTaskStore(s => s.tasks);
  
  /** 调试指示：帧数据状态 */
  const frameDebugInfo = `帧: ${extractedData?.framePaths?.length || 0} 条`;

  const [isDragging, setIsDragging] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [searchKey, setSearchKey] = useState('');
  const [activeFilter, setActiveFilter] = useState<string>('all');
  
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, mediaId: string } | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  useEffect(() => {
    const handleGlobalClick = () => setContextMenu(null);
    document.addEventListener('click', handleGlobalClick);
    return () => document.removeEventListener('click', handleGlobalClick);
  }, []);

  // 状态字典转换
  const getStatusLabel = (status: string) => {
    const map: Record<string, string> = {
      'pending': '排队中...',
      'extracting_audio': '正在抽取音频',
      'parsing_text': 'AI 提取台词中',
      'indexing_vision': '构建视觉索引',
      'error': '解析失败'
    };
    return map[status] || '处理中...';
  };

  // 💥 防御性编程：确保 mediaItems 是数组
  const mediaArray = Array.isArray(mediaItems) ? mediaItems : [];
  
  const displayItems = useMemo(() => {
    // mediaItems 已经包含所有内容（视频、帧、音频），直接使用
    return mediaArray.filter(item => {
      if (activeFilter !== 'all' && item.type !== activeFilter) return false;
      if (searchKey && !item.name.toLowerCase().includes(searchKey.toLowerCase())) return false;
      return true;
    });
  }, [mediaItems, activeFilter, searchKey]);

  /** 处理文件导入：调用后端API导入媒体文件 */
  const processFiles = async (filePaths: string[]) => {
    if (!projectId || filePaths.length === 0) return;
    setIsImporting(true);
    try {
      const newItems = await API.media.import(projectId, filePaths);
      addMediaItems(newItems);
      if (newItems.length > 0) {
         selectItem(newItems[0].id, 'media');
         setActivePlaySource(newItems[0]);
         setGlobalFocusMode('media');
      }
    } catch (error: any) { 
      FrontendLogger.error('MediaPool', 'Import Media Error', undefined, error);
      AppNotifier.error(error.message || (t.common as any)?.error || '导入失败'); 
    }
    finally { setIsImporting(false); }
  };

  /** 通过文件对话框导入媒体 */
  const handleImport = async () => {
    const paths = await API.system.openMediaDialog();
    if (paths && paths.length > 0) processFiles(paths);
  };

  /** 拖拽导入相关事件 */
  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(true); };
  const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(false); };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setIsDragging(false);
    const files = Array.from(e.dataTransfer.files).map((f: any) => f.path).filter(Boolean);
    if (files.length > 0) processFiles(files);
  };

  /** 拖拽开始：将素材信息传递给时间轴等目标区域 */
  const handleDragStart = (e: React.DragEvent<HTMLDivElement>, item: any) => {
    e.dataTransfer.setData('magic/media', JSON.stringify(item));
    e.dataTransfer.effectAllowed = 'copy';
  };

  const handleContextMenu = (e: React.MouseEvent, mediaId: string) => {
    e.preventDefault(); e.stopPropagation();
    setContextMenu({ x: e.pageX, y: e.pageY, mediaId });
  };

  const executeDelete = async () => {
    if (!deleteConfirmId || !projectId) return;
    try {
      await API.media.delete(projectId, deleteConfirmId);
      useEditorStore.getState().removeMediaItem(deleteConfirmId);
      AppNotifier.success('素材已删除');
    } catch (error: any) {
      FrontendLogger.error('MediaPool', 'Delete Media Error', undefined, error);
      AppNotifier.error(error.message || '删除失败');
    } finally {
      setDeleteConfirmId(null);
    }
  };

  const renderMediaCard = (_index: number, item: any) => {
    const coverSrc = getSafeMediaUrl(item.coverPath);
    const isActive = selectedItemId === item.id;
    const isFrame = item.type === 'frame';
    const parentId = item.parentId || item.id;
    const activeTask = tasks[parentId];
    const isProcessing = activeTask && (activeTask.percent ?? 0) < 100 && activeTask.status !== 'error';

    return (
      <div 
        onClick={() => {
          selectItem(item.id, 'media');
          if (isFrame) {
            /** 帧类型：点击跳转播放器到对应时间戳，而非切换播放源 */
            const fps = useEditorStore.getState().extractionConfig?.frames?.fps || 2;
            const frameIndex = mediaItems.filter((m: any) => m.type === 'frame').indexOf(item);
            if (frameIndex >= 0) setCurrentTime(frameIndex / fps);
          } else {
            setActivePlaySource(item);
          }
          setGlobalFocusMode('media');
        }} 
        onContextMenu={(e) => handleContextMenu(e, item.parentId || item.id)}
        draggable={true} 
        onDragStart={(e) => handleDragStart(e, item)} 
        className="flex flex-col gap-1.5 cursor-grab active:cursor-grabbing group w-full h-full relative"
      >
        <div className={`w-full aspect-square bg-muted rounded-lg relative overflow-hidden transition-all duration-200`}>
          {item.coverPath ? (
            <img src={coverSrc} alt={item.name || 'cover'} className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).src = ''; (e.target as HTMLImageElement).classList.add('hidden'); }} />
          ) : (
             <div className="w-full h-full flex items-center justify-center bg-muted">
               {item.type === DICT.MEDIA_TYPE.AUDIO ? <AppIcon name="Music" size={24} className="text-muted-foreground/50" /> : <AppIcon name="Video" size={24} className="text-muted-foreground/50" />}
             </div>
          )}
          <div className={`absolute inset-0 rounded-lg pointer-events-none transition-colors duration-200 border-2 ${isActive ? 'border-primary' : 'border-transparent group-hover:border-primary/30'}`} />
          <div className={`absolute top-1.5 right-1.5 backdrop-blur-md rounded px-1 py-0.5 flex items-center justify-center border shadow-sm ${isFrame ? 'bg-amber-500/80 border-amber-500/50' : 'bg-background/60 border-border/50'}`}>
            {isFrame ? <AppIcon name="Film" size={10} className="text-primary-foreground" /> : item.type === DICT.MEDIA_TYPE.VIDEO ? <AppIcon name="Video" size={10} className="text-primary-foreground" /> : (item.type === DICT.MEDIA_TYPE.AUDIO ? <AppIcon name="Music" size={10} className="text-emerald-500" /> : <AppIcon name="Video" size={10} className="text-blue-500" />)}
          </div>

          {/* 🌟 核心：遥测进度遮罩 (Telemetry Overlay) */}
          {activeTask && (
            <div className={`absolute inset-0 flex flex-col items-center justify-center z-10 backdrop-blur-sm transition-all duration-300 ${isProcessing ? 'bg-background/80' : 'bg-green-500/80'}`}>
              {isProcessing ? (
                 <>
                   <Loader2 className="w-6 h-6 animate-spin text-primary mb-2 shadow-black drop-shadow-md" />
                   <span className="text-sm font-bold text-primary drop-shadow-md">{Math.round(activeTask.percent!)}%</span>
                   <span className="text-[10px] text-foreground mt-1 font-medium px-2 text-center drop-shadow-md">
                     {getStatusLabel(activeTask.status!)}
                   </span>
                 </>
              ) : (
                 <span className="text-sm font-bold text-white drop-shadow-md">解析完成</span>
              )}
            </div>
          )}
        </div>
        <span className={`text-[11px] text-center w-full whitespace-nowrap overflow-hidden text-ellipsis px-0.5 transition-colors ${isActive ? 'text-primary font-semibold' : 'text-muted-foreground group-hover:text-foreground font-medium'}`} title={item.name}>
          {item.name}
        </span>
      </div>
    );
  };

  return (
    <div className="animate-in fade-in flex flex-col h-full gap-3 p-3 box-border relative">
      {/* 搜索栏 + 导入按钮 */}
      <div className="flex gap-2">
        <div className="relative flex-1 group">
          <Search className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
          <Input value={searchKey} onChange={e=>setSearchKey(e.target.value)} placeholder={t.common?.search || '搜索素材...'} className="h-8 pl-8 pr-3 text-[11px] bg-background/50 border-border text-foreground placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-primary shadow-none" />
        </div>
        <Button onClick={handleImport} disabled={isImporting} variant="outline" className="h-8 px-3 flex items-center justify-center gap-1.5 text-[11px] text-primary border-primary/20 hover:bg-primary hover:text-primary-foreground shadow-none">
          <AppIcon name="Folder" size={14} /> {t.common?.import || '导入'}
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <div className="flex bg-muted/30 p-1 rounded-lg border border-border shrink-0">
          {[{id:'all', label:'全部', icon:'Edit'}, {id:DICT.MEDIA_TYPE.VIDEO, label:'视频', icon:'Video'}, {id:DICT.MEDIA_TYPE.AUDIO, label:'音频', icon:'Music'}].map(f => (
            <button key={f.id} onClick={() => setActiveFilter(f.id as string)} className={`flex-1 flex items-center justify-center gap-1.5 py-1 text-[11px] font-medium rounded-md transition-all cursor-pointer outline-none ${activeFilter === f.id ? 'bg-background text-foreground shadow-sm border border-border/50' : 'text-muted-foreground hover:text-foreground hover:bg-background/20 border border-transparent'}`}>
               <AppIcon name={f.icon as any} size={13} /> {f.label}
            </button>
          ))}
        </div>
        <span className="text-[9px] text-muted-foreground/50 shrink-0">{frameDebugInfo}</span>
      </div>

      {/* 素材列表 - 支持拖拽导入 */}
      <div onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop} className={`flex-1 overflow-hidden p-1 -m-1 transition-all duration-300 ${isDragging ? 'border border-primary border-dashed bg-primary/5 rounded-md' : 'bg-transparent'}`}>
        {displayItems.length === 0 ? (
          <div className="h-full border border-dashed border-border rounded-lg flex flex-col items-center justify-center pointer-events-none bg-muted/20">
            <AppIcon name="Folder" size={24} className="text-muted-foreground/50 mb-3" />
            <span className="text-muted-foreground text-[11px] font-medium tracking-wide">拖入素材或点击导入</span>
            <span className="text-muted-foreground/60 text-[10px] mt-1">支持 MP4 / MOV / AVI / MKV</span>
          </div>
        ) : (
          <VirtuosoGrid style={{ height: '100%', width: '100%' } data={displayItems} listClassName="grid grid-cols-[repeat(auto-fill,minmax(80px,1fr))] gap-2.5 pb-4" itemContent={renderMediaCard} overscan={200} />
        )}
      </div>

      {/* 关键帧库 */}
      {extractedData?.framePaths?.length > 0 && (
        <div className="border-t border-border pt-2 flex flex-col gap-2 shrink-0">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium text-muted-foreground flex items-center gap-1">
              <AppIcon name="Film" size={12} /> 关键帧库 ({extractedData.framePaths.length} 帧)
            </span>
          </div>
          <div className="grid grid-cols-3 gap-1 max-h-[140px] overflow-y-auto bg-muted/10 rounded-lg p-1">
            {extractedData.framePaths.map((framePath: string, index: number) => (
              <div
                key={index}
                className="aspect-video bg-muted rounded border border-border/30 cursor-pointer hover:border-primary/50 overflow-hidden group transition-colors relative"
                onClick={() => {
                  setActivePlaySource({ id: `frame_${index}`, filePath: framePath, type: 'frame', name: `第${index + 1}帧` });
                }}
              >
                <img
                  src={getSafeMediaUrl(framePath)}
                  className="w-full h-full object-cover group-hover:opacity-90 transition-opacity"
                  loading="lazy"
                  alt={`帧 ${index + 1}`}
                />
                <span className="absolute bottom-0 right-0.5 text-[8px] bg-black/60 text-muted-foreground px-0.5 font-mono rounded">
                  {index + 1}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {contextMenu && (
        <div 
          style={{ top: contextMenu.y, left: contextMenu.x }}
          className="fixed z-[9999] bg-popover border border-border rounded-md shadow-lg py-1 w-32 animate-in fade-in zoom-in duration-150"
          onClick={(e) => e.stopPropagation()}
        >
          <button 
            className="w-full text-left px-3 py-2 text-[12px] text-destructive hover:bg-destructive/10 flex items-center gap-2 transition-colors outline-none cursor-pointer"
            onClick={(e) => {
               e.stopPropagation();
               setDeleteConfirmId(contextMenu.mediaId);
               setContextMenu(null);
            }}
          >
            <AppIcon name="Trash2" size={14} /> 删除素材
          </button>
        </div>
      )}

      {/* 💥 专业、简洁、不中二的标准大厂删除确认窗 */}
      <Dialog open={!!deleteConfirmId} onOpenChange={(open) => !open && setDeleteConfirmId(null)}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AppIcon name="AlertTriangle" size={18} className="text-destructive" />
              确认删除素材？
            </DialogTitle>
            <DialogDescription className="pt-3 text-[13px] leading-relaxed">
              此操作将移除该素材及其在本地生成的所有缓存文件（含抽帧与音频）。<br/><br/>
              如果时间轴已使用了该素材，相关片段也将被一并清除。此操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-2 flex sm:justify-end gap-2">
            <Button variant="outline" onClick={() => setDeleteConfirmId(null)}>
              {t.common?.cancel || '取消'}
            </Button>
            <Button variant="destructive" onClick={executeDelete} className="flex items-center gap-1.5">
              <AppIcon name="Trash" size={14}/> {t.common?.confirm || '确认删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
