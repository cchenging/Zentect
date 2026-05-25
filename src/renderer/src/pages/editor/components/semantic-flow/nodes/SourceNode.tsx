// 📁 路径：src/renderer/src/pages/editor/components/semantic-flow/nodes/SourceNode.tsx
import React from 'react';
import { FileVideo, Upload, RefreshCw } from 'lucide-react';
import { BaseNode } from './BaseNode';
import { useEditorStore } from '../../../../../store/useStore';
import { stopEvent } from '../../../../../utils/domEvents';
import { NODE_MENU_CONFIG } from '../../../config/nodeMenu';
import { NODE_STATUS } from '../../../../../store/constants';
import { useI18n } from '../../../../../store/useI18n';
import { getSafeMediaUrl } from '../../../../../utils/formatUrl';

export const SourceNode: React.FC<any> = ({ id, data, selected }) => {
  const { importNodeMedia, mediaItems } = useEditorStore();
  const { t } = useI18n();
  const sn = t.nodes?.source || {};
  const config = NODE_MENU_CONFIG.flatMap(c => c.items).find(i => i.type === 'sourceNode');
  const Icon = config?.icon || FileVideo;

  // 💥 溯源寻找：根据节点记录的 mediaId 找出真实资产
  const media = Array.isArray(mediaItems) ? mediaItems.find(m => m.id === data.mediaId) : null;

  const handleImport = (e: React.MouseEvent) => {
    stopEvent(e); 
    importNodeMedia(id);
  };

  return (
    <BaseNode
      id={id} selected={selected}
      title={data.label || (sn.title || '媒体源')}
      icon={<Icon size={16} />}
      accent="blue"
      variant="compact"
      themeColor={config?.color}
      themeBg={config?.bg}
      width={config?.defaultWidth || 200}
      status={data.status} progress={data.progress}
      outputs={[{ id: 'source-out', type: 'media' }]}
    >
      <div className="flex flex-col gap-1.5 p-1">
        
        {media && (media.cover || media.coverPath) && (
          <div className="w-full aspect-video rounded-md overflow-hidden bg-black/40 border border-white/10 group relative">
            <img 
              src={getSafeMediaUrl(media.cover || media.coverPath)} 
              alt="cover" 
              className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" 
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent pointer-events-none" />
          </div>
        )}

        {data.mediaId ? (
          <div className="flex items-center gap-2 p-1.5 bg-zinc-900/50 rounded border border-zinc-800/60 text-[11px] group cursor-pointer" onClick={handleImport} title="点击重新导入">
            <span className="w-2 h-2 rounded-full bg-green-500/80 shrink-0" />
            <span className="truncate text-zinc-300 flex-1" title={media?.fileName || data.label}>
              {media?.fileName || data.label || '已加载'}
            </span>
            <RefreshCw size={12} className="text-zinc-500 group-hover:text-primary shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        ) : (
          <button 
            onClick={handleImport} disabled={data.status === NODE_STATUS.PROCESSING}
            className="w-full h-9 border border-dashed border-zinc-700/60 hover:border-primary/50 hover:bg-primary/5 rounded-md flex items-center justify-center gap-1.5 text-[11px] text-zinc-400 hover:text-primary transition-all cursor-pointer disabled:opacity-50 outline-none"
          >
            <Upload size={13} /> {sn.importBtn || '导入素材'}
          </button>
        )}
      </div>
    </BaseNode>
  );
};
