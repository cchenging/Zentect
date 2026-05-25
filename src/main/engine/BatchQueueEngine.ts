// 📁 新建文件: src/main/engine/BatchQueueEngine.ts
// V1.2: 批量任务队列引擎 + 黑灯工厂 — FIFO 调度 MP4 渲染 + 发布素材包

import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../shared/utils/LogConstants';
import { FFmpegRenderer, RenderJob, RenderShot } from './media/FFmpegRenderer';
import { BatchJobRepository } from '../database/repositories/BatchJobRepository';
import { PipelineEngine } from './PipelineEngine';
import { PublishService, PublishRequest } from '../services/PublishService';
import { PathManager } from '../utils/pathManager';
import * as path from 'path';
import * as fs from 'fs';

/** 批量作业 */
export interface BatchJob {
  id: string;
  projectId: string;
  projectName: string;
  mediaPath: string;
  shots: BatchShot[];
  workflowId?: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress: number;
  message: string;
  createdAt: string;
  queuePosition: number;
}

interface BatchShot {
  id: string;
  startTime: number;
  endTime: number;
  script: string;
  label: string;
  ttsAudioPath?: string;
  subtitle?: string;
}

/** 队列状态 */
export interface QueueStatus {
  isRunning: boolean;
  totalJobs: number;
  pendingJobs: number;
  completedJobs: number;
  failedJobs: number;
  currentJob: BatchJob | null;
  jobs: BatchJob[];
}

export class BatchQueueEngine {
  private static instance: BatchQueueEngine;
  private repo = new BatchJobRepository();
  private renderer = new FFmpegRenderer();
  private isRunning = false;
  private isPaused = false;
  private currentJobId: string | null = null;
  private onQueueProgress: ((status: QueueStatus) => void) | null = null;

  static getInstance(): BatchQueueEngine {
    if (!BatchQueueEngine.instance) {
      BatchQueueEngine.instance = new BatchQueueEngine();
    }
    return BatchQueueEngine.instance;
  }

  /** 注册进度回调（供 EngineController 推送前端） */
  onProgress(callback: (status: QueueStatus) => void): void {
    this.onQueueProgress = callback;
  }

  /** 添加一个或多个渲染任务到队列 */
  addJobs(jobs: BatchJobInput[]): BatchJob[] {
    const added = this.repo.addJobs(jobs);
    AppLogger.info(LOG_TAGS.SCHEDULER, `[BatchQueue] 已入队 ${added.length} 个任务`);
    this.emitStatus();
    return added;
  }

  /** 启动队列执行 */
  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.isPaused = false;
    AppLogger.info(LOG_TAGS.SCHEDULER, '[BatchQueue] 队列引擎启动');
    this.emitStatus();
    await this.processQueue();
  }

  /** 暂停队列 */
  pause(): void {
    this.isPaused = true;
    AppLogger.info(LOG_TAGS.SCHEDULER, '[BatchQueue] 队列已暂停');
    this.emitStatus();
  }

  /** 恢复队列 */
  resume(): void {
    this.isPaused = false;
    AppLogger.info(LOG_TAGS.SCHEDULER, '[BatchQueue] 队列已恢复');
    this.emitStatus();
    this.processQueue();
  }

  /** 停止队列引擎 */
  stop(): void {
    this.isRunning = false;
    this.renderer.abort();
    AppLogger.warn(LOG_TAGS.SCHEDULER, '[BatchQueue] 队列引擎已停止');
    this.emitStatus();
  }

  /** 获取当前队列状态 */
  getStatus(): QueueStatus {
    const all = this.repo.getAllJobs();
    return {
      isRunning: this.isRunning && !this.isPaused,
      totalJobs: all.length,
      pendingJobs: all.filter(j => j.status === 'pending').length,
      completedJobs: all.filter(j => j.status === 'completed').length,
      failedJobs: all.filter(j => j.status === 'failed').length,
      currentJob: all.find(j => j.id === this.currentJobId) || null,
      jobs: all,
    };
  }

  /** 移除一个任务 */
  removeJob(jobId: string): boolean {
    if (jobId === this.currentJobId) this.renderer.abort();
    this.repo.removeJob(jobId);
    this.emitStatus();
    return true;
  }

  /** 重排任务顺序 */
  reorderJobs(jobIds: string[]): void {
    this.repo.reorder(jobIds);
    this.emitStatus();
  }

  /** 失败重试 */
  retryJob(jobId: string): void {
    this.repo.resetToPending(jobId);
    AppLogger.info(LOG_TAGS.SCHEDULER, `[BatchQueue] 重试任务: ${jobId}`);
    this.emitStatus();
    if (this.isRunning && !this.isPaused) this.processQueue();
  }

  /** 核心：处理队列中的下一个任务 */
  private async processQueue(): Promise<void> {
    if (!this.isRunning || this.isPaused) return;

    const next = this.repo.getNextPending();
    if (!next) {
      this.isRunning = false;
      AppLogger.info(LOG_TAGS.SCHEDULER, '[BatchQueue] 队列已清空');
      this.emitStatus();
      return;
    }

    this.currentJobId = next.id;
    this.repo.updateStatus(next.id, 'processing', 0, '开始处理');
    this.emitStatus();

    try {
      // 步骤 A: 如果存在工作流，先执行 DAG 管线
      if (next.workflowId) {
        await this.executeDagPipeline(next);
      }

      // 步骤 B: MP4 渲染
      const renderResult = await this.renderMp4(next);
      if (!renderResult.success) {
        throw new Error(renderResult.error || 'MP4 渲染失败');
      }

      // 步骤 C: 生成发布素材包
      const publishResult = await this.generatePublishPackage(next, renderResult.outputPath);
      if (!publishResult.success) {
        AppLogger.warn(LOG_TAGS.EXPORT, `[BatchQueue] 发布素材包部分失败: ${publishResult.error}，MP4 已生成`);
      }

      this.repo.updateStatus(next.id, 'completed', 100, publishResult.success ? '发布素材包生成完成' : publishResult.error || '');
      AppLogger.info(LOG_TAGS.SCHEDULER, `[BatchQueue] ✅ 任务完成: ${next.projectName} → ${renderResult.outputPath}`);
    } catch (err: any) {
      this.repo.updateStatus(next.id, 'failed', 0, err.message);
      AppLogger.error(LOG_TAGS.SCHEDULER, `[BatchQueue] ❌ 任务失败: ${next.projectName}`, err);
    }

    this.currentJobId = null;
    this.emitStatus();

    // 继续处理下一个（间隔 1 秒）
    if (this.isRunning && !this.isPaused) {
      setTimeout(() => this.processQueue(), 1000);
    }
  }

  /** 执行 DAG 工作流（如果存在） */
  private async executeDagPipeline(job: BatchJob): Promise<void> {
    AppLogger.info(LOG_TAGS.SCHEDULER, `[BatchQueue] 执行 DAG 管线: ${job.projectName}`);
    this.repo.updateStatus(job.id, 'processing', 10, 'DAG 管线执行中');

    const engine = new PipelineEngine();
    await engine.executeFromWorkflow(job.projectId, (progressData) => {
      AppLogger.debug(LOG_TAGS.SCHEDULER, `[BatchQueue] DAG 进度: ${progressData.nodeId} - ${progressData.progress}%`);
    });
  }

  /** MP4 渲染 */
  private async renderMp4(job: BatchJob): Promise<{ success: boolean; outputPath: string; error?: string }> {
    this.repo.updateStatus(job.id, 'processing', 30, 'MP4 渲染中');
    AppLogger.info(LOG_TAGS.SCHEDULER, `[BatchQueue] 开始 MP4 渲染: ${job.projectName}`);

    const exportDir = path.join(PathManager.getProjectExportDir(job.projectId), 'videos');
    if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });

    const renderShots: RenderShot[] = job.shots.map(s => ({
      id: s.id,
      startTime: s.startTime,
      endTime: s.endTime,
      ttsAudioPath: s.ttsAudioPath,
      subtitle: s.subtitle,
    }));

    const renderJob: RenderJob = {
      projectId: job.projectId,
      mediaPath: job.mediaPath,
      shots: renderShots,
      outputDir: exportDir,
      outputName: job.projectName.replace(/[<>:"/\\|?*]/g, '_'),
      onProgress: (progress) => {
        const mappedPercent = 30 + ((progress.percent / 100) * 60); // 映射到 30%-90%
        this.repo.updateStatus(job.id, 'processing', mappedPercent, `渲染: ${progress.step}`);
        this.emitStatus();
      },
    };

    return await this.renderer.render(renderJob);
  }

  /** 生成发布素材包 */
  private async generatePublishPackage(job: BatchJob, mp4Path: string): Promise<{ success: boolean; error?: string }> {
    this.repo.updateStatus(job.id, 'processing', 90, '生成发布素材包');
    AppLogger.info(LOG_TAGS.SCHEDULER, `[BatchQueue] 生成发布素材包: ${job.projectName}`);

    const publishService = new PublishService();
    const publishReq: PublishRequest = {
      projectId: job.projectId,
      projectName: job.projectName,
      mediaPath: job.mediaPath,
      shots: job.shots,
      mp4Path,
    };

    const result = await publishService.generatePackage(publishReq);
    return { success: result.success, error: result.error };
  }

  /** 推送队列状态 */
  private emitStatus(): void {
    this.onQueueProgress?.(this.getStatus());
  }
}

/** 批量作业输入（前端提交时只需要这些字段） */
export interface BatchJobInput {
  projectId: string;
  projectName: string;
  mediaPath: string;
  shots: BatchShot[];
  workflowId?: string;
}
