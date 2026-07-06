// 📁 路径：src/modules/media/frames/index.ts
// 模块入口：只导出接口契约和公共服务

export type {
  FrameStrategy,
  FrameExtractInput,
  FrameExtractOutput,
  FrameExtractionTelemetry,
} from './types';

export { FRAME_STRATEGIES } from './types';

export type {
  FrameExtractionDeps,
  ExtractOptions,
} from './backend/Service';

export {
  FrameExtractionService,
  resolveStrategy,
} from './backend/Service';
