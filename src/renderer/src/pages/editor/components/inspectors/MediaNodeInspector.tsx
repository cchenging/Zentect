// 💥 局部更新：绑定真实的 importNodeMedia 动作
import { FileVideo, Monitor, Clock, RefreshCcw, Trash2, Box, Loader2, Plus } from 'lucide-react';
import { useEditorStore } from '../../../../store/useStore';
import { Button } from '../../../../components/ui/button';
import { getSafeMediaUrl } from '../../../../utils/formatUrl';

export const MediaNodeInspector = () => {
  const { mediaItems, activeNode, importNodeMedia, updateNodeData } = useEditorStore();
  
  if (!activeNode) return null;

  // 💥 防御性编程：确保 mediaItems 是数组
  const mediaArray = Array.isArray(mediaItems) ? mediaItems : [];
  
  const media = mediaArray.find(m => m.id === (activeNode as any).data?.mediaId);
  const isProcessing = (activeNode as any).data?.status === 'processing';

  // 💥 使用统一的 getSafeMediaUrl 工具函数处理封面图
  const coverUrl = getSafeMediaUrl(media?.coverPath || media?.thumbnail);

  return (
    // 💥 修复：移除原本用于侧边栏的 animate-in slide-in-from-right-4 动画类，交给基座统一控制出现动画，防止视觉抖动错位
    <div className="flex flex-col gap-5 p-1">
      
      {/* ================= 核心：局部条件渲染，而不是阻断整个组件 ================= */}
      {!media ? (
        // 🌟 状态 1：未导入视频时的局部空状态
        <div className="flex flex-col items-center justify-center p-6 bg-black/20 border border-dashed border-zinc-800 rounded-xl text-zinc-500 gap-3">
          {isProcessing ? <Loader2 size={32} className="opacity-50 animate-spin text-blue-400" /> : <FileVideo size={32} className="opacity-50" />}
          <span className="text-[12px]">{isProcessing ? '底层引擎拷贝与解析中...' : '尚未导入任何本地视频'}</span>
          <Button variant="outline" size="sm" disabled={isProcessing} onClick={() => importNodeMedia(activeNode.id)} className="mt-2 h-8 text-[11px] w-full">
            <Plus size={14} className="mr-2" /> 浏览本地文件...
          </Button>
        </div>
      ) : (
        // 🌟 状态 2：已导入视频时的真实数据展示
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
            <Button disabled={isProcessing} variant="secondary" className="w-full justify-start h-7 text-[10px] bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-zinc-800" onClick={() => importNodeMedia(activeNode.id)}>
              {isProcessing ? <Loader2 size={12} className="mr-2 animate-spin" /> : <RefreshCcw size={12} className="mr-2 text-zinc-500" />}
              重新导入 / 替换媒体
            </Button>
            <Button variant="ghost" className="w-full justify-start h-7 text-[10px] text-zinc-500 hover:text-rose-400 hover:bg-rose-500/10"
              onClick={() => updateNodeData(activeNode.id, { mediaId: null, status: 'idle', label: '媒体资产源' })}>
              <Trash2 size={12} className="mr-2" />
              解除资产绑定
            </Button>
          </div>
        </>
      )}
      {/* ========================================================================= */}

      {/* 👇 重点！！！
        请把你原本在这个面板里写的其他属性（比如音量控制、静音开关、画面裁剪设置等）
        原封不动地保留在这里！它们现在就不会因为没有媒体而被隐藏了。
      */}

    </div>
  );
};
