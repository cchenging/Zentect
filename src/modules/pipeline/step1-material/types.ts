// Module: pipeline/step1-material - Types

import type { AsrLine, Role, StepStatus } from '../../../shared/types/entities/editor';
import type { MediaItem } from '../../../shared/types';

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

/** 抽帧配置 */
export interface FramesConfig {
  enabled: boolean;
  mode: 'VLM_OPTIMIZED' | 'UNIFORM_FPS' | 'FAST_KEYFRAME' | 'PRECISE_SINGLE';
  sceneThreshold: number;
  quality: number;
  scale: number;
  fps: number;
  minFrameInterval?: number;
  timePoint?: number;
}

/** 音频分离配置 */
export interface AudioConfig {
  enabled: boolean;
}

/** ASR 引擎配置 */
export interface WhisperConfig {
  enabled: boolean;
  engine: 'sensevoice' | 'whisper-v3';
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
  subStepStatuses: Record<string, StepStatus>;
  subStepProgresses: Record<string, number>;
  extractionConfig: Step1Config;
}

/** View 层 Props */
export interface StepMaterialAnalysisViewProps {
  asrLines: AsrLine[];
  frameCount: number;
  audioSeparated: boolean;
  mediaItems: MediaItem[];
  roles: Role[];
  subStepStatuses: Record<string, StepStatus>;
  subStepProgresses: Record<string, number>;
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
  onSetSubStepStatus: (key: string, status: StepStatus) => void;
  onRetrySubStep: (stepKey: string) => void;
  onUpdateExtractionConfig: (config: Partial<Step1Config>) => void;
}
