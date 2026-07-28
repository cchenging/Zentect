// — 路径: src/main/core/JobScheduler.ts
import { JobRepository } from '../database/repositories/JobRepository';
import { MediaRepository } from '../database/repositories/MediaRepository';
import { RoleRepository } from '../database/repositories/RoleRepository';
import { MainNotifier } from './MainNotifier';
import { PipelineEngine } from '../engine/PipelineEngine';
import { PathManager } from '../utils/pathManager';
import { ProjectService } from '../services/ProjectService';
import { PipelineRecoveryService } from '../pipeline/PipelineRecoveryService';
import { DICT } from '../../modules/infra/i18n/dictionary';
import { AppLogger } from './AppLogger';
import { LOG_TAGS } from '../../modules/infra/logger/LogConstants';
import { IPC_CHANNELS } from '../../modules/infra/ipc/IpcConstants';
import { TaskProgressPayload } from '../../shared/types';
import * as path from 'path';
import { SQLiteConnection } from '../../modules/infra/database/core/SQLiteConnection';
import { PROJECT_SQL } from '../database/queries/ProjectQueries';

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
          separationEngine: payload.config?.audio?.engine || 'auto',
          shots: (step1Data.asr?.lines || []).map((line: any) => {
            if (typeof line.start === 'number') {
              return {
                originalText: line.text || line.originalText || '',
                start: line.start,
                end: line.end,
              };
            }
            return {
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
          const { PipelineResultWriter } = require('../pipeline/PipelineResultWriter');
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

  public async executeLinearQuickPipeline(projectId: string, videoPath: string, window: Electron.BrowserWindow) {
    try {
      AppLogger.info(LOG_TAGS.SCHEDULER, `[线性向导中枢] 开始激活极速提取分析流. 项目: ${projectId}`);
      
      window.webContents.send('QUICK_PIPELINE_PROGRESS', { progress: 5, status: 'processing' });

      // 1. 抽帧（FFmpeg 本地执行，不依赖 Python）
      window.webContents.send('QUICK_PIPELINE_PROGRESS', { progress: 10, status: 'processing', nodeName: '正在提取关键帧...' });
      let framePaths: string[] = [];
      try {
        const { VideoProcessor } = require('../engine/media/VideoProcessor');
        const framesDir = path.join(PathManager.getProjectDir(projectId), 'cache', 'frames');
        const frameResult = await VideoProcessor.extractFrames(videoPath, framesDir, projectId, {
          strategy: 'VLM_OPTIMIZED', fps: 2, scale: 1024, quality: 3,
        });
        framePaths = frameResult.files || [];
      } catch (frameErr: any) {
        AppLogger.warn(LOG_TAGS.SCHEDULER, `[线性向导] 抽帧失败，降级跳过`, { error: frameErr.message });
      }

      // 2. 音频分离
      window.webContents.send('QUICK_PIPELINE_PROGRESS', { progress: 30, status: 'processing', nodeName: '正在分离视频音轨，提取人声中...' });

      // 从视频提取音频后调用 Python /api/separate（与主流水线共用同一 Python 契约）
      const projectDir = PathManager.getProjectDir(projectId);
      const audioDir = path.join(projectDir, 'cache', 'audio');
      const fs = require('fs');
      if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });
      // 先用 ffmpeg 抽出 44.1k stereo wav 给分离引擎
      let extractedAudioPath = '';
      try {
        const { AudioProcessor } = require('../engine/media/AudioProcessor');
        const hqPath = path.join(audioDir, `${projectId}_hq.wav`);
        const ok = await AudioProcessor.extractHQAudio(videoPath, hqPath);
        extractedAudioPath = ok ? (ok as string) : '';
      } catch (extractErr: any) {
        AppLogger.warn(LOG_TAGS.SCHEDULER, `[线性向导] 抽音失败，降级跳过分离`, { error: extractErr.message });
      }

      let vocalPath: string | null = null;
      let backgroundPath: string | null = null;
      let vocalsIsFallback = false;

      if (extractedAudioPath) {
        const { PythonClient } = require('../engine/PythonClient');

        // SSE 进度回调：把 Python 端 0-100 的 pct 映射到前端进度条 30-50 区间
        let lastPct = 30;
        const onSseProgress = (pct: number, msg: string) => {
          const mapped = 30 + Math.floor(pct * 0.2);
          if (mapped > lastPct) {
            lastPct = mapped;
            window.webContents.send('QUICK_PIPELINE_PROGRESS', { progress: lastPct, status: 'processing', nodeName: msg || '正在分离人声...' });
          }
        };

        try {
          // PythonClient.callAsync 内部处理 POST 触发 + SSE 订阅
          const sseResult = await PythonClient.getInstance().callAsync(
            '/api/separate',
            { audio_path: extractedAudioPath, output_dir: audioDir, engine: 'auto' },
            onSseProgress,
            { timeoutMs: 600000 }
          );
          if (sseResult.result?.vocals) {
            vocalPath = sseResult.result.vocals || null;
            backgroundPath = sseResult.result.bgm || null;
          } else if (sseResult.error) {
            throw new Error(sseResult.error || 'Python 音频分离失败');
          }
        } catch (separateErr: any) {
          AppLogger.warn(LOG_TAGS.SCHEDULER, `[线性向导] 分离失败，降级使用原始音轨`, { error: separateErr.message });
          vocalPath = extractedAudioPath;
          vocalsIsFallback = true;
        }
      }

      // 3. ASR（走 LocalWhisperStrategy 双引擎降级，而非直接 HTTP）
      window.webContents.send('QUICK_PIPELINE_PROGRESS', { progress: 55, status: 'processing', nodeName: '音轨分离成功！正在呼叫本地语音识别引擎...' });

      let asrLines: any[] = [];
      if (vocalPath) {
        try {
          const { LocalWhisperStrategy } = require('../engine/strategies/LocalWhisperStrategy');
          const whisperStrategy = new LocalWhisperStrategy();
          const whisperResult = await whisperStrategy.transcribe(vocalPath, audioDir, projectId, 'zh');

          if (whisperResult?.whisperJsonPath) {
            const whisperJson = JSON.parse(fs.readFileSync(whisperResult.whisperJsonPath, 'utf-8'));
            asrLines = (whisperJson.transcription || []).map((t: any) => ({
              start: t.timestamps?.from || '00:00',
              end: t.timestamps?.to || '00:00',
              text: t.text || '',
              originalText: t.text || '',
            }));
          }
        } catch (asrErr: any) {
          AppLogger.warn(LOG_TAGS.SCHEDULER, `[线性向导] ASR 失败，降级跳过`, { error: asrErr.message });
        }
      }

      // 4. 人脸检测
      let roles: any[] = [];
      if (framePaths.length > 0) {
        window.webContents.send('QUICK_PIPELINE_PROGRESS', { progress: 80, status: 'processing', nodeName: '正在检测人脸...' });
        try {
          const { VisionProcessor } = require('../engine/media/VisionProcessor');
          const facesDir = path.join(projectDir, 'cache', 'faces');
          roles = await VisionProcessor.scanFaces(framePaths, facesDir);
        } catch (faceErr: any) {
          AppLogger.warn(LOG_TAGS.SCHEDULER, `[线性向导] 人脸检测失败，降级跳过`, { error: faceErr.message });
        }
      }

      // 5. 持久化到 DB（media_assets + roles + EVENT_EXTRACTION_SUCCESS）
      try {
        const mediaRepo = new MediaRepository();
        const projectMedias = mediaRepo.getByProject(projectId);
        const targetMedia = projectMedias.find((m: any) => m.type === 'video');

        if (targetMedia) {
          // 更新 media_assets：frames / extractedVocals / extractedBgm + 分离配置
          if (framePaths.length > 0) {
            targetMedia.frames = framePaths.map((fp: string) =>
              path.isAbsolute(fp) ? path.relative(projectDir, fp).replace(/\\/g, '/') : fp
            );
          }
          if (vocalPath) {
            targetMedia.extractedVocals = path.isAbsolute(vocalPath)
              ? path.relative(projectDir, vocalPath).replace(/\\/g, '/') : vocalPath;
          }
          if (backgroundPath) {
            targetMedia.extractedBgm = path.isAbsolute(backgroundPath)
              ? path.relative(projectDir, backgroundPath).replace(/\\/g, '/') : backgroundPath;
          }
          // 落盘分离配置：模式、引擎、降级标记（线性向导固定 quality + auto）
          targetMedia.separationMode = 'quality';
          targetMedia.separationEngine = 'auto';
          targetMedia.vocalsIsFallback = vocalsIsFallback;
          targetMedia.status = 'parsed';

          // 🔧 修复：把 ASR 台词序列化落盘到 media_assets.extracted_text
          // 与主流水线保持一致，避免依赖前端 IPC 导致 asrLines 丢失
          if (asrLines.length > 0) {
            targetMedia.extractedText = JSON.stringify(
              asrLines.map((l: any) => ({
                start: l.start,
                end: l.end,
                text: l.text || '',
              }))
            );
          }

          mediaRepo.updateMedia(targetMedia.id, targetMedia);
        }

        // 保存 roles 到 roles 表
        if (roles.length > 0) {
          const db = SQLiteConnection.getInstance().getDB();
          db.prepare(PROJECT_SQL.HARD_DELETE_ROLES).run({ projectId });
          const insertRole = db.prepare(PROJECT_SQL.INSERT_ROLE_FULL);
          for (const role of roles) {
            // 🔧 修复 P1：为 role 补默认 name/avatar/description
            //   Strategy 层已生成 name（角色_X），此处兜底防止 name 为空
            //   avatar 取 representative.facePath 或空字符串（后续可由前端从人脸目录补全）
            const roleName = role.name || role.label || `角色_${Date.now().toString(36).slice(-4)}`;
            const roleAvatar = role.avatar || role.representative?.facePath || '';
            insertRole.run({
              id: `role_qp_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
              projectId,
              systemId: role.systemId || null,
              name: roleName,
              pronoun: role.pronoun || '',
              avatar: roleAvatar,
              description: role.description || role.label || roleName,
              voiceId: role.voiceId || null,
              mergedRoles: JSON.stringify(role.mergedRoles || []),
            });
          }
        }

        // 发送 EVENT_EXTRACTION_SUCCESS 通知前端数据已持久化
        if (targetMedia) {
          MainNotifier.notify(IPC_CHANNELS.EVENT_EXTRACTION_SUCCESS, {
            mediaId: targetMedia.id,
            projectId,
            media: {
              id: targetMedia.id,
              name: targetMedia.name,
              type: targetMedia.type,
              filePath: targetMedia.filePath,
              frames: framePaths.length > 0
                ? framePaths.map((fp: string) =>
                    path.isAbsolute(fp) ? path.relative(projectDir, fp).replace(/\\/g, '/') : fp
                  )
                : [],
              extractedVocals: targetMedia.extractedVocals || null,
              extractedBgm: targetMedia.extractedBgm || null,
              // 透传分离配置与降级标记，供前端展示
              separationMode: targetMedia.separationMode,
              separationEngine: targetMedia.separationEngine,
              vocalsIsFallback: targetMedia.vocalsIsFallback,
              status: 'parsed',
            },
            shots: asrLines.map((line: any) => ({
              originalText: line.text || line.originalText || '',
              start: (() => {
                const parts = (line.start || '00:00').split(':');
                return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
              })(),
              end: (() => {
                const parts = (line.end || '00:00').split(':');
                return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
              })(),
            })),
            roles,
          });
        }

        AppLogger.info(LOG_TAGS.SCHEDULER, `[线性向导] 数据库持久化完成: media_assets + roles`);
      } catch (dbErr: any) {
        AppLogger.warn(LOG_TAGS.SCHEDULER, `[线性向导] 数据库持久化失败`, { error: dbErr.message });
      }

      // 6. 派发结果到前端
      const finalCleanPayload = {
        progress: 100,
        status: 'success',
        results: {
          vocalPath,
          backgroundPath,
          asrLines,
          framePaths,
          frameCount: framePaths.length,
          roles,
        }
      };

      window.webContents.send('QUICK_PIPELINE_PROGRESS', finalCleanPayload);
      AppLogger.info(LOG_TAGS.SCHEDULER, `[线性向导中枢] 全业务数据链全线胜利通车！`);

    } catch (err: any) {
      AppLogger.error(LOG_TAGS.SCHEDULER, `[线性向导中枢致命崩溃]: ${err.message}`);
      window.webContents.send('QUICK_PIPELINE_PROGRESS', {
        progress: 0,
        status: 'error',
        error: err.message || '本步算力抢占发生熔断'
      });
    }
  }
}
