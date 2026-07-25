// 📁 路径：src/modules/media/audio/index.ts
// 模块入口：导出类型契约 + 公共服务

export type {
  SeparationEngine,
  SeparationMode,
  AudioSeparationInput,
  AudioSeparationResult,
} from './types';

export type {
  SeparationProgressCallback,
} from './backend/Service';

export type {
  SeparationOptions,
} from './backend/Service';

export {
  AudioSeparationService,
} from './backend/Service';
