// Module: editor/shell/utils/pipelineConstants
// 原 editor/utils/pipelineConstants.ts — 已迁移

import { Search, PictureInPicture, PenLine, Mic, Clapperboard, Film, Music, Image, type LucideIcon } from 'lucide-react';
// 🔧 修复 TS2339：导入 PipelineTask 类型供 STEP_SEQUENCES 使用
import type { PipelineTask } from '../../../../shared/types';

/** 步骤定义 */
export const STEPS = [
  { key: 1, label: '素材分析', icon: Search },
  { key: 2, label: '画面描述', icon: PictureInPicture },
  { key: 3, label: '解说文案', icon: PenLine },
  { key: 4, label: '配音合成', icon: Mic },
  { key: 5, label: '镜头匹配', icon: Clapperboard },
];

/** 步骤编号到管线节点序列的映射 */
// 🔧 修复 TS2339：使用 PipelineTask 类型，包含 params/dependsOn/mergedInputs 字段
export const STEP_SEQUENCES: Record<number, PipelineTask[]> = {
  2: [{ nodeId: 'vlm-1', actionType: 'vision-extract', label: '画面描述', params: {}, dependsOn: [], mergedInputs: {} }],
  3: [{ nodeId: 'script-1', actionType: 'script-gen', label: '解说文案', params: {}, dependsOn: [], mergedInputs: {} }],
  4: [{ nodeId: 'tts-1', actionType: 'tts-synthesize', label: '配音合成', params: {}, dependsOn: [], mergedInputs: {} }],
  5: [{ nodeId: 'match-1', actionType: 'semantic-analyze', label: '镜头匹配', params: {}, dependsOn: [], mergedInputs: {} }],
};

/**
 * 文案风格选项（重写：去掉废话文学，改为专业解说方向）
 * 风格作为"词汇库/语法框架"，与情绪基调(tone)做二次乘法组合
 */
export const SCRIPT_STYLES = [
  '爆款短视频',   // 抖音/快手快剪风格：高钩子、短句快切、网感词
  '深度解说',     // B站长视频风格：硬核分析、镜头语言解读、因果推导
  '评述视角',     // 主观点评风格：观点输出、价值判断、金句提炼
  '情感叙事',     // 感性叙事风格：细腻笔触、意象比喻、情绪共鸣
  '悬疑推理',     // 悬疑营造风格：层层设问、伏笔铺设、真相拼凑
  '硬核科普',     // 知识科普风格：事实准确、专业术语、逻辑清晰
];

/** 素材库标签（icon 为组件引用，消费方需自行渲染） */
export const MEDIA_TABS: { key: string; label: string; icon?: LucideIcon }[] = [
  { key: 'video', label: '视频', icon: Film },
  { key: 'audio', label: '音频', icon: Music },
  { key: 'frames', label: '关键帧', icon: Image },
  { key: 'chunks', label: '视频切片', icon: Film },
];

/** 任务代码到中文名称的映射（兼容 ExtractionPipeline 所有状态码） */
export const CODE_TO_NAME: Record<string, string> = {
  extracting_frames: '关键帧提取',
  TASK_EXTRACT_FRAMES: '关键帧提取',
  separating_audio: '音频分离',
  audio_separated: '音频分离完成',
  TASK_EXTRACT_AUDIO: '音频分离',
  TASK_SEPARATE_AUDIO_MATRIX: '人声分离',
  parsing_text: 'ASR 识别',
  transcribing: 'ASR 识别',
  TASK_WHISPER: 'ASR 识别',
  indexing_vision: '人脸检测',
  TASK_SCAN_FACES: '人脸检测',
  TASK_CLUSTER_FACES: '人脸聚类',
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
