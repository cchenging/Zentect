// 📁 路径：src/main/utils/CacheGarbageCollector.ts
// Layer 6 基建: 优雅关机时静默清理磁盘冷资产碎片
import fs from 'fs';
import path from 'path';
import { PathManager } from './pathManager';
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../infra/logger/LogConstants';

export class CacheGarbageCollector {
  /** 缓存过期红线：7 天 */
  private static readonly MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

  /**
   * 极轻量扫描：针对超过 7 天的本地 L2 缓存块进行安全物理抹杀
   * 在应用优雅关机时调用，不引入定时扫描线程
   */
  public static runSilentGC(): void {
    const cacheRoot = path.join(PathManager.getProjectsRootPath(), 'cache');
    if (!fs.existsSync(cacheRoot)) return;

    try {
      const entries = fs.readdirSync(cacheRoot);
      const now = Date.now();
      let reclaimedCount = 0;

      for (const entry of entries) {
        const fullPath = path.join(cacheRoot, entry);
        const stat = fs.statSync(fullPath);

        if (now - stat.mtimeMs > this.MAX_CACHE_AGE_MS) {
          if (stat.isDirectory()) {
            fs.rmSync(fullPath, { recursive: true, force: true });
          } else {
            fs.unlinkSync(fullPath);
          }
          reclaimedCount++;
        }
      }

      if (reclaimedCount > 0) {
        AppLogger.info(LOG_TAGS.SYSTEM, `基础设施层：冷资产 L2 磁盘垃圾回收完成，清理 ${reclaimedCount} 项`);
      }
    } catch {
      // 基础设施异常静默跳过，绝不干扰正常的关机排水逻辑
    }
  }
}
