// Module: pipeline/step1-material - Types

import type { AsrLine, Role, StepStatus } from '../../../shared/types/entities/editor';
import type { MediaItem } from '../../../shared/types';
import type { SubStepTiming } from '../../../renderer/src/store/usePipelineStore';
import type {
  FrameExtractStrategy as SharedFrameStrategy,
  DensityPreset as SharedFrameDensityPreset,
} from '../../../shared/contracts/capabilities';

/** Step1 输入接口 (§3.3.2) */
export interface Step1Input {
  projectId: string;
  mediaPath: string;
  config: Step1Config;
}

/** Step1 输出接口 (§3.3.2) */
export interface Step1Output {
  asrLines: AsrLine[];
  framePaths: string[];
  frameCount: number;
  audioSeparated: boolean;
  roles: Role[];
}

/** Step1 子步骤配置 */
export interface Step1Config {
  targetLanguage: string;
  frames: FramesConfig;
  audio: AudioConfig;
  whisper: WhisperConfig;
  faces: FacesConfig;
}

/** 抽帧配置（P0 契约收拢：mode 2 值 + 抽帧密度预设 frameDensityPreset）
 *  ⚠️ 字段命名注意：`density` 已被 step3 解说文案密度占用（usePipelineOrchestrator 动态访问），
 *  因此抽帧密度预设使用 `frameDensityPreset`，避免语义碰撞。
 */
export interface FramesConfig {
  enabled: boolean;
  /** P0 抽帧策略（2 值；历史 4 枚举 job 打开时自动迁移） */
  mode: SharedFrameStrategy | string;
  /** P0 抽帧密度预设（仅 AUTO_ADAPTIVE 生效，绑定帧数预算/最小间隔/转场阈值，默认 standard） */
  frameDensityPreset?: SharedFrameDensityPreset;
  /** 场景变化阈值 0.0~1.0；AUTO_ADAPTIVE 下默认由 frameDensityPreset 派生（调试可覆盖） */
  sceneThreshold: number;
  quality: number;
  scale: number;
  /** 均匀抽帧帧率，仅 UNIFORM_FPS 模式生效 */
  fps: number;
  /** 最小帧间隔；AUTO_ADAPTIVE 下默认由 frameDensityPreset 派生（调试可覆盖） */
  minFrameInterval?: number;
  /** ⚠️ 历史兼容：定点截图时间，P0 起抽帧主流程不消费，走 screenshotAt 独立 API */
  timePoint?: number;
  // 🔧 修复 TS2339：usePipelineOrchestrator 动态访问的字段（用于 UI 配置传递到管线）
  value?: number;
  /** ⚠️ 保留字段：step3 解说文案密度（解说密度，非抽帧密度！不要与 frameDensityPreset 混用） */
  density?: 'sparse' | 'standard' | 'dense' | string;
}

/** 音频分离配置 */
export interface AudioConfig {
  enabled: boolean;
  /** 'fast': 跳过人声分离，ASR 使用原始音轨（含 BGM）；'quality': 使用 Demucs/MDX-Net 分离人声 */
  separationMode?: 'fast' | 'quality';
  /** quality 模式下可选引擎：'demucs'(重型,高保真) | 'mdx'(轻量,极速) | 'auto'(Python 默认顺序) */
  engine?: 'demucs' | 'mdx' | 'auto';
}

/** ASR 引擎配置 */
export interface WhisperConfig {
  enabled: boolean;
  /** ASR 引擎：'auto'(按检测语言自动选择) | 'sensevoice'(中日韩) | 'faster-whisper'(英文/欧洲语言) */
  engine: 'sensevoice' | 'faster-whisper' | 'auto';
  language?: string;
}

/** 人脸检测配置 */
export interface FacesConfig {
  enabled: boolean;
  engine: 'insightface' | 'mediapipe';
}

/** Step1 Store 状态 */
export interface Step1State {
  asrLines: AsrLine[];
  frameCount: number;
  audioSeparated: boolean;
  roles: Role[];
  /** subStepStatuses 已迁移至 usePipelineStore 单一数据源 */
  subStepProgresses: Record<string, number>;
  extractionConfig: Step1Config;
}

/** View 层 Props */
export interface StepMaterialAnalysisViewProps {
  asrLines: AsrLine[];
  frameCount: number;
  audioSeparated: boolean;
  /** 人声分离降级标记：true=分离失败降级到原始音轨，需展示降级提示 */
  vocalsIsFallback: boolean;
  mediaItems: MediaItem[];
  roles: Role[];
  subStepStatuses: Record<string, StepStatus>;
  subStepProgresses: Record<string, number>;
  /** 子步骤耗时记录（key: frames/audio/whisper/faces），用于展示「耗时 Xs」 */
  subStepTimings: Record<string, SubStepTiming | null>;
  extractionConfig: Step1Config | null;
  extractedData: {
    videoPath?: string;
    vocalPath?: string;
    backgroundPath?: string;
    asrLines?: AsrLine[];
    frameCount?: number;
    framePaths?: string[];
  } | null;
  onUpdateAsrLine: (index: number, text: string) => void;
  onSetAsrLines: (lines: AsrLine[]) => void;
  onSetCurrentTime: (time: number) => void;
  onSetActivePlaySource: (source: MediaItem | null) => void;
  onUpdateRole: (id: string, updates: Partial<Role>) => void;
  /** 🎭 P0.5+ 合并角色：source 合并到 target */
  onMergeRoles: (sourceRoleId: string, targetRoleId: string) => void;
  /** 🎭 P0.5+ 拆分角色：从 target 恢复 source */
  onUnmergeRole: (sourceRoleId: string, targetRoleId: string) => void;
  /** 🎭 P0.5+ 删除角色 */
  onDeleteRole: (id: string) => void;
  onSetSubStepStatus: (key: string, status: StepStatus) => void;
  onRetrySubStep: (stepKey: string) => void;
  /** 停止正在运行的子任务（调用后端 abortPipeline + 前端状态置为 idle） */
  onAbortSubStep: (stepKey: string) => void;
  onUpdateExtractionConfig: (config: Partial<Step1Config>) => void;
}
