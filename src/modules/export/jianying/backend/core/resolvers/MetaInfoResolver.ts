// 📁 路径：src/modules/export/jianying/backend/core/resolvers/MetaInfoResolver.ts
// 元数据解析：构建 draft_meta_info.json（31 键，剪映草稿列表扫描依赖）

import { resolveStorageDevice } from './StorageDeviceResolver';
import { resolveTimelineSize } from './TimelineSizeResolver';

/** 草稿元数据解析输入 */
export interface MetaInfoInput {
  /** 草稿文件夹绝对路径（原生反斜杠） */
  draftFolder: string;
  /** 草稿根目录 */
  jianyingRoot: string;
  /** 草稿名（如 "Z_项目名 (1)"） */
  draftName: string;
  /** draft_content 对象（用于取 id / duration / 素材路径） */
  draftContent: Record<string, unknown>;
}

/**
 * 构建 draft_meta_info.json（31 键）。
 *
 * 手册 §5：剪映草稿列表扫描依赖此文件，缺失则"剪映看不到导出"。
 * 关键必填字段：draft_id / draft_name / draft_fold_path / draft_root_path /
 * draft_removable_storage_device / draft_new_version / draft_timeline_materials_size_ / tm_duration。
 *
 * @param input 元数据解析输入
 * @returns draft_meta_info.json 对象
 */
export function resolveMetaInfo(input: MetaInfoInput): Record<string, unknown> {
  const { draftFolder, jianyingRoot, draftName, draftContent } = input;
  const draftId = String(draftContent.id || '');

  return {
    cloud_package_completed_time: '',
    draft_cloud_capcut_purchase_info: '',
    draft_cloud_last_action_download: false,
    draft_cloud_materials: [],
    draft_cloud_purchase_info: '',
    draft_cloud_template_id: '',
    draft_cloud_tutorial_info: '',
    draft_cloud_videocut_purchase_info: '',
    draft_cover: '',
    draft_deeplink_url: '',
    draft_enterprise_info: {
      draft_enterprise_extra: '',
      draft_enterprise_id: '',
      draft_enterprise_name: '',
      enterprise_material: [],
    },
    draft_fold_path: draftFolder.replace(/\\/g, '/'),
    draft_removable_storage_device: resolveStorageDevice(jianyingRoot),
    draft_id: draftId,
    draft_is_ai_packaging_used: false,
    draft_is_ai_shorts: false,
    draft_is_ai_translate: false,
    draft_is_article_video_draft: false,
    draft_is_from_deeplink: 'false',
    draft_is_invisible: false,
    draft_materials: [],
    draft_materials_copied_info: [],
    draft_name: draftName,
    draft_new_version: '110.0.0',
    draft_root_path: jianyingRoot,
    draft_segment_extra_info: [],
    draft_timeline_materials_size_: resolveTimelineSize(draftContent),
    draft_type: '',
    tm_draft_cloud_completed: '',
    tm_draft_cloud_modified: 0,
    tm_draft_create: Date.now(),
    tm_draft_modified: Date.now(),
    tm_draft_removed: 0,
    tm_duration: Number(draftContent.duration) || 0,
  };
}