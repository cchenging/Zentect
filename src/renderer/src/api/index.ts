// 📁 路径: src/renderer/src/api/index.ts
import { IPC_CHANNELS } from '../../../shared/utils/IpcConstants';
import type { TaskProgressPayload, TaskCompletedPayload, AppNotifyPayload } from '../../../shared/types';

/**
 * 💥 核心封装：前端通用调用池
 * 修复 1：将 payload 彻底改为 ...args 平铺展开，与主进程 IpcRouter.handle 的多参数完全对齐
 * 修复 2：智能兼容响应体，既支持标准的 { success, data } 信封，也支持后端直接丢回来的裸数组 (Raw Array)
 */
async function invokeSafe<T = any>(channel: string, ...args: any[]): Promise<T> {
  if (!window.api?.ipc?.invoke) throw new Error('Electron 环境未挂载');

  if (!channel) {
    console.error('致命 IPC 错误: 调用的 Channel 名称为空或 undefined', { channel, args });
    throw new Error('系统错误：IPC 桥接信道未定义');
  }

  const safeArgs = args.map(arg => arg === undefined ? null : arg);

  const res = await window.api.ipc.invoke(channel, ...safeArgs);

  // 🛡️ 智能兼容：如果后端返回了标准的信封结构 { success, data, error }
  if (res && typeof res === 'object' && 'success' in res) {
    if (!res.success) {
      throw new Error(res.error || '未知的 IPC 桥接错误');
    }
    // 有些接口直接把成功的数据放在 res 上，有的放在 res.data 里
    return ('data' in res) ? (res.data as T) : (res as unknown as T);
  }

  // 🛡️ 智能兼容：如果后端直接裸返回数据（如 MediaController 经常直接 return Array 或 boolean）
  return res as T;
}

// 💥 领域划分 SDK
export const API = {
  system: {
    getPaths: () => invokeSafe<{ projects: string, exports: string }>(IPC_CHANNELS.SYSTEM_GET_PATHS),
    resizeWindow: (w: number, h: number) => invokeSafe(IPC_CHANNELS.SYSTEM_RESIZE, w, h),
    close: () => invokeSafe(IPC_CHANNELS.SYSTEM_CLOSE),
    minimize: () => invokeSafe(IPC_CHANNELS.SYSTEM_MINIMIZE),
    maximize: () => invokeSafe(IPC_CHANNELS.SYSTEM_MAXIMIZE),

    getSetting: <T>(key: string, defaultVal?: T) =>
      invokeSafe<T>(IPC_CHANNELS.SYSTEM_SETTING_GET, key, defaultVal ?? null),

    setSetting: (key: string, value: any) =>
      invokeSafe(IPC_CHANNELS.SYSTEM_SETTING_SET, key, value ?? null),

    openDirectory: () => invokeSafe<string | null>(IPC_CHANNELS.SYSTEM_OPEN_DIR),
    openMediaDialog: () => invokeSafe<string[]>(IPC_CHANNELS.SYSTEM_OPEN_MEDIA),
    openPath: (filePath: string) => invokeSafe(IPC_CHANNELS.SYSTEM_OPEN_PATH, filePath),
    openFile: (options?: { filters?: Array<{ name: string; extensions: string[] }>; properties?: string[] }) => invokeSafe<string | null>(IPC_CHANNELS.SYSTEM_OPEN_FILE, options ?? null),
    readFile: (filePath: string) => invokeSafe<string>(IPC_CHANNELS.SYSTEM_READ_FILE, filePath),

    // 兼容旧 API 的额外接口
    switchView: (viewName: string) => window.api.system.switchView(viewName),
    appIsReady: () => window.api.system.appIsReady(),
    log: (payload: any) => window.api.system.log(payload),
    migrateProjects: (oldPath: string, newPath: string) => invokeSafe(IPC_CHANNELS.SYSTEM_MIGRATE, oldPath, newPath),
    health: () => invokeSafe<any>('system:health'),
    smokeTest: () => invokeSafe<any>('system:smoke-test'),
  },

  media: {
    // 💥 关键修复区：解除对象花括号，直接多参数透传，拯救主进程解构崩溃
    import: (projectId: string, filePaths: string[]) => invokeSafe<any[]>(IPC_CHANNELS.MEDIA_IMPORT, projectId, filePaths),
    update: (mediaId: string, data: any) => invokeSafe(IPC_CHANNELS.MEDIA_UPDATE, mediaId, data),
    process: (projectId: string, activeMedia: any, config: any) => invokeSafe(IPC_CHANNELS.MEDIA_PROCESS, projectId, activeMedia, config),
    /** 轻量抽帧：只执行抽帧，不跑全管线，用于前端即时反馈闭环 */
    extractFrames: (payload: { mediaId: string; projectId: string; strategy: string; fps: number; sceneThreshold: number; scale: number; quality: number; minFrameInterval?: number; timePoint?: number }) => invokeSafe<{ success: boolean; frameCount: number; previewUrls: string[] }>(IPC_CHANNELS.MEDIA_EXTRACT_FRAMES, payload),
    cancelProcess: (mediaId: string) => invokeSafe(IPC_CHANNELS.MEDIA_CANCEL, mediaId),
    delete: (projectId: string, mediaId: string) => invokeSafe(IPC_CHANNELS.MEDIA_DELETE, projectId, mediaId),
    getByProject: (projectId: string) => invokeSafe<any[]>(IPC_CHANNELS.MEDIA_GET_BY_PROJECT, projectId),
  },

  ai: {
    // 💥 同步修复所有多参数接口
    testNetwork: (provider: string, config: any) => invokeSafe<string>(IPC_CHANNELS.AI_TEST_NETWORK, provider, config),
    testTTS: (engine: string) => invokeSafe<string>(IPC_CHANNELS.AI_TEST_TTS, engine),
    generateTTS: (text: string, roleId: string) => invokeSafe(IPC_CHANNELS.AI_GENERATE_TTS, text, roleId),
    runSingleTTS: (projectId: string, shot: any) => invokeSafe(IPC_CHANNELS.AI_RUN_SINGLE_TTS, projectId, shot),
    runGlobalTTS: (projectId: string, shots: any[]) => invokeSafe(IPC_CHANNELS.AI_RUN_GLOBAL_TTS, projectId, shots),
    visionSingle: (data: any) => invokeSafe(IPC_CHANNELS.AI_VISION_SINGLE, data),
    emotionSingle: (data: any) => invokeSafe(IPC_CHANNELS.AI_EMOTION_SINGLE, data),
    generateAiScript: (data: any) => invokeSafe(IPC_CHANNELS.AI_GENERATE_SCRIPT, data),
    streamText: (payload: any) => window.api.ai.streamText(payload),
    searchSemantics: (mediaId: string, query: string) => invokeSafe(IPC_CHANNELS.AI_SEARCH_SEMANTICS, mediaId, query),
  },

  export: {
    jianying: (payload: any) => invokeSafe(IPC_CHANNELS.EXPORT_JIANYING, payload),
    localVideo: (payload: any) => invokeSafe(IPC_CHANNELS.EXPORT_LOCAL_VIDEO, payload),
    /** V1.2: FFmpeg 独立 MP4 渲染 */
    mp4Render: (payload: any) => invokeSafe(IPC_CHANNELS.EXPORT_MP4_RENDER, payload),
    /** V1.2: 发布素材包生成 */
    publishPackage: (payload: any) => invokeSafe(IPC_CHANNELS.EXPORT_PUBLISH_PACKAGE, payload),
    /** 字幕文件导出 (SRT/ASS) */
    subtitle: (payload: any) => invokeSafe(IPC_CHANNELS.EXPORT_SUBTITLE, payload),
    /** 文案 TXT 导出 */
    txt: (payload: any) => invokeSafe(IPC_CHANNELS.EXPORT_TXT, payload),
  },

  project: {
    // P1: 增量保存 — 仅更新解说稿修改的段落
    updateScriptDelta: (projectId: string, deltas: Array<{ shotId: string; text: string }>) =>
      invokeSafe(IPC_CHANNELS.PROJECT_UPDATE_SCRIPT_DELTA, projectId, deltas),
    getById: (id: string) => invokeSafe(IPC_CHANNELS.PROJECT_GET_BY_ID, id),
    getAll: () => invokeSafe(IPC_CHANNELS.PROJECT_GET_LIST),
    loadData: (id: string) => invokeSafe(IPC_CHANNELS.PROJECT_LOAD_DATA, id),
    // 💥 同步修复：解除对象花括号
    saveData: (id: string, data: any) => invokeSafe(IPC_CHANNELS.PROJECT_SAVE_DATA, id, data),
    saveCanvas: (id: string, canvasData: string) => invokeSafe(IPC_CHANNELS.PROJECT_SAVE_CANVAS, id, canvasData),
    getRecent: () => invokeSafe(IPC_CHANNELS.PROJECT_GET_RECENT),
    getList: () => invokeSafe(IPC_CHANNELS.PROJECT_GET_LIST),
    create: (payload?: { name?: string, type?: string }) => invokeSafe(IPC_CHANNELS.PROJECT_CREATE, payload),
    delete: (id: string) => invokeSafe(IPC_CHANNELS.PROJECT_DELETE, id),
    rename: (id: string, newName: string) => invokeSafe(IPC_CHANNELS.PROJECT_RENAME, id, newName),
    duplicate: (id: string) => invokeSafe(IPC_CHANNELS.PROJECT_DUPLICATE, id),
    instantiate: (payload: any) => invokeSafe(IPC_CHANNELS.PROJECT_INSTANTIATE, payload),
    import: async () => { console.warn('[API] project.import 尚未实现 IPC 通道'); return null; },
    /** 导出项目备份 */
    exportProject: (id: string) => invokeSafe<string>(IPC_CHANNELS.PROJECT_EXPORT, id),
  },

  tasks: {
    getAll: (projectId: string) => invokeSafe(IPC_CHANNELS.TASK_GET_ALL, projectId),
    getActive: (projectId: string) => invokeSafe(IPC_CHANNELS.TASK_GET_ACTIVE, projectId),
    cancel: (taskId: string) => invokeSafe(IPC_CHANNELS.TASK_CANCEL, taskId),
  },

  // 💥 集中管理底层物理引擎任务接口
  engine: {
    extractFrames: (videoPath: string, config: any) => invokeSafe(IPC_CHANNELS.AI_EXTRACT_FRAMES, videoPath, config),
    searchBroll: (query: string, projectId: string) => invokeSafe(IPC_CHANNELS.AI_SEARCH_BROLL, query, projectId),
    runPipeline: (payload: any) => invokeSafe(IPC_CHANNELS.ENGINE_RUN_PIPELINE, payload),

    // V1.0: SimplePipelineRunner — 固定管线
    runV1Pipeline: (projectId: string, mediaId: string, mediaPath: string) =>
      invokeSafe('engine:run-v1-pipeline', { projectId, mediaId, mediaPath }),
    onPipelineProgress: (listener: (payload: any) => void) => {
      window.api.ipc.on(IPC_CHANNELS.ENGINE_PIPELINE_PROGRESS, (_, data) => listener(data));
    },

    offPipelineProgress: () => {
      window.api.ipc.removeAllListeners(IPC_CHANNELS.ENGINE_PIPELINE_PROGRESS);
    },

    abortPipeline: () => invokeSafe(IPC_CHANNELS.ENGINE_ABORT_PIPELINE),

    // P0: 前置检查 — 查询 AI 服务配置状态
    preflight: (steps?: string[]) => invokeSafe<{ ok: boolean; message: string; checks: any[] }>(IPC_CHANNELS.ENGINE_PREFLIGHT, { steps }),

    // V1.1: Pipeline 参数更新
    updateParams: (projectId: string, params: Record<string, number>) =>
      invokeSafe(IPC_CHANNELS.PIPELINE_UPDATE_PARAMS, { projectId, params }),

    // 💥 断层2修复：DAG 工作流执行 — 从 WorkflowService 加载 DAG 并拓扑排序执行
    runDagWorkflow: (projectId: string) =>
      invokeSafe(IPC_CHANNELS.ENGINE_RUN_DAG_WORKFLOW, { projectId }),
  },

  // V1.1: 工作流画布持久化域
  workflow: {
    save: (payload: { projectId: string; nodes: any[]; edges: any[] }) =>
      invokeSafe(IPC_CHANNELS.WORKFLOW_SAVE, payload),
    load: (projectId: string) =>
      invokeSafe(IPC_CHANNELS.WORKFLOW_LOAD, projectId),
  },

  // V1.1: 角色与音色管理域
  roles: {
    list: (projectId: string) =>
      invokeSafe(IPC_CHANNELS.ROLE_LIST, projectId),
    updateVoice: (id: string, voiceId: string) =>
      invokeSafe(IPC_CHANNELS.ROLE_UPDATE_VOICE, { id, voiceId }),
  },
  voice: {
    preview: (provider: string, voiceId?: string, text?: string) =>
      invokeSafe<{ audioPath: string }>(IPC_CHANNELS.VOICE_PREVIEW, { provider, voiceId, text }),
    listByEngine: (engine: string) =>
      invokeSafe(IPC_CHANNELS.VOICE_LIST_BY_ENGINE, engine),
    /** 获取已克隆的音色列表 */
    getClonedVoices: () =>
      invokeSafe<{ code: number; voices: Array<{ id: string; name: string }> }>('voice:get-cloned-voices'),
  },

  // 宪法重构：纯洁、类型安全且绝对合法的前端事件总线
  events: {
    onTaskProgress: (listener: (payload: TaskProgressPayload) => void) => {
      window.api.events.onTaskProgress((arg1: any, arg2?: any, arg3?: any, arg4?: any) => {
        const payload: TaskProgressPayload = typeof arg1 === 'object' ? arg1 : { mediaId: arg1, code: arg2, percent: arg3, status: arg4 };
        listener(payload);
      });
    },
    onTaskCompleted: (listener: (payload: TaskCompletedPayload) => void) => {
      window.api.events.onTaskCompleted((arg1: any, arg2?: any, arg3?: any) => {
        const payload: TaskCompletedPayload = typeof arg1 === 'object' ? arg1 : { mediaId: arg1, projectId: arg2, result: arg3 };
        listener(payload);
      });
    },
    onAppNotify: (listener: (payload: AppNotifyPayload) => void) => {
      window.api.events.onAppNotify((arg1: any, arg2?: any) => {
        const payload: AppNotifyPayload = typeof arg1 === 'object' ? arg1 : { code: arg1, level: arg2 };
        listener(payload);
      });
    },
    onExtractionSuccess: (listener: (payload: any) => void) => {
      window.api.ipc.on(IPC_CHANNELS.EVENT_EXTRACTION_SUCCESS, (_, data) => listener(data));
    },
    /** 移除素材提取完成事件监听 */
    offExtractionSuccess: () => {
      window.api.ipc.removeAllListeners(IPC_CHANNELS.EVENT_EXTRACTION_SUCCESS);
    },
    onMediaUpdated: (listener: (payload: any) => void) => {
      window.api.events.onMediaUpdated(listener);
    },
    /** V1.2: 批量队列进度推送 */
    onBatchProgress: (listener: (payload: any) => void) => {
      window.api.ipc.on(IPC_CHANNELS.BATCH_PROGRESS, (_, data) => listener(data));
    },
    offBatchProgress: () => {
      window.api.ipc.removeAllListeners(IPC_CHANNELS.BATCH_PROGRESS);
    },
    removeAll: () => {
      window.api.events.removeAll();
    }
  },

  /** V1.2: 批量队列管理域 */
  queue: {
    add: (payload: any) => invokeSafe(IPC_CHANNELS.BATCH_QUEUE_ADD, payload),
    start: () => invokeSafe(IPC_CHANNELS.BATCH_QUEUE_START),
    status: () => invokeSafe(IPC_CHANNELS.BATCH_QUEUE_STATUS),
    pause: () => invokeSafe(IPC_CHANNELS.BATCH_QUEUE_PAUSE),
    remove: (taskId: string) => invokeSafe(IPC_CHANNELS.BATCH_QUEUE_REMOVE, taskId),
    reorder: (taskIds: string[]) => invokeSafe(IPC_CHANNELS.BATCH_QUEUE_REORDER, taskIds),
    retry: (taskId: string) => invokeSafe(IPC_CHANNELS.BATCH_QUEUE_RETRY, taskId),
  },

  /** 用户体系域 */
  user: {
    /** 用户注册 */
    register: (username: string, password: string) =>
      invokeSafe<{ userId: string; token: string }>(IPC_CHANNELS.USER_REGISTER, username, password),
    /** 用户登录 */
    login: (username: string, password: string, rememberMe?: boolean) =>
      invokeSafe<{ userId: string; token: string }>(IPC_CHANNELS.USER_LOGIN, username, password, rememberMe ?? false),
    /** 用户登出 */
    logout: (token: string) =>
      invokeSafe<boolean>(IPC_CHANNELS.USER_LOGOUT, token),
    /** 获取用户信息 */
    getProfile: (userId: string) =>
      invokeSafe<any>(IPC_CHANNELS.USER_GET_PROFILE, userId),
    /** 更新用户资料 */
    updateProfile: (userId: string, data: { avatar?: string }) =>
      invokeSafe<any>(IPC_CHANNELS.USER_UPDATE_PROFILE, userId, data),
    /** 修改密码 */
    changePassword: (userId: string, oldPassword: string, newPassword: string) =>
      invokeSafe<boolean>(IPC_CHANNELS.USER_CHANGE_PASSWORD, userId, oldPassword, newPassword),
    /** 检查登录状态 */
    checkSession: (token: string) =>
      invokeSafe<{ valid: boolean; userId?: string }>(IPC_CHANNELS.USER_CHECK_SESSION, token),
    /** VIP 激活码激活 */
    activateVip: (userId: string, code: string) =>
      invokeSafe<any>(IPC_CHANNELS.USER_ACTIVATE_VIP, userId, code),
    /** 获取 VIP 信息 */
    getVipInfo: (userId: string) =>
      invokeSafe<any>(IPC_CHANNELS.USER_GET_VIP_INFO, userId),
  },

  /** 模型管理域 */
  model: {
    /** 获取所有本地模型列表 */
    getList: () =>
      invokeSafe<any[]>(IPC_CHANNELS.MODEL_GET_LIST),
    /** 下载模型 */
    download: (modelId: string) =>
      invokeSafe<any>(IPC_CHANNELS.MODEL_DOWNLOAD, modelId),
    /** 卸载模型 */
    uninstall: (modelId: string) =>
      invokeSafe<boolean>(IPC_CHANNELS.MODEL_UNINSTALL, modelId),
    /** 检查模型更新 */
    checkUpdate: (modelId: string) =>
      invokeSafe<any>(IPC_CHANNELS.MODEL_CHECK_UPDATE, modelId),
    /** 更新模型 */
    update: (modelId: string) =>
      invokeSafe<any>(IPC_CHANNELS.MODEL_UPDATE, modelId),
    /** 设置模型存储路径 */
    setPath: (modelId: string, customPath: string) =>
      invokeSafe<boolean>(IPC_CHANNELS.MODEL_SET_PATH, modelId, customPath),
    /** 批量下载 */
    batchDownload: (modelIds: string[]) =>
      invokeSafe<any[]>(IPC_CHANNELS.MODEL_BATCH_DOWNLOAD, modelIds),
    /** 批量更新 */
    batchUpdate: (modelIds: string[]) =>
      invokeSafe<any[]>(IPC_CHANNELS.MODEL_BATCH_UPDATE, modelIds),
    /** 监听下载进度 */
    onDownloadProgress: (listener: (payload: { modelId: string; status: string; progress: number }) => void) => {
      window.api.ipc.on(IPC_CHANNELS.MODEL_DOWNLOAD_PROGRESS, (_, data) => listener(data));
    },
    /** 移除下载进度监听 */
    offDownloadProgress: () => {
      window.api.ipc.removeAllListeners(IPC_CHANNELS.MODEL_DOWNLOAD_PROGRESS);
    },
  },

  /** 管线模型映射域 */
  pipelineModel: {
    /** 获取管线节点模型映射 */
    getNodeModelConfig: (projectId: string) =>
      invokeSafe<any>(IPC_CHANNELS.PIPELINE_GET_NODE_MODEL_CONFIG, projectId),
    /** 设置某节点的模型映射 */
    setNodeModel: (projectId: string, nodeType: string, provider: string, modelName: string, customBaseUrl?: string) =>
      invokeSafe<any>(IPC_CHANNELS.PIPELINE_SET_NODE_MODEL, projectId, nodeType, provider, modelName, customBaseUrl),
    /** 重置为默认模型 */
    resetNodeModel: (projectId: string, nodeType: string) =>
      invokeSafe<any>(IPC_CHANNELS.PIPELINE_RESET_NODE_MODEL, projectId, nodeType),
    /** 测试节点模型连接 */
    testNodeModel: (nodeType: string, provider: string, modelName: string, apiKey: string) =>
      invokeSafe<any>(IPC_CHANNELS.PIPELINE_TEST_NODE_MODEL, nodeType, provider, modelName, apiKey),
  },

  /** 设置扩展域 */
  settingsExt: {
    /** 获取所有设置 */
    getAll: () =>
      invokeSafe<Record<string, any>>(IPC_CHANNELS.SETTINGS_GET_ALL),
    /** 批量获取指定键的设置 */
    getByKeys: (keys: string[]) =>
      invokeSafe<Record<string, any>>(IPC_CHANNELS.SETTINGS_GET_BY_KEYS, keys),
    /** 重置所有设置为默认值 */
    resetAll: () =>
      invokeSafe<boolean>(IPC_CHANNELS.SETTINGS_RESET_ALL),
    /** 验证路径有效性 */
    validatePath: (dirPath: string) =>
      invokeSafe<{ valid: boolean; exists: boolean; writable: boolean }>(IPC_CHANNELS.SETTINGS_VALIDATE_PATH, dirPath),
  },
};
