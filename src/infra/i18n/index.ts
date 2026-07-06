// 📁 路径: src/infra/i18n/index.ts
// 国际化模块桶文件 — 统一导出入口

export {
  DICT,
  ErrorConfig,
  ErrorCode,
  Dictionary,
  TaskCode,
  ENGINE_STATUS,
  AppDictionary,
  SUPPORTED_EXTENSIONS,
  ALL_MEDIA_EXTENSIONS,
} from './dictionary';

export { zhCN } from './zh-CN';
export { default as zhCN } from './zh-CN';

export { EDITOR_STEP_I18N } from './editor-steps';
