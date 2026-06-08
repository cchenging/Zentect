import { Search, PictureInPicture, PenLine, Mic, Clapperboard, Film, Music, Image, type LucideIcon } from 'lucide-react';

/** 步骤定义 */
export const STEPS = [
  { key: 1, label: '素材分析', icon: Search },
  { key: 2, label: '画面描述', icon: PictureInPicture },
  { key: 3, label: '解说文案', icon: PenLine },
  { key: 4, label: '配音合成', icon: Mic },
  { key: 5, label: '镜头匹配', icon: Clapperboard },
];

/** 步骤编号到管线节点序列的映射 */
export const STEP_SEQUENCES: Record<number, { actionType: string; nodeId: string; label: string }[]> = {
  2: [{ actionType: 'vision-extract', nodeId: 'vlm-1', label: '画面描述' }],
  3: [{ actionType: 'script-gen', nodeId: 'script-1', label: '解说文案' }],
  4: [{ actionType: 'tts-synthesize', nodeId: 'tts-1', label: '配音合成' }],
  5: [{ actionType: 'semantic-analyze', nodeId: 'match-1', label: '镜头匹配' }],
};

/** 文案风格选项 */
export const SCRIPT_STYLES = ['赛博现实主义', '无厘头废话文学', '正经科普', '情感叙事', '悬疑推理', '轻松幽默'];

/** 素材库标签（icon 为组件引用，消费方需自行渲染） */
export const MEDIA_TABS: { key: string; label: string; icon?: LucideIcon }[] = [
  { key: 'video', label: '视频', icon: Film },
  { key: 'audio', label: '音频', icon: Music },
  { key: 'frames', label: '关键帧', icon: Image },
];

/** 任务代码到中文名称的映射（兼容 ExtractionPipeline 所有状态码） */
export const CODE_TO_NAME: Record<string, string> = {
  // 关键帧提取
  extracting_frames: '关键帧提取',
  TASK_EXTRACT_FRAMES: '关键帧提取',
  // 音频分离
  separating_audio: '音频分离',
  audio_separated: '音频分离完成',
  TASK_EXTRACT_AUDIO: '音频分离',
  TASK_SEPARATE_AUDIO_MATRIX: '人声分离',
  // ASR 识别
  parsing_text: 'ASR 识别',
  transcribing: 'ASR 识别',
  TASK_WHISPER: 'ASR 识别',
  // 人脸检测
  indexing_vision: '人脸检测',
  TASK_SCAN_FACES: '人脸检测',
  TASK_CLUSTER_FACES: '人脸聚类',
  // 其他
  analyzing_flow: '分析中',
  TASK_ASSEMBLE: '数据组装',
  TASK_EXTRACT_SEMANTICS: '语义提取',
  TASK_SEMANTIC_FLOW: '语义流生成',
  TASK_INIT: '初始化',
  TASK_SUCCESS: '完成',
};

/** 管线节点类型枚举（替代字符串匹配） */
export enum PipelineNodeType {
  AUDIO_SEPARATE = 'audio',
  ASR = 'asr',
  FRAME_EXTRACT = 'frame',
  VISION = 'vision',
  SCRIPT = 'script',
  TTS = 'tts',
  MATCH = 'match',
}

/** 判断 nodeId 属于哪种管线节点类型 */
export const classifyNodeId = (nodeId: string): PipelineNodeType | null => {
  if (nodeId.includes('audio') || nodeId.includes('separate')) return PipelineNodeType.AUDIO_SEPARATE;
  if (nodeId.includes('asr') || nodeId.includes('whisper')) return PipelineNodeType.ASR;
  if (nodeId.includes('frame') || nodeId.includes('extract')) return PipelineNodeType.FRAME_EXTRACT;
  if (nodeId.includes('vision') || nodeId.includes('vlm')) return PipelineNodeType.VISION;
  if (nodeId.includes('script') || nodeId.includes('narration')) return PipelineNodeType.SCRIPT;
  if (nodeId.includes('tts')) return PipelineNodeType.TTS;
  if (nodeId.includes('match') || nodeId.includes('align') || nodeId.includes('semantic')) return PipelineNodeType.MATCH;
  return null;
};
