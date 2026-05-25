/** V1.3 A4: 占位步骤组件
 *  用于未上线的流程（video_narrate / text_narrate / batch）
 *  居中显示"即将上线"提示，左栏可回退，无下一步按钮和 RightPanel
 */

import React from 'react';
import { Construction } from 'lucide-react';

export const PlaceholderStep: React.FC = () => {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="flex flex-col items-center gap-4 text-center max-w-sm">
        <div className="w-20 h-20 rounded-2xl bg-muted/50 flex items-center justify-center">
          <Construction size={40} className="text-muted-foreground/40" />
        </div>
        <h2 className="text-xl font-semibold text-foreground">此功能即将上线</h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          我们正在全力开发中，敬请期待。你可以点击左侧已完成的步骤返回。
        </p>
      </div>
    </div>
  );
};