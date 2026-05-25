// 📁 src/renderer/src/components/app-icon/index.tsx
import React, { memo } from 'react';
// 💥 增量规范 1：显式导入。彻底解决 `* as LucideIcons` 导致的包体积爆炸问题，完美支持 Tree-shaking
import {
  Play, Pause, Music, Video, Film, Camera, Mic, Volume2, VolumeX, PlayCircle, MonitorPlay,
  Home, LayoutTemplate, Gift, User, Crown, Settings, FolderOpen, Server, X, Minus, Square, Maximize, Maximize2, ZoomIn, Clock,
  Edit3, Star, Download, RotateCcw, RotateCw, Link, Scan, Hand, Columns3, Magnet, Scissors, PlusCircle, Copy, Trash2,
  RefreshCw, Wand2, Activity, Globe, Wrench, Sparkles, FileText, Type, Eye, EyeOff, Layers, Search,
  Check, CheckCircle2, CircleDashed, XCircle, AlertTriangle, AlertOctagon, Loader2, MoreVertical, MoreHorizontal, Contact, HelpCircle,
  Zap, AudioWaveform, FileVideo, Image, Mic2, Database, Clapperboard, Cpu, // 增量：补充缺失图标
  ScanFace, Speech // 💥 修复：补充 UserFocus 和 Speech 的缺失图标
} from 'lucide-react';

import { cn } from '../../lib/utils';
import { UI_CONFIG } from '../../constants/ui';
import { FrontendLogger } from '../../utils/logger';

export interface AppIconProps extends React.SVGAttributes<SVGSVGElement> {
  /** 图标名称 (支持 Lucide 官方名称，或下方字典的旧别名) */
  name: AppIconName;
  /** 图标尺寸，默认读取全局 UI_CONFIG.ICON_SIZE (16px) */
  size?: number | string;
  /** 图标颜色，默认继承父级文本颜色 */
  color?: string;
  /** 线条粗细，统一设计语言推荐 1.5 或 2 */
  strokeWidth?: number;
  className?: string;
  spin?: boolean;
}

/**
 * 💥 历史债务与全站图标映射字典 (Facade Compatibility Layer)
 * 增量规范 2：将字符串映射升级为【真实组件引用映射】。
 * 绝不删除您原有的任何一种业务图标别名！
 */
const ICON_DICTIONARY = {
  // --- 1. 媒体与播放 ---
  'Play': Play,
  'Pause': Pause,
  'Music': Music,
  'Video': Video,
  'Film': Film,
  'Camera': Camera,
  'Mic': Mic,
  'Volume2': Volume2,
  'VolumeX': VolumeX,
  'PlayCircle': PlayCircle,
  'MonitorPlay': MonitorPlay,

  // --- 2. 界面与布局 ---
  'Home': Home,
  'LayoutTemplate': LayoutTemplate,
  'Gift': Gift,
  'User': User,
  'Crown': Crown,
  'Settings': Settings,
  'Setting': Settings, // 兼容拼写
  'Folder': FolderOpen,
  'FolderOpen': FolderOpen,
  'Server': Server,
  'X': X,
  'Minus': Minus,
  'Square': Square,
  'Maximize': Maximize,
  'Maximize2': Maximize2,
  'ZoomIn': ZoomIn,
  'Clock': Clock,

  // --- 3. 编辑器与操作 ---
  'Edit': Edit3,
  'Edit2': Edit3, // 统一收编为更好看的 Edit3
  'Edit3': Edit3,
  'Star': Star,
  'Download': Download,
  'Export': Download,
  'Undo': RotateCcw,
  'Redo': RotateCw,
  'Link': Link,
  'Scan': Scan,
  'Hand': Hand,
  'Domino': Columns3,
  'Magnet': Magnet,
  'Razor': Scissors,
  'Scissors': Scissors,
  'PlusCircle': PlusCircle,
  'Copy': Copy,
  'Trash': Trash2,
  'Trash2': Trash2,

  // --- 4. AI 与极客功能 ---
  'Refresh': RefreshCw,
  'RefreshCw': RefreshCw,
  'Magic': Wand2,
  'Wand2': Wand2,
  'Activity': Activity,
  'Globe': Globe,
  'Wrench': Wrench,
  'Sparkles': Sparkles,
  'FileText': FileText,
  'Type': Type,
  'Eye': Eye,
  'EyeOff': EyeOff,
  'Layers': Layers,
  'Search': Search,
  'AIProcess': Zap, // 增量映射
  
  // --- 5. 状态与反馈 ---
  'Check': Check,
  'CheckCircle2': CheckCircle2,
  'CircleDashed': CircleDashed,
  'XCircle': XCircle,
  'Alert': AlertTriangle,
  'AlertTriangle': AlertTriangle,
  'AlertOctagon': AlertOctagon,
  'Loader2': Loader2,
  'MoreVertical': MoreVertical,
  'MoreHorizontal': MoreHorizontal,
  'Contact': Contact,

  // --- 6. 节点语义化别名 (增量扩充，适配最新管线需求) ---
  'NodeIdle': CircleDashed,
  'NodeProcessing': Loader2,
  'NodeSuccess': CheckCircle2,
  'NodeError': XCircle,
  'PipelineRun': Play,
  'PipelineStop': Square,
  
  // --- 7. 节点菜单图标 (增量补充，解决问号图标问题) ---
  'AudioWaveform': AudioWaveform,
  'FileVideo': FileVideo,
  'Image': Image,
  'Mic2': Mic2,
  'Database': Database,
  'Clapperboard': Clapperboard,
  'Cpu': Cpu,
  
  // --- 8. 💥 修复缺失图标映射 ---
  'UserFocus': ScanFace, // Lucide 中没有 UserFocus，使用 ScanFace 代替
  'Speech': Speech
} as const;

export type AppIconName = keyof typeof ICON_DICTIONARY | (string & {});

/**
 * @component AppIcon
 * @description 全局唯一图标门面组件 (Facade Pattern)。
 * 统御所有 SVG 渲染，收敛默认尺寸与样式。兼顾向下兼容。
 */
export const AppIcon: React.FC<AppIconProps> = memo(({
  name,
  size = UI_CONFIG.ICON_SIZE, // 严格挂载全局常量 16px
  color = 'currentColor',
  strokeWidth = 2,
  className,
  spin,
  ...props
}) => {
  // 1. O(1) 复杂度直接获取组件，告别 any 强转
  const LucideIcon = ICON_DICTIONARY[name as keyof typeof ICON_DICTIONARY];

  // 2. 防爆盾：渲染容错图标并静默报警 (完美保留您的原有逻辑)
  if (!LucideIcon) {
    FrontendLogger.warn('AppIcon', `Icon not found in explicit registry`, undefined, { requestedName: name });
    const FallbackIcon = HelpCircle;
    return (
      <FallbackIcon
        size={size}
        color={color}
        strokeWidth={strokeWidth}
        className={cn("shrink-0 text-destructive", className)}
        {...props}
      />
    );
  }

  const iconClassName = spin ? cn("animate-spin", className) : className;

  // 3. 标准化渲染
  return (
    <LucideIcon
      size={size}
      color={color}
      strokeWidth={strokeWidth}
      className={cn("shrink-0 transition-colors", iconClassName)}
      {...props}
    />
  );
});

AppIcon.displayName = 'AppIcon';
