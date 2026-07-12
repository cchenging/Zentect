// 📁 新建文件: src/main/controllers/EngineController.ts
import { z } from 'zod';
import { BrowserWindow } from 'electron';
import { IpcRouter } from '../core/IpcRouter';
import { IPC_CHANNELS } from '../../modules/infra/ipc/IpcConstants';
import { PipelineEngine } from '../engine/PipelineEngine';
import { SimplePipelineRunner } from '../engine/SimplePipelineRunner';
import { AIEngine } from '../engine/AIEngine';
import { PipelineRecoveryService } from '../pipeline/PipelineRecoveryService';
import { PipelineSuspendController } from '../pipeline/PipelineSuspendController';
import { ProjectService } from '../services/ProjectService';
import { LocalAiGateway } from '../engine/LocalAiGateway';
import { HealthService } from '../services/HealthService';
import { WorkflowService } from '../services/WorkflowService';
import { RoleRepository } from '../database/repositories/RoleRepository';
import { TTSProvider } from '../../modules/pipeline/step4-tts/backend/Service';
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../modules/infra/logger/LogConstants';
import { SettingsRepository } from '../database/repositories/SettingsRepository';
import { FFmpegRenderer } from '../engine/media/FFmpegRenderer'
import { BatchQueueEngine } from '../engine/BatchQueueEngine'
import { PublishService } from '../services/PublishService';
import { PathManager } from '../utils/pathManager';
import { ExceptionHub } from '../core/ExceptionHub';
import { ProjectRepository } from '../database/repositories/ProjectRepository';
import { JobScheduler } from '../core/JobScheduler';
import * as path from 'path';
import type { PipelinePayload } from '../../shared/types';

const V1_PIPELINE_PAYLOAD_SCHEMA = z.object({
  projectId: z.string().min(1, 'projectId 不能为空'),
  mediaId: z.string().min(1, 'mediaId 不能为空'),
  mediaPath: z.string().min(1, 'mediaPath 不能为空'),
});

export class EngineController {
  private projectService = new ProjectService();
  private static engines = new Map<string, PipelineEngine>();
  private static simpleRunners = new Map<string, SimplePipelineRunner>();
  private static suspendController = new PipelineSuspendController();

  static register() {
    // V1.2: 前置配置检查缓存 — 60 秒 TTL 避免重复查询 LLM 配置
    let preflightCache: { ok: boolean; message: string; checks: any[] } | null = null;
    let preflightCacheTime = 0;

    IpcRouter.handle(IPC_CHANNELS.ENGINE_PREFLIGHT, async (_, payload?: { steps?: string[] }) => {
      const now = Date.now();
      if (preflightCache && (now - preflightCacheTime) < 60000) {
        return preflightCache;
      }
      const stepIds = payload?.steps || ['extract_frames', 'separate_audio', 'asr', 'face_detect', 'scene_detect', 'script_gen', 'tts_export'];
      const checks = AIEngine.preflightCheck(stepIds);
      const { ok, message } = AIEngine.formatCheckResult(checks);
      preflightCache = { ok, message, checks };
      preflightCacheTime = now;
      return preflightCache;
    });
    // V1.0: SimplePipelineRunner — 固定管线，按序执行（含人机交替挂起）
    IpcRouter.handleWithSchema(
      IPC_CHANNELS.ENGINE_RUN_V1_PIPELINE,
      V1_PIPELINE_PAYLOAD_SCHEMA,
      async (_, { projectId, mediaId, mediaPath }) => {
        AppLogger.info(LOG_TAGS.ENGINE, `V1.0 Pipeline 启动: project=${projectId}, media=${mediaId}`);

        const runner = new SimplePipelineRunner();
        this.simpleRunners.set(projectId, runner);

        try {
          const result = await runner.run(projectId, mediaId, mediaPath, this.suspendController);
          return result;
        } finally {
          this.simpleRunners.delete(projectId);
        }
      }
    );

    // V1.1+: DAG PipelineEngine + 极速向导分流
    IpcRouter.handle(IPC_CHANNELS.ENGINE_RUN_PIPELINE, async (event, payload: any) => {
      const { projectId, isQuickMode, extractedData, isSaveAction } = payload;
      const window = event.sender.getOwnerBrowserWindow();

      // A. 前端发来的完工落盘信号
      if (isSaveAction || payload.action === 'SAVE_QUICK_DATA') {
        const projectRepo = new ProjectRepository();
        const success = projectRepo.updateQuickCardMetadata(projectId, extractedData);
        return { success, message: success ? 'SQLite 持久化大成功' : '写盘失败' };
      }

      // B. 右下角按钮触发运行 — 极速线性管道
      if (isQuickMode || payload.action === 'RUN_LINEAR_PIPELINE') {
        const projectRepo = new ProjectRepository();
        const currentProject = projectRepo.findQuickProjectById(projectId);
        if (!currentProject || !currentProject.videoPath) {
          return { success: false, error: '未检测到工作区导入的有效多媒体路径' };
        }
        JobScheduler.getInstance().executeLinearQuickPipeline(
          projectId, 
          currentProject.videoPath, 
          window
        );
        return { success: true, message: 'Zentect 线性内核异步唤醒成功' };
      }

      // C. 步骤管线 / DAG 管线执行
      const pid = projectId || 'default';
      AppLogger.info(LOG_TAGS.SYSTEM, `接收到管线执行指令，工程 ID: ${pid}`);

      const engine = new PipelineEngine();
      this.engines.set(pid, engine);

      try {
        const result = await engine.executePipeline(
          payload as PipelinePayload,
          (progressData) => {
            event.sender.send(IPC_CHANNELS.ENGINE_PIPELINE_PROGRESS, progressData);

            // 当进度状态为 shot-data 时，额外推送到故事板卡片通道
            if (progressData.status === 'shot-data' && progressData.results?.shotId) {
              try {
                if (!event.sender.isDestroyed()) {
                  event.sender.send(IPC_CHANNELS.EVENT_STREAM_TO_SHOT_CARD, {
                    shotId: progressData.results.shotId,
                    safeText: JSON.stringify(progressData.results.data),
                  });
                }
              } catch { /* 推送失败不影响主流程 */ }
            }
          }
        );
        return { data: result, message: '工作流执行圆满完成' };
      } catch (error: any) {
        const errMsg = error?.message || error?.toString() || '未知异常';
        const errStack = error?.stack || '';
        AppLogger.error(LOG_TAGS.SYSTEM, `工作流执行崩盘: ${errMsg}`, { stack: errStack.substring(0, 500) });

        // 💥 断层3修复：异常归一化后推送 EVENT_PIPELINE_ERROR 到前端
        try {
          const i18nPayload = ExceptionHub.normalize(error);
          event.sender.send(IPC_CHANNELS.EVENT_PIPELINE_ERROR, {
            nodeId: error?.nodeId || 'unknown',
            titleKey: i18nPayload.titleKey,
            promptKey: i18nPayload.promptKey,
          });
        } catch { /* 推送失败不影响主流程 */ }

        throw error;
      } finally {
        this.engines.delete(pid);
      }
    });

    // 中止 — 同时处理 PipelineEngine 和 SimpleRunner，并清理挂起状态
    IpcRouter.handle(IPC_CHANNELS.ENGINE_ABORT_PIPELINE, async (_, payload?: { projectId?: string; mediaId?: string }) => {
      const pid = payload?.projectId;
      if (pid) {
        const engine = this.engines.get(pid);
        if (engine) { engine.abort(); this.engines.delete(pid); }
        const runner = this.simpleRunners.get(pid);
        if (runner) { runner.abort(); this.simpleRunners.delete(pid); }
        if (payload?.mediaId) {
          this.suspendController.abandon(pid, payload.mediaId);
        }
        AppLogger.warn(LOG_TAGS.SYSTEM, `已中止工程 ${pid} 的工作流`);
      } else {
        this.engines.forEach(e => e.abort());
        this.engines.clear();
        this.simpleRunners.forEach(r => r.abort());
        this.simpleRunners.clear();
        this.suspendController.destroy();
        AppLogger.warn(LOG_TAGS.SYSTEM, `已中止所有工作流`);
      }
      return true;
    });

    // V1.0: 获取挂起状态 — 前端轮询当前是否有等待用户操作的挂起
    IpcRouter.handle(IPC_CHANNELS.ENGINE_REQUIRE_USER_ACTION, async (_, payload: { projectId: string; mediaId: string }) => {
      const suspension = this.suspendController.getSuspension(payload.projectId, payload.mediaId);
      return {
        suspended: !!suspension,
        actionType: suspension?.actionType || null,
        stepId: suspension?.stepId || null,
        context: suspension?.context || null,
      };
    });

    // V1.0: Pipeline 恢复 — 用户完成操作后继续执行
    IpcRouter.handle(IPC_CHANNELS.ENGINE_RESUME_PIPELINE, async (_, payload: { projectId: string; mediaId: string; userInput: Record<string, unknown> }) => {
      const result = this.suspendController.resume({
        projectId: payload.projectId,
        mediaId: payload.mediaId,
        userInput: payload.userInput || {},
      });
      return result;
    });

    // V1.0: Pipeline 恢复 — 探测未完成的 pipeline
    IpcRouter.handle(IPC_CHANNELS.PIPELINE_PROBE_RECOVERY, async (_, payload: { projectId: string }) => {
      const recoveryService = new PipelineRecoveryService();
      const status = recoveryService.probeProject(payload.projectId);
      return { hasIncomplete: status?.hasIncomplete ?? false, status };
    });

    // V1.0: Pipeline 恢复 — 继续执行
    IpcRouter.handle(IPC_CHANNELS.PIPELINE_RECOVERY_CONTINUE, async (_, payload: { projectId: string }) => {
      const recoveryService = new PipelineRecoveryService();
      const result = recoveryService.continuePipeline(payload.projectId);
      return result;
    });

    // V1.0: Pipeline 恢复 — 放弃执行
    IpcRouter.handle(IPC_CHANNELS.PIPELINE_RECOVERY_ABANDON, async (_, payload: { projectId: string }) => {
      const recoveryService = new PipelineRecoveryService();
      recoveryService.abandonPipeline(payload.projectId);
      return { abandoned: true };
    });

    // V1.1: DAG 工作流执行 — 从 WorkflowService 加载 DAG 并拓扑排序执行
    IpcRouter.handle(IPC_CHANNELS.ENGINE_RUN_DAG_WORKFLOW, async (event, payload: { projectId: string }) => {
      const pid = payload.projectId;
      AppLogger.info(LOG_TAGS.ENGINE, `DAG 工作流执行启动: project=${pid}`);

      const engine = new PipelineEngine();
      this.engines.set(pid, engine);

      try {
        const result = await engine.executeFromWorkflow(
          pid,
          (progressData) => {
            event.sender.send(IPC_CHANNELS.ENGINE_PIPELINE_PROGRESS, progressData);

            // 当进度状态为 shot-data 时，额外推送到故事板卡片通道
            if (progressData.status === 'shot-data' && progressData.results?.shotId) {
              try {
                if (!event.sender.isDestroyed()) {
                  event.sender.send(IPC_CHANNELS.EVENT_STREAM_TO_SHOT_CARD, {
                    shotId: progressData.results.shotId,
                    safeText: JSON.stringify(progressData.results.data),
                  });
                }
              } catch { /* 推送失败不影响主流程 */ }
            }
          }
        );
        return { data: result, message: 'DAG 工作流执行完成' };
      } catch (error: any) {
        AppLogger.error(LOG_TAGS.ENGINE, `DAG 工作流执行失败`, error);

        // 💥 断层3修复：异常归一化后推送 EVENT_PIPELINE_ERROR 到前端
        try {
          const i18nPayload = ExceptionHub.normalize(error);
          event.sender.send(IPC_CHANNELS.EVENT_PIPELINE_ERROR, {
            nodeId: error?.nodeId || 'unknown',
            titleKey: i18nPayload.titleKey,
            promptKey: i18nPayload.promptKey,
          });
        } catch { /* 推送失败不影响主流程 */ }

        throw error;
      } finally {
        this.engines.delete(pid);
      }
    });

    // V1.1: 工作流画布保存 — 节点/连线持久化到 SQLite
    IpcRouter.handle(IPC_CHANNELS.WORKFLOW_SAVE, async (_, payload) => {
      const service = new WorkflowService();
      service.save(payload);
      return { success: true };
    });

    // V1.1: 工作流画布加载 — 从 SQLite 恢复节点/连线
    IpcRouter.handle(IPC_CHANNELS.WORKFLOW_LOAD, async (_, projectId: string) => {
      const service = new WorkflowService();
      return service.load(projectId);
    });

    // V1.1: Pipeline 参数更新 — 持久化 R/S/T/P 到 Settings，后续 Pipeline 执行时自动注入 ExecutionContext
    IpcRouter.handle(IPC_CHANNELS.PIPELINE_UPDATE_PARAMS, async (_, payload: { projectId: string; params: Record<string, number> }) => {
      AppLogger.info(LOG_TAGS.ENGINE, `Pipeline 参数更新: project=${payload.projectId}, params=${JSON.stringify(payload.params)}`);

      const settings = new SettingsRepository();
      const paramMapping: Record<string, string> = {
        R: 'pipeline.param.retainRatio',
        S: 'pipeline.param.silenceRatio',
        T: 'pipeline.param.ttsCoverage',
        P: 'pipeline.param.paceFactor',
      };

      for (const [key, settingKey] of Object.entries(paramMapping)) {
        if (payload.params[key] !== undefined) {
          settings.saveSettings({ [settingKey]: String(payload.params[key]) });
        }
      }

      return { success: true, params: payload.params };
    });

    // V1.1: License 已迁移至 VIP 激活码体系（UserController 处理）
    // 旧 IPC 频道保留兼容，返回迁移提示
    IpcRouter.handle(IPC_CHANNELS.LICENSE_VALIDATE, async () => {
      return { success: false, message: '已迁移至 VIP 激活码体系，请使用 user:activateVip' };
    });

    IpcRouter.handle(IPC_CHANNELS.LICENSE_STATUS, async () => {
      return { active: false, message: '已迁移至 VIP 激活码体系，请使用 user:getVipInfo' };
    });

    // V1.1: 角色列表 — 获取指定工程的所有角色
    IpcRouter.handle(IPC_CHANNELS.ROLE_LIST, async (_, projectId: string) => {
      const repo = new RoleRepository();
      return repo.findByProjectId(projectId);
    });

    // V1.1: 角色音色更新 — 设置角色的 voice_id
    IpcRouter.handle(IPC_CHANNELS.ROLE_UPDATE_VOICE, async (_, payload: { id: string; voiceId: string }) => {
      const repo = new RoleRepository();
      repo.updateVoiceId(payload.id, payload.voiceId);
      return { success: true };
    });

    // V1.1: 音色试听 — 使用指定引擎/音色合成示例文本，返回音频路径
    IpcRouter.handle(IPC_CHANNELS.VOICE_PREVIEW, async (_, payload: { provider: string; voiceId?: string; text?: string }) => {
      const provider = new TTSProvider();
      const sampleText = payload.text || '欢迎使用 Zentect 智能剪辑，这是一段测试语音合成效果。';
      const audioPath = await provider.synthesize(sampleText, payload.provider as any, undefined, payload.voiceId || undefined);
      return { audioPath };
    });

    // V1.1: 音色列表 — 根据引擎类型返回可用音色清单
    IpcRouter.handle(IPC_CHANNELS.VOICE_LIST_BY_ENGINE, async (_, engine: string) => {
      const voices = await getVoicesForEngine(engine);
      return voices;
    });

    // M3.0 安全收口: 语音克隆代理 — renderer 不再直连 127.0.0.1:9882
    IpcRouter.handle('voice:get-cloned-voices', async () => {
      const gateway = LocalAiGateway.getInstance();
      return gateway.getClonedVoices();
    });

    IpcRouter.handle('voice:delete-cloned', async (_, payload: { cloneId: string }) => {
      const gateway = LocalAiGateway.getInstance();
      return gateway.deleteClonedVoice(payload.cloneId);
    });

    // M4.0: 系统健康检查与冒烟测试
    IpcRouter.handle('system:health', async () => {
      const healthService = new HealthService();
      return healthService.collect();
    });

    IpcRouter.handle('system:smoke-test', async () => {
      const healthService = new HealthService();
      return healthService.smokeTest();
    });

    // ========== V1.2: FFmpeg 独立 MP4 渲染 ==========
    IpcRouter.handle(IPC_CHANNELS.EXPORT_MP4_RENDER, async (_, payload) => {
      AppLogger.info(LOG_TAGS.EXPORT, `[IPC] MP4 渲染请求: ${payload.projectName}`);
      // 防御性兜底: 前端可能未传 outputDir，由服务端计算
      const outputDir = payload.outputDir || path.join(PathManager.getProjectExportDir(payload.projectId), 'videos');
      const outputName = payload.outputName || payload.projectName?.replace(/[<>:"/\\|?*]/g, '_') || 'output';
      const renderer = new FFmpegRenderer();
      return renderer.render({
        projectId: payload.projectId,
        mediaPath: payload.mediaPath,
        shots: payload.shots || [],
        bgmPath: payload.bgmPath,
        subtitlePath: payload.subtitlePath,
        outputDir,
        outputName,
      });
    });

    // ========== V1.2: 发布素材包 ==========
    IpcRouter.handle(IPC_CHANNELS.EXPORT_PUBLISH_PACKAGE, async (_, payload) => {
      AppLogger.info(LOG_TAGS.EXPORT, `[IPC] 发布素材包请求: ${payload.projectName}`);
      const service = new PublishService();
      return service.generatePackage({
        projectId: payload.projectId,
        projectName: payload.projectName,
        shots: payload.shots || [],
        mediaPath: payload.mediaPath,
        mp4Path: payload.mp4Path,
      });
    });

    // ========== V1.2: 批量任务队列 ==========
    const queueEngine = BatchQueueEngine.getInstance();

    queueEngine.onProgress((status) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.BATCH_PROGRESS, status);
      }
    });

    IpcRouter.handle(IPC_CHANNELS.BATCH_QUEUE_ADD, async (_, payload) => {
      AppLogger.info(LOG_TAGS.SCHEDULER, `[IPC] 批量入队: ${payload?.length || 0} 个任务`);
      return queueEngine.addJobs(payload || []);
    });

    IpcRouter.handle(IPC_CHANNELS.BATCH_QUEUE_START, async () => {
      AppLogger.info(LOG_TAGS.SCHEDULER, '[IPC] 启动队列引擎');
      await queueEngine.start();
      return queueEngine.getStatus();
    });

    IpcRouter.handle(IPC_CHANNELS.BATCH_QUEUE_STATUS, async () => {
      return queueEngine.getStatus();
    });

    IpcRouter.handle(IPC_CHANNELS.BATCH_QUEUE_PAUSE, async () => {
      queueEngine.pause();
      return queueEngine.getStatus();
    });

    IpcRouter.handle(IPC_CHANNELS.BATCH_QUEUE_REMOVE, async (_, jobId) => {
      return queueEngine.removeJob(jobId);
    });

    IpcRouter.handle(IPC_CHANNELS.BATCH_QUEUE_REORDER, async (_, jobIds) => {
      queueEngine.reorderJobs(jobIds);
      return queueEngine.getStatus();
    });

    IpcRouter.handle(IPC_CHANNELS.BATCH_QUEUE_RETRY, async (_, jobId) => {
      queueEngine.retryJob(jobId);
      return queueEngine.getStatus();
    });

    AppLogger.info(LOG_TAGS.SYSTEM, 'EngineController 注册完成 (含 V1.2 批量队列)')
  }
}

/** V1.1: 获取指定 TTS 引擎的可用音色清单 */
async function getVoicesForEngine(engine: string): Promise<Array<{ id: string; name: string; lang?: string; gender?: string; locale?: string }>> {
  switch (engine) {
    case 'edge':
      return [
        { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓 (女)', gender: 'female', locale: 'zh-CN' },
        { id: 'zh-CN-YunxiNeural', name: '云希 (男)', gender: 'male', locale: 'zh-CN' },
        { id: 'zh-CN-YunyangNeural', name: '云扬 (男·新闻)', gender: 'male', locale: 'zh-CN' },
        { id: 'zh-CN-XiaoyiNeural', name: '晓伊 (女)', gender: 'female', locale: 'zh-CN' },
        { id: 'zh-CN-YunjianNeural', name: '云健 (男·体育)', gender: 'male', locale: 'zh-CN' },
        { id: 'zh-CN-XiaochenNeural', name: '晓辰 (女·温柔)', gender: 'female', locale: 'zh-CN' },
      ];
    case 'doubao':
      return [
        { id: 'zh_female_meilinvyou_saturn_bigtts', name: '美女主播 (女)', gender: 'female', locale: 'zh-CN' },
        { id: 'zh_male_shaunglangxueke_moon_bigtts', name: '爽朗学科 (男)', gender: 'male', locale: 'zh-CN' },
        { id: 'zh_female_vv_uranus_bigtts', name: 'vv 女声', gender: 'female', locale: 'zh-CN' },
        { id: 'zh_male_dashu_saturn_bigtts', name: '大叔 (男)', gender: 'male', locale: 'zh-CN' },
      ];
    case 'fish':
      return [
        { id: 'default', name: 'Fish Audio 默认音色', gender: 'unknown', locale: 'zh-CN' },
      ];
    case 'sovits':
      return [
        { id: 'default', name: '本地 SoVITS 音色 (需克隆)', gender: 'unknown', locale: 'zh-CN' },
      ];
    case 'moss': {
      try {
        const response = await fetch('http://127.0.0.1:9881/voices');
        const data = await response.json();
        if (data?.voices && Array.isArray(data.voices)) {
          const langMap: Record<string, string> = { zh: '中文', en: '英文', ja: '日文' };
          const genderMap: Record<string, string> = { male: '男', female: '女' };
          return data.voices.map((v: any) => ({
            id: v.id,
            name: v.name,
            lang: `${langMap[v.language] || v.language}·${genderMap[v.gender] || v.gender}`,
          }));
        }
      } catch {
        // tts_worker 未启动时返回空数组，前端以硬编码 VOICE_OPTIONS 兜底
      }
      return [];
    }
    default:
      return [];
  }
}
