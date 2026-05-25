/** V1.3 B1+A1: QuickCard 主页面 — 三栏布局重构 + TopBar 重写
 *  去掉 StepIndicator + BottomBar，采用配置驱动的步骤渲染
 *  URL 参数 ?flow=quickcard&step=2&projectId=xxx 支持刷新恢复
 */

import React, { useState, useCallback, useMemo } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  Sparkles, Layers, Settings, BarChart3,
} from 'lucide-react';
import { useQuickCardStore } from '../../store/useQuickCardStore';
import { WindowControls } from '../../components/window-controls';
import { LeftNav } from './components/LeftNav';
import { RightPanel } from './components/RightPanel';
import { BatchQueuePanel } from './components/BatchQueuePanel';
import { resolveFlow, type StepConfig } from './config/flows';

/** 步骤间传递的流程参数 */
interface FlowParams {
  projectId: string;
  mediaId: string;
  mediaPath: string;
  shots: any[];
  roles: any[];
  script: string;
}

export const QuickCard: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const publishConfig = useQuickCardStore(s => s.publishConfig);

  /** 从 URL 读取 flow 和 step */
  const { config: flowConfig, flowKey } = useMemo(
    () => resolveFlow(searchParams.get('flow')),
    [searchParams]
  );

  const steps = flowConfig.steps;
  const urlStep = parseInt(searchParams.get('step') || '0', 10);

  /** 步骤安全跳转（自动 clamp 到合法范围） */
  const goToStep = useCallback((n: number) => {
    const clamped = Math.max(0, Math.min(n, steps.length - 1));
    setCurrentStep(clamped);
    setRightPanelOpen(false);
    const next = new URLSearchParams(searchParams);
    next.set('step', String(clamped));
    if (flowKey) next.set('flow', flowKey);
    setSearchParams(next);
  }, [steps.length, searchParams, setSearchParams, flowKey]);

  const [currentStep, setCurrentStep] = useState(urlStep < steps.length ? urlStep : 0);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);

  /** 流程参数：上游产生、下游消费 */
  const [flowParams, setFlowParams] = useState<FlowParams>({
    projectId: searchParams.get('projectId') || '',
    mediaId: '',
    mediaPath: '',
    shots: [],
    roles: [],
    script: '',
  });

  /** 当前步骤配置 */
  const currentStepConfig: StepConfig = steps[currentStep] || steps[0];
  const StepComponent = currentStepConfig.component;
  const RightPanelComponent = currentStepConfig.rightPanel;

  /** StepImport onComplete → 创建项目并跳转 */
  const handleImportComplete = useCallback(async (filePath: string) => {
    try {
      const winApi = (window as any).api;
      if (!winApi) throw new Error('非 Electron 环境');
      const result = await winApi.invoke('project:create', { filePath, flow: flowKey });
      const { projectId, mediaId } = result;
      setFlowParams(p => ({ ...p, projectId, mediaId, mediaPath: filePath }));
      const next = new URLSearchParams(searchParams);
      next.set('step', '1');
      next.set('projectId', projectId);
      if (flowKey) next.set('flow', flowKey);
      setSearchParams(next);
      setCurrentStep(1);
    } catch (err: any) {
      throw err;
    }
  }, [flowKey, searchParams, setSearchParams]);

  /** StepAnalysis onComplete → 存储结果并跳转 */
  const handleAnalysisComplete = useCallback(() => {
    goToStep(currentStep + 1);
  }, [currentStep, goToStep]);

  /** StepReview onComplete → 跳转发布素材 */
  const handleReviewComplete = useCallback(() => {
    goToStep(currentStep + 1);
  }, [currentStep, goToStep]);

  /** StepPublish onComplete → 跳转导出 */
  const handlePublishComplete = useCallback(() => {
    goToStep(currentStep + 1);
  }, [currentStep, goToStep]);

  /** 步骤组件通用 props 构建器 */
  const buildStepProps = useCallback(() => {
    const base: Record<string, any> = {};
    if (flowParams.projectId) base.projectId = flowParams.projectId;
    if (flowParams.mediaId) base.mediaId = flowParams.mediaId;
    if (flowParams.mediaPath) base.mediaPath = flowParams.mediaPath;
    if (flowParams.shots.length > 0) base.shots = flowParams.shots;

    switch (currentStepConfig.id) {
      case 'import':
        base.onComplete = handleImportComplete;
        break;
      case 'analysis':
        base.onComplete = handleAnalysisComplete;
        break;
      case 'review':
        base.onComplete = handleReviewComplete;
        base.onOpenRightPanel = () => setRightPanelOpen(true);
        break;
      case 'publish':
        base.onComplete = handlePublishComplete;
        base.onOpenRightPanel = () => setRightPanelOpen(true);
        break;
      case 'export':
        base.container = 'page';
        break;
    }
    return base;
  }, [currentStepConfig.id, flowParams, handleImportComplete, handleAnalysisComplete, handleReviewComplete, handlePublishComplete]);

  /** RightPanel 专属 props */
  const rightPanelProps = useMemo(() => {
    const props: Record<string, any> = {};
    if (flowParams.projectId) props.projectId = flowParams.projectId;
    if (flowParams.mediaPath) props.mediaPath = flowParams.mediaPath;

    switch (currentStepConfig.id) {
      case 'review':
        props.currentTime = 0;
        props.onSeekTo = (_time: number) => { /* 播放器 seek 由父组件处理 */ };
        break;
      case 'publish':
        props.coverUrl = publishConfig.coverUrl;
        props.title = publishConfig.title;
        props.description = publishConfig.description;
        props.tags = publishConfig.tags;
        props.coverSource = publishConfig.coverSource;
        props.onCoverChange = (url: string, source: 'custom') => {
          useQuickCardStore.getState().setPublishConfig({ ...publishConfig, coverUrl: url, coverSource: source });
        };
        props.onTitleChange = (title: string) => {
          useQuickCardStore.getState().setPublishConfig({ ...publishConfig, title });
        };
        props.onDescriptionChange = (description: string) => {
          useQuickCardStore.getState().setPublishConfig({ ...publishConfig, description });
        };
        props.onTagsChange = (tags: string[]) => {
          useQuickCardStore.getState().setPublishConfig({ ...publishConfig, tags });
        };
        break;
    }
    return props;
  }, [currentStepConfig.id, flowParams, publishConfig]);

  return (
    <div className="h-screen w-full flex flex-col bg-[#0a0a0f]">
      {/* ========== TopBar（重写，内联，不与 Editor 共用） ========== */}
      <header className="h-[44px] shrink-0 flex items-center justify-between px-4 border-b border-zinc-800 bg-[#18181B] backdrop-blur-md gap-3">
        {/* 左侧 */}
        <div className="flex items-center gap-2.5">
          <span
            className="font-bold text-sm tracking-tight cursor-pointer text-zinc-100 hover:text-zinc-200 transition-colors"
            style={{ fontFamily: 'Space Grotesk, sans-serif', letterSpacing: '-0.02em' }}
            onClick={() => navigate('/')}
          >
            Zentect
          </span>
          {/* ModeSwitcher 胶囊 */}
          <div className="flex items-center rounded-lg bg-zinc-800/80 p-0.5">
            <button
              onClick={() => navigate('/editor')}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              <Sparkles size={12} /> 专业
            </button>
            <button
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-zinc-700 text-[11px] font-medium text-zinc-100 shadow-sm"
            >
              <Layers size={12} /> 简易
            </button>
          </div>
          {/* 队列按钮 */}
          <button
            onClick={() => setQueueOpen(!queueOpen)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50 transition-colors"
          >
            <BarChart3 size={12} /> 队列
          </button>
        </div>

        {/* 中间：项目名 + SaveStatus */}
        <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-2 pointer-events-none">
          <span className="text-xs text-zinc-400 font-medium truncate max-w-[200px]">
            {flowParams.projectId ? flowParams.projectId.slice(0, 8) : 'Zentect'}
          </span>
          {flowParams.projectId && (
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500/80" title="已保存" />
          )}
        </div>

        {/* 右侧 */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate('/settings')}
            className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50 transition-colors"
          >
            <Settings size={15} />
          </button>
          <div className="w-px h-4 bg-zinc-700 mx-1" />
          <WindowControls onClose={() => navigate('/')} />
        </div>
      </header>

      {/* 队列弹窗 */}
      {queueOpen && (
        <div className="absolute top-[44px] right-4 z-50">
          <BatchQueuePanel onClose={() => setQueueOpen(false)} />
        </div>
      )}

      {/* ========== 三栏主体 ========== */}
      <div className="flex-1 flex min-h-0">
        {/* 左栏导航 */}
        <LeftNav
          steps={steps}
          currentStep={currentStep}
          onStepClick={goToStep}
        />

        {/* 中栏内容区 */}
        <main className="flex-1 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
          <div className="h-full">
            <StepComponent {...buildStepProps()} />
          </div>
        </main>

        {/* 右栏精修面板 */}
        <RightPanel
          open={rightPanelOpen}
          onClose={() => setRightPanelOpen(false)}
          component={RightPanelComponent}
          componentProps={rightPanelProps}
        />
      </div>
    </div>
  );
};

export default QuickCard;