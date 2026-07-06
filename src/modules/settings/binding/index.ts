// 📁 路径：src/modules/settings/binding/index.ts
// 模块入口：管线-模型映射（§3.7.2）

export type { ProfileBinding, BindingInput } from './types';
export { PIPELINE_NODES, ProfileBindingRepository } from './backend/BindingService';
export type { ProfileBindingRow } from './backend/BindingService';
