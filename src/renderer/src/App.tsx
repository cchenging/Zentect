import React, { useEffect, Suspense } from 'react';
import { HashRouter, Routes, Route } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { AppLayout } from './layout/AppLayout';
// 🔧 启动性能修复：SettingsPage 改为懒加载，避免 vite 首次编译时
//    把整个 Settings 模块树（HealthPage 31KB + AITab 23KB + ModelTab 18KB）全部编译
//    之前是唯一同步导入的页面，导致 vite 编译耗时 100+ 秒
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
const Home = React.lazy(() => import('@modules/home').then(m => ({ default: m.HomeContainer })));
const Editor = React.lazy(() => import('@modules/editor'));
const ModelsPage = React.lazy(() => import('@modules/models'));
const UserSettingsPage = React.lazy(() => import('@modules/user-settings'));
// 🔧 修复：SettingsPage 也改为懒加载，与其它页面保持一致
const SettingsPage = React.lazy(() => import('@modules/settings/frontend').then(m => ({ default: m.Settings })));

function App() {
  const mode = useEditorStore((state) => state.mode);
  const hydrateUI = useEditorStore((state) => state.hydrateUI);

  // ⏱️ App 组件首次执行（render 阶段）
  if (!(window as any).__APP_RENDER) {
    (window as any).__APP_RENDER = performance.now();
    const t0 = (window as any).__BOOT_T0 || 0;
    const mainStart = (window as any).__MAIN_START || 0;
    console.log(`[BOOT] App() 首次 render | HTML→App render 总耗时 ${Math.round(performance.now() - t0)}ms | main.tsx→App 耗时 ${Math.round(performance.now() - mainStart)}ms`);
  }

  useEffect(() => {
    // ⏱️ App useEffect 触发（commit 阶段完成）
    if (!(window as any).__APP_COMMIT) {
      (window as any).__APP_COMMIT = performance.now();
      const t0 = (window as any).__BOOT_T0 || 0;
      console.log(`[BOOT] App useEffect 首次 commit | HTML→commit 总耗时 ${Math.round(performance.now() - t0)}ms`);
    }
    hydrateUI();
  }, []);

  useEffect(() => {
    // — 致命修复：双端同步！
    // 既修改 html 的 class (服务于 Tailwind v4 原生引擎)
    // 又修改 body 的 attribute (服务于我们写的 CSS 强压变量)
    const resolvedMode = mode === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : (mode || 'dark');
    const root = window.document.documentElement;
    root.classList.remove('light', 'dark');
    root.classList.add(resolvedMode);
    document.body.setAttribute('theme-mode', resolvedMode);
    // — 回写 localStorage，保持与预内联脚本同步
    localStorage.setItem('theme-mode', resolvedMode);
    // — 注入：主题切换追踪
    FrontendLogger.info('AppRoot', `System theme switched to: ${resolvedMode}`);

    if (mode === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const listener = (e: MediaQueryListEvent) => {
        const newMode = e.matches ? 'dark' : 'light';
        document.documentElement.classList.remove('light', 'dark');
        document.documentElement.classList.add(newMode);
        document.body.setAttribute('theme-mode', newMode);
      };
      mq.addEventListener('change', listener);
      return () => mq.removeEventListener('change', listener);
    }
  }, [mode]);

  // ==========================================================
  // — 引擎点火握手信号发射器
  // 🔧 修复黑屏：移除 requestAnimationFrame 包裹（窗口失焦时 raf 会暂停），
  //   改为同步发送 + try/catch 防止任何异常阻断握手信号
  // ==========================================================
  useEffect(() => {
    console.log('[AppRoot]握手useEffect触发');
    // 同步发送握手信号，避免 raf 在窗口失焦时暂停导致超时
    try {
      API.system.appIsReady();
      FrontendLogger.info('AppRoot', '=== Frontend React Engine Ready ===', FrontendLogger.generateTraceId());
      console.log('[AppRoot]握手信号已发送');
    } catch (err) {
      console.error('[AppRoot]握手信号发送失败:', err);
      // 即使握手失败也尝试发送原始 IPC，避免主进程永远等不到信号
      try { (window as any).api?.system?.appIsReady?.(); } catch {}
    }

    try {
      useTaskStore.getState().initIpcListeners();
    } catch (err) {
      console.error('[AppRoot]initIpcListeners失败:', err);
    }

    // 启动时检查用户会话有效性
    useUserStore.getState().checkSession().catch(err => console.error('[AppRoot]checkSession失败:', err));

    // 首次启动检测：无 API Key 时通过通知中心提示
    (async () => {
      try {
        // ⚡ 单次批量获取所有设置，消灭 3 次独立 getSetting IPC 调用
        const settings = await API.settingsExt.getAll().catch(() => ({}));
        const hasAnyKey = !!(settings.deepseekKey || settings.qwenKey || settings.doubaoKey || settings.openaiKey);
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
      try {
        useTaskStore.getState().cleanupIpcListeners();
      } catch (err) {
        console.error('[AppRoot]cleanupIpcListeners失败:', err);
      }
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
