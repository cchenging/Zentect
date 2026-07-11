// 📁 路径：src/main/core/StreamBufferGuard.ts
// Layer 4 进阶: 流式调用断点保护 — 网络熔断时验证完整性，破损则回滚为空契约
import { NetworkPipeline } from './NetworkPipeline';
import { AppLogger } from './AppLogger';
import { LOG_TAGS } from '../../modules/infra/logger/LogConstants';

export class StreamBufferGuard {
  /** 流式数据块缓存 */
  private chunkCache: string = '';

  /** 追加流式数据块 */
  public append(chunk: string): void {
    this.chunkCache += chunk;
  }

  /** 获取当前缓存内容 */
  public getCache(): string {
    return this.chunkCache;
  }

  /** 重置缓存（新会话开始时调用） */
  public reset(): void {
    this.chunkCache = '';
  }

  /**
   * 突发断网时，验证完整性并决定放行或回滚
   * @returns 合法则返回清洗后的 JSON；破损则返回空数组契约
   */
  public rollbackOrResolve(): string {
    try {
      // 尝试在数据流向状态层前，进行闭合合法性测试
      const testClean = NetworkPipeline.sanitizeJson(this.chunkCache);
      JSON.parse(testClean);
      return testClean; // 验证通过，数据合法
    } catch {
      // 格式破损，说明流式传输被意外截断，启动快照隔离
      AppLogger.warn(LOG_TAGS.SCHEDULER, '流式传输因网络异常截断，触发主进程快照保护，丢弃当前受污染资产');
      return '[]'; // 返回空契约降级，交由异常层转换为多语言弹窗
    }
  }
}
