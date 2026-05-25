// 📁 路径：src/renderer/src/pages/editor/config/templates.ts
import type { FlowNode, FlowEdge } from '../../../store/storeTypes';
import { initialNodes, initialEdges } from '../components/semantic-flow/initialLayout';

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

/**
 * 💥 智能体工作流堆栈源数据
 * 每一项代表一个可瞬时切换的"桌面级处理管线"
 */
export const TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'tpl-video-pipeline',
    name: '通用短视频管线',
    description: '标准自动化剪辑管线。包含素材解析、视觉抽取、语音识别 (ASR) 与最终混音合成环节。',
    nodes: initialNodes as FlowNode[], // 默认使用工程自带的初始拓扑
    edges: initialEdges,
  },
  {
    id: 'tpl-script-extract',
    name: 'AI 剧本提纯与重铸',
    description: '专注于文案侧。利用视觉大模型 (VLM) 深度反推视频画面，结合原声音频，重铸爆款短视频脚本。',
    nodes: initialNodes as FlowNode[], // 实际业务中，这里可配置一套完全不同的 Node 拓扑
    edges: initialEdges,
  },
  {
    id: 'tpl-audio-clean',
    name: '人声分离与智作',
    description: '高能音频专线。剥离嘈杂背景音，提取纯净人声，并支持一键克隆与替换为指定 AI 音色。',
    nodes: initialNodes as FlowNode[],
    edges: initialEdges,
  }
];

// 💥 替换为真正的、原生的桌面级空画布基座
export const DEFAULT_WORKFLOW: WorkflowTemplate = {
  id: 'tpl-blank',
  name: '未命名工作流',
  description: '一张白纸，任你发挥。你可以点击下方添加模板，或在右侧画布右键添加节点。',
  nodes: [],
  edges: []
};
