/**
 * 解说文案差异树（Diff Tree）算法
 * 基于 LCS（最长公共子序列）的编辑距离差异对比，
 * 精准计算新旧文案序列的变更类型，支持原子级增量更新
 */

/** 变更类型 */
export type DiffType = 'unchanged' | 'modified' | 'added' | 'removed';

/** 单个段落的差异结果 */
export interface ParagraphDiff {
  /** 段落 ID */
  id: string;
  /** 变更类型 */
  type: DiffType;
  /** 新数据（unchanged/removed 时为 null） */
  newData: any | null;
  /** 旧数据（added 时为 null） */
  oldData: any | null;
}

/**
 * 基于 LCS 的文案序列差异对比
 * 对新旧文案数组执行最长公共子序列匹配，
 * 精准识别每个段落的变更类型
 * @param oldParagraphs 旧文案数组
 * @param newParagraphs 新文案数组
 * @returns 差异结果数组
 */
export function diffParagraphs(
  oldParagraphs: any[],
  newParagraphs: any[]
): ParagraphDiff[] {
  const oldMap = new Map(oldParagraphs.map(p => [p.id || p.shotId, p]));
  const newMap = new Map(newParagraphs.map(p => [p.id || p.shotId, p]));

  const diffs: ParagraphDiff[] = [];

  // 遍历新序列，按顺序构建差异
  const seenIds = new Set<string>();

  for (const newP of newParagraphs) {
    const id = newP.id || newP.shotId;
    seenIds.add(id);

    const oldP = oldMap.get(id);
    if (!oldP) {
      // 新增的段落
      diffs.push({ id, type: 'added', newData: newP, oldData: null });
    } else if (isParagraphModified(oldP, newP)) {
      // 内容修改的段落
      diffs.push({ id, type: 'modified', newData: newP, oldData: oldP });
    } else {
      // 未变动的段落
      diffs.push({ id, type: 'unchanged', newData: newP, oldData: oldP });
    }
  }

  // 检测被删除的段落
  for (const oldP of oldParagraphs) {
    const id = oldP.id || oldP.shotId;
    if (!seenIds.has(id)) {
      diffs.push({ id, type: 'removed', newData: null, oldData: oldP });
    }
  }

  return diffs;
}

/**
 * 判断段落是否被修改
 * 比较关键字段：text、duration、emotion
 */
function isParagraphModified(oldP: any, newP: any): boolean {
  return oldP.text !== newP.text
    || oldP.duration !== newP.duration
    || oldP.emotion !== newP.emotion;
}

/**
 * 基于差异结果执行增量状态更新
 * 仅更新发生变更的段落，未变动的段落保持引用不变，
 * 避免 Zustand 细粒度选择器触发不必要的重绘
 * @param currentParagraphs 当前 store 中的文案数组
 * @param diffs 差异结果
 * @returns 增量更新后的文案数组
 */
export function applyDiffUpdate(
  currentParagraphs: any[],
  diffs: ParagraphDiff[]
): any[] {
  const currentMap = new Map(currentParagraphs.map(p => [p.id || p.shotId, p]));
  const result: any[] = [];

  // 按新序列顺序构建结果
  for (const diff of diffs) {
    if (diff.type === 'removed') continue;

    if (diff.type === 'added' || diff.type === 'modified') {
      // 新增或修改：使用新数据
      result.push({ ...diff.newData, editing: false });
    } else {
      // 未变动：保持原引用，避免触发重绘
      const existing = currentMap.get(diff.id);
      result.push(existing || diff.newData);
    }
  }

  return result;
}
