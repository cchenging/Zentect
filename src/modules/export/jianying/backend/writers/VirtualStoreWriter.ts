// 📁 路径：src/modules/export/jianying/backend/writers/VirtualStoreWriter.ts
// draft_virtual_store.json 写入：剪映 8.9.0+ 素材导入仓库（手册坑位 7）

import { toUuid } from '../core/utils/IdUtils';

/**
 * 构建 draft_virtual_store.json 对象。
 *
 * type=1 记录已导入素材清单，child_id 为素材 id 的小写 UUID 格式（8-4-4-4-12）。
 *
 * @param content 已编译的 draft_content 对象
 * @returns draft_virtual_store.json 对象
 */
export function buildDraftVirtualStore(content: Record<string, unknown>): Record<string, unknown> {
  const materials = (content.materials as any) || {};
  const children: Array<{ child_id: string; parent_id: string }> = [];

  for (const cat of ['videos', 'audios', 'texts']) {
    for (const mat of (materials[cat] as any[]) || []) {
      if (!mat || !mat.id) continue;
      children.push({ child_id: toUuid(mat.id), parent_id: '' });
    }
  }

  return {
    draft_materials: [],
    draft_virtual_store: [
      {
        type: 0,
        value: [
          {
            creation_time: 0,
            display_name: '',
            filter_type: 0,
            id: '',
            import_time: 0,
            import_time_us: 0,
            sort_sub_type: 0,
            sort_type: 0,
          },
        ],
      },
      { type: 1, value: children },
      { type: 2, value: [] as unknown[] },
    ],
  };
}