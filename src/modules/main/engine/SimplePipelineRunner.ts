import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../infra/logger/LogConstants';
import { PathManager } from '../utils/pathManager';
import { AIEngine } from './AIEngine';
import { CheckpointRepository } from '../pipeline/CheckpointRepository';
import { TaskEventBus } from './TaskEventBus';
import { TraceContext } from '../core/TraceContext';
import { PipelineStepRegistry } from '../pipeline/PipelineStepRegistry';
import type { PipelineSuspendController } from '../pipeline/PipelineSuspendController';
import fs from 'fs';
import * as path from 'path';

// Strategy imports
import { VisionExtractStrategy, VisionExtractInput } from './strategies/VisionExtractStrategy';
import { AudioSeparateStrategy } from './strategies/AudioSeparateStrategy';
import { LocalWhisperStrategy } from './strategies/LocalWhisperStrategy';
import { FaceDetectStrategy } from './strategies/FaceDetectStrategy';
import { ScriptGenStrategy } from './strategies/ScriptGenStrategy';
import { TTSStrategy } from '../../modules/pipeline/step4-tts/backend/Strategy';
import { ExecutionContext } from './strategies/BaseNodeStrategy';
import { detectFromASRJson } from './media/MediaLanguageDetector';
import type { PipelineTask } from '../../shared/types';

interface StepConfig {
  id: string;
  order: number;
  label: string;
  maxRetries: number;
  retryDelay: number;
  fatal: boolean;
  exponentialBackoff?: boolean;
}

interface StepProgress {
  projectId: string;
  stepId: string;
  stepName: string;
  stepProgress: number;
  overallProgress: number;
  status: 'running' | 'completed' | 'failed' | 'degraded' | 'suspended';
  message?: string;
}

interface StepResult {
  stepId: string;
  status: string;
  degraded: boolean;
  /** 步骤耗时（毫秒），由 TraceContext 采集 */
  durationMs?: number;
}

interface PipelineResult {
  success: boolean;
  projectId: string;
  mediaId: string;
  steps: StepResult[];
  error?: string;
  /** 整个管线耗时（毫秒），由 TraceContext 采集 */
  totalDurationMs?: number;
}

const STEP_CONFIG: StepConfig[] = [
  { id: 'extract_frames',   order: 1, label: '帧提取',     maxRetries: 2, retryDelay: 3000,   fatal: false },
  { id: 'separate_audio',   order: 2, label: '音频分离',    maxRetries: 1, retryDelay: 3000,   fatal: false },
  { id: 'asr',              order: 3, label: '语音识别',    maxRetries: 3, retryDelay: 0,      fatal: false, exponentialBackoff: true },
  { id: 'face_detect',      order: 4, label: '人脸检测',    maxRetries: 2, retryDelay: 3000,   fatal: false },
  { id: 'scene_detect',     order: 5, label: '场景分割',    maxRetries: 2, retryDelay: 3000,   fatal: false },
  { id: 'script_gen',       order: 6, label: '解说稿生成',  maxRetries: 3, retryDelay: 0,      fatal: true,  exponentialBackoff: true },
  { id: 'tts_export',       order: 7, label: 'TTS 配音',    maxRetries: 0, retryDelay: 0,      fatal: false },
];

export class SimplePipelineRunner {
  private aborted = false;
  private checkpointRepo = new CheckpointRepository();
  private eventBus = TaskEventBus.getInstance();
  private stepRegistry: PipelineStepRegistry;
  private suspendController: PipelineSuspendController | undefined;

  constructor() {
    this.stepRegistry = PipelineStepRegistry.getInstance();
    this.validateStepsInRegistry();
  }

  /**
   * 验证 STEP_CONFIG 中的所有步骤都在 PipelineStepRegistry 中注册
   * 如果发现未注册的步骤，记录警告但不阻止运行（兼容降级）
   */
  private validateStepsInRegistry(): void {
    for (const cfg of STEP_CONFIG) {
      if (!this.stepRegistry.has(cfg.id)) {
        AppLogger.warn(LOG_TAGS.ENGINE, TraceContext.enrichLog(
          `步骤 ${cfg.id} 未在 PipelineStepRegistry 中注册，将使用默认配置`
        ));
      }
    }
    AppLogger.info(LOG_TAGS.ENGINE, TraceContext.enrichLog(
      `PipelineStepRegistry 校验完成，已注册 ${this.stepRegistry.count} 个步骤`
    ));
  }

  async run(projectId: string, mediaId: string, mediaPath: string, suspendController?: PipelineSuspendController): Promise<PipelineResult> {
    this.aborted = false;
    this.suspendController = suspendController;

    // 启动全链路追踪
    TraceContext.startTrace('pipeline_run', {
      projectId,
      mediaId,
      mediaPath: path.basename(mediaPath),
    });
    const pipelineStartTime = Date.now();

    try {
      // P0: 前置检查 — AI 服务配置是否完整（API Key、模型等）
      const stepIds = STEP_CONFIG.map(s => s.id);
      const checks = AIEngine.preflightCheck(stepIds);
      const { ok, message } = AIEngine.formatCheckResult(checks);
      if (!ok) {
        AppLogger.warn(LOG_TAGS.ENGINE, TraceContext.enrichLog(`[preflightCheck] 配置不完整，拒绝启动\n${message}`));
        return {
          success: false, projectId, mediaId, steps: [],
          error: message,
          totalDurationMs: Date.now() - pipelineStartTime,
        };
      }

      // 前置检查：磁盘空间 >= 20GB
      await this.preflightStorageCheck();

      const steps: StepResult[] = [];
      const context: ExecutionContext = { projectId, bus: new Map() };

      for (const cfg of STEP_CONFIG) {
        if (this.aborted) break;

        const existing = this.checkpointRepo.findByStep(projectId, mediaId, cfg.id);
        if (existing?.status === 'completed') {
          steps.push({ stepId: cfg.id, status: 'completed', degraded: existing.degraded === 1 });
          this.pushProgress(projectId, cfg, 100, this.calcOverall(cfg.order), 'completed');
          continue;
        }

        this.checkpointRepo.upsert({ projectId, mediaId, stepId: cfg.id, stepOrder: cfg.order, status: 'running' });
        this.pushProgress(projectId, cfg, 0, this.calcOverall(cfg.order - 1), 'running', `正在${cfg.label}...`);

        let lastError: Error | null = null;

        // 为每个步骤创建追踪 Span
        const spanId = TraceContext.startSpan(`step:${cfg.id}`, {
          stepId: cfg.id,
          stepLabel: cfg.label,
          maxRetries: String(cfg.maxRetries),
        });

        for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
          if (this.aborted) break;
          try {
            if (attempt > 0) {
              const delay = cfg.exponentialBackoff
                ? [1000, 3000, 5000][attempt] || 5000
                : cfg.retryDelay;
              await this.sleep(delay);
              AppLogger.info(LOG_TAGS.ENGINE, TraceContext.enrichLog(
                `步骤 ${cfg.id} 第 ${attempt + 1} 次重试 (delay: ${delay}ms)`
              ));
            }
            await this.executeStep(cfg.id, mediaPath, projectId, mediaId, context);
            lastError = null;
            break;
          } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            AppLogger.warn(LOG_TAGS.ENGINE, TraceContext.enrichLog(
              `步骤 ${cfg.id} 第 ${attempt + 1}/${cfg.maxRetries + 1} 次失败: ${lastError.message}`
            ));
          }
        }

        TraceContext.endSpan(spanId);
        const stepDuration = TraceContext.getSpanDuration(spanId);

        if (lastError) {
          if (cfg.fatal) {
            this.checkpointRepo.upsert({ projectId, mediaId, stepId: cfg.id, stepOrder: cfg.order, status: 'failed', errorMessage: lastError.message });
            this.pushProgress(projectId, cfg, 0, this.calcOverall(cfg.order - 1), 'failed', `${cfg.label}失败：${lastError.message}`);
            steps.push({ stepId: cfg.id, status: 'failed', degraded: false, durationMs: stepDuration });
            this.eventBus.emitPipelineFailed({ projectId, mediaId, success: false, error: lastError.message });
            return {
              success: false, projectId, mediaId, steps,
              error: lastError.message,
              totalDurationMs: Date.now() - pipelineStartTime,
            };
          } else {
            this.checkpointRepo.upsert({ projectId, mediaId, stepId: cfg.id, stepOrder: cfg.order, status: 'completed', degraded: true });
            this.pushProgress(projectId, cfg, 100, this.calcOverall(cfg.order), 'degraded', `${cfg.label}已降级`);
            steps.push({ stepId: cfg.id, status: 'degraded', degraded: true, durationMs: stepDuration });
          }
        } else {
          this.checkpointRepo.upsert({ projectId, mediaId, stepId: cfg.id, stepOrder: cfg.order, status: 'completed' });
          this.pushProgress(projectId, cfg, 100, this.calcOverall(cfg.order), 'completed');
          steps.push({ stepId: cfg.id, status: 'completed', degraded: false, durationMs: stepDuration });
        }
      }

      const totalDuration = Date.now() - pipelineStartTime;
      this.eventBus.emitPipelineCompleted({ projectId, mediaId, success: true });
      return { success: true, projectId, mediaId, steps, totalDurationMs: totalDuration };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.eventBus.emitPipelineFailed({ projectId, mediaId, success: false, error: msg });
      return {
        success: false, projectId, mediaId, steps: [],
        error: msg,
        totalDurationMs: Date.now() - pipelineStartTime,
      };
    } finally {
      // 结束全链路追踪
      TraceContext.endTrace();
    }
  }

  abort(): void { this.aborted = true; }

  // ==================== 步骤执行 ====================

  private async executeStep(stepId: string, mediaPath: string, projectId: string, mediaId: string, context: ExecutionContext): Promise<void> {
    const taskId = `${projectId}_${mediaId}_${stepId}`;
    const baseTask: Partial<PipelineTask> = { nodeId: taskId, params: {}, dependsOn: [] };

    switch (stepId) {
      case 'extract_frames': {
        const strategy = new VisionExtractStrategy();
        const input: VisionExtractInput = {
          mediaId, mediaPath,
          framesMode: 'scene', framesValue: 0.3,
        };
        await strategy.execute(
          { ...baseTask, actionType: 'vision-extract', label: '帧提取', params: input } as PipelineTask,
          context,
          (p, s) => this.pushProgress(projectId,
            { id: stepId, order: 1, label: '帧提取' },
            Math.round(p * 0.15), this.calcOverall(1), 'running', s)
        );
        break;
      }

      case 'separate_audio': {
        const strategy = new AudioSeparateStrategy();
        await strategy.execute(
          { ...baseTask, actionType: 'audio', label: '音频分离', params: { mediaId, mediaPath } } as PipelineTask,
          context,
          () => {}
        );
        break;
      }

      case 'asr': {
        const asrDir = PathManager.getNodeBaseDir(projectId, taskId, 'whisper');
        const vocalPath = path.join(PathManager.getNodeBaseDir(projectId, taskId, 'audio'), `vocal_${mediaId}.wav`);
        const audioPath = fs.existsSync(vocalPath) ? vocalPath : mediaPath;
        const whisper = new LocalWhisperStrategy();
        const result = await whisper.transcribe(audioPath, asrDir, mediaId, 'zh');

        // P2: 语言检测 — ASR 完成后检查是否为外语或无台词
        const asrJsonPath = result?.whisperJsonPath;
        if (asrJsonPath && fs.existsSync(asrJsonPath)) {
          try {
            const asrJson = JSON.parse(fs.readFileSync(asrJsonPath, 'utf-8'));
            const langCheck = asrJson._languageCheck || detectFromASRJson(asrJson);
            if (langCheck.status === 'foreign') {
              AppLogger.warn(LOG_TAGS.ENGINE, TraceContext.enrichLog(`[Pipeline] 检测到外语影片: ${langCheck.message}`));
              throw new Error(langCheck.message);
            }
            if (langCheck.status === 'silent') {
              AppLogger.warn(LOG_TAGS.ENGINE, TraceContext.enrichLog(`[Pipeline] 检测到无台词影片: ${langCheck.message}`));
              throw new Error(langCheck.message);
            }
          } catch (err) {
            if (err instanceof Error) throw err;
          }
        }
        break;
      }

      case 'face_detect': {
        const strategy = new FaceDetectStrategy();
        await strategy.execute(
          { ...baseTask, actionType: 'face-detect', label: '人脸检测', params: { mediaId, mediaPath, framesDir: PathManager.getNodeBaseDir(projectId, taskId, 'frames') } } as PipelineTask,
          context,
          () => {}
        );
        break;
      }

      case 'scene_detect': {
        AppLogger.warn(LOG_TAGS.ENGINE, 'scene_detect 暂未对接 VisionProcessor.detectSceneChanges');
        break;
      }

      case 'script_gen': {
        const strategy = new ScriptGenStrategy();
        await strategy.execute(
          { ...baseTask, actionType: 'script-gen', label: '解说稿生成', params: { projectId } } as PipelineTask,
          context,
          () => {}
        );
        break;
      }

      case 'tts_export': {
        const strategy = new TTSStrategy();
        await strategy.execute(
          { ...baseTask, actionType: 'tts', label: 'TTS 配音', params: { projectId } } as PipelineTask,
          context,
          () => {}
        );
        break;
      }

      default:
        throw new Error(`未知步骤: ${stepId}`);
    }
  }

  // ==================== 进度推送 ====================

  private pushProgress(
    projectId: string, cfg: { id: string; label: string; order: number },
    stepProgress: number, overall: number,
    status: StepProgress['status'], message?: string
  ): void {
    this.eventBus.emitPipelineProgress({
      projectId,
      stepId: cfg.id,
      stepName: cfg.label,
      stepProgress,
      overallProgress: overall,
      status,
      message: message || '',
    });
  }

  private calcOverall(currentStepOrder: number): number {
    return Math.round(currentStepOrder * (100 / STEP_CONFIG.length));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }

  // ==================== 前置检查 ====================

  private async preflightStorageCheck(): Promise<void> {
    // V1.0: 检查磁盘可用空间 >= 20GB
    const projectsRoot = PathManager.getProjectsRootPath();
    try {
      const stats = fs.statfsSync(projectsRoot);
      const freeGB = (stats.bfree * stats.bsize) / (1024 * 1024 * 1024);
      if (freeGB < 20) {
        throw new Error(`磁盘空间不足（剩余 ${freeGB.toFixed(1)}GB），请清理后重试（至少需要 20GB 可用空间）`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('磁盘空间不足')) throw err;
      // statfs 可能在某些系统上不支持，静默跳过检查
      AppLogger.warn(LOG_TAGS.ENGINE, TraceContext.enrichLog('磁盘空间检查跳过（当前系统不支持 statfs）'));
    }
  }
}
