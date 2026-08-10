// 📁 路径：src/modules/export/jianying/backend/core/resolvers/TimelineSizeResolver.ts
// 时间线素材大小解析：计算 draft_timeline_materials_size_

import * as fs from 'fs';

/**
 * 计算时间线素材总字节数（draft_timeline_materials_size_）。
 *
 * 遍历草稿 materials 中所有视频/音频素材的 path，累加文件大小。
 * 手册 §5：该字段为所有素材文件大小总和（字节），缺失会被剪映跳过。
 *
 * @param content 已编译的 draft_content 对象
 * @returns 素材文件总字节数
 */
export function resolveTimelineSize(content: Record<string, unknown>): number {
  const materials = (content.materials as any) || {};
  let total = 0;
  for (const cat of ['videos', 'audios']) {
    const list = (materials[cat] as any[]) || [];
    for (const mat of list) {
      if (!mat || typeof mat.path !== 'string') continue;
      try {
        total += fs.statSync(mat.path).size;
      } catch {
        /* 素材文件缺失不计入，交由剪映打开时校验 */
      }
    }
  }
  return total;
}