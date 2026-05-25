// — 路径: src/main/core/JobScheduler.ts
import { JobRepository } from '../database/repositories/JobRepository';
import { MediaRepository } from '../database/repositories/MediaRepository';
import { MainNotifier } from './MainNotifier';
import { ExtractionPipeline } from '../engine/ExtractionPipeline';
import { LocalWhisperStrategy } from '../engine/strategies/LocalWhisperStrategy';
import { PathManager } from '../utils/pathManager';
import { ProjectService } from '../services/ProjectService';
import { PipelineRecoveryService } from '../pipeline/PipelineRecoveryService';
import { DICT } from '../../shared/locales/dictionary';
import { AppLogger } from './AppLogger';
import { LOG_TAGS } from '../../shared/utils/LogConstants';
import { IPC_CHANNELS } from '../../shared/utils/IpcConstants';
import * as path from 'path';
import * as fs from 'fs';

export class JobScheduler {
  private static instance: JobScheduler;
  private repo = new JobRepository();
  private isRunning = false;
  private projectService = new ProjectService(); // — 实例化 ProjectService
  private memoryBlacklist: Set<string> = new Set();
  private blacklistCleanupTimer: NodeJS.Timeout | null = null;

  private constructor() {}

  public static getInstance(): JobScheduler {
    if (!JobScheduler.instance) {
      JobScheduler.instance = new JobScheduler();
    }
    return JobScheduler.instance;
  }

  // 清理僵尸任务
  public recoverZombieJobs() {
    const pendingJobs = this.repo.getPendingJobs();
    for (const job of pendingJobs) {
      this.repo.failJob(job.id, 'SYS_CRASH_RECOVERY');
      AppLogger.warn(LOG_TAGS.SCHEDULER, `🧹 清理遗留僵尸任务: ${job.id}`);
      MainNotifier.notifyTaskProgress(job.targetId, job.projectId, 'SYS_CRASH_RECOVERY', 0, DICT.TASK_STATUS.FAILED);
    }

    // V1.0: 委托 PipelineRecoveryService 检测并处理未完成的 Pipeline
    try {
      const recoveryService = new PipelineRecoveryService();
      // 从已存在的检查点扫描所有关联的 project_id
      const knownProjects = this.repo.getPendingJobs()
        .map(j => j.projectId)
        .filter((id, idx, arr) => arr.indexOf(id) === idx);
      recoveryService.probeAllProjects(knownProjects);
    } catch (e) {
      AppLogger.debug(LOG_TAGS.SCHEDULER, 'Pipeline 恢复检测跳过（表不存在或首次启动）');
    }
  }

  public addExtractionJob(projectId: string, mediaId: string, filePath: string, config?: any) {
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    this.repo.addJob({ id: jobId, projectId, targetId: mediaId, taskType: 'extract', payload: { filePath, config } });
    AppLogger.info(LOG_TAGS.SCHEDULER, `📥 任务已入队 [JobId: ${jobId}, MediaId: ${mediaId}]`);
    this.start();
  }

  public cancelJob(mediaId: string) {
    const jobs = this.repo.getPendingJobs().filter(j => j.targetId === mediaId);
    for (const job of jobs) {
       this.repo.failJob(job.id, 'USER_CANCELLED');
       AppLogger.warn(LOG_TAGS.SCHEDULER, `— 用户主动终止任务 [MediaId: ${mediaId}]`);
       MainNotifier.notifyTaskProgress(job.targetId, job.projectId, 'TASK_CANCELLED', 0, DICT.TASK_STATUS.FAILED);
    }
  }

  public async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    AppLogger.info(LOG_TAGS.SCHEDULER, `调度引擎已启动`);
    // 定期清理黑名单（每10分钟）
    this.blacklistCleanupTimer = setInterval(() => {
      if (this.memoryBlacklist.size > 0) {
        this.memoryBlacklist.clear();
        AppLogger.info(LOG_TAGS.SCHEDULER, `黑名单已清理`);
      }
    }, 600000);
    await this.processNext();
  }

  public stop() {
    this.isRunning = false;
    if (this.blacklistCleanupTimer) {
      clearInterval(this.blacklistCleanupTimer);
      this.blacklistCleanupTimer = null;
    }
    AppLogger.warn(LOG_TAGS.SCHEDULER, `调度引擎已挂起`);
  }

  private async processNext() {
    if (!this.isRunning) return;

    // — 致命修复：过滤内存黑名单中的脏任务
    const pendingJobs = this.repo.getPendingJobs().filter(j => !this.memoryBlacklist.has(j.id));
    
    if (pendingJobs.length === 0) {
      this.isRunning = false;
      return;
    }

    const job = pendingJobs[0];
    const payload = job.payload;

    this.repo.updateJobStatus(job.id, DICT.TASK_STATUS.RUNNING, 0, 'TASK_START');
    MainNotifier.notifyTaskProgress(job.targetId, job.projectId, 'TASK_START', 0, DICT.TASK_STATUS.RUNNING);

    try {
      if (job.taskType === 'extract') {
        AppLogger.info(LOG_TAGS.SCHEDULER, `⚙️ 开始执行提取管线 [JobId: ${job.id}]`);
        
        const whisperStrategy = new LocalWhisperStrategy();
        const pipeline = new ExtractionPipeline(whisperStrategy);
        
        const mediaDir = PathManager.getProjectMediaDir(job.projectId);
        const framesBaseDir = PathManager.getProjectExtractionsDir(job.projectId, 'frames');
        const framesDir = path.join(framesBaseDir, job.targetId);
        if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir, { recursive: true });

        const result = await pipeline.execute(
          payload.filePath, mediaDir, framesDir, job.targetId, job.projectId,
          undefined, undefined, 
          (progress, text) => {
            if (!this.isRunning) return; 
            this.repo.updateJobStatus(job.id, DICT.TASK_STATUS.RUNNING, progress, text);
            MainNotifier.notifyTaskProgress(job.targetId, job.projectId, text, progress, DICT.TASK_STATUS.RUNNING);
          },
          undefined, payload.config
        );

        try {
          const mediaRepo = new MediaRepository();
          const updatedMedia = await mediaRepo.findById(job.targetId);
          if (updatedMedia) {
            updatedMedia.status = 'parsed';
            updatedMedia.frames = result.frames || [];
            updatedMedia.extractedAudio = result.audioPath;
            updatedMedia.extractedVocals = result.vocalsPath;
            updatedMedia.extractedBgm = result.bgmPath;
            
            await mediaRepo.update(updatedMedia.id, updatedMedia);

            const hydratedPayload = this.projectService.hydratePaths({
              media: updatedMedia,
              shots: result.shots || [],
              roles: result.roles || []
            }, job.projectId);

            MainNotifier.notify(IPC_CHANNELS.EVENT_EXTRACTION_SUCCESS, {
              mediaId: job.targetId,
              projectId: job.projectId,
              media: hydratedPayload.media,
              shots: hydratedPayload.shots,
              roles: hydratedPayload.roles
            });
            
            AppLogger.info(LOG_TAGS.SCHEDULER, `[JobScheduler] 素材分离完毕，已向前端发送注水后广播`);
          }

          this.repo.updateJobStatus(job.id, DICT.TASK_STATUS.COMPLETED, 100, 'TASK_SUCCESS');
          MainNotifier.notifyTaskCompleted(job.targetId, job.projectId, result);
          AppLogger.info(LOG_TAGS.SCHEDULER, `— 管线执行圆满成功 [JobId: ${job.id}]`);
        } catch (dbErr: any) {
          AppLogger.error(LOG_TAGS.SCHEDULER, `[JobScheduler] 状态回写失败`, dbErr);
          this.repo.failJob(job.id, dbErr.message || 'DB_WRITE_FAILED');
          MainNotifier.notifyTaskProgress(job.targetId, job.projectId, 'DB_WRITE_FAILED', 0, DICT.TASK_STATUS.FAILED);
        }
      }
    } catch (err: any) {
      try {
        // 尝试写回失败状态
        this.repo.failJob(job.id, err.message);
      } catch (dbErr: any) {
        // — 致命修复：如果数据库写回失败，将该任务压入内存黑名单，强制踢出队列！
        this.memoryBlacklist.add(job.id);
        AppLogger.fatal(LOG_TAGS.SCHEDULER, `❌ 数据库写入死锁，已将脏任务 [${job.id}] 压入内存黑名单`, dbErr);
      }

      MainNotifier.notifyTaskProgress(job.targetId, job.projectId, 'TASK_FAILED', 0, DICT.TASK_STATUS.FAILED);
      AppLogger.error(LOG_TAGS.SCHEDULER, `❌ 任务执行崩溃 [JobId: ${job.id}]`, err);
    }

    if (this.isRunning) {
      setTimeout(() => this.processNext(), 1000);
    }
  }
}
