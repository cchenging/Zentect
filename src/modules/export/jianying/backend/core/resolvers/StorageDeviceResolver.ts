// 📁 路径：src/modules/export/jianying/backend/core/resolvers/StorageDeviceResolver.ts
// 存储设备解析：从草稿根目录提取盘符（如 "F:"）

import * as path from 'path';

/**
 * 从草稿根目录提取存储设备盘符（如 "F:"），供 draft_removable_storage_device 使用。
 *
 * 剪映依靠该字段定位草稿所在磁盘，缺失时草稿会从列表中被跳过（手册坑位 11）。
 *
 * @param root 草稿根目录路径
 * @returns 盘符，如 "F:"；无法解析时返回空串
 */
export function resolveStorageDevice(root: string): string {
  const parsed = path.parse(root);
  const m = /^([A-Za-z]):/.exec(parsed.root || '');
  return m ? `${m[1]}:` : '';
}