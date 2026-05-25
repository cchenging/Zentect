import React from 'react';
import { useEditorStore } from '../../../../store/useStore';
import { Image as ImageIcon, MousePointerClick } from 'lucide-react';

export const AIAssets: React.FC = () => {
  const extractedFrames = useEditorStore(state => (state as any).extractedFrames || []);

  if (extractedFrames.length === 0) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center text-muted-foreground p-6 text-center space-y-3">
        <ImageIcon size={48} className="opacity-20" />
        <p className="text-sm">暂无 AI 切片</p>
        <p className="text-xs opacity-70">请在 [AI 导演] 中下达"抽帧"指令</p>
      </div>
    );
  }

  return (
    <div className="w-full h-full overflow-y-auto p-3">
      <div className="text-xs text-muted-foreground mb-3 flex items-center gap-2">
        <MousePointerClick size={14} /> 点击可快速将画面加入时间轴
      </div>
      <div className="grid grid-cols-2 gap-2">
        {extractedFrames.map((frame, index) => (
          <div 
            key={index} 
            className="group relative aspect-video bg-muted rounded-md overflow-hidden border border-border hover:border-primary cursor-pointer transition-colors"
            onClick={() => {
               const { addShotFromMedia } = useEditorStore.getState();
               addShotFromMedia({ coverPath: frame, id: `frame_${Date.now()}` }, 0);
            }}
          >
            <img src={frame} alt="AI Extracted" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
              <span className="text-white text-xs font-medium">加入轨道</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};