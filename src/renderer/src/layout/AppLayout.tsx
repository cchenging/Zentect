// 📁 路径：src/renderer/src/layout/AppLayout.tsx
import React from 'react';
import { Outlet } from 'react-router-dom';
import { TitleBar } from '../components/title-bar';
import { AppSidebar } from './components/AppSidebar';
import { useEditorStore } from '../store/useStore';

/**
 * 全局应用布局
 * 左侧全高侧边栏贯穿整屏，右侧包含系统标题栏与业务内容渲染区
 * 支持侧边栏展开/收起切换
 */
export const AppLayout: React.FC = () => {
  const isSidebarExpanded = useEditorStore((s) => s.isSidebarExpanded);

  return (
    <div className="flex w-screen h-screen bg-bg-deep overflow-hidden text-foreground">

      {/* 左侧：全高侧边栏贯穿整屏，支持收起为 64px */}
      <AppSidebar
        className={`h-full border-r border-border/50 flex-shrink-0 transition-all duration-300 ease-smooth ${isSidebarExpanded ? 'w-[var(--sidebar-collapsed)]' : 'w-[var(--sidebar-width)]'}`}
      />

      {/* 右侧：包含系统标题栏与业务内容渲染区的复合区域 */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden bg-bg-primary">
        <TitleBar />

        {/* 业务页面出口，自带滚动条保护 */}
        <main className="flex-1 relative overflow-y-auto custom-scrollbar">
          <Outlet />
        </main>
      </div>

    </div>
  );
};
