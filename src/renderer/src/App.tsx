import React, { useEffect, Suspense } from 'react';
import { HashRouter, Routes, Route } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { AppLayout } from './layout/AppLayout';
import { Settings as SettingsPage } from './pages/settings';
import { IPCBridge } from './core/IPCBridge';
import { useEditorStore } from './store/useStore';
import { API } from './api';
import { FrontendLogger } from './utils/logger';
import { useTaskStore } from './store/useTaskStore';
import { GlobalToaster } from './components/global-toaster';
import { ErrorBoundary } from './components/error-boundary';
import { AuthModal } from './components/auth-modal';
import { useUserStore } from './store/useUserStore';
import { useNotificationCenter } from './services/NotificationCenter';

// ==========================================================
// — S-Tier 优化：路由懒加载 (Code Splitting)
// 将工作台和重型剪辑器的 JS 物理分卷，极大提升首屏解析速度！
// ==========================================================
const Home = React.lazy(() => import('./pages/home').then(m => ({ default: m.Home })));
const Editor = React.lazy(() => import('./pages/editor'));
const ModelsPage = React.lazy(() => import('./pages/models'));
const UserSettingsPage = React.lazy(() => import('./pages/user-settings'));

function App() {
  const theme = useEditorStore((state) => state.theme);

  useEffect(() => {
    // — 致命修复：双端同步！
    // 既修改 html 的 class (服务于 Tailwind v4 原生引擎)
    // 又修改 body 的 attribute (服务于我们写的 CSS 强压变量)
    const root = window.document.documentElement;
    root.classList.remove('light', 'dark');
    root.classList.add(theme);
    document.body.setAttribute('theme-mode', theme);
    // — 注入：主题切换追踪
    FrontendLogger.info('AppRoot', `System theme switched to: ${theme}`);
  }, [theme]);

  // ==========================================================
  // — 引擎点火握手信号发射器
  // ==========================================================
  useEffect(() => {
    requestAnimationFrame(() => {
      API.system.appIsReady();
      FrontendLogger.info('AppRoot', '=== Frontend React Engine Ready ===', FrontendLogger.generateTraceId());
    });

    useTaskStore.getState().initIpcListeners();

    // 启动时检查用户会话有效性
    useUserStore.getState().checkSession();

    // 首次启动检测：无 API Key 时通过通知中心提示
    (async () => {
      try {
        const deepseek = await API.system.getSetting('ai.deepseekKey', '');
        const qwen = await API.system.getSetting('ai.qwenKey', '');
        const doubao = await API.system.getSetting('ai.doubaoKey', '');
        const hasAnyKey = !!(deepseek || qwen || doubao);
        if (!hasAnyKey) {
          useNotificationCenter.getState().addNotification({
            title: '欢迎使用 Zentect',
            message: '请先配置 AI 服务的 API Key，即可开始创作',
            level: 'info',
            actions: [{ label: '去配置', intent: 'navigate', payload: { path: '/settings' } }],
          });
        }
      } catch {}
    })();

    return () => {
      useTaskStore.getState().cleanupIpcListeners();
    };
  }, []);

  return (
    <ErrorBoundary>
      <IPCBridge />
      <GlobalToaster />
      <AuthModal />
      <HashRouter>
        <Suspense fallback={
          <div className="h-screen w-screen bg-background flex items-center justify-center">
            <div className="flex flex-col items-center gap-3">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
              <span className="text-xs text-muted-foreground">加载中...</span>
            </div>
          </div>
        }>
          <Routes>
            <Route path="/" element={<AppLayout />}>
              <Route index element={<Home />} />
              <Route path="models" element={<ModelsPage />} />
            </Route>
            <Route path="/editor/:id" element={<Editor />} />
            <Route path="/editor/new" element={<Editor />} />

            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/user-settings" element={<UserSettingsPage />} />
          </Routes>
        </Suspense>
      </HashRouter>
    </ErrorBoundary>
  );
}

export default App;
