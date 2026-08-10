// 📁 路径：src/modules/export/jianying/backend/core/resolvers/DraftNameResolver.ts
// 草稿命名解析：Z_项目名 (自增序号)

import * as fs from 'fs';

/**
 * 生成草稿名：Z_项目名 (自增序号)。
 *
 * 命名规则：扫描剪映草稿根目录下已存在的同名草稿文件夹，取最大序号 +1，
 * 首个导出即为 "(1)"，后续依次递增，便于在剪映列表里直观排序。
 *
 * @param safeName    - 已清洗非法字符的项目名
 * @param jianyingRoot - 剪映草稿根目录
 * @returns 例如 "Z_测试项目 (1)"、"Z_测试项目 (2)"
 */
export function resolveDraftName(safeName: string, jianyingRoot: string): string {
  const base = `Z_${safeName}`;
  // 匹配已存在的 "Z_项目名 (N)" 文件夹，提取最大序号
  let maxIndex = 0;
  try {
    const entries = fs.readdirSync(jianyingRoot, { withFileTypes: true });
    const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\((\\d+)\\)$`);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const m = entry.name.match(re);
      if (m) {
        const idx = parseInt(m[1], 10);
        if (idx > maxIndex) maxIndex = idx;
      }
    }
  } catch {
    /* 目录不可读时从 0 开始，交由后续 mkdir 抛错暴露真实问题 */
  }
  return `${base} (${maxIndex + 1})`;
}