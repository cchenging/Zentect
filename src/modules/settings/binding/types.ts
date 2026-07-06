// 📁 路径：src/modules/settings/binding/types.ts
// 接口契约：管线-模型映射（§3.7.2）

/** 管线节点模型绑定 */
export interface ProfileBinding {
  /** 任务类型：visual / script / translate / helper / tts / audio / asr / sentiment */
  taskType: string;
  /** 关联的 API Profile ID，null 表示自动匹配 */
  profileId: string | null;
  /** 模型名称 */
  modelName: string;
  /** 是否生效 */
  isActive: boolean;
}

/** 绑订输入 */
export interface BindingInput {
  /** 所有绑订配置 */
  bindings: ProfileBinding[];
  /** 可用的 API Profile 列表 */
  apiProfiles: Array<{
    id: string;
    name: string;
    models: string[];
  }>;
}
