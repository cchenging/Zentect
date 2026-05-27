// 📁 路径：src/main/core/FlowCheckpointPipeline.ts
// Layer 4 进阶: 断点续传管道 — 结合 CheckpointRepository 实现大模型调用断线恢复
import { CheckpointRepository } from '../pipeline/CheckpointRepository';
import { MultiChannelPipeline } from './MultiChannelPipeline';
import { AppLogger } from './AppLogger';
import { LOG_TAGS } from '../../shared/utils/LogConstants';

export class FlowCheckpointPipeline {
  /**
   * 带断点续传的大模型调用管道
   * @param projectId 项目 ID
   * @param mediaId 媒体 ID
   * @param nodeId 节点 ID（对应 stepId）
   * @param stepOrder 步骤顺序
   * @param primaryTask 主通道调用
   * @param fallbackTask 备用通道调用
   * @param checkpointRepo 可选的 CheckpointRepository 实例（用于测试注入）
   */
  public static async executeWithCheckpoint(
    projectId: string,
    mediaId: string,
    nodeId: string,
    stepOrder: number,
    primaryTask: () => Promise<string>,
    fallbackTask: () => Promise<string>,
    checkpointRepo?: CheckpointRepository
  ): Promise<string> {
    const repo = checkpointRepo || new CheckpointRepository();

    // 1. 优先检索本地 Checkpoint 缓存
    const existing = repo.findByStep(projectId, mediaId, nodeId);
    if (existing && existing.status === 'completed' && existing.checkpoint_data) {
      AppLogger.info(LOG_TAGS.SCHEDULER, `[Checkpoint Hit] 节点 ${nodeId} 已存在完好资产，直接跳过网络调用`);
      return existing.checkpoint_data;
    }

    // 2. 执行主/备通道调用（含熔断切换）
    const result = await MultiChannelPipeline.executeWithFailover(
      primaryTask,
      fallbackTask
    );

    // 3. 成功后立即写入 Checkpoint 物理锚点
    repo.upsert({
      projectId,
      mediaId,
      stepId: nodeId,
      stepOrder,
      status: 'completed',
      checkpointData: { result },
    });

    AppLogger.info(LOG_TAGS.SCHEDULER, `[Checkpoint Save] 节点 ${nodeId} 结果已落盘保护`);
    return result;
  }
}
