// 📁 src/renderer/src/pages/editor/components/AppSidebar.tsx
import React, { useState, useRef, useMemo } from 'react';
import { Grid2X2, FolderOpen, Upload } from 'lucide-react';
import { WorkflowList } from './left-panel/WorkflowList';
import { MediaPool } from './left-panel/MediaPool';
import { VideoImport } from './VideoImport';
import { useI18n } from '../../../store/useI18n';
import { useEditorStore } from '../../../store/useStore';
import { NODE_MENU_CONFIG } from '../config/nodeMenu';

/**
 * 左侧悬空岛工具栏 - 包含工作流、素材库、导入媒体、AI节点菜单
 * PRD: 左侧导航栏包含 项目总览/媒体库/导入媒体/智能分析/AI剧本/TTS/导出
 */
export const AppSidebar = () => {
  const { t } = useI18n();
  const { projectId, setActivePlaySource } = useEditorStore();
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const hideTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const SIDEBAR_DATA: any[] = useMemo(() => [
    { id: 'workflow', label: t.sidebar?.workflow || '工作流', icon: Grid2X2, isComponent: true, Component: WorkflowList },
    { id: 'media', label: t.sidebar?.media || '媒体库', icon: FolderOpen, isComponent: true, Component: MediaPool },
    { id: 'import', label: '导入', icon: Upload, isComponent: true, Component: () => (
      <VideoImport
        projectId={projectId}
        onImportSuccess={(items) => {
          // 导入视频直接播放，不添加到素材区
          if (items.length > 0) setActivePlaySource(items[0]);
        }}
      />
    )},
    // 映射动态节点分类
    ...NODE_MENU_CONFIG.map(cat => ({
      id: cat.categoryId,
      label: t.editor?.nodes?.categories?.[cat.categoryId] || cat.categoryId,
      icon: cat.icon,
      isComponent: false,
      items: cat.items
    }))
  ], [t, projectId, setActivePlaySource]);

  const handleMouseEnter = (id: string) => {
    if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    setHoveredId(id);
  };

  const handleMouseLeave = () => {
    hideTimeoutRef.current = setTimeout(() => setHoveredId(null), 400);
  };

  const handleDragStart = (e: React.DragEvent, item: any) => {
    const label = t.editor?.nodes?.items?.[item.menuKey]?.title || item.menuKey;
    e.dataTransfer.setData('application/json', JSON.stringify({ type: item.type, label, data: item.data }));
    e.dataTransfer.effectAllowed = 'move';
  };

  return (
    <div
      className="relative flex flex-col items-center py-3 bg-black/80 backdrop-blur-3xl border border-white/10 rounded-2xl shadow-2xl w-[58px]"
      onMouseLeave={handleMouseLeave}
    >
      {SIDEBAR_DATA.map((item) => (
        <div
          key={item.id}
          className="relative w-full flex justify-center py-2.5 group cursor-pointer"
          onMouseEnter={() => handleMouseEnter(item.id)}
        >
          <div className={`flex flex-col items-center transition-all duration-200 ${
            hoveredId === item.id ? 'text-white' : 'text-white/60'
          }`}>
            <item.icon size={18} strokeWidth={1.8} />
            <span className="text-[9px] mt-1.5 font-bold tracking-wider">{item.label}</span>
          </div>

          {hoveredId === item.id && (
            <div className="absolute left-[58px] top-0 pl-[8px] z-50">
              <div className={`bg-[#0F0F11]/98 backdrop-blur-3xl border border-white/15 rounded-xl p-2 shadow-2xl animate-in fade-in zoom-in-95 duration-150 ${
                item.isComponent ? 'w-[280px] max-h-[75vh] overflow-y-auto' : 'w-44'
              }`}>
                {item.isComponent ? (
                  <item.Component />
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {item.items?.map(sub => (
                      <div
                        key={sub.menuKey}
                        draggable
                        onDragStart={(e) => handleDragStart(e, sub)}
                        className="flex items-center px-3 py-2.5 bg-white/5 border border-white/10 rounded-lg hover:bg-white/15 transition-all text-white text-[12px] font-medium"
                      >
                        {t.editor?.nodes?.items?.[sub.menuKey]?.title}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
};
