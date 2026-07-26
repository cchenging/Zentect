import React from 'react'
import { createRoot } from 'react-dom/client'
// 💥 致命修复 1：彻底删除了 import { HashRouter } from 'react-router-dom'
import App from './App'

// 确保您的 Tailwind 和自定义全局样式在组件库之后引入，以便实现覆盖和接管
import './index.css'

// ⏱️ 标记 main.tsx 开始执行（vite 编译完成的标志）
;(window as any).__MAIN_START = performance.now();
const bootT0 = (window as any).__BOOT_T0 || performance.now();
console.log(`[BOOT] main.tsx 开始执行 | vite 编译耗时 ${Math.round((performance.now() - bootT0))}ms`);

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(
    <React.StrictMode>
      {/* 💥 致命修复 2：剥离外层路由套娃，将控制权全权交还给 App.tsx！ */}
      <App />
    </React.StrictMode>
  );
  // ⏱️ 标记 React 挂载调用完成（不等于首屏可见）
  (window as any).__RENDER_MOUNT = performance.now();
  console.log(`[BOOT] root.render() 已调用 | main.tsx 总耗时 ${Math.round(performance.now() - (window as any).__MAIN_START)}ms`);
}
