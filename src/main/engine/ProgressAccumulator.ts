/**
 * ProgressAccumulator — L2 引擎层全局进度归一化器
 *
 * 职责：将节点序列按"耗时权重"分配全局进度区间 [start, end]，
 * 并把节点内部 0~100 进度映射为全局进度，提供单调保护（只增不减）与防丢尾。
 *
 * 设计原则（对照项目准则）：
 * - 单调不重复：map() 内部 Math.max(已推送最大值, 新值)，杜绝并发/顺序错乱导致的进度倒退；
 * - 与耗时成比例：权重由调用方按真实耗时注入（静态经验权重表），消除"卡住不动/瞬间跳变"；
 * - 单点职责：strategy 只报节点内部进度，前端只显示，归一化只发生在此处。
 */

/** 节点标识 → 全局区间的注册项 */
interface NodeRange {
  /** 全局起始（0~100 整数，含） */
  start: number;
  /** 全局终点（0~100 整数，含） */
  end: number;
}

export class ProgressAccumulator {
  /** 节点ID → [全局start, 全局end]（0~100 整数，按权重分配） */
  private ranges = new Map<string, NodeRange>();
  /** 已推送的全局进度最大值（单调保护基线，-1 表示尚未推送） */
  private lastGlobal = -1;

  /**
   * 注册节点序列，按权重分配全局区间。
   * @param nodes 节点序列（只需 nodeId）
   * @param weights 节点ID → 权重；缺省节点按权重 1 均分，未注册节点 map() 时退化为 0~100
   */
  register(nodes: { nodeId: string }[], weights?: Record<string, number>): void {
    const total = nodes.reduce((sum, n) => sum + (weights?.[n.nodeId] ?? 1), 0);
    let cursor = 0;
    this.ranges.clear();
    nodes.forEach((n) => {
      const w = weights?.[n.nodeId] ?? 1;
      const start = (cursor / total) * 100;
      const end = ((cursor + w) / total) * 100;
      this.ranges.set(n.nodeId, { start: Math.round(start), end: Math.round(end) });
      cursor += w;
    });
    this.lastGlobal = -1;
  }

  /**
   * 将节点内部 0~100 进度映射为全局进度（单调、防回退）。
   * @param nodeId 节点 ID
   * @param nodeProgress 节点内部进度 0~100
   * @returns 全局进度 0~100 整数
   */
  map(nodeId: string, nodeProgress: number): number {
    const range = this.ranges.get(nodeId) ?? { start: 0, end: 100 };
    const clampedNode = Math.max(0, Math.min(100, nodeProgress));
    const global = range.start + ((range.end - range.start) * clampedNode) / 100;
    const clampedGlobal = Math.min(100, Math.max(this.lastGlobal, global));
    this.lastGlobal = clampedGlobal;
    return Math.round(clampedGlobal);
  }

  /**
   * 节点完成时强制固定到区间终点（防丢尾）：错误/降级等未走到 100 的场景下，
   * 仍将全局进度推进到该节点区间末端，保证后续节点能接续推进而不回退。
   * @param nodeId 节点 ID
   * @returns 固定后的全局进度 0~100 整数
   */
  settle(nodeId: string): number {
    const range = this.ranges.get(nodeId) ?? { start: 0, end: 100 };
    this.lastGlobal = Math.max(this.lastGlobal, range.end);
    return Math.round(Math.min(100, this.lastGlobal));
  }

  /** 当前已推送的最大全局进度（调试/测试用） */
  get current(): number {
    return this.lastGlobal;
  }
}
