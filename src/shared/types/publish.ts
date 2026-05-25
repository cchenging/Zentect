/** V1.3 B4: 发布素材配置类型定义
 *  跨组件共享：StepPublish → PublishEditor ↔ ExportPanel
 *  存放在 Zustand store 中，实现双向数据同步
 */

export interface PublishConfig {
  /** 封面图片路径（本地文件或 base64） */
  coverUrl: string;
  /** 发布标题（AI 自动生成吸引眼球标题，用户可编辑） */
  title: string;
  /** 内容描述（AI 脚本摘要，用户可编辑） */
  description: string;
  /** 标签列表 */
  tags: string[];
  /** 封面来源：first_frame=视频首帧 / custom=用户自定义上传 */
  coverSource: 'first_frame' | 'custom';
}

/** 初始值工厂：从 AI 分析结果自动填充 */
export function createDefaultPublishConfig(overrides?: Partial<PublishConfig>): PublishConfig {
  return {
    coverUrl: '',
    title: '',
    description: '',
    tags: [],
    coverSource: 'first_frame',
    ...overrides,
  };
}

/** 重置为初始值 */
export const EMPTY_PUBLISH_CONFIG: PublishConfig = {
  coverUrl: '',
  title: '',
  description: '',
  tags: [],
  coverSource: 'first_frame',
};