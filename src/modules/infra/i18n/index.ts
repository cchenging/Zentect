// 📁 路径: src/infra/i18n/index.ts
// 国际化模块桶文件 — 统一导出入口

// 🔧 修复 TS1205：值用 export，类型用 export type
export {
  DICT,
  ErrorConfig,
  ENGINE_STATUS,
  SUPPORTED_EXTENSIONS,
  ALL_MEDIA_EXTENSIONS,
} from './dictionary';

export type { ErrorCode, Dictionary, TaskCode, AppDictionary } from './dictionary';

// 🔧 修复 TS2300：删除重复的 zhCN 导出（第 16/17 行只能保留一个）
export { default as zhCN } from './zh-CN';

export { EDITOR_STEP_I18N } from './editor-steps';
