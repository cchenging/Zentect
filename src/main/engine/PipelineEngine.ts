// 📁 src/main/engine/PipelineEngine.ts
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../modules/infra/logger/LogConstants';
import { PipelineTask, PipelinePayload, TaskProgressPayload } from '../../shared/types';
import { INodeStrategy, ExecutionContext } from './strategies/BaseNodeStrategy';
import { VisionExtractStrategy } from './strategies/VisionExtractStrategy';
import { AudioSeparateStrategy } from './strategies/AudioSeparateStrategy';
import { ASRStrategy } from './strategies/ASRStrategy';
import { ScriptGenStrategy } from './strategies/ScriptGenStrategy';
import { TTSStrategy } from '../../modules/pipeline/step4-tts/backend/Strategy';
import { FaceDetectStrategy } from './strategies/FaceDetectStrategy';
import { SemanticAnalyzeStrategy } from './strategies/SemanticAnalyzeStrategy';
import { SentimentAnalyzeStrategy } from './strategies/SentimentAnalyzeStrategy';
import { LLMProcessorStrategy } from './strategies/LLMProcessorStrategy';
import { ClusterFacesStrategy } from './strategies/ClusterFacesStrategy';
import { ClipSemanticStrategy } from './strategies/ClipSemanticStrategy';
import { SemanticFlowStrategy } from './strategies/SemanticFlowStrategy';
import { Step1MaterialStrategy } from '../../modules/pipeline/step1-material/backend/Strategy';

import { PathManager } from '../utils/pathManager';
import { generateStateHash } from '../utils/crypto';
import { WorkflowService } from '../services/WorkflowService';
import { SettingsRepository } from '../database/repositories/SettingsRepository';
import { EngineStateGuard } from '../core/EngineStateGuard';
import { ExceptionHub } from '../core/ExceptionHub';
import { IPC_CHANNELS } from '../../modules/infra/ipc/IpcConstants';
import * as path from 'path';
import * as fs from 'fs';

export class PipelineEngine {
  private strategyRegistry: Map<string, INodeStrategy> = new Map();
  private isAborted = false;
  /** Fix 10: 当前管线的 AbortController，用于向子进程/HTTP 请求传播取消信号 */
  private abortController: AbortController | null = null;

  constructor() {
    // 💥 注册点：符合 OCP 原则，未来新增节点仅需在此添加一行
    this.register(new VisionExtractStrategy());
    this.register(new AudioSeparateStrategy());
    this.register(new ASRStrategy());
    this.register(new ScriptGenStrategy());
    this.register(new TTSStrategy());
    this.register(new FaceDetectStrategy());
    this.register(new SemanticAnalyzeStrategy());
    this.register(new SentimentAnalyzeStrategy());
    this.register(new LLMProcessorStrategy());
    this.register(new ClusterFacesStrategy());
    this.register(new ClipSemanticStrategy());
    this.register(new SemanticFlowStrategy());
    this.register(new Step1MaterialStrategy());
  }

  private register(strategy: INodeStrategy) {
    this.strategyRegistry.set(strategy.nodeType, strategy);
  }

  public abort() {
    this.isAborted = true;
    // Fix 10: 触发 AbortController，让所有正在运行的子进程/HTTP 请求立即中止
    this.abortController?.abort();
    this.abortController = null;
    EngineStateGuard.forceReset(); // 💥 全局熔断时清空所有算力锁
    AppLogger.warn(LOG_TAGS.SCHEDULER, '🛑 收到全局熔断指令，算力锁已全部清空');
  }

  /** V1.1: 从 Settings 读取 R/S/T/P 参数，注入到 ExecutionContext */
  private loadPipelineParams(): { R: number; S: number; T: number; P: number } {
    const settings = new SettingsRepository();
    return {
      R: settings.get('pipeline.param.retainRatio', 50),
      S: settings.get('pipeline.param.silenceRatio', 50),
      T: settings.get('pipeline.param.ttsCoverage', 50),
      P: settings.get('pipeline.param.paceFactor', 50),
    };
  }

  /** V1.1: 从 WorkflowService 加载 DAG 并执行 — 支持拓扑排序与并行调度 */
  async executeFromWorkflow(
    projectId: string,
    onProgressUpdate: (progressData: TaskProgressPayload) => void
  ): Promise<any> {
    this.isAborted = false;
    this.abortController = new AbortController();

    const workflowService = new WorkflowService();
    const snapshot = workflowService.load(projectId);

    if (!snapshot || snapshot.nodes.length === 0) {
      AppLogger.warn(LOG_TAGS.SCHEDULER, `[V1.1] 工程 ${projectId} 无可用工作流快照，回退到空序列`);
      return {};
    }

    const { nodes, edges } = snapshot;

    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();
    nodes.forEach(n => { inDegree.set(n.id, 0); adjacency.set(n.id, []); });
    edges.forEach(e => {
      adjacency.get(e.source)?.push(e.target);
      inDegree.set(e.target, (inDegree.get(e.target) || 0) + 1);
    });

    const context: ExecutionContext = {
      projectId,
      bus: new Map<string, any>(),
      pipelineParams: this.loadPipelineParams(),
      signal: this.abortController.signal,
    };

    const ready: string[] = [];
    nodes.forEach(n => { if ((inDegree.get(n.id) || 0) === 0) ready.push(n.id); });

    AppLogger.info(LOG_TAGS.SCHEDULER, `[V1.1] DAG 拓扑就绪，入口节点数: ${ready.length}, 总节点: ${nodes.length}`);

    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const completed = new Set<string>();

    while (ready.length > 0) {
      if (this.isAborted) break;

      const batch = [...ready];
      ready.length = 0;

      const batchPromises = batch.map(async (nodeId) => {
        if (this.isAborted) return;

        const node = nodeMap.get(nodeId);
        if (!node) return;

        const rawActionType = node.data?.actionType || node.type;
        const actionType: string = typeof rawActionType === 'string' ? rawActionType : '';
        const strategy = this.strategyRegistry.get(actionType);
        if (!strategy) {
          AppLogger.warn(LOG_TAGS.SCHEDULER, `[V1.1] 跳过未知节点类型: ${actionType} (${nodeId})`);
          completed.add(nodeId);
          return;
        }

        try {
          // 算力互斥锁：阻断并发重叠
          if (!EngineStateGuard.acquire(nodeId, actionType)) {
            AppLogger.warn(LOG_TAGS.SCHEDULER, `[V1.1] 节点 ${nodeId} 被算力互斥锁拦截，跳过本次执行`);
            // 不标记 completed，下游节点不会被调度，避免读到 undefined 数据
            return;
          }

          const task: PipelineTask = {
            nodeId,
            actionType,
            label: typeof node.data?.label === 'string' ? node.data.label : actionType,
            dependsOn: [],
            mergedInputs: {},
            params: (node.data as Record<string, unknown>) || {},
          };
          const result = await this.executeNodeTask(strategy, task, context, onProgressUpdate);
          if (result && result._failed === true && strategy.isRecoverable) {
            onProgressUpdate({
              nodeId, progress: 100, status: 'degraded',
              message: `${actionType} 降级通过`,
              results: result,
            });
          }
        } catch (error: any) {
          // 💥 Layer 5 异常归一化：将原始错误转换为 I18N Key 契约载荷
          const i18nPayload = ExceptionHub.normalize(error);
          AppLogger.error(LOG_TAGS.SCHEDULER, `[V1.1] 节点 ${nodeId} 异常归一化: ${i18nPayload.titleKey}`, error);

          if (!strategy.isRecoverable) throw error;
          AppLogger.warn(LOG_TAGS.SCHEDULER, `[V1.1] 节点 ${nodeId} 可恢复失败:`, error.message);
        } finally {
          // 💥 铁律释放算力锁
          EngineStateGuard.release(nodeId);
        }
      });

      await Promise.all(batchPromises);
      batch.forEach(id => completed.add(id));

      batch.forEach(nodeId => {
        (adjacency.get(nodeId) || []).forEach(nextId => {
          const currentDeg = inDegree.get(nextId) || 1;
          const newDeg = currentDeg - 1;
          inDegree.set(nextId, newDeg);
          if (newDeg === 0) ready.push(nextId);
        });
      });
    }

    if (completed.size < nodes.length) {
      if (!this.isAborted) {
        AppLogger.warn(LOG_TAGS.SCHEDULER, `[V1.1] DAG 存在未完成的节点 (可能因循环依赖)`);
      }
    }

    return Object.fromEntries(context.bus);
  }

  /**
   * 执行完整的 DAG 任务序列（兼容旧接口）
   */
  public async execute(
    payload: any,
    sender: Electron.WebContents
  ): Promise<any> {
    return await this.executePipeline(
      payload,
      (progressData: TaskProgressPayload) => {
        if (sender && !sender.isDestroyed()) {
          sender.send('engine:pipeline-progress', progressData);
        }
      }
    );
  }

  /**
   * 执行完整的 DAG 任务序列
   */
  public async executePipeline(
    payload: PipelinePayload,
    onProgressUpdate: (progressData: TaskProgressPayload) => void
  ): Promise<any> {
    this.isAborted = false;
    this.abortController = new AbortController();
    
    // 💥 核心：建立贯穿整个管线的总线，节点连线的数据传递全靠它
    const context: ExecutionContext = {
      projectId: payload.projectId,
      bus: new Map<string, any>(),
      pipelineParams: this.loadPipelineParams(),
      signal: this.abortController.signal,
    };

    // 如果前端传了 sourceMedia，直接将其注入总线作为起始点
    if (payload.sourceMedia) {
      context.bus.set('source_root', { filePath: payload.sourceMedia });
    }

    // 💥 架构最优解：宽容拆包 (Postel's Law)
    let sequence: any[] = [];
    if (Array.isArray(payload)) {
      sequence = payload;
    } else if (payload && typeof payload === 'object') {
      sequence = payload.sequence || (payload as any).actions || [];
      
      if (!sequence || !Array.isArray(sequence)) {
        if ((payload as any).action && (payload as any).nodeId) {
          AppLogger.info(LOG_TAGS.SCHEDULER, `[智能拆包] 检测到单兵任务，已自动封装为序列: ${(payload as any).action}`);
          sequence = [payload]; // 动态包装成长度为 1 的序列
        }
      }
    }

    if (!sequence || sequence.length === 0) {
      AppLogger.warn(LOG_TAGS.SCHEDULER, '[PipelineEngine] 拆包后执行序列依然为空，已安全拦截');
      return {};
    }

    AppLogger.info(LOG_TAGS.SCHEDULER, `🚀 开始执行工作流，共 ${sequence.length} 个节点`);

    for (const task of sequence) {
      if (this.isAborted) break;

      const actionType = task.actionType || task.type;
      const strategy = this.strategyRegistry.get(actionType);
      
      if (!strategy) {
        if (actionType === 'frame-extract') {
          const legacyStrategy = this.strategyRegistry.get('vision-extract');
          if (legacyStrategy) {
            task.actionType = 'vision-extract';
            await this.executeNodeTask(legacyStrategy, task, context, onProgressUpdate);
            continue;
          }
        }
        AppLogger.warn(LOG_TAGS.SCHEDULER, `跳过未知算力节点: ${actionType}`);
        continue;
      }

      try {
        // 💥 Layer 3 状态守卫：算力互斥锁，阻断并发重叠
        if (!EngineStateGuard.acquire(task.nodeId, actionType)) {
          AppLogger.warn(LOG_TAGS.SCHEDULER, `[状态红线] 节点 ${task.nodeId} 被算力互斥锁拦截，跳过`);
          continue;
        }

        const result = await this.executeNodeTask(strategy, task, context, onProgressUpdate);

        // 💥 recoverable 节点降级检测：节点返回 _failed 但 Pipeline 继续
        if (result && result._failed === true && strategy.isRecoverable) {
          const nodeType = strategy.nodeType;
          AppLogger.warn(LOG_TAGS.SCHEDULER, `[${task.nodeId}] 节点降级通过（${nodeType}），错误: ${result._error || '未知'}`);
          onProgressUpdate({
            nodeId: task.nodeId,
            progress: 100,
            status: 'degraded',
            message: `${nodeType} 降级跳过（可在审阅模式中手动重试）`,
            results: result
          });
          continue;
        }
      } catch (error: any) {
        // 💥 Layer 5 异常归一化：将原始错误转换为 I18N Key 契约载荷
        const i18nPayload = ExceptionHub.normalize(error);
        AppLogger.error(LOG_TAGS.SCHEDULER, `工作流在节点 [${task.nodeId}] 发生致命异常 (I18N: ${i18nPayload.titleKey})`, error);

        // 💥 通过进度回调下发 I18N 载荷到前端
        onProgressUpdate({
          nodeId: task.nodeId,
          progress: 100,
          status: 'error',
          message: i18nPayload.titleKey,
          results: ExceptionHub.toIPCPayload(i18nPayload),
        });

        throw error;
      } finally {
        // 💥 铁律释放算力锁
        EngineStateGuard.release(task.nodeId);
      }
    }

    // 💥 白屏保护：管线无产出时注入空结果兜底，防止前端白屏
    if (context.bus.size === 0) {
      AppLogger.warn(LOG_TAGS.SCHEDULER, '[PipelineEngine] 管线无产出，注入白屏保护兜底');
      context.bus.set('_whitescreen_safeguard', {
        frames: { count: 0, paths: [] },
        audio: { separated: false },
        asr: { lines: [] },
        faces: { roles: [] },
      });
    }

    return Object.fromEntries(context.bus); // 返回总线上所有产物
  }

  private async executeNodeTask(
    strategy: INodeStrategy,
    task: PipelineTask,
    context: ExecutionContext,
    onProgressUpdate: (progressData: TaskProgressPayload) => void
  ): Promise<any> {
    return await strategy.execute(task, context, (progress, status, results) => {
      onProgressUpdate({
        nodeId: task.nodeId,
        progress,
        status,
        message: status || `节点运行中...`,
        results
      });

      // 当节点产出包含 shotId 的数据时，额外推送到故事板卡片通道
      if (progress === 100 && Array.isArray(results) && !task.nodeId?.includes('tts')) {
        for (const item of results) {
          if (item && item.shotId) {
            onProgressUpdate({
              nodeId: `shot:${item.shotId}`,
              progress: 100,
              status: 'shot-data',
              message: `镜头卡片数据就绪`,
              results: { shotId: item.shotId, data: item },
            });
          }
        }
      }
    });
  }

  /**
   * 缓存探针：供前端项目启动时静默调用，只检查缓存不执行真实算力
   */
  async probeCache(payload: any): Promise<any> {
    const results: any = {};
    const simulatedBus = new Map<string, any>();
    
    let sequence: any[] = [];
    if (Array.isArray(payload)) {
      sequence = payload;
    } else if (payload && typeof payload === 'object') {
      sequence = payload.sequence || payload.actions || [];
    }

    const projectId = payload?.projectId || 'default-project';

    for (const task of sequence) {
      const nodeId = task.nodeId;
      const actionType = task.actionType || task.type;
      void actionType;
      const dependsOn = task.dependsOn || task.dependencies || [];
      
      let mergedInputs: Record<string, any> = {};
      
      if (task.mergedInputs) {
        Object.assign(mergedInputs, task.mergedInputs);
      }
      
      for (const parentId of dependsOn) {
        if (simulatedBus.has(parentId)) {
          Object.assign(mergedInputs, simulatedBus.get(parentId));
        }
      }

      const targetMedia = mergedInputs.mediaPath || payload?.sourceMedia;

      try {
        const cachedResult = await this.probeTaskCache(task, projectId, targetMedia, mergedInputs, simulatedBus);
        if (cachedResult) {
          results[nodeId] = cachedResult;
          simulatedBus.set(nodeId, cachedResult);
        }
      } catch (e) {
        // 探针遇到异常静默跳过
      }
    }
    return results;
  }

  private async probeTaskCache(
    task: any,
    projectId: string,
    targetMedia: string,
    _mergedInputs: Record<string, any>,
    _simulatedBus: Map<string, any>
  ): Promise<any> {
    const actionType = task.actionType || task.type;

    switch (actionType) {
      case 'frame-extract':
      case 'vision-extract': {
        const fps = task.params?.fps || 1;
        const strategy = task.params?.strategy || 'uniform';
        const threshold = task.params?.threshold || 0.3;

        const sourceMedia = targetMedia;
        if (!sourceMedia) return null;

        const cacheHash = generateStateHash('ffmpeg_v1', sourceMedia, fps, strategy, threshold);
        const hashedFramesDir = PathManager.getNodeL2CacheDir(projectId, task.nodeId, 'frames', cacheHash);

        if (fs.existsSync(hashedFramesDir)) {
          let existingFiles: string[] = [];
          try {
            existingFiles = fs.readdirSync(hashedFramesDir).filter(f => f.endsWith('.jpg'));
          } catch {
            AppLogger.warn(LOG_TAGS.SCHEDULER, `[${task.nodeId}] L2 缓存目录不可读: ${hashedFramesDir}`);
          }
          if (existingFiles.length > 0) {
            AppLogger.info(LOG_TAGS.SCHEDULER, `[${task.nodeId}] 🟢 探针命中视觉 L2 缓存 [${cacheHash}]`);
            return { frames: existingFiles.map(f => path.join(hashedFramesDir, f)) };
          }
        }
        return null;
      }

      case 'audio-separate': {
        const isolateType = task.params?.isolateType || 'vocals_bgm';
        const model = task.params?.model || 'htdemucs';
        const computeMode = task.params?.computeMode || 'local';

        const sourceMedia = targetMedia;
        if (!sourceMedia) return null;

        const cacheHash = generateStateHash('audio_v1', sourceMedia, isolateType, model, computeMode);
        const hashedAudioDir = PathManager.getNodeL2CacheDir(projectId, task.nodeId, 'audio', cacheHash);

        if (fs.existsSync(hashedAudioDir)) {
          const existingVocal = fs.existsSync(path.join(hashedAudioDir, 'vocals.mp3'));
          const existingBgm = fs.existsSync(path.join(hashedAudioDir, 'bgm.mp3'));
          if (existingVocal && existingBgm) {
            AppLogger.info(LOG_TAGS.SCHEDULER, `[${task.nodeId}] 🟢 探针命中音频 L2 缓存 [${cacheHash}]`);
            return {
              vocalUrl: `magic://${projectId}/nodes/${task.nodeId}/audio/${cacheHash}/vocals.mp3`,
              bgmUrl: `magic://${projectId}/nodes/${task.nodeId}/audio/${cacheHash}/bgm.mp3`
            };
          }
        }
        return null;
      }

      default:
        return null;
    }
  }
}
