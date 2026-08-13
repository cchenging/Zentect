// — 路径: src/main/core/JobScheduler.ts
import { JobRepository } from '../database/repositories/JobRepository';
import { MediaRepository } from '../database/repositories/MediaRepository';
import { MainNotifier } from './MainNotifier';
import { PipelineEngine } from '../engine/PipelineEngine';
import { ProjectService } from '../services/ProjectService';
import { PipelineRecoveryService } from '../pipeline/PipelineRecoveryService';
import { PipelineResultWriter } from '../pipeline/PipelineResultWriter';
import { DICT } from '../../modules/infra/i18n/dictionary';
import { AppLogger } from './AppLogger';
import { LOG_TAGS } from '../../modules/infra/logger/LogConstants';
import { IPC_CHANNELS } from '../../modules/infra/ipc/IpcConstants';
import { TaskProgressPayload } from '../../shared/types';

export class JobScheduler {
  private static instance: JobScheduler;
  private repo = new JobRepository();
  private isRunning = false;
  private processNextTimer: NodeJS.Timeout | null = null;
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

    // 💥 卡死恢复：清理长时间未更新进度的 running 任务（SSE 断连/进程崩溃/子步骤卡死）
    //   修复：旧版只清理 pending，卡死/崩溃的 running 任务永久遗留 → 前端永远停留在"运行中"且无成果物
    const staleJobs = this.repo.getStaleRunningJobs();
    for (const job of staleJobs) {
      this.repo.failJob(job.id, 'STUCK_TASK_RECOVERY');
      AppLogger.warn(LOG_TAGS.SCHEDULER,
        `🧹 清理卡死任务 (progress=${job.progress}, message=${job.message || ''}): ${job.id}`);
      MainNotifier.notifyTaskProgress(job.targetId, job.projectId, 'STUCK_TASK_RECOVERY', 0, DICT.TASK_STATUS.FAILED);
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

  /** 停止调度引擎，清理所有定时器 */
  public stop() {
    this.isRunning = false;
    if (this.blacklistCleanupTimer) {
      clearInterval(this.blacklistCleanupTimer);
      this.blacklistCleanupTimer = null;
    }
    if (this.processNextTimer) {
      clearTimeout(this.processNextTimer);
      this.processNextTimer = null;
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

        const mediaRepo = new MediaRepository();
        const existingMedia = await mediaRepo.findById(job.targetId);
        if (existingMedia) {
          AppLogger.info(LOG_TAGS.SCHEDULER, `[JobScheduler] 检测到已有媒体数据，将启用增量执行模式`, {
            mediaId: job.targetId,
            hasFrames: Array.isArray(existingMedia.frames) && existingMedia.frames.length > 0,
            hasVocals: !!existingMedia.extractedVocals,
            hasBgm: !!existingMedia.extractedBgm,
            hasAsr: !!existingMedia.extractedText,
          });
        }

        const engine = new PipelineEngine();
        const busResult = await engine.executePipeline(
          {
            projectId: job.projectId,
            workflowId: '',
            sourceMedia: payload.filePath,
            sequence: [{
              nodeId: `step1-${job.targetId}`,
              actionType: 'step1-material',
              label: '素材分析',
              dependsOn: [],
              mergedInputs: {},
              params: {
                mediaPath: payload.filePath,
                mediaId: job.targetId,
                config: payload.config,
                existingMedia: existingMedia || null,
              },
            }],
          },
          (progressData: TaskProgressPayload) => {
            if (!this.isRunning) return;
            const text = progressData.message || '';
            const progress = progressData.progress || 0;
            this.repo.updateJobStatus(job.id, DICT.TASK_STATUS.RUNNING, progress, text);
            MainNotifier.notifyTaskProgress(job.targetId, job.projectId, text, progress, DICT.TASK_STATUS.RUNNING);
          }
        );

        const step1Data = busResult['step1-result'] || {};
        const framesSkipped = !!step1Data.frames?._skipped;
        const audioSkipped = !!step1Data.audio?._skipped;
        const asrSkipped = !!step1Data.asr?._skipped;
        const facesSkipped = !!step1Data.faces?._skipped;

        AppLogger.info(LOG_TAGS.SCHEDULER, `[JobScheduler] 管线执行结果统计`, {
          mediaId: job.targetId,
          framesSkipped, audioSkipped, asrSkipped, facesSkipped,
          frameCount: step1Data.frames?.count || 0,
          asrCount: step1Data.asr?.lines?.length || 0,
          roleCount: step1Data.faces?.count || 0,
        });

        const result = {
          frames: step1Data.frames?.paths || [],
          audioPath: step1Data.audio?.audioPath || null,
          vocalsPath: step1Data.audio?.vocalsPath || null,
          bgmPath: step1Data.audio?.bgmPath || null,
          vocalsIsFallback: !!step1Data.audio?.vocalsIsFallback,
          separationMode: payload.config?.audio?.separationMode || 'quality',
          separationEngine: payload.config?.audio?.engine || 'mdx',
          shots: (step1Data.asr?.lines || []).map((line: any, idx: number) => {
            // 🔧 修复：为每个 shot 生成全局唯一 id，避免 ProjectRepository 跳过无 id 的 shot
            const shotId = `shot_${Date.now()}_${idx}`;
            if (typeof line.start === 'number') {
              return {
                id: shotId,
                originalText: line.text || line.originalText || '',
                start: line.start,
                end: line.end,
              };
            }
            return {
              id: shotId,
              originalText: line.text || line.originalText || '',
              start: (() => {
                const parts = (line.start || '00:00').split(':');
                return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
              })(),
              end: (() => {
                const parts = (line.end || '00:00').split(':');
                return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
              })(),
            };
          }),
          roles: step1Data.faces?.roles || [],
        };

        try {
          const { updatedMedia, finalRoles } = await PipelineResultWriter.writeStep1Results({
            projectId: job.projectId,
            mediaId: job.targetId,
            result,
            framesSkipped,
            audioSkipped,
            asrSkipped,
            facesSkipped,
            step1Data,
          });

          const hydratedPayload = this.projectService.hydratePaths({
            media: updatedMedia,
            shots: result.shots || [],
            roles: finalRoles
          }, job.projectId);

          MainNotifier.notify(IPC_CHANNELS.EVENT_EXTRACTION_SUCCESS, {
            mediaId: job.targetId,
            projectId: job.projectId,
            media: hydratedPayload.media,
            shots: hydratedPayload.shots,
            roles: hydratedPayload.roles
          });

          AppLogger.info(LOG_TAGS.SCHEDULER, `[JobScheduler] 素材分析完毕，增量结果已合并并广播`);

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
      this.processNextTimer = setTimeout(() => this.processNext(), 1000);
    }
  }

  /**
   * 极速线性向导：复用一个 step1-material 节点，复用 Step1MaterialStrategy 编排
   * 与主流水线共用同一套子任务(SDK) + PipelineResultWriter 写库 + 统一进度通道。
   *
   * 🔧 收敛重构：旧版在 JobScheduler 内手写 4 个子任务 + 裸 SQL 写库 + QUICK_PIPELINE_PROGRESS 通道，
   *   造成双实现。现改为复用 PipelineEngine + Step1MaterialStrategy + PipelineResultWriter，
   *   进度统一走 ENGINE_PIPELINE_PROGRESS，消除维护双路径的成本。
   */
  public async executeLinearQuickPipeline(projectId: string, videoPath: string, window: Electron.BrowserWindow) {
    try {
      AppLogger.info(LOG_TAGS.SCHEDULER, `[线性向导中枢] 开始激活极速提取分析流. 项目: ${projectId}`);

      // 定位本项目主视频媒体（作为 mediaId，供 Strategy 增量跳过与写库使用）
      const mediaRepo = new MediaRepository();
      const projectMedias = mediaRepo.getByProject(projectId);
      const targetMedia = projectMedias.find((m: any) => m.type === 'video');
      const mediaId = targetMedia?.id || `media_${Date.now()}`;

      // 复用 PipelineEngine + Step1MaterialStrategy，编排抽帧/音频分离/ASR/人脸
      const engine = new PipelineEngine();
      const busResult = await engine.executePipeline(
        {
          projectId,
          workflowId: '',
          sourceMedia: videoPath,
          sequence: [{
            nodeId: `quick-step1-${mediaId}`,
            actionType: 'step1-material',
            label: '素材分析',
            dependsOn: [],
            mergedInputs: {},
            params: {
              mediaPath: videoPath,
              mediaId,
              config: {
                frames: { enabled: true },
                audio: { enabled: true, separationMode: 'quality', engine: 'mdx' },
                whisper: { enabled: true },
                faces: { enabled: true },
              },
              existingMedia: targetMedia || null,
            },
          }],
        },
        (progressData: TaskProgressPayload) => {
          if (window.isDestroyed()) return;
          const pct = progressData.progress || 0;
          const text = progressData.message || '';
          MainNotifier.notifyTaskProgress(mediaId, projectId, text, pct, DICT.TASK_STATUS.RUNNING);
          // 统一进度通道：极速向导与正式管线共用 ENGINE_PIPELINE_PROGRESS
          window.webContents.send(IPC_CHANNELS.ENGINE_PIPELINE_PROGRESS, progressData);
        }
      );

      // 从总线提取 step1 结果，组装与主流水线一致的 result 契约
      const step1Data = busResult['step1-result'] || {};
      const framesSkipped = !!step1Data.frames?._skipped;
      const audioSkipped = !!step1Data.audio?._skipped;
      const asrSkipped = !!step1Data.asr?._skipped;
      const facesSkipped = !!step1Data.faces?._skipped;

      const result = {
        frames: step1Data.frames?.paths || [],
        audioPath: step1Data.audio?.audioPath || null,
        vocalsPath: step1Data.audio?.vocalsPath || null,
        bgmPath: step1Data.audio?.bgmPath || null,
        vocalsIsFallback: !!step1Data.audio?.vocalsIsFallback,
        separationMode: 'quality',
        separationEngine: 'mdx',
        shots: (step1Data.asr?.lines || []).map((line: any, idx: number) => {
          const shotId = `shot_${Date.now()}_${idx}`;
          if (typeof line.start === 'number') {
            return { id: shotId, originalText: line.text || line.originalText || '', start: line.start, end: line.end };
          }
          const parse = (t: string) => { const p = (t || '00:00').split(':'); return parseInt(p[0], 10) * 60 + parseInt(p[1], 10); };
          return { id: shotId, originalText: line.text || line.originalText || '', start: parse(line.start), end: parse(line.end) };
        }),
        roles: step1Data.faces?.roles || [],
      };

      // 统一经 PipelineResultWriter 写库（media_assets + roles + subStepStatuses）
      const { updatedMedia, finalRoles } = await PipelineResultWriter.writeStep1Results({
        projectId,
        mediaId,
        result,
        framesSkipped,
        audioSkipped,
        asrSkipped,
        facesSkipped,
        step1Data,
      });

      // 路径水合 + 广播成果物（与主流水线一致）
      const hydratedPayload = this.projectService.hydratePaths({
        media: updatedMedia,
        shots: result.shots || [],
        roles: finalRoles
      }, projectId);

      MainNotifier.notify(IPC_CHANNELS.EVENT_EXTRACTION_SUCCESS, {
        mediaId,
        projectId,
        media: hydratedPayload.media,
        shots: hydratedPayload.shots,
        roles: hydratedPayload.roles
      });

      // 派发最终结果到前端（进度通道统一为 ENGINE_PIPELINE_PROGRESS）
      window.webContents.send(IPC_CHANNELS.ENGINE_PIPELINE_PROGRESS, {
        progress: 100,
        status: 'success',
        results: {
          vocalPath: result.vocalsPath,
          backgroundPath: result.bgmPath,
          asrLines: step1Data.asr?.lines || [],
          framePaths: result.frames,
          frameCount: result.frames.length,
          roles: result.roles,
        },
      });

      AppLogger.info(LOG_TAGS.SCHEDULER, `[线性向导中枢] 全业务数据链全线胜利通车！ mediaId=${mediaId}`);
    } catch (err: any) {
      AppLogger.error(LOG_TAGS.SCHEDULER, `[线性向导中枢致命崩溃]: ${err.message}`);
      if (!window.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.ENGINE_PIPELINE_PROGRESS, {
          progress: 0,
          status: 'error',
          error: err.message || '本步算力抢占发生熔断'
        });
      }
    }
  }
}
