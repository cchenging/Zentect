// 💥 增量更新 3：瘦身后的视图层，严守单一职责原则
import { useEffect, useRef, useState } from 'react';
import { addEdge, type Connection } from '@xyflow/react';
import { useEditorStore } from '../../../../store/useStore';
import { Search } from 'lucide-react';
import LOCALE from '../../../../../../shared/locales/zh-CN';
// 引入统一管理的配置文件
import { NODE_MENU_CONFIG, ACCENT_COLORS, type NodeMenuItem } from '../../config/nodeMenu';

export const NodePicker = ({ config, onClose, rfInstance }: any) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [smartPos, setSmartPos] = useState({ top: 0, left: 0, opacity: 0 });

  useEffect(() => {
    if (config && menuRef.current) {
      const { innerWidth: winW, innerHeight: winH } = window;
      const { offsetWidth: menuW, offsetHeight: menuH } = menuRef.current;
      let top = config.y;
      let left = config.x;
      if (top + menuH > winH) top = winH - menuH - 20;
      if (left + menuW > winW) left = winW - menuW - 20;
      setSmartPos({ top, left, opacity: 1 });
    }
  }, [config]);

  const handleAddNode = (item: NodeMenuItem) => {
    const position = rfInstance ? rfInstance.screenToFlowPosition({ x: config.x, y: config.y }) : { x: config.flowX, y: config.flowY };
    const newNodeId = `n-${crypto.randomUUID().slice(0, 8)}`;

    // 动态提取统一字典中的真实文案，兜底使用内置 label
    const i18nData = LOCALE.editor?.nodes?.items?.[item.menuKey];
    const realTitle = i18nData?.title || item.data.label || item.type;

    // 💥 1. 获取该节点定义的 accent 颜色
    const accentKey = item.data.accent || 'purple';
    const strokeColor = ACCENT_COLORS[accentKey] || ACCENT_COLORS.purple;

    const newNode = {
      id: newNodeId,
      type: item.type,
      position,
      data: { ...item.data, title: realTitle },
      style: { width: item.defaultWidth }
    };

    useEditorStore.setState((state: any) => {
      const updatedNodes = [...state.nodes, newNode];
      let updatedEdges = state.edges;

      if (config.sourceNodeId) {
        // 💥 规范 2.1：严格构造官方 Connection 对象
        const connectionParams: Connection = {
          source: config.sourceNodeId,
          sourceHandle: config.sourceHandleId || null,
          target: newNodeId,
          targetHandle: null // 允许空目标端口，ReactFlow 会自动寻找最近的 default 端口
        };

        // 💥 规范 2.2：定义连线视觉属性
        const edgeOptions = {
          type: 'smoothstep',
          animated: true,
          style: { 
            stroke: strokeColor, 
            strokeWidth: 3,
            filter: `drop-shadow(0 0 3px ${strokeColor}44)` 
          }
        };

        // 💥 规范 2.3：使用官方 addEdge 方法合成新状态！这能 100% 通过底层拓扑校验
        updatedEdges = addEdge({ ...connectionParams, ...edgeOptions }, state.edges);
      }

      return { nodes: updatedNodes, edges: updatedEdges };
    });

    onClose();
  };

  if (!config) return null;

  return (
    <div 
      ref={menuRef}
      style={{ top: smartPos.top, left: smartPos.left, opacity: smartPos.opacity }}
      className="fixed z-[9999] w-[280px] bg-[#0C0C0E]/95 backdrop-blur-3xl border border-white/10 rounded-2xl shadow-[0_20px_60px_rgba(0,0,0,0.8)] overflow-hidden transition-all duration-200"
    >
      <div className="p-3 border-b border-white/5 bg-white/[0.02] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Search size={14} className="text-zinc-500" />
          <span className="text-[10px] font-black text-zinc-400 tracking-[0.2em] uppercase">
            {LOCALE.editor?.nodes?.picker?.title || 'Add Node'}
          </span>
        </div>
      </div>

      <div className="flex flex-col max-h-[450px] overflow-y-auto custom-scrollbar p-1.5">
        {NODE_MENU_CONFIG.map((category) => (
          <div key={category.categoryId} className="mb-2 last:mb-0">
            {/* 动态读取分类标题 */}
            <div className="px-3 py-1.5 text-[10px] font-bold text-zinc-500 tracking-wider">
              {LOCALE.editor?.nodes?.categories?.[category.categoryId] || category.categoryId}
            </div>
            
            <div className="flex flex-col gap-0.5">
              {category.items.map((item) => {
                const i18nItem = LOCALE.editor?.nodes?.items?.[item.menuKey];
                return (
                  <button
                    key={item.menuKey}
                    onClick={() => handleAddNode(item)}
                    className="flex items-center gap-3 w-full p-2 rounded-xl hover:bg-white/[0.06] active:bg-white/[0.02] transition-all group text-left"
                  >
                    <div className={`w-8 h-8 rounded-lg ${item.bg} ${item.color} flex items-center justify-center group-hover:scale-110 transition-transform shadow-inner border border-white/5`}>
                      <item.icon size={16} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[12px] font-medium text-zinc-200 group-hover:text-white transition-colors">
                        {i18nItem?.title || item.menuKey}
                      </div>
                      <div className="text-[10px] text-zinc-500 truncate mt-0.5">
                        {i18nItem?.desc || '...'}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
