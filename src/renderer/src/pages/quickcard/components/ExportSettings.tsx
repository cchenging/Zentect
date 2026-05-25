/** V1.3: 导出设置面板（RightPanel 嵌入组件，占位）
 *  后续迭代补全导出参数配置
 */

import React from 'react';
import { Settings2 } from 'lucide-react';

interface ExportSettingsProps {
  projectId: string;
}

export const ExportSettings: React.FC<ExportSettingsProps> = ({ projectId: _projectId }) => {
  return (
    <div className="flex flex-col gap-4 h-full">
      <h3 className="text-sm font-medium">导出设置</h3>
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-2">
          <Settings2 size={28} className="text-muted-foreground/40 mx-auto" />
          <p className="text-xs text-muted-foreground">更多导出选项即将上线</p>
          <p className="text-xs text-muted-foreground/60">
            当前使用默认导出参数：1080p / H.264 / AAC
          </p>
        </div>
      </div>
    </div>
  );
};