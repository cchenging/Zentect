// 📁 路径：src/renderer/src/pages/editor/components/inspectors/MediaNodeInspector.tsx
// 已移除画布节点系统依赖，改为基于 selectedItemId + mediaItems 渲染
import { FileVideo, Monitor, Clock, RefreshCcw, Box, Loader2, Plus } from 'lucide-react';
import { useEditorStore } from '../../../../store/useStore';
import { Button } from '../../../../components/ui/button';
import { getSafeMediaUrl } from '../../../../utils/formatUrl';

/**
 * 媒体资产属性检查面板
 * 从 store 读取 selectedItemId，在 mediaItems 中查找对应媒体进行渲染
 */
export const MediaNodeInspector = () => {
  const selectedItemId = useEditorStore((s) => s.selectedItemId);
  const mediaItemsStore = useEditorStore((s) => s.mediaItems);

  /** 防御性处理：确保 mediaItems 是数组 */
  const mediaItems = Array.isArray(mediaItemsStore) ? mediaItemsStore : [];

  /** 根据选中的 itemId 查找对应的媒体资产 */
  const media = selectedItemId ? mediaItems.find(m => m.id === selectedItemId) : null;

  if (!selectedItemId) return null;

  /** 获取安全的封面图 URL */
  const coverUrl = getSafeMediaUrl(media?.coverPath || media?.thumbnail);

  return (
    <div className="flex flex-col gap-5 p-1">

      {/* 未导入视频时的空状态 */}
      {!media ? (
        <div className="flex flex-col items-center justify-center p-6 bg-black/20 border border-dashed border-zinc-800 rounded-xl text-zinc-500 gap-3">
          <FileVideo size={32} className="opacity-50" />
          <span className="text-[12px]">尚未导入任何本地视频</span>
          <Button variant="outline" size="sm" onClick={() => useEditorStore.getState().importNodeMedia()} className="mt-2 h-8 text-[11px] w-full">
            <Plus size={14} className="mr-2" /> 浏览本地文件...
          </Button>
        </div>
      ) : (
        /* 已导入视频时的真实数据展示 */
        <>
          {/* 资产预览 */}
          <div className="space-y-2">
            <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">源文件预览</div>
            <div className="w-full aspect-video bg-black rounded-lg border border-zinc-800 overflow-hidden relative shadow-inner">
              {coverUrl ? (
                <img src={coverUrl} alt="cover" className="w-full h-full object-cover opacity-90" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-zinc-600"><FileVideo size={24}/></div>
              )}
            </div>
            <div className="text-[12px] font-medium text-zinc-200 truncate mt-1" title={media.name}>{media.name}</div>
            <div className="text-[10px] text-zinc-500 font-mono truncate" title={media.filePath}>{media.filePath}</div>
          </div>

          {/* 物理规格 */}
          <div className="space-y-3">
            <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest border-b border-zinc-800 pb-1">物理规格</div>
            <div className="grid grid-cols-1 gap-2 text-[10px]">
              <div className="flex justify-between items-center">
                <span className="text-zinc-500 flex items-center gap-1.5"><Monitor size={11}/> 画幅分辨率</span>
                <span className="text-blue-400 font-mono bg-blue-500/10 px-1.5 py-0.5 rounded border border-blue-500/20">
                  {media.width || 0} × {media.height || 0}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-zinc-500 flex items-center gap-1.5"><Box size={11}/> 物理帧率 (FPS)</span>
                <span className="text-zinc-300 font-mono bg-zinc-900 px-1.5 py-0.5 rounded">{media.fps || '--'}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-zinc-500 flex items-center gap-1.5"><Clock size={11}/> 总时长</span>
                <span className="text-zinc-300 font-mono bg-zinc-900 px-1.5 py-0.5 rounded">
                  {media.duration ? Number(media.duration).toFixed(2) : '--'}s
                </span>
              </div>
            </div>
          </div>

          {/* 动作区 */}
          <div className="flex flex-col gap-2 pt-2 border-t border-zinc-800">
            <Button variant="secondary" className="w-full justify-start h-7 text-[10px] bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-zinc-800" onClick={() => useEditorStore.getState().importNodeMedia()}>
              <RefreshCcw size={12} className="mr-2 text-zinc-500" />
              重新导入 / 替换媒体
            </Button>
            {/* 解除资产绑定按钮暂时隐藏，因为画布节点系统已移除，无 updateNodeData 可用 */}
          </div>
        </>
      )}

    </div>
  );
};
