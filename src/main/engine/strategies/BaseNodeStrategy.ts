// 📁 src/main/engine/strategies/BaseNodeStrategy.ts
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '@modules/infra/logger/LogConstants';
import { PipelineTask } from '../../../shared/types';
import { PathManager } from '../../utils/pathManager';
import { PipelineModelConfigRepository } from '../../database/repositories/ModelRepository';

export interface PipelineParams {
  R: number; // 经典片段保留比 (0-100)
  S: number; // 原台词保留比 (0-100)
  T: number; // TTS 覆盖比 (0-100)
  P: number; // 节奏因子 (0-100)
}

/** 节点模型配置（从 pipeline_model_config 表读取） */
export interface NodeModelConfig {
  provider: string;
  modelName: string;
  customBaseUrl?: string;
  configJson?: any;
}

export interface ExecutionContext {
  projectId: string;
  bus: Map<string, any>;
  /** V1.1: R/S/T/P 参数，由 PipelineEngine 注入，各 Strategy 可读取 */
  pipelineParams?: PipelineParams;
  /** V1.2: 节点模型配置，由 BaseNodeStrategy 自动注入 */
  modelConfig?: NodeModelConfig;
  /** Fix 10: 用户取消管线时的 AbortSignal，所有异步子操作必须监听并中止 */
  signal?: AbortSignal;
}

/** 管线模型配置仓库（懒加载单例） */
let _pipelineConfigRepo: PipelineModelConfigRepository | null = null;
function getPipelineConfigRepo(): PipelineModelConfigRepository {
  if (!_pipelineConfigRepo) _pipelineConfigRepo = new PipelineModelConfigRepository();
  return _pipelineConfigRepo;
}

export interface INodeStrategy {
  readonly nodeType: string;
  /** 节点失败时是否允许 Pipeline 继续执行（降级跳过而非 throw） */
  readonly isRecoverable?: boolean;
  execute(task: PipelineTask, context: ExecutionContext, onProgress: (progress: number, status: string, results?: any) => void): Promise<any>;
}

// 💥 修复：引入泛型约束 TInput 和 TOutput，彻底解决子类类型丢失问题
export abstract class BaseNodeStrategy<TInput = any, TOutput = any> implements INodeStrategy {
  abstract readonly nodeType: string;

  /** 节点失败时是否允许 Pipeline 降级跳过。默认 false。子类可覆盖为 true（如 TTS）。 */
  readonly isRecoverable: boolean = false;

  // 💥 约束子类：严禁重写 execute！所有业务逻辑必须在此方法内实现
  protected abstract performTask(
    input: TInput,
    context: ExecutionContext,
    cacheDir: string,
    onProgress: (p: number, s: string) => void
  ): Promise<TOutput>;

  // 可选的参数校验钩子
  protected async validate(_input: TInput): Promise<void> {}

  public async execute(
    task: PipelineTask,
    context: ExecutionContext,
    onProgress: (progress: number, status: string, results?: any) => void
  ): Promise<TOutput> {
    const { nodeId, params } = task;
    AppLogger.info(LOG_TAGS.SCHEDULER, `[${this.nodeType}] 节点调度启动: ${nodeId}`);

    // 合并 params 和 mergedInputs
    const taskData = task.mergedInputs
      ? { ...(params as any), ...task.mergedInputs }
      : (params as TInput);

    try {
      await this.validate(taskData as TInput);

      /** 从 pipeline_model_config 表查询节点模型配置 */
      try {
        const config = getPipelineConfigRepo().findByProjectAndNodeType(context.projectId, this.nodeType);
        if (config) {
          context.modelConfig = {
            provider: config.provider,
            modelName: config.model_name,
            customBaseUrl: config.custom_base_url || undefined,
            configJson: config.config_json ? JSON.parse(config.config_json) : undefined,
          };
          AppLogger.info(LOG_TAGS.SCHEDULER, `[${this.nodeType}] 模型配置: ${config.provider}/${config.model_name}`);
        }
      } catch (e) {
        AppLogger.warn(LOG_TAGS.SCHEDULER, `[${this.nodeType}] 模型配置查询失败，使用默认配置`, e);
      }

      onProgress(0, 'processing');

      const nodeCacheDir = PathManager.getNodeBaseDir(context.projectId, nodeId, 'frames');
      PathManager.ensureDir(nodeCacheDir);

      const results = await this.performTask(taskData as TInput, context, nodeCacheDir, (p, s) => onProgress(p, s));

      // 防御性检查：确保 context.bus 存在
      if (!context.bus) {
        AppLogger.warn(LOG_TAGS.SCHEDULER, `[${this.nodeType}] context.bus 为空，自动创建补偿实例`);
        context.bus = new Map();
      }
      context.bus.set(nodeId, results);

      onProgress(100, 'success', results);
      AppLogger.info(LOG_TAGS.SCHEDULER, `[${this.nodeType}] 节点执行完毕`);

      return results;
    } catch (error: any) {
      AppLogger.error(LOG_TAGS.SCHEDULER, `[${this.nodeType}] 节点崩溃`, error);
      onProgress(0, 'error', { error: error.message });

      // 💥 recoverable 降级：不 throw，返回 _failed 标记让 PipelineEngine 决定是否继续
      if (this.isRecoverable) {
        AppLogger.warn(LOG_TAGS.SCHEDULER, `[${this.nodeType}] 节点可降级跳过，继续执行后续节点`);
        const degradedResult = { _failed: true, _error: error.message, _nodeType: this.nodeType } as unknown as TOutput;
        context.bus.set(nodeId, degradedResult);
        return degradedResult;
      }

      throw error;
    }
  }
}
