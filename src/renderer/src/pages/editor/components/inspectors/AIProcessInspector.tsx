// 📁 路径：src/renderer/src/pages/editor/components/inspectors/AIProcessInspector.tsx
import { useState } from 'react';
import { useEditorStore } from '../../../../store/useStore';
import { useI18n } from '../../../../store/useI18n';
import { Play, Settings2, Loader2, Terminal } from 'lucide-react';
import { Button } from '../../../../components/ui/button';
import { AppNotifier } from '../../../../core/AppNotifier';
import { API } from '../../../../api';

import { FrameExtractConfig } from './configs/FrameExtractConfig';
import { AudioParseConfig } from './configs/AudioParseConfig';
import { AudioSeparateConfig } from './configs/AudioSeparateConfig';
import { ScriptGenConfig } from './configs/ScriptGenConfig';
import { TTSConfig } from './configs/TTSConfig';
import { LLMProcessConfig } from './configs/LLMProcessConfig';
import { DefaultInspector } from './DefaultInspector';

/**
 * 节点配置组件映射字典
 * Key: 节点的 label 标识
 * Value: 对应的配置面板组件
 * 未来新增节点类型只需在此添加一行映射，告别 switch-case
 */
const ConfigComponentMap: Record<string, React.FC<any>> = {
  'vision-extract': FrameExtractConfig,
  'frame-extract': FrameExtractConfig,
  'asr': AudioParseConfig,
  'audio-separate': AudioSeparateConfig,
  'script-gen': ScriptGenConfig,
  'sentiment-analyze': AudioParseConfig,
  'tts-synthesize': TTSConfig,
  'tts-generate': TTSConfig,
  'face-detect': DefaultInspector,
  'semantic-analyze': DefaultInspector,
  'llm-processor': LLMProcessConfig,
};

export const AIProcessInspector = () => {
  const { activeNode, nodes, updateNodeData, mediaItems: mediaItemsStore } = useEditorStore();
  const { t } = useI18n();
  const ins = t.inspector || {};
  const currentNode = nodes.find(n => n.id === activeNode?.id);
  const [localLoading, setLocalLoading] = useState(false); // 防止重复点击的本地锁
  
  // 💥 防御性编程：确保 mediaItems 是数组
  const mediaItems = Array.isArray(mediaItemsStore) ? mediaItemsStore : [];
  
  if (!currentNode) return null;
  const data = currentNode.data || {};
  const isProcessing = data.status === 'processing' || localLoading;

  const updateParams = (payload: any) => {
    updateNodeData(currentNode.id, { ...data, ...payload });
  };

  // 💥 核心：启动物理管线（使用封装好的 API）
  const handleStartTask = async () => {
    if (data.actionType !== 'vision-extract' && data.actionType !== 'frame-extract') return AppNotifier.info('当前节点暂未接入物理引擎');
    
    const media = mediaItems?.[0];
    if (!media) return AppNotifier.warn('请先导入视频资产并连接源节点！');

    setLocalLoading(true);
    // 1. 将画布节点状态设为 processing，触发 UI 绿色呼吸灯和进度条
    updateNodeData(currentNode.id, { status: 'processing', progress: 30 });
    
    try {
      // 💥 重构点：调用 API 网关，而不是直接调用 ipcRenderer
      const response = await API.engine.extractFrames((media.filePath || media.path || ''), data);

      if (response) {
        // 3. 拿到物理结果，回写到节点自身
        const shots = response;
        updateNodeData(currentNode.id, { 
          status: 'success', 
          progress: 100, 
          results: shots // 将抽帧结果永久挂载在节点上
        });
        
        // 4. [可选] 如果该节点已经连入了 Player，立即触发监视器胶片带更新
        useEditorStore.getState().setActiveShots(shots); 
        
        AppNotifier.success(`物理抽帧完成！共提取 ${shots.length} 个镜头。`);
      } else {
        throw new Error('抽帧失败');
      }
    } catch (err: any) {
      updateNodeData(currentNode.id, { status: 'error', progress: 0 });
      AppNotifier.error(`引擎宕机: ${err.message}`);
    } finally {
      setLocalLoading(false);
    }
  };

  const renderSpecificConfig = () => {
    const currNode = currentNode;
    const ConfigComponent = ConfigComponentMap[data.actionType] || DefaultInspector;
    return <ConfigComponent nodeId={currNode?.id} data={data} updateParams={updateParams} />;
  };

  return (
    <div className="flex flex-col gap-5 animate-in fade-in duration-300 h-full pb-4">
      {/* --- 头部状态卡片 --- */}
      <div className={`border p-3 rounded-lg flex items-center justify-between shrink-0 transition-colors ${
        data.status === 'error' ? 'bg-red-500/10 border-red-500/30' : 
        isProcessing ? 'bg-emerald-500/10 border-emerald-500/30' : 
        'bg-blue-500/5 border-blue-500/20'
      }`}>
         <div className="flex flex-col">
            <span className={`text-[9px] uppercase tracking-widest ${
              data.status === 'error' ? 'text-red-400' : isProcessing ? 'text-emerald-400' : 'text-blue-400/80'
            }`}>
               {data.status === 'error' ? (ins.header_error || '引擎宕机') : isProcessing ? (ins.header_busy || '算力全开') : (ins.header_idle || '节点身份')}
            </span>
            <span className="text-[12px] font-bold text-zinc-100">{data.label || '算力节点'}</span>
         </div>
         {isProcessing ? <Loader2 size={14} className="text-emerald-400 animate-spin" /> : <Settings2 size={14} className="text-zinc-500" />}
      </div>

      {/* --- 深度参数配置区 --- */}
      <div className={`flex-1 overflow-y-auto space-y-4 pr-1 transition-opacity ${isProcessing ? 'opacity-50 pointer-events-none' : 'opacity-100'}`} style={{ scrollbarWidth: 'none' }}>
         {renderSpecificConfig()}
      </div>

      {/* 🌟 全局动作执行台 */}
      <div className="pt-6 border-t border-zinc-800/80 mt-6">
        <div className="bg-black/50 border border-zinc-800/80 rounded-lg p-3 font-mono text-[10px] text-zinc-500 mb-4 h-24 overflow-y-auto">
          <div className="flex items-center gap-2 mb-2 text-zinc-400">
              <Terminal size={12} /> {ins.terminal_log || '引擎调度日志'}
          </div>
          {isProcessing ? (
            <div className="text-emerald-500/80 animate-pulse">{ins.terminal_running || '> System: Allocation...'}</div>
          ) : data.status === 'success' ? (
            <div className="text-blue-400/80">{ins.terminal_success || '> Process finished with exit code 0.'}</div>
          ) : (
            <div>{ins.terminal_ready || '> System: Ready.'}</div>
          )}
        </div>

        <Button 
          onClick={handleStartTask} 
          disabled={isProcessing}
          className="w-full h-10 bg-zinc-100 text-black hover:bg-white font-bold text-[12px] tracking-wide rounded-md shadow-[0_0_15px_rgba(255,255,255,0.1)] transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isProcessing ? <Loader2 size={14} className="animate-spin text-black" /> : <Play size={14} className="fill-black" />}
          {isProcessing ? (ins.btn_executing || '引擎运转中 (Processing)') : (ins.btn_execute || '启动任务 (Execute)')}
        </Button>
      </div>

    </div>
  );
};