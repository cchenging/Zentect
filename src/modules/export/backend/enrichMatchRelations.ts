// 📁 路径：src/modules/export/backend/enrichMatchRelations.ts
// 阶段 A 核心纯函数：对"相邻镜头序列"做父子/关系判定，
// 识别同一物理镜头（parentChunkId 相同）内被细分/拆分出的连续子段（假转场），
// 为导出层提供合并依据（sceneGroupId）。
//
// 设计：
//   - 泛型实现：任意带 { id, chunkData } 形状的镜头序列（ExportShot / CompileShot）共用同一判定逻辑，
//     单一实现、多出口消费，避免逻辑分叉。
//   - 只读入数组，返回增强后的新数组（不修改入参），无 IO、无副作用，可单测。
//   - 父 ID 解析：优先 chunkData.parentChunkId（Python 切片 / Node 兜底拆分已回填）；
//     老数据无父子字段时 fallback 到 chunkData.id（各段唯一 → 永不触发合并，仅作异常兜底，非生效路径）。
//   - 时间连续性：源时间轴上 |当前 startMs - 前段 endMs| < 100ms 才判定为同镜头连续。
//     双条件（同父 + 时间连续）命中才合并，避免"同父但时间不连续"的误判（用户评审采纳的隐患1）。
//   - sceneGroupId 仅在真正形成合并组时写入（组首与组内成员都有），其余段不设。

/** 相邻镜头关系 */
export type ShotRelation = 'FIRST' | 'SCENE_SWITCH' | 'SAME_SCENE_CONTINUOUS';

/** 参与关系判定的最小镜头形状（ExportShot / CompileShot 均满足） */
export interface RelationEnrichable {
  id: string;
  chunkData?: Record<string, unknown> | null;
  /** 解析后写入的父 ID */
  parentChunkId?: string;
  /** 解析后写入的相邻关系 */
  prevRelation?: ShotRelation;
  /** 解析后写入的合并组 id */
  sceneGroupId?: string;
}

/** 同父且时间连续判定容差（ms）：源时间轴上两段首尾间隙小于该值视为物理连续 */
const TIME_CONTINUITY_MS = 100;

/** 解析镜头所属物理镜头父 ID */
function resolveParentId(shot: RelationEnrichable): string | undefined {
  const chunk = shot.chunkData;
  if (!chunk || typeof chunk !== 'object') return undefined;
  const parentChunkId = chunk.parentChunkId;
  if (typeof parentChunkId === 'string' && parentChunkId.trim() !== '') {
    return parentChunkId;
  }
  // 异常兜底：老数据无父子字段 → 以 chunk.id 为父。各段 id 唯一 → 永不相等，不会误合并。
  const id = chunk.id;
  return typeof id === 'string' && id.trim() !== '' ? id : undefined;
}

/**
 * 对镜头序列做相邻关系增强（泛型，ExportShot / CompileShot 共用）。
 * @param shots 按时间线顺序排列的镜头序列
 * @returns 增强后的新数组（写入 parentChunkId / prevRelation / sceneGroupId）
 */
export function enrichMatchRelations<T extends RelationEnrichable>(shots: T[]): T[] {
  if (!Array.isArray(shots) || shots.length === 0) return [];

  const enriched: T[] = shots.map((s) => ({ ...s }));
  let groupSeq = 0;
  let currentGroupId: string | undefined;

  for (let i = 0; i < enriched.length; i++) {
    const shot = enriched[i];
    const chunk = shot.chunkData;
    const parentId = resolveParentId(shot);
    shot.parentChunkId = parentId;

    if (i === 0 || parentId === undefined) {
      // 首段 / 父解析失败（无切片或异常兜底）：不合并，重置组
      shot.prevRelation = 'FIRST';
      currentGroupId = undefined;
      continue;
    }

    const prev = enriched[i - 1];
    // 源时间轴连续性校验：|当前 startMs - 前段 endMs| < 容差
    const curStart = chunk && typeof chunk.startMs === 'number' ? (chunk.startMs as number) : undefined;
    const prevChunk = prev.chunkData;
    const prevEnd = prevChunk && typeof prevChunk.endMs === 'number' ? (prevChunk.endMs as number) : undefined;
    const isTimeContinuous =
      curStart !== undefined &&
      prevEnd !== undefined &&
      Math.abs(curStart - prevEnd) < TIME_CONTINUITY_MS;

    if (prev.parentChunkId === parentId && isTimeContinuous) {
      shot.prevRelation = 'SAME_SCENE_CONTINUOUS';
      // 组延续：上一段已在组内则续用，否则开新组并把组首也标记进去
      if (currentGroupId === undefined) {
        groupSeq += 1;
        currentGroupId = `SG_${groupSeq}`;
        prev.sceneGroupId = currentGroupId;
      }
      shot.sceneGroupId = currentGroupId;
    } else {
      shot.prevRelation = 'SCENE_SWITCH';
      currentGroupId = undefined;
    }
  }

  return enriched;
}
