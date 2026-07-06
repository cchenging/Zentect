// 📁 路径：src/modules/media/audio/index.ts
// 模块入口：只导出接口契约与公共服务（§3.5.3）

export type {
  AudioSeparateInput,
  AudioSeparateOutput,
} from './types';

export type {
  SeparationOptions,
  SeparationProgressCallback,
} from './backend/Service';

export {
  AudioSeparationService,
} from './backend/Service';
