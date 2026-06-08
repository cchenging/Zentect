// 📁 路径: src/renderer/src/pages/editor/components/left-panel/TextPool.tsx
import React from 'react';
import { useEditorStore } from '../../../../store/useStore';

export const TextPool: React.FC = () => {
  // 💥 单职责：仅收听大减法并线后的 extractedData.asrLines 数据源，解耦原本对 NodeStatus 的强绑定
  const asrLines = useEditorStore((state) => state.extractedData?.asrLines || []);
  const isRunning = useEditorStore((state) => state.pipelineRunning);
  const progress = useEditorStore((state) => state.pipelineProgress);

  return (
    <div className="flex-1 flex flex-col h-full bg-[#111111] p-4 overflow-hidden">
      <div className="text-sm font-bold text-gray-300 mb-3 flex items-center justify-between">
        <span>语音识别 (ASR) 增量资产池</span>
        {isRunning && <span className="text-xs text-[#E63946] animate-pulse">电波接收中 {progress}%</span>}
      </div>

      <div className="flex-1 overflow-y-auto border border-[#1F1F1F] bg-[#0A0A0A] rounded-xl p-3 space-y-3 custom-scrollbar">
        {asrLines.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-xs text-gray-500 space-y-2">
            <span>{isRunning ? '本地大模型正在全力转录中，请耐心等待...' : '暂无语音转写数据，请点击右下角运行分析'}</span>
          </div>
        ) : (
          asrLines.map((line: any, index: number) => (
            <div
              key={index}
              className="group p-2 rounded-lg bg-[#141414] hover:bg-[#1A1A1A] border border-[#1F1F1F] transition-all flex flex-col space-y-1"
            >
              <div className="text-[10px] font-mono text-[#E63946] font-bold">
                [{line.startTime || line[0]}s - {line.endTime || line[1]}s]
              </div>
              <div className="text-xs text-gray-300 leading-relaxed select-text">
                {line.text || line[2]}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default TextPool;
