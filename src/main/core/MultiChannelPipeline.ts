// 📁 路径：src/main/core/MultiChannelPipeline.ts
// Layer 4 进阶: AI 通道熔断自动切换 — 主通道失败后自动降级到备用通道
import { AppLogger } from './AppLogger';
import { LOG_TAGS } from '../../modules/infra/logger/LogConstants';
import { AppError, ErrorCode } from '../../modules/infra/error/AppError';

export class MultiChannelPipeline {
  /** 默认主通道重试次数 */
  private static readonly DEFAULT_RETRIES = 2;

  /** 重试基础间隔（毫秒），指数退避 */
  private static readonly BASE_DELAY_MS = 1000;

  /**
   * AI 通道熔断自动切换 — 主通道失败后自动降级到备用通道
   * @param primaryCall 主算力通道调用（如火山大模型）
   * @param fallbackCall 备用容灾通道调用（如 OpenAI Compatible 代理通道）
   * @param retries 主通道重试次数（默认 2）
   * @returns 主通道或备用通道的返回值
   */
  public static async executeWithFailover<T>(
    primaryCall: () => Promise<T>,
    fallbackCall: () => Promise<T>,
    retries = this.DEFAULT_RETRIES
  ): Promise<T> {
    try {
      return await primaryCall();
    } catch (primaryError) {
      // 主通道仍有重试次数，执行指数退避重试
      if (retries > 0) {
        const delay = this.BASE_DELAY_MS * (this.DEFAULT_RETRIES - retries + 1);
        AppLogger.warn(LOG_TAGS.SYSTEM, `主算力通道波动，${delay}ms 后重试。剩余: ${retries}`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.executeWithFailover(primaryCall, fallbackCall, retries - 1);
      }

      // 熔断触发：主通道彻底崩溃，自动降级到备用通道
      AppLogger.warn(LOG_TAGS.SYSTEM, '主算力通道熔断，自动切换到备用 AI 通道');
      try {
        return await fallbackCall();
      } catch (fallbackError) {
        // 双通道全灭，抛出标准错误交由 ExceptionHub 归一化
        AppLogger.error(LOG_TAGS.SYSTEM, '双通道全灭，所有 AI 通道不可用', fallbackError);
        throw new AppError(ErrorCode.AI_PROCESS_FAILED, 'All LLM channels exhausted');
      }
    }
  }
}
