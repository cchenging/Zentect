// 📁 路径：src/renderer/src/pages/editor/components/inspectors/AIProcessInspector.tsx
// 画布节点系统已移除，此组件改为占位提示
import { Settings2 } from 'lucide-react';

/**
 * AI 处理节点配置面板（占位组件）
 * 画布节点系统已移除，待后续重新设计后恢复
 */
export const AIProcessInspector = () => (
  <div className="flex flex-col items-center justify-center p-8 text-zinc-500 gap-3">
    <Settings2 size={32} className="opacity-50" />
    <span className="text-xs">AI 处理节点配置面板开发中</span>
  </div>
);
