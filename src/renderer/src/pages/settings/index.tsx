// 📁 路径：src/renderer/src/pages/settings/index.tsx
// 设置页 - V3 设计系统风格
import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { FolderOpen, Server, Download, Heart, ChevronLeft } from 'lucide-react';
import { useSettingsManager } from './hooks/useSettingsManager';
import { AITab } from './components/AITab';
import { GeneralTab } from './components/GeneralTab';
import { ModelTab } from './components/ModelTab';
import { HealthPage } from './components/HealthPage';
import { Button } from '../../components/ui/button';
import { useI18n } from '../../store/useI18n';
import { API } from '../../api';
import { WindowControls } from '../../components/window-controls';

export const Settings: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useI18n();
  const {
    config, activeTab, setActiveTab, updateConfig, saveConfig,
    testAIConnection, testTTS, isTesting, isSaving, modelPool
  } = useSettingsManager();

  useEffect(() => {
    API.system.resizeWindow(1440, 900).catch(console.error);
  }, []);

  if (!config) {
    return <div className="w-screen h-screen bg-bg-deep flex items-center justify-center text-muted-foreground">加载配置中...</div>;
  }

  /** 设置标签页定义 - V3 原型4标签 */
  const TABS = [
    { id: 'general', label: '通用', icon: FolderOpen, color: 'text-accent' },
    { id: 'ai', label: 'AI 服务', icon: Server, color: 'text-accent-cyan' },
    { id: 'models', label: '模型管理', icon: Download, color: 'text-accent-purple' },
    { id: 'health', label: '健康检查', icon: Heart, color: 'text-accent-green' },
  ] as const;

  /** 保存配置并返回 */
  const handleSave = async () => {
    const success = await saveConfig();
    if (success) navigate(-1);
  };

  return (
    <div className="w-screen h-screen bg-bg-deep flex flex-col text-foreground">
      {/* 顶部栏 */}
      <div className="h-[41px] border-b border-border/50 flex items-center justify-between px-4 bg-bg-deep/80 backdrop-blur-sm select-none [-webkit-app-region:drag]">
        <div className="flex items-center gap-3 [-webkit-app-region:no-drag]">
          <button onClick={() => navigate(-1)} className="text-muted-foreground hover:text-foreground transition-colors outline-none cursor-pointer">
            <ChevronLeft size={20} />
          </button>
          <span className="font-semibold text-sm tracking-widest text-foreground">偏好设置</span>
        </div>

        <div className="[-webkit-app-region:no-drag]">
          <WindowControls
            btnClassName="h-8 w-8 flex items-center justify-center bg-transparent border-none text-muted-foreground rounded-md transition-colors cursor-pointer outline-none"
            hoverBgClassName="hover:bg-muted hover:text-foreground"
            closeHoverBgClassName="hover:bg-accent-rose hover:text-white"
            onClose={() => navigate(-1)}
            closeTitle={t.common?.cancel || '返回'}
          />
        </div>
      </div>

      {/* 主体区域 */}
      <div className="flex flex-1 overflow-hidden">
        {/* 左侧导航 */}
        <div className="w-[220px] bg-bg-deep/50 border-r border-border/50 flex flex-col p-3 gap-1 select-none">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id || (activeTab === undefined && tab.id === 'general');
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13px] transition-all duration-200 outline-none cursor-pointer ${
                  isActive
                    ? 'bg-accent/10 text-accent font-medium shadow-sm shadow-accent/10'
                    : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                }`}
              >
                <Icon size={16} className={isActive ? tab.color : 'text-muted-foreground/60'} />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* 右侧内容 */}
        <div className="flex-1 p-8 overflow-y-auto bg-bg-primary">
          {(activeTab === 'general' || !activeTab) && <GeneralTab data={config} onUpdate={updateConfig} />}
          {activeTab === 'ai' && (
            <AITab
              data={config}
              onUpdate={updateConfig}
              onTest={testAIConnection}
              onTestTTS={testTTS}
              isTesting={isTesting}
              modelPool={modelPool}
            />
          )}
          {activeTab === 'models' && <ModelTab />}
          {activeTab === 'health' && <HealthPage />}
        </div>
      </div>

      {/* 底部操作栏 */}
      <div className="shrink-0 h-14 bg-card border-t border-border/50 flex items-center justify-end px-8 gap-3 z-20">
        <Button variant="outline" className="h-9 px-6 text-xs border-border/50" onClick={() => navigate(-1)}>
          {t.common?.cancel || '取消'}
        </Button>
        <Button onClick={handleSave} disabled={isSaving} className="h-9 px-8 text-xs font-semibold btn-gradient">
          {isSaving ? '保存中...' : (t.common?.save || '保存配置')}
        </Button>
      </div>
    </div>
  );
};

export default Settings;
