/** V1.3: 多流程步骤配置驱动模型
 *  每种工作流定义为一个 FlowConfig，由 LeftNav / RightPanel / 主页面 自动消费
 *  新增流程只需在此数组追加条目，不改动任何组件代码
 */

import type { LucideIcon } from 'lucide-react';
import {
  Upload, BarChart3, Play, Image, Download, Clock,
} from 'lucide-react';
import { StepImport } from '../components/StepImport';
import { StepAnalysis } from '../components/StepAnalysis';
import { StepReview } from '../components/StepReview';
import { StepPublish } from '../components/StepPublish';
import { ExportPanel } from '../components/ExportPanel';
import { ScriptPanel } from '../components/ScriptPanel';
import { PublishEditor } from '../components/PublishEditor';
import { ExportSettings } from '../components/ExportSettings';
import { PlaceholderStep } from '../components/PlaceholderStep';

/** 单步骤配置：定义图标、渲染组件、精修面板及导航文案 */
export interface StepConfig {
  id: string;
  icon: LucideIcon;
  title: string;
  component: React.ComponentType<any>;
  rightPanel: React.ComponentType<any> | null;
  showRightPanelButton?: boolean;
  onNextLabel?: string | null;
  autoAdvance?: boolean;
}

/** 完整流程定义 */
export interface FlowConfig {
  label: string;
  description?: string;
  steps: StepConfig[];
}

/** 全量流程配置字典：首页 MiniCard 点击后通过 query.flow 解析到此配置 */
export const FLOW_CONFIGS: Record<string, FlowConfig> = {
  /** 一键解说（V1.3 MVP） */
  quickcard: {
    label: '一键解说',
    description: '导入视频 → AI 分析 → 审阅解说稿 → 设置封面及发布素材 → 导出',
    steps: [
      {
        id: 'import',
        icon: Upload,
        title: '导入',
        component: StepImport,
        rightPanel: null,
        onNextLabel: '开始分析',
      },
      {
        id: 'analysis',
        icon: BarChart3,
        title: 'AI 分析',
        component: StepAnalysis,
        rightPanel: null,
        autoAdvance: true,
      },
      {
        id: 'review',
        icon: Play,
        title: '审阅',
        component: StepReview,
        rightPanel: ScriptPanel,
        showRightPanelButton: true,
        onNextLabel: '下一步 → 发布素材',
      },
      {
        id: 'publish',
        icon: Image,
        title: '发布素材',
        component: StepPublish,
        rightPanel: PublishEditor,
        onNextLabel: '去导出 →',
      },
      {
        id: 'export',
        icon: Download,
        title: '导出',
        component: ExportPanel,
        rightPanel: ExportSettings,
        onNextLabel: null,
      },
    ],
  },

  /** 以下为 V1.3 占位流程，后续迭代补全 */
  video_narrate: {
    label: '视频解说',
    description: '跳过发布素材，快速出片',
    steps: [
      {
        id: 'placeholder',
        icon: Clock,
        title: '即将上线',
        component: PlaceholderStep,
        rightPanel: null,
      },
    ],
  },

  text_narrate: {
    label: '文本解说',
    description: '从写稿开始，纯文字配音出片',
    steps: [
      {
        id: 'placeholder',
        icon: Clock,
        title: '即将上线',
        component: PlaceholderStep,
        rightPanel: null,
      },
    ],
  },

  batch: {
    label: '批量出片',
    description: '选择多个项目，批量导出',
    steps: [
      {
        id: 'placeholder',
        icon: Clock,
        title: '即将上线',
        component: PlaceholderStep,
        rightPanel: null,
      },
    ],
  },
};

/** 获取合法 Flow 配置（非法 flow 自动回退到 quickcard） */
export function resolveFlow(flow: string | null): { config: FlowConfig; flowKey: string } {
  const safeFlow = flow?.trim() || 'quickcard';
  if (FLOW_CONFIGS[safeFlow]) {
    return { config: FLOW_CONFIGS[safeFlow], flowKey: safeFlow };
  }
  console.warn(`[QuickCard] Unknown flow type '${safeFlow}', falling back to 'quickcard'`);
  return { config: FLOW_CONFIGS.quickcard, flowKey: 'quickcard' };
}