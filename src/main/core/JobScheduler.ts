// — 路径: src/main/core/JobScheduler.ts
import { JobRepository } from '../database/repositories/JobRepository';
import { MediaRepository } from '../database/repositories/MediaRepository';
import { MainNotifier } from './MainNotifier';
import { PipelineEngine } from '../engine/PipelineEngine';
import { PathManager } from '../utils/pathManager';
import { ProjectService } from '../services/ProjectService';
import { PipelineRecoveryService } from '../pipeline/PipelineRecoveryService';
import { DICT } from '../../modules/infra/i18n/dictionary';
import { AppLogger } from './AppLogger';
import { LOG_TAGS } from '../../modules/infra/logger/LogConstants';
import { IPC_CHANNELS } from '../../shared/utils/IpcConstants';
import { TaskProgressPayload } from '../../shared/types';
import * as path from 'path';

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

        // 将 PipelineEngine bus 结果映射为旧版兼容格式
        const step1Data = busResult['step1-result'] || {};
        const result = {
          frames: step1Data.frames?.paths || [],
          audioPath: step1Data.audio?.audioPath || null,
          vocalsPath: step1Data.audio?.vocalsPath || null,
          bgmPath: step1Data.audio?.bgmPath || null,
          shots: [],
          roles: step1Data.faces?.roles || [],
        };

        try {
          const mediaRepo = new MediaRepository();
          const updatedMedia = await mediaRepo.findById(job.targetId);
          if (updatedMedia) {
            updatedMedia.status = 'parsed';
            
            // 💥 把绝对路径转换成相对于项目根目录的相对路径
            const projectDir = PathManager.getProjectDir(job.projectId);
            
            // 转换 frames 数组
            /** 💥 关键修复：只有本次管线实际执行了抽帧时才更新 frames，
             *  否则会用空数组覆盖 DB 中已有的帧数据 */
            if (result.frames && Array.isArray(result.frames) && result.frames.length > 0) {
              updatedMedia.frames = result.frames.map((framePath: string) => {
                if (path.isAbsolute(framePath)) {
                  return path.relative(projectDir, framePath).replace(/\\/g, '/');
                }
                return framePath;
              });
            }
            
            // 转换音频路径（只有本次管线实际产出了音频才更新，避免覆盖已有数据）
            if (result.audioPath) {
              updatedMedia.extractedAudio = path.isAbsolute(result.audioPath)
                ? path.relative(projectDir, result.audioPath).replace(/\\/g, '/')
                : result.audioPath;
            }
            if (result.vocalsPath) {
              updatedMedia.extractedVocals = path.isAbsolute(result.vocalsPath)
                ? path.relative(projectDir, result.vocalsPath).replace(/\\/g, '/')
                : result.vocalsPath;
            }
            if (result.bgmPath) {
              updatedMedia.extractedBgm = path.isAbsolute(result.bgmPath)
                ? path.relative(projectDir, result.bgmPath).replace(/\\/g, '/')
                : result.bgmPath;
            }
            
            mediaRepo.updateMedia(updatedMedia.id, updatedMedia);

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
      this.processNextTimer = setTimeout(() => this.processNext(), 1000);
    }
  }

  /** 💥【大减法重构】：建立去画布纯净执行流，直连本地 Python 后台 */
  public async executeLinearQuickPipeline(projectId: string, videoPath: string, window: Electron.BrowserWindow) {
    try {
      AppLogger.info(`[线性向导中枢] ⚙️ 开始激活极速提取分析流. 项目: ${projectId}`);
      
      // 1. 发送第一颗信号，点亮前台进度
      window.webContents.send('QUICK_PIPELINE_PROGRESS', { progress: 5, status: 'processing' });

      const pythonPort = require('./AIDaemon').AIDaemon.getInstance?.().getPort?.() || 9885;

      // 2. 呼叫 Python 执行音轨提取与重度分离
      window.webContents.send('QUICK_PIPELINE_PROGRESS', { progress: 15, status: 'processing', nodeName: '正在分离视频音轨，提取人声中...' });

      const httpClient = require('./HttpClient').HttpClient;
      const separateRes = await httpClient.post(`http://127.0.0.1:${pythonPort}/audio/separate`, {
        videoPath,
        projectId
      });

      if (!separateRes?.data?.success) {
        throw new Error(separateRes?.data?.error || 'Python 音频分离模块遭遇内核阻断');
      }

      const { vocalPath, backgroundPath } = separateRes.data;

      // 3. 呼叫 SenseVoice 模型提取语音识别 (ASR)
      window.webContents.send('QUICK_PIPELINE_PROGRESS', { progress: 55, status: 'processing', nodeName: '音轨分离成功！正在呼叫本地 SenseVoice 大模型转录文字...' });

      const asrRes = await httpClient.post(`http://127.0.0.1:${pythonPort}/audio/asr`, {
        audioPath: vocalPath,
        projectId
      });

      const asrLines = asrRes?.data?.asrLines || [];

      // 4. 💥【并线合并】：向前端派发 100% 极速向导标准的纯净成果包
      const finalCleanPayload = {
        progress: 100,
        status: 'success',
        results: {
          vocalPath,
          backgroundPath,
          asrLines,
          frameCount: asrRes?.data?.frameCount || 0
        }
      };

      console.log('====== [MAIN PROCESS SEND 核心大包] ======', JSON.stringify(finalCleanPayload));
      window.webContents.send('QUICK_PIPELINE_PROGRESS', finalCleanPayload);
      AppLogger.info(`[线性向导中枢] 🎉 全业务数据链全线胜利通车！`);

    } catch (err: any) {
      AppLogger.error(`[线性向导中枢致命崩溃]: ${err.message}`);
      window.webContents.send('QUICK_PIPELINE_PROGRESS', {
        progress: 0,
        status: 'error',
        error: err.message || '本步算力抢占发生熔断'
      });
    }
  }
}
