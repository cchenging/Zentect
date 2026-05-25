// 📁 路径：src/renderer/src/store/constants.ts

/**
 * 💥 全局状态机字典：消灭散落在项目中的魔法字符串 (Magic Strings)
 * 采用 as const 结合 typeof 提取类型，兼顾了运行时的按值引用与编译时的严格推导
 */

// 节点运行状态机
export const NODE_STATUS = {
  IDLE: 'idle',
  PROCESSING: 'processing',
  SUCCESS: 'success',
  ERROR: 'error'
} as const;
export type NodeStatusType = typeof NODE_STATUS[keyof typeof NODE_STATUS];

// 画布节点类型字典
export const NODE_TYPES = {
  SOURCE: 'sourceNode',
  PROCESS: 'processNode',
  VECTOR: 'vectorNode',
  SCRIPT: 'scriptNode',
  PLAYER: 'playerNode'
} as const;
export type NodeCategoryType = typeof NODE_TYPES[keyof typeof NODE_TYPES];

// 画布数据水合状态
export const HYDRATION_STATUS = {
  IDLE: 'IDLE',
  LOADING: 'LOADING',
  READY: 'READY',
  ERROR: 'ERROR'
} as const;
export type HydrationStatusType = typeof HYDRATION_STATUS[keyof typeof HYDRATION_STATUS];

// 节点类型注册表 (SSOT) — actionType 与前端类型的唯一映射
export const NODE_REGISTRY = {
  SOURCE:       { type: 'sourceNode',  actionType: null,                  configLabel: '媒体源导入' },
  FRAME_EXTRACT:{ type: 'processNode', actionType: 'vision-extract',      configLabel: '视觉抽帧' },
  AUDIO_SEPARATE:{ type: 'processNode',actionType: 'audio-separate',      configLabel: '音频分离' },
  ASR:          { type: 'processNode', actionType: 'asr',                 configLabel: '台词识别' },
  FACE_DETECT:  { type: 'processNode', actionType: 'face-detect',         configLabel: '人物识别' },
  SEMANTIC:     { type: 'processNode', actionType: 'semantic-analyze',    configLabel: '视觉语义' },
  SENTIMENT:    { type: 'processNode', actionType: 'sentiment-analyze',   configLabel: '情绪分析' },
  SCRIPT_GEN:   { type: 'scriptNode',  actionType: 'script-gen',          configLabel: '智能剧本重铸' },
  TTS:          { type: 'processNode', actionType: 'tts-synthesize',      configLabel: '语音合成' },
  LLM_PROC:     { type: 'processNode', actionType: 'llm-processor',       configLabel: 'LLM 处理' },
  VECTOR:       { type: 'vectorNode',  actionType: null,                  configLabel: '多模态特征库' },
  PLAYER:       { type: 'playerNode',  actionType: null,                  configLabel: '全局监视器' },
} as const;
export type NodeRegistryKey = keyof typeof NODE_REGISTRY;

// 连接规则 — 从 initialLayout 移至此处作为 SSOT
export const CONNECTION_RULES: Record<string, string[]> = {
  'sourceNode':  ['processNode', 'playerNode'],
  'processNode': ['processNode', 'vectorNode', 'scriptNode', 'playerNode'],
  'vectorNode':  ['scriptNode'],
  'scriptNode':  ['processNode', 'playerNode'],
  'playerNode':  []
};
