import React from 'react';
import { useEditorStore } from '../../../../../store/useStore';
import { AppIcon } from '../../../../../components/app-icon';

interface AudioCompactViewProps {
  nodeId: string;
}

export const AudioCompactView: React.FC<AudioCompactViewProps> = ({ nodeId }) => {
  const node = useEditorStore((s) => s.nodes.find((n) => n.id === nodeId));
  const data = node?.data;

  // handleProgress 在 B3 修复后将结果存入 data.results
  // 兼容旧数据：读取 data.vocalPath / data.results.vocalPath
  const r = data?.results || data;
  const hasVocal = !!r?.vocalPath;
  const hasBgm = !!r?.bgmPath;

  if (!data || (!hasVocal && !hasBgm)) {
    return (
      <div className="text-center p-2">
        <AppIcon name="Activity" size={14} className="mx-auto text-zinc-500 mb-1" />
        <span className="text-[10px] text-zinc-500">等待分离</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-1">
      {hasVocal && (
        <div className="flex items-center gap-1.5 p-1.5 bg-black/20 rounded border border-gray-800">
          <AppIcon name="Mic" size={12} className="text-green-400 shrink-0" />
          <span className="text-[10px] text-zinc-300 truncate">人声轨道</span>
        </div>
      )}
      {hasBgm && (
        <div className="flex items-center gap-1.5 p-1.5 bg-black/20 rounded border border-gray-800">
          <AppIcon name="Music" size={12} className="text-blue-400 shrink-0" />
          <span className="text-[10px] text-zinc-300 truncate">伴奏轨道</span>
        </div>
      )}
    </div>
  );
};