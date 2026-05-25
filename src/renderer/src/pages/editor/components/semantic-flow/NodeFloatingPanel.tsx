import React from 'react';
import { useEditorStore } from '../../../../store/useStore';
import { FrameExtractConfig } from '../inspectors/configs/FrameExtractConfig';
import { AudioSeparateConfig } from '../inspectors/configs/AudioSeparateConfig';
import { AudioParseConfig } from '../inspectors/configs/AudioParseConfig';
import { TTSConfig } from '../inspectors/configs/TTSConfig';
import { ScriptGenConfig } from '../inspectors/configs/ScriptGenConfig';
import { LLMProcessConfig } from '../inspectors/configs/LLMProcessConfig';

export const NodeFloatingPanel: React.FC = () => {
  const { activeNode, nodes, updateNodeData } = useEditorStore();
  const node = activeNode ? nodes.find(n => n.id === activeNode.id) : null;

  if (!node || !node.selected) return null;

  const data = node.data || {};
  const nodeId = node.id;

  const updateParams = (params: any) => updateNodeData(nodeId, { params });

  const renderConfig = () => {
    const actionType = data.actionType;
    switch (actionType) {
      case 'vision-extract':
      case 'frame-extract':
        return <FrameExtractConfig {...{ nodeId, data, updateParams } as any} />;
      case 'audio-separate':
        return <AudioSeparateConfig nodeId={nodeId} data={data} updateParams={updateParams} />;
      case 'asr':
        return <AudioParseConfig data={data} updateParams={updateParams} />;
      case 'script-gen':
        return <ScriptGenConfig data={data} updateParams={updateParams} />;
      case 'sentiment-analyze':
      case 'semantic-analyze':
        return <ScriptGenConfig data={data} updateParams={updateParams} />;
      case 'llm-processor':
        return <LLMProcessConfig node={node} />;
      case 'tts-synthesize':
        return <TTSConfig data={data} updateParams={updateParams} />;
      default:
        return null;
    }
  };

  const config = renderConfig();
  if (!config) return null;

  return (
    <div
      className="absolute left-1/2 -translate-x-1/2 z-40 mt-2 w-[260px] bg-zinc-900/95 backdrop-blur-xl border border-zinc-700/60 rounded-xl shadow-2xl p-3 animate-in fade-in slide-in-from-top-2 duration-200"
      style={{ pointerEvents: 'auto' }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between mb-2 pb-2 border-b border-zinc-800">
        <span className="text-[10px] font-bold text-zinc-400 tracking-wider uppercase">{data.label || '参数配置'}</span>
      </div>
      {config}
    </div>
  );
};
