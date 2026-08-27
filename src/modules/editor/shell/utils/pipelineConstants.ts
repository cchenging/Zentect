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
 * 风格作为"词汇库/语法框架"总模板预设，选中时自动填充默认的 emotionTone
 * 用户可手动微调（微调可能产生语义冲突，UI 会显式告警但不静默修正）
 */
export const SCRIPT_STYLES = [
  '爆款短视频',   // 抖音/快手快剪风格：高钩子、短句快切、网感词
  '深度解说',     // B站长视频风格：硬核分析、镜头语言解读、因果推导
  '评述视角',     // 主观点评风格：观点输出、价值判断、金句提炼
  '情感叙事',     // 感性叙事风格：细腻笔触、意象比喻、情绪共鸣
  '悬疑推理',     // 悬疑营造风格：层层设问、伏笔铺设、真相拼凑
  '硬核科普',     // 知识科普风格：事实准确、专业术语、逻辑清晰
];

/**
 * 创作风格预设 → 默认参数组合映射（SSOT：唯一真源，View.tsx 消费此表）
 * 选中风格时自动写入 emotionTone，后续用户手动微调不回写此表
 * 注释说明各组合的设计意图，保证正交切分
 */
export const STYLE_PRESET_MAP: Record<string, { emotionTone: import('../../../../shared/types/entities/editor').PipelineParams['emotionTone']; description: string }> = {
  '爆款短视频': {
    emotionTone: 'epic',         // 高燃热血：拉高情绪卡点，追求完播率
    description: '高燃基调，适配短视频快剪高钩子',
  },
  '深度解说': {
    emotionTone: 'neutral',      // 客观中立：严谨分析，避免主观情绪干扰
    description: '中立基调，适配 B 站长视频硬核分析',
  },
  '评述视角': {
    emotionTone: 'emotional',    // 情感渲染：带强烈个人立场和情绪共鸣
    description: '情感基调，适配 UP 主个人 IP 观点输出',
  },
  '情感叙事': {
    emotionTone: 'emotional',    // 情感渲染：细腻笔触 + 比喻意象
    description: '情感基调，适配文艺类/情感类内容感性叙事',
  },
  '悬疑推理': {
    emotionTone: 'suspense',     // 悬疑营造：张弛有度、引导观众思考
    description: '悬疑基调，适配推理/烧脑类剧情分析',
  },
  '硬核科普': {
    emotionTone: 'neutral',      // 客观中立：事实准确、忌主观情绪
    description: '中立基调，适配科技/历史/自然类知识科普',
  },
};

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
