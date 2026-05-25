// 📁 路径：src/renderer/src/layout/AppLayout.tsx
import React from 'react';
import { Outlet } from 'react-router-dom';
import { TitleBar } from '../components/title-Bar';
import { AppSidebar } from './components/AppSidebar';

/**
 * 全局应用布局
 * 左侧全高侧边栏贯穿整屏，右侧包含系统标题栏与业务内容渲染区
 */
export const AppLayout: React.FC = () => {
  return (
    <div className="flex w-screen h-screen bg-bg-deep overflow-hidden text-foreground">

      {/* 左侧：全高侧边栏贯穿整屏 */}
      <AppSidebar className="w-[210px] h-full border-r border-border/50 flex-shrink-0" />

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
