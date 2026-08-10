// 📁 路径：src/modules/export/jianying/backend/core/resolvers/TimelineSizeResolver.ts
// 时间线素材大小解析：计算 draft_timeline_materials_size_

import * as fs from 'fs';

/**
 * 计算时间线素材总字节数（draft_timeline_materials_size_）。
 *
 * 遍历草稿 materials 中所有视频/音频素材的 path，按文件绝对路径去重后累加文件大小。
 * 关键：多个镜头可能引用同一个源视频/切片文件（chunkData 缺失时统一回退源视频），
 * 若不去重会把这个大文件重复累加 N 次，导致该字段虚高（如显示 7G）。
 * 手册 §5：该字段为所有素材文件大小总和（字节），缺失会被剪映跳过。
 *
 * @param content 已编译的 draft_content 对象
 * @returns 素材文件总字节数
 */
export function resolveTimelineSize(content: Record<string, unknown>): number {
  const materials = (content.materials as any) || {};
  // 按文件绝对路径去重，同一素材文件只计入一次
  const seenPaths = new Set<string>();
  let total = 0;
  for (const cat of ['videos', 'audios']) {
    const list = (materials[cat] as any[]) || [];
    for (const mat of list) {
      if (!mat || typeof mat.path !== 'string') continue;
      const normPath = mat.path.replace(/\\/g, '/');
      if (seenPaths.has(normPath)) continue;
      seenPaths.add(normPath);
      try {
        total += fs.statSync(mat.path).size;
      } catch {
        /* 素材文件缺失不计入，交由剪映打开时校验 */
      }
    }
  }
  return total;
}