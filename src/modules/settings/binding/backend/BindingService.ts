// 📁 路径：src/modules/settings/binding/backend/BindingService.ts
// 管线-模型绑订服务：封装 ProfileBinding CRUD（§3.7.2）
// 委托层：委托 ProfileBindingRepository 现有实现

import type { ProfileBinding, BindingInput } from '../types';

// 委托到原有实现，保持零侵入
export { ProfileBindingRepository } from '../../../../main/database/repositories/ProfileBindingRepository';
export type { ProfileBinding as ProfileBindingRow } from '../../../../main/database/repositories/ProfileBindingRepository';

/** 管线节点定义（与规格 §3.7.2 对齐） */
export const PIPELINE_NODES = [
  { taskType: 'audio', label: '音频分离', localOptions: ['本地轻量模型', 'Demucs', 'MDX-Net'] },
  { taskType: 'asr', label: '台词识别 (ASR)', localOptions: ['Whisper 本地版', 'SenseVoiceSmall'] },
  { taskType: 'visual', label: 'VLM 画面分析', useModelPool: true },
  { taskType: 'sentiment', label: '情绪识别', useModelPool: true },
  { taskType: 'script', label: 'AI 解说文案', useModelPool: true },
  { taskType: 'tts', label: 'TTS 配音合成' },
] as const;

export { ProfileBindingRepository as default } from '../../../../main/database/repositories/ProfileBindingRepository';
