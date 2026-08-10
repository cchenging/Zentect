// 📁 路径：src/modules/export/mp4/index.ts
// 成片导出模块入口：导出类型与服务

export type { Mp4ExportInput, Mp4ExportOutput } from './types';
export { Mp4Exporter } from './backend/Mp4Exporter';
export { compileSrt, writeSrtFile } from './backend/SubtitleAssembler';
export { assembleRenderShots } from './backend/RenderShotsAssembler';
export { buildRenderJob } from './backend/RenderJobFactory';