import React, { useState, useMemo } from 'react';
import { Search, Music, Upload, Headphones, Mic, Sparkles } from 'lucide-react';
import { useEditorStore } from '../../../../store/useStore';
import { AppNotifier } from '../../../../core/AppNotifier';
import { VirtuosoGrid } from 'react-virtuoso';
import { API } from '../../../../api';
import { Input } from '../../../../components/ui/input';
import { Button } from '../../../../components/ui/button';

export const AudioPool: React.FC = () => {
  const { projectId, mediaItems: mediaItemsStore, addMediaItems, selectItem, selectedItemId, setActivePlaySource } = useEditorStore();

  const [isImporting, setIsImporting] = useState(false);
  const [searchKey, setSearchKey] = useState('');
  const [activeFilter, setActiveFilter] = useState<'all'|'bgm'|'sound'|'vocal'>('all');

  // 💥 防御性编程：确保 mediaItems 是数组
  const mediaItems = Array.isArray(mediaItemsStore) ? mediaItemsStore : [];

  const displayItems = useMemo(() => {
    return mediaItems.filter(item => {
      if (item.type !== 'audio') return false;
      if (activeFilter === 'bgm' && !(item.name ?? '').toLowerCase().includes('bgm')) return false;
      if (activeFilter === 'sound' && !(item.name ?? '').toLowerCase().includes('音效')) return false;
      if (searchKey && !(item.name ?? '').toLowerCase().includes(searchKey.toLowerCase())) return false;
      return true;
    });
  }, [mediaItems, activeFilter, searchKey]);

  const handleImport = async () => {
    const paths = await API.system.openMediaDialog();
    if (paths && paths.length > 0) {
      if (!projectId) return;
      setIsImporting(true);
      try {
        const newItems = await API.media.import(projectId, paths);
        addMediaItems(newItems);
        if (newItems.length > 0) {
          selectItem(newItems[0].id, 'media');
          setActivePlaySource(newItems[0]);
        }
      } catch (error: any) {
        AppNotifier.error(error.message || '音频导入失败');
      } finally {
        setIsImporting(false);
      }
    }
  };

  const handleDragStart = (e: React.DragEvent<HTMLDivElement>, item: any) => {
    e.dataTransfer.setData('magic/audio', JSON.stringify(item));
    e.dataTransfer.effectAllowed = 'copy';
  };

  const renderAudioCard = (_index: number, item: any) => {
    const isActive = selectedItemId === item.id;
    return (
      <div
        onClick={() => { selectItem(item.id, 'media'); setActivePlaySource(item); }}
        draggable={true}
        onDragStart={(e) => handleDragStart(e, item)}
        className="flex flex-col gap-1.5 cursor-grab active:cursor-grabbing group w-full h-full"
      >
        <div className={`w-full aspect-[4/3] bg-muted/30 rounded-lg relative overflow-hidden transition-all duration-200 flex flex-col items-center justify-center ${isActive ? 'ring-2 ring-primary ring-offset-1 ring-offset-background shadow-md bg-primary/10' : 'border border-border/50 group-hover:border-primary/50 group-hover:shadow-sm'}`}>
          <Music size={28} className={isActive ? 'text-primary' : 'text-emerald-500/70 group-hover:text-emerald-500 transition-colors'} />
          <div className="absolute bottom-1.5 left-1.5 bg-black/70 backdrop-blur-md rounded px-1.5 py-0.5 border border-white/10 shadow-sm">
            <span className="text-white text-mini font-mono font-medium tracking-wider">{item.duration || '00:00'}</span>
          </div>
        </div>
        <span className={`text-caption text-center w-full whitespace-nowrap overflow-hidden text-ellipsis px-0.5 transition-colors ${isActive ? 'text-foreground font-semibold' : 'text-muted-foreground group-hover:text-foreground font-medium'}`} title={item.name}>
          {item.name}
        </span>
      </div>
    );
  };

  return (
    <div className="animate-in fade-in flex flex-col h-full gap-3 p-3 box-border">
      <div className="flex gap-2">
        <div className="relative flex-1 group">
          <Search className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground transition-colors" />
          <Input
            value={searchKey}
            onChange={e=>setSearchKey(e.target.value)}
            placeholder="搜索音频素材..."
            className="h-8 pl-8 pr-3 text-caption bg-background border-border focus-visible:ring-1 focus-visible:ring-primary shadow-none"
          />
        </div>
        <Button
          onClick={handleImport}
          disabled={isImporting}
          variant="outline"
          className="h-8 px-3 flex items-center justify-center gap-1.5 text-caption bg-primary/10 text-primary border-primary/20 hover:bg-primary hover:text-primary-foreground shadow-none"
        >
          <Upload size={14} /> 导入
        </Button>
      </div>

      <div className="flex bg-muted/50 p-1 rounded-md border border-border/50 shrink-0">
        {[
          {id:'all', label:'全部', icon: Music},
          {id:'bgm', label:'音乐', icon: Headphones},
          {id:'sound', label:'音效', icon: Sparkles},
          {id:'vocal', label:'人声', icon: Mic}
        ].map(f => {
          const Icon = f.icon;
          return (
            <button key={f.id} onClick={() => setActiveFilter(f.id as any)} className={`flex-1 flex items-center justify-center gap-1.5 py-1 text-caption font-medium rounded-[4px] transition-all cursor-pointer ${activeFilter === f.id ? 'bg-background text-foreground shadow-sm border border-border/50' : 'text-muted-foreground hover:text-foreground hover:bg-muted border border-transparent'}`}>
               <Icon size={14} /> {f.label}
            </button>
          );
        })}
      </div>

      <div className="flex-1 overflow-hidden p-1 -m-1 bg-transparent">
        {displayItems.length === 0 ? (
          <div className="h-full border border-dashed border-border rounded-lg flex flex-col items-center justify-center pointer-events-none bg-muted/10">
            <Music size={24} className="text-muted-foreground mb-3" />
            <span className="text-muted-foreground text-caption font-medium tracking-wide">无匹配音频</span>
          </div>
        ) : (
          <VirtuosoGrid
            style={{ height: '100%', width: '100%' }}
            data={displayItems}
            listClassName="grid grid-cols-[repeat(auto-fill,minmax(80px,1fr))] gap-2.5 pb-4"
            itemContent={renderAudioCard}
            overscan={200}
          />
        )}
      </div>
    </div>
  );
};