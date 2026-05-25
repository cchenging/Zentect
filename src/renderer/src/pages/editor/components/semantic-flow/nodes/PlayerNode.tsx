// 📁 路径：src/renderer/src/pages/editor/components/semantic-flow/nodes/PlayerNode.tsx
import React, { useMemo, useRef, useEffect, useState } from 'react';
import { useNodeConnections, useNodesData, useReactFlow } from '@xyflow/react';
import { Play, Pause, Volume2, VolumeX, Maximize, MonitorPlay } from 'lucide-react';
import { useEditorStore } from '../../../../../store/useStore';
import { getSafeMediaUrl } from '../../../../../utils/formatUrl';
import { BaseNode } from './BaseNode';
import { NODE_STATUS } from '../../../../../store/constants';
import { useI18n } from '../../../../../store/useI18n';
import { NODE_MENU_CONFIG } from '../../../config/nodeMenu';

export const PlayerNode = ({ id, selected, data: _data }) => {
  const { mediaItems } = useEditorStore();
  const { t } = useI18n();
  const pn = t.nodes?.player || {};
  const { setNodes } = useReactFlow(); 
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerContainerRef = useRef<HTMLDivElement>(null);
  
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);

  const config = NODE_MENU_CONFIG.flatMap(c => c.items).find(i => i.type === 'playerNode');
  const Icon = config?.icon || MonitorPlay;

  const connections = useNodeConnections({ type: 'target' } as any);
  const sourceNodeData = useNodesData(connections[0]?.source);
  const sourceNodes = useEditorStore(s => s.nodes);
  const _edges = useEditorStore(s => s.edges);
  void _edges;
  const mediaArray = Array.isArray(mediaItems) ? mediaItems : [];
  
  const media = useMemo(() => {
    // 1. 优先从上游节点的 mediaId 查找
    const mediaId = sourceNodeData?.data?.mediaId;
    if (mediaId) {
      const found = mediaArray.find(m => m.id === mediaId);
      if (found) return found;
    }

    // 2. 从上游节点的 results 中查找媒体路径
    const upstreamResults = sourceNodeData?.data?.results;
    if ((upstreamResults as any)?.mediaPath || (upstreamResults as any)?.filePath) {
      return {
        id: 'upstream',
        filePath: (upstreamResults as any).mediaPath || (upstreamResults as any).filePath,
        name: (upstreamResults as any).fileName || '上游数据',
      } as any;
    }

    // 3. 回溯到第一个 SourceNode 获取媒体
    const sourceNode = sourceNodes.find(n => n.type === 'sourceNode' && n.data?.mediaId);
    if (sourceNode?.data?.mediaId) {
      return mediaArray.find(m => m.id === sourceNode.data.mediaId) || null;
    }

    return null;
  }, [sourceNodeData, mediaArray, sourceNodes]);

  const videoUrl = getSafeMediaUrl(media?.filePath);

  const handleVideoMetadata = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const video = e.currentTarget;
    const ratio = video.videoWidth / video.videoHeight;
    const targetWidth = config?.defaultWidth || 320; 
    const targetHeight = targetWidth / ratio;

    setNodes((nds) => 
      nds.map((node) => {
        if (node.id === id) return { ...node, style: { ...node.style, width: targetWidth, height: targetHeight + 36 } };
        return node;
      })
    );
  };

  useEffect(() => {
    if (videoRef.current && videoUrl) {
      videoRef.current.load();
      videoRef.current.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
    }
  }, [videoUrl]);

  useEffect(() => {
    if (videoRef.current) {
      if (isPlaying) videoRef.current.play().catch(() => setIsPlaying(false));
      else videoRef.current.pause();
    }
  }, [isPlaying]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = isMuted ? 0 : volume;
  }, [volume, isMuted]);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement && playerContainerRef.current) {
      playerContainerRef.current.requestFullscreen().catch(err => console.error(err));
    } else if (document.fullscreenElement) {
      document.exitFullscreen();
    }
  };

  const DisplayCore = (
    <div ref={playerContainerRef} className="w-full h-full bg-black relative flex items-center justify-center group overflow-hidden rounded-b-md">
       {media ? (
         videoUrl ? (
           <video 
             ref={videoRef} src={videoUrl} className="w-full h-full object-contain" 
             autoPlay={isPlaying} muted={isMuted} loop playsInline /* 💥 增加 playsInline 提升兼容性 */
             onPlay={() => setIsPlaying(true)} onPause={() => setIsPlaying(false)}
             onLoadedMetadata={handleVideoMetadata} 
           />
          ) : (<div className="text-primary/80 font-mono text-[10px] animate-pulse tracking-widest">{pn.signal_waiting || '信号连接中...'}</div>)
       ) : (
         <div className="flex flex-col items-center gap-2 opacity-50">
           <span className="text-[10px] font-mono tracking-widest text-zinc-400">{pn.no_input || '未连接输入源'}</span>
         </div>
       )}
      
      {media && videoUrl && (
      <div className="absolute bottom-0 left-0 right-0 p-2 bg-gradient-to-t from-black/90 via-black/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200">
        <div className="flex items-center justify-between gap-2">
          <button onClick={() => setIsPlaying(!isPlaying)} className="p-1.5 hover:bg-white/20 rounded-md transition-colors text-white">
            {isPlaying ? <Pause size={14} /> : <Play size={14} />}
          </button>
          
          <div className="flex items-center gap-2 flex-1">
            <button onClick={() => setIsMuted(!isMuted)} className="p-1 hover:bg-white/20 rounded-md transition-colors text-white">
              {isMuted ? <VolumeX size={12} /> : <Volume2 size={12} />}
            </button>
            <input 
              type="range" min="0" max="1" step="0.1" value={isMuted ? 0 : volume}
              onChange={(e) => { setVolume(parseFloat(e.target.value)); setIsMuted(false); }}
              className="flex-1 h-1 bg-white/30 rounded-lg appearance-none cursor-pointer accent-white"
            />
          </div>
          <button onClick={toggleFullscreen} className="p-1.5 hover:bg-white/20 rounded-md transition-colors text-white ml-1">
            <Maximize size={14} />
          </button>
        </div>
      </div>
      )}
    </div>
  );

  return (
    <BaseNode
      id={id} selected={selected} 
      title={pn.title || '预览监视器'}
      icon={<Icon size={16} />}
      accent="rose"
      variant="player"
      themeColor={config?.color}
      themeBg={config?.bg}
      width={config?.defaultWidth || 320}
      status={media ? NODE_STATUS.SUCCESS : NODE_STATUS.IDLE}
      inputs={true} outputs={false as any}
      contentClassName="p-0 rounded-xl overflow-hidden flex-1 h-full flex flex-col"
    >
      {DisplayCore}
    </BaseNode>
  );
};
