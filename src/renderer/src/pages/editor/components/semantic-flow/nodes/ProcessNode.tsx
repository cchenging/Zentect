import { Cpu, CheckCircle2 } from 'lucide-react';
import { BaseNode } from './BaseNode';
import { useEditorStore } from '../../../../../store/useStore';
import { useI18n } from '../../../../../store/useI18n';

import { FrameCompactView } from '../views/FrameCompactView';
import { AudioCompactView } from '../views/AudioCompactView';

import { FrameExtractConfig } from '../../inspectors/configs/FrameExtractConfig';
import { AudioSeparateConfig } from '../../inspectors/configs/AudioSeparateConfig';
import { Handle, Position } from '@xyflow/react';

// 辅助：从 data 或 data.results 读取结果字段
const getResult = (data: any, key: string, fallback: any = undefined) => {
  return data?.results?.[key] ?? data?.[key] ?? fallback;
};

export const ProcessNode = ({ id, data, selected }) => {
  const updateNodeData = useEditorStore((s) => s.updateNodeData);
  const { t } = useI18n();
  const nt = t.nodes?.process || {};
  const ntSource = t.nodes?.source || {};
  void ntSource;

  const renderCompactView = () => {
    const noConfig = <div className="flex items-center justify-center min-h-[36px] text-[10px] text-zinc-500">{nt.no_config || '等待配置'}</div>;
    const hasResults = data?.results && Object.keys(data.results).length > 0;

    switch (data.actionType) {
      case 'vision-extract':
      case 'frame-extract':
        if (hasResults) {
          const count = getResult(data, 'framesCount');
          const desc = getResult(data, 'sceneDescriptions');
          return (
            <div className="flex flex-col gap-1 p-1 text-[10px]">
              <div className="flex items-center gap-1.5 text-green-400/80">
                <CheckCircle2 size={10} />
                <span>{nt.result_frames?.replace('{count}', String(count || 0)) || `${count || 0} 帧已提取`}</span>
              </div>
              {desc && <span className="text-zinc-400 truncate">{desc.slice(0, 40)}...</span>}
            </div>
          );
        }
        return <FrameCompactView nodeId={id} />;
      case 'audio-separate':
        return <AudioCompactView nodeId={id} />;
      case 'asr':
        if (hasResults) {
          const transcript = getResult(data, 'transcript') || getResult(data, 'textData');
          return (
            <div className="flex flex-col gap-0.5 p-1 text-[10px]">
              <div className="flex items-center gap-1.5 text-green-400/80">
                <CheckCircle2 size={10} />
                <span>{nt.result_asr_done || '识别完成'}</span>
              </div>
              {transcript && <span className="text-zinc-400 truncate">{String(transcript).slice(0, 40)}...</span>}
            </div>
          );
        }
        return (
          <div className="flex items-center justify-between px-1 py-1 text-[10px]">
            <span className="text-zinc-500">模型</span>
            <span className="text-zinc-300 font-medium">{data.params?.modelSize || 'base'}</span>
          </div>
        );
      case 'face-detect': {
        const faceCount = getResult(data, 'faceCount');
        return (
          <div className="flex items-center gap-2 px-1 py-1 text-[10px]">
            <span className="w-2 h-2 rounded-full bg-purple-400/60" />
            <span className="text-zinc-400">{faceCount != null ? `${faceCount}${nt.face_result?.replace('{count}', '') || ' 人脸'}` : (nt.face_detect || '待检测')}</span>
          </div>
        );
      }
      case 'semantic-analyze': {
        const segments = getResult(data, 'segments');
        return (
          <div className="flex items-center justify-between px-1 py-1 text-[10px]">
            <span className="text-zinc-500">语义</span>
            <span className="text-zinc-300">{segments?.length || 0} {nt.semantic_segments?.replace('{count}', '') || '段'}</span>
          </div>
        );
      }
      case 'sentiment-analyze': {
        const emotion = getResult(data, 'emotion');
        return (
          <div className="flex items-center justify-between px-1 py-1 text-[10px]">
            <span className="text-zinc-500">情感</span>
            <span className="text-zinc-300">{emotion || (nt.sentiment_waiting || '待分析')}</span>
          </div>
        );
      }
      case 'tts-synthesize':
        if (hasResults) {
          const dur = getResult(data, 'duration');
          return (
            <div className="flex items-center gap-1.5 p-1 text-[10px] text-green-400/80">
              <CheckCircle2 size={10} />
              <span>{dur ? (nt.tts_done_with_dur?.replace('{dur}', String(dur)) || `语音已生成 (${dur}s)`) : (nt.tts_done || '语音已生成')}</span>
            </div>
          );
        }
        return (
          <div className="flex items-center gap-2 px-1 py-1 text-[10px]">
            <span className="w-2 h-2 rounded-full bg-green-400/60" />
            <span className="text-zinc-300">{data.params?.voiceType || (nt.tts_default_voice || '默认音色')}</span>
          </div>
        );
      case 'llm-processor':
        if (hasResults) {
          const output = getResult(data, 'outputText');
          return (
            <div className="flex flex-col gap-0.5 p-1 text-[10px]">
              <div className="flex items-center gap-1.5 text-green-400/80">
                <CheckCircle2 size={10} />
                <span>{nt.llm_processor_done || '处理完成'}</span>
              </div>
              {output && <span className="text-zinc-400 truncate">{String(output).slice(0, 40)}...</span>}
            </div>
          );
        }
        return (
          <div className="flex items-center justify-between px-1 py-1 text-[10px]">
            <span className="text-zinc-500">模型</span>
            <span className="text-zinc-300 truncate max-w-[120px]">{data.params?.model || (nt.llm_default_model || 'deepseek-chat')}</span>
          </div>
        );
      default:
        return noConfig;
    }
  };

  const renderHandles = () => {
    return (
      <>
        <Handle type="target" position={Position.Left} id="in" className="w-4 h-4 bg-zinc-800 border-2 border-zinc-500 -ml-2" />
        <Handle type="source" position={Position.Right} id="out" className="w-4 h-4 bg-zinc-800 border-2 border-zinc-500 -mr-2" />
      </>
    );
  };

  const renderDetailConfig = () => {
    if (!selected) return null;

    switch (data.actionType) {
      case 'vision-extract':
      case 'frame-extract':
        return <FrameExtractConfig {...{ nodeId: id, data, updateParams: (params: any) => updateNodeData(id, { params }) } as any} />;
      case 'audio-separate':
        return <AudioSeparateConfig nodeId={id} data={data} updateParams={(params) => updateNodeData(id, { params })} />;
      default:
        return null;
    }
  };

  const DisplayCore = (
    <div className="flex flex-col px-1.5 py-1">
      {renderCompactView()}
    </div>
  );

  return (
    <BaseNode
      {...({
        id,
        selected,
        title: data.label || '算力处理',
        icon: <Cpu size={14} />,
        accent: data.accent,
        status: data.status,
        progress: data.progress,
        inspector: renderDetailConfig(),
        handles: renderHandles(),
        className: 'min-w-[240px]'
      } as any)}
    >
      {DisplayCore}
    </BaseNode>
  );
};
