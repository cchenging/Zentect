// 📁 路径：src/modules/export/txt/index.ts
// 模块入口：只导出接口契约与公共服务（§3.6.3）

export type {
  ScriptParagraph,
  TxtExportInput,
} from './types';

export {
  TxtExportService,
} from './backend/Service';
