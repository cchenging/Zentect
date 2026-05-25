import React, { useState, useMemo } from 'react';
import { Search, Plus, FileEdit, Type } from 'lucide-react';
import { useEditorStore } from '../../../../store/useStore';
import { Virtuoso } from 'react-virtuoso';
import { Input } from '../../../../components/ui/input';
import { Button } from '../../../../components/ui/button';

export const TextPool: React.FC = () => {
  const { shots, selectItem, selectedItemId, insertOriginalShot } = useEditorStore();

  const [searchKey, setSearchKey] = useState('');

  const displayItems = useMemo(() => {
    const textItems = shots.filter(s => s.aiText || s.originalText).map(s => ({
      id: s.id,
      text: s.aiText || s.originalText,
      type: s.aiText ? 'ai' : 'original'
    }));

    if (!searchKey) return textItems;
    return textItems.filter(item => ((item as any).text ?? '').toLowerCase().includes(searchKey.toLowerCase()));
  }, [shots, searchKey]);

  const handleDragStart = (e: React.DragEvent<HTMLDivElement>, item: any) => {
    e.dataTransfer.setData('magic/text', JSON.stringify(item));
    e.dataTransfer.effectAllowed = 'copy';
  };

  const renderTextCard = (_index: number, item: any) => {
    const isActive = selectedItemId === item.id;
    return (
      <div
        onClick={() => selectItem(item.id, 'shot')}
        draggable={true}
        onDragStart={(e) => handleDragStart(e, item)}
        className={`w-full p-2.5 rounded-lg border transition-all cursor-grab active:cursor-grabbing flex gap-3 ${isActive ? 'bg-primary/10 border-primary ring-1 ring-primary shadow-sm' : 'bg-card border-border/50 hover:border-primary/50 hover:shadow-sm'}`}
      >
        <div className={`w-8 h-8 shrink-0 rounded flex items-center justify-center ${item.type === 'ai' ? 'bg-blue-500/10 text-blue-500' : 'bg-emerald-500/10 text-emerald-500'}`}>
          <Type size={16} />
        </div>
        <div className="flex-1 min-w-0 flex flex-col justify-center">
           <p className="text-caption text-foreground font-medium truncate w-full m-0 leading-relaxed">
             {item.text}
           </p>
           <span className="text-mini text-muted-foreground mt-0.5">
             {item.type === 'ai' ? 'AI 润色台词' : '原始台词'}
           </span>
        </div>
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
            placeholder="搜索文案/台词..."
            className="h-8 pl-8 pr-3 text-caption bg-background border-border focus-visible:ring-1 focus-visible:ring-primary shadow-none"
          />
        </div>
        <Button
          variant="outline"
          className="h-8 px-3 flex items-center justify-center gap-1.5 text-caption bg-primary/10 text-primary border-primary/20 hover:bg-primary hover:text-primary-foreground shadow-none"
          onClick={() => {
            const newId = `txt_${Date.now()}`;
            insertOriginalShot({ id: newId, text: '', start: 0, end: 3, duration: 3, mediaId: '' } as any);
            selectItem(newId, 'shot');
          }}
        >
          <Plus size={14} /> 新建
        </Button>
      </div>

      <div className="flex-1 overflow-hidden p-1 -m-1 bg-transparent">
        {displayItems.length === 0 ? (
          <div className="h-full border border-dashed border-border rounded-lg flex flex-col items-center justify-center pointer-events-none bg-muted/10">
            <FileEdit size={24} className="text-muted-foreground mb-3" />
            <span className="text-muted-foreground text-caption font-medium tracking-wide">无台词数据</span>
          </div>
        ) : (
          <Virtuoso
            style={{ height: '100%', width: '100%' }}
            data={displayItems}
            itemContent={renderTextCard}
            className="gap-2 flex flex-col pb-4 scrollbar-hide"
          />
        )}
      </div>
    </div>
  );
};