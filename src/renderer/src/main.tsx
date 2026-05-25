import React from 'react'
import { createRoot } from 'react-dom/client' 
// 💥 致命修复 1：彻底删除了 import { HashRouter } from 'react-router-dom'
import App from './App'

// 确保您的 Tailwind 和自定义全局样式在组件库之后引入，以便实现覆盖和接管
import './index.css'

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(
    <React.StrictMode>
      {/* 💥 致命修复 2：剥离外层路由套娃，将控制权全权交还给 App.tsx！ */}
      <App />
    </React.StrictMode>
  );
}
