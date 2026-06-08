// 📁 路径：src/renderer/src/pages/editor/components/left-panel/index.tsx
import React from 'react';
import { useEditorStore } from '../../../../store/useStore';

import { MediaPool } from './MediaPool';
import { AIAssets } from './AIAssets';
import { Storyboard } from './Storyboard';
import { WorkflowList } from './WorkflowList';
import { AudioPool } from './AudioPool';
import { TextPool } from './TextPool';
import { AICasting } from './AICasting';

/**
 * 左侧面板：受控宽度截断
 * 根据 leftPanelOpen 的值直接把外壳宽度归零，实现丝滑折叠
 */
export const LeftPanel: React.FC = () => {
  const { leftTab, leftPanelOpen, leftPanelWidth } = useEditorStore();

  return (
    <div 
      className="bg-zinc-900 border-r border-white/5 flex flex-col h-full transition-all duration-300 ease-in-out overflow-hidden"
      style={{ width: leftPanelOpen ? leftPanelWidth || 260 : 0 }}
    >
      <div className="w-[260px] h-full flex flex-col"> 
        {leftTab === 'workflow' && <WorkflowList />}
        {leftTab === 'media' && <MediaPool />}
        {leftTab === 'aiAssets' && <AIAssets />}
        {leftTab === 'storyboard' && <Storyboard />}
        {leftTab === 'audio' && <AudioPool />}
        {leftTab === 'text' && <TextPool />}
        {leftTab === 'casting' && <AICasting />}
        {leftTab === 'narration' && <div className="p-4 text-zinc-500 text-sm">旁白管理开发中...</div>}
      </div>
    </div>
  );
};
