// 📁 路径：src/main/core/EngineStateGuard.ts
// Layer 3: 主进程算力互斥锁 — 阻断前端高频重复点击穿透到核心算力层
import { AppLogger } from './AppLogger';
import { LOG_TAGS } from '../../shared/utils/LogConstants';

export class EngineStateGuard {
  /** 内存常驻，追踪当前正在执行高负载算力的节点 ID */
  private static activeNodes = new Set<string>();

  /**
   * 尝试锁定某个算法节点
   * @param nodeId 节点唯一标识
   * @param actionType 算力动作类型（如 vision-extract、audio-separate）
   * @returns true 锁定成功获准执行；false 节点繁忙，已安全拦截
   */
  public static acquire(nodeId: string, actionType: string): boolean {
    if (this.activeNodes.has(nodeId)) {
      AppLogger.warn(
        LOG_TAGS.SCHEDULER,
        `[状态红线拦截] 算力节点 ${actionType} (${nodeId}) 当前正在执行中，已安全拦截二次无序请求`
      );
      return false;
    }
    this.activeNodes.add(nodeId);
    AppLogger.info(LOG_TAGS.SCHEDULER, `[状态锁定] 算力节点 ${actionType} (${nodeId}) 已获准执行`);
    return true;
  }

  /**
   * 释放算力锁 — 无论完工还是抛错崩溃，铁律释放
   * @param nodeId 节点唯一标识
   */
  public static release(nodeId: string): void {
    this.activeNodes.delete(nodeId);
    AppLogger.info(LOG_TAGS.SCHEDULER, `[状态释放] 节点 (${nodeId}) 算力锁已释放`);
  }

  /**
   * 查询指定节点是否正在执行
   * @param nodeId 节点唯一标识
   */
  public static isRunning(nodeId: string): boolean {
    return this.activeNodes.has(nodeId);
  }

  /**
   * 获取当前所有活跃节点 ID（用于调试和状态展示）
   */
  public static getActiveNodes(): string[] {
    return [...this.activeNodes];
  }

  /**
   * 强制清空所有锁（仅用于系统级重置，如全局熔断）
   */
  public static forceReset(): void {
    this.activeNodes.clear();
    AppLogger.warn(LOG_TAGS.SCHEDULER, '[状态重置] 所有算力锁已强制清空');
  }
}
