// 💥 增量更新 2：纯粹的业务配置文件 (脱离 UI)
import { 
  FileVideo, Image as ImageIcon, Mic2, User, 
  Database, Clapperboard, AudioWaveform, MonitorPlay,
  Brain, Heart, Cpu
} from 'lucide-react';

export const ACCENT_COLORS = {
  blue: '#3b82f6',
  purple: '#a855f7',
  indigo: '#6366f1',
  emerald: '#10b981',
  amber: '#f59e0b',
  rose: '#f43f5e',
  green: '#22c55e'
};

export interface NodeMenuItem {
  menuKey: string;
  type: string;
  icon: any;
  color: string;
  bg: string;
  defaultWidth: number;
  data: any;
}

export interface NodeMenuCategory {
  categoryId: string;
  icon: any;
  items: NodeMenuItem[];
}

export const NODE_MENU_CONFIG: NodeMenuCategory[] = [
  {
    categoryId: 'inputs',
    icon: FileVideo,
    items: [
      { menuKey: 'sourceNode', type: 'sourceNode', icon: FileVideo, color: 'text-blue-400', bg: 'bg-blue-500/10', defaultWidth: 200, data: { accent: 'blue' } }
    ]
  },
  {
    categoryId: 'extractors',
    icon: ImageIcon,
    items: [
      { menuKey: 'sceneCut', type: 'processNode', icon: ImageIcon, color: 'text-indigo-400', bg: 'bg-indigo-500/10', defaultWidth: 200, data: { actionType: 'vision-extract', accent: 'indigo' } },
      { menuKey: 'vadExtract', type: 'processNode', icon: Mic2, color: 'text-indigo-400', bg: 'bg-indigo-500/10', defaultWidth: 200, data: { actionType: 'asr', accent: 'indigo' } },
      { menuKey: 'faceCluster', type: 'processNode', icon: User, color: 'text-purple-400', bg: 'bg-purple-500/10', defaultWidth: 200, data: { actionType: 'face-detect', accent: 'purple' } },
      { menuKey: 'audioSeparate', type: 'processNode', icon: AudioWaveform, color: 'text-blue-400', bg: 'bg-blue-500/10', defaultWidth: 200, data: { actionType: 'audio-separate', accent: 'blue' } },
      { menuKey: 'semanticAnalyze', type: 'processNode', icon: Brain, color: 'text-purple-400', bg: 'bg-purple-500/10', defaultWidth: 200, data: { actionType: 'semantic-analyze', accent: 'purple' } },
      { menuKey: 'sentimentAnalyze', type: 'processNode', icon: Heart, color: 'text-rose-400', bg: 'bg-rose-500/10', defaultWidth: 200, data: { actionType: 'sentiment-analyze', accent: 'rose' } },
    ]
  },
  {
    categoryId: 'brain',
    icon: Brain,
    items: [
      { menuKey: 'llmProcessor', type: 'processNode', icon: Cpu, color: 'text-amber-400', bg: 'bg-amber-500/10', defaultWidth: 240, data: { actionType: 'llm-processor', accent: 'amber' } },
      { menuKey: 'vectorNode', type: 'vectorNode', icon: Database, color: 'text-emerald-400', bg: 'bg-emerald-500/10', defaultWidth: 220, data: { accent: 'emerald' } },
      { menuKey: 'scriptNode', type: 'scriptNode', icon: Clapperboard, color: 'text-amber-400', bg: 'bg-amber-500/10', defaultWidth: 280, data: { actionType: 'script-gen', accent: 'amber' } }
    ]
  },
  {
    categoryId: 'renderers',
    icon: MonitorPlay,
    items: [
      { menuKey: 'ttsEngine', type: 'processNode', icon: AudioWaveform, color: 'text-green-400', bg: 'bg-green-500/10', defaultWidth: 200, data: { actionType: 'tts-synthesize', accent: 'green' } },
      { menuKey: 'playerNode', type: 'playerNode', icon: MonitorPlay, color: 'text-rose-400', bg: 'bg-rose-500/10', defaultWidth: 320, data: { accent: 'rose' } }
    ]
  }
];
