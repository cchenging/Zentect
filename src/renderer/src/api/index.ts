// 📁 路径: src/renderer/src/api/index.ts
import { IPC_CHANNELS } from '@modules/infra/ipc/IpcConstants';
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
    /** 🔧 V7 新增：获取数据库详情（路径/大小/版本/表列表） */
    getDbDetail: () => invokeSafe<{
      path: string;
      sizeBytes: number;
      journalMode: string;
      sqliteVersion: string;
      tables: Array<{ name: string; rowCount: number }>;
    }>(IPC_CHANNELS.SYSTEM_GET_DB_DETAIL),
    /** 🔧 V8 新增：触发 pip install 安装缺失依赖（返回 task_id，进度通过 onInstallDepProgress 监听） */
    installDep: (packages: string[]) => invokeSafe<{ success: boolean; task_id?: string; message?: string }>(
      IPC_CHANNELS.SYSTEM_INSTALL_DEP, packages
    ),
    /** 🔧 V8 新增：安装依赖后重启 AI 运行时（stop + start，让新装的 Python 包生效） */
    restartAiRuntime: () => invokeSafe<{ success: boolean; message: string }>(
      IPC_CHANNELS.SYSTEM_AI_RUNTIME_RESTART
    ),
    /** 🔧 V8 新增：注册安装进度监听器（主进程通过 IPC event 推送进度） */
    onInstallDepProgress: (callback: (progress: any) => void) => {
      // 通过 preload 暴露的 window.api.ipc 订阅 IPC 事件（window.electron 运行时不存在）
      const handler = (_event: any, progress: any) => callback(progress);
      window.api.ipc.on(IPC_CHANNELS.SYSTEM_INSTALL_DEP_PROGRESS, handler);
      return () => window.api.ipc.removeListener(IPC_CHANNELS.SYSTEM_INSTALL_DEP_PROGRESS, handler);
    },

    /** 🚀 阶段 3 新增：查询 GPU/CUDA 状态 */
    getGpuStatus: () => invokeSafe<any>(IPC_CHANNELS.SYSTEM_GPU_STATUS),

    /** 🚀 阶段 3 新增：触发 CUDA 版 torch 安装（返回 task_id，进度通过 onGpuInstallProgress 监听） */
    installCudaTorch: () => invokeSafe<{ success: boolean; task_id?: string; message?: string }>(
      IPC_CHANNELS.SYSTEM_GPU_INSTALL_CUDA
    ),

    /** 🚀 阶段 3 新增：注册 CUDA 安装进度监听器 */
    onGpuInstallProgress: (callback: (progress: any) => void) => {
      // 通过 preload 暴露的 window.api.ipc 订阅 IPC 事件（window.electron 运行时不存在）
      const handler = (_event: any, progress: any) => callback(progress);
      window.api.ipc.on(IPC_CHANNELS.SYSTEM_GPU_INSTALL_PROGRESS, handler);
      return () => window.api.ipc.removeListener(IPC_CHANNELS.SYSTEM_GPU_INSTALL_PROGRESS, handler);
    },
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
    // 检查 Python 依赖安装状态（返回 { deps, modules, python_executable } 或 null）
    // V7 modules 字段：torch/demucs/mdx_net/whisper/sensevoice/insightface/clip 7 个引擎的 ready 状态
    checkDeps: () => invokeSafe<{
      deps: Record<string, { installed: boolean; version: string | null; display_name: string }>;
      modules: Record<string, {
        ready: boolean;
        missing: string[];
        display_name: string;
        size?: string;
        shared_by?: string[];
        needs?: string[];
      }>;
      python_executable: string;
    } | null>(IPC_CHANNELS.AI_CHECK_DEPS),
    emotionSingle: (data: any) => invokeSafe(IPC_CHANNELS.AI_EMOTION_SINGLE, data),
    generateAiScript: (data: any) => invokeSafe(IPC_CHANNELS.AI_GENERATE_SCRIPT, data),
    streamText: (payload: any) => window.api.ai.streamText(payload),
    searchSemantics: (mediaId: string, query: string) => invokeSafe(IPC_CHANNELS.AI_SEARCH_SEMANTICS, mediaId, query),
    // 🔧 修复 TS2339：usePipelineOrchestrator 调用 visionExtract
    visionExtract: (projectId: string, filePath: string, mediaId: string, existingFrames?: string[]) =>
      invokeSafe(IPC_CHANNELS.AI_VISION_SINGLE, { projectId, filePath, mediaId, existingFrames }),
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
    /** 订阅导出进度（EXPORT_PROGRESS 通道），返回取消订阅函数 */
    onProgress: (listener: (p: { projectId: string; percent: number; step: string }) => void) => {
      const handler = (_: unknown, data: any) => listener(data);
      window.api.ipc.on(IPC_CHANNELS.EXPORT_PROGRESS, handler);
      return () => window.api.ipc.removeListener(IPC_CHANNELS.EXPORT_PROGRESS, handler);
    },
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
    create: (payload?: { name?: string, type?: string, workflowData?: any }) => invokeSafe(IPC_CHANNELS.PROJECT_CREATE, payload),
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
    /** 🎭 P0.5+ 更新角色信息（名称/代词/描述/头像/tier 分级） */
    update: (id: string, fields: { name?: string; pronoun?: string; description?: string; avatar?: string; tier?: 'main' | 'supporting' | 'extra' }) =>
      invokeSafe(IPC_CHANNELS.ROLE_UPDATE, { id, fields }),
    /** 🎭 P0.5+ 合并角色：source 合并到 target */
    merge: (sourceRoleId: string, targetRoleId: string, projectId: string) =>
      invokeSafe(IPC_CHANNELS.ROLE_MERGE, { sourceRoleId, targetRoleId, projectId }),
    /** 🎭 P0.5+ 拆分角色：从 target 恢复 source 为独立角色 */
    unmerge: (sourceRoleId: string, targetRoleId: string) =>
      invokeSafe(IPC_CHANNELS.ROLE_UNMERGE, { sourceRoleId, targetRoleId }),
    /** 🎭 P0.5+ 删除角色 */
    delete: (id: string, projectId: string) =>
      invokeSafe(IPC_CHANNELS.ROLE_DELETE, { id, projectId }),
  },
  /** 🎭 P1 全局人物注册中心（跨集/跨项目人物复用） */
  globalCharacters: {
    /** 列出所有全局人物（按出现次数降序） */
    list: () =>
      invokeSafe(IPC_CHANNELS.GLOBAL_CHARACTER_LIST),
    /** 更新全局人物信息（名称/头像/音色/代词/描述） */
    update: (id: string, fields: { name?: string; avatar?: string; voiceId?: string; pronoun?: string; description?: string }) =>
      invokeSafe(IPC_CHANNELS.GLOBAL_CHARACTER_UPDATE, { id, fields }),
    /** 删除全局人物（同时解绑所有本地角色） */
    delete: (id: string) =>
      invokeSafe<{ success: boolean; unbindCount: number }>(IPC_CHANNELS.GLOBAL_CHARACTER_DELETE, { id }),
    /** 绑定本地角色到全局人物 */
    bind: (roleId: string, globalCharacterId: string) =>
      invokeSafe(IPC_CHANNELS.GLOBAL_CHARACTER_BIND, { roleId, globalCharacterId }),
    /** 解绑本地角色的全局人物关联 */
    unbind: (roleId: string) =>
      invokeSafe(IPC_CHANNELS.GLOBAL_CHARACTER_UNBIND, { roleId }),
    /** 查询全局人物关联的所有本地角色（跨项目） */
    findLocalRoles: (globalCharacterId: string) =>
      invokeSafe(IPC_CHANNELS.GLOBAL_CHARACTER_FIND_LOCAL_ROLES, { globalCharacterId }),
  },
  /** 🎬 P2-A 剧集语义层（跨集项目组织） */
  shows: {
    /** 列出所有剧集（按更新时间降序） */
    list: () =>
      invokeSafe(IPC_CHANNELS.SHOW_LIST),
    /** 创建新剧集 */
    create: (name: string, options?: { coverPath?: string; description?: string }) =>
      invokeSafe(IPC_CHANNELS.SHOW_CREATE, { name, ...options }),
    /** 更新剧集信息（名称/封面/描述） */
    update: (id: string, fields: { name?: string; coverPath?: string; description?: string }) =>
      invokeSafe(IPC_CHANNELS.SHOW_UPDATE, { id, fields }),
    /** 删除剧集（同时解绑其下所有项目） */
    delete: (id: string) =>
      invokeSafe<{ success: boolean; unbindCount: number }>(IPC_CHANNELS.SHOW_DELETE, { id }),
    /** 查询某剧集下所有项目（按集数升序） */
    findProjects: (showId: string) =>
      invokeSafe(IPC_CHANNELS.SHOW_FIND_PROJECTS, { showId }),
    /** 把项目绑定到剧集（episodeNumber 省略时自动递增） */
    bindProject: (projectId: string, showId: string, episodeNumber?: number) =>
      invokeSafe(IPC_CHANNELS.SHOW_BIND_PROJECT, { projectId, showId, episodeNumber }),
    /** 解除项目与剧集的绑定 */
    unbindProject: (projectId: string) =>
      invokeSafe(IPC_CHANNELS.SHOW_UNBIND_PROJECT, { projectId }),
  },
  voice: {
    preview: (provider: string, voiceId?: string, text?: string, rate?: number) =>
      invokeSafe<{ audioPath: string }>(IPC_CHANNELS.VOICE_PREVIEW, { provider, voiceId, text, rate }),
    listByEngine: (engine: string) =>
      invokeSafe(IPC_CHANNELS.VOICE_LIST_BY_ENGINE, engine),
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
    // 🔧 V7 新增：功能模块化接口
    /** 获取功能模块列表（7 张卡片，含模型文件 + 运行时状态） */
    getModuleList: () =>
      invokeSafe<any[]>(IPC_CHANNELS.MODEL_GET_MODULE_LIST),
    /** 获取 4 个分类定义（供 Chip 菜单） */
    getCategories: () =>
      invokeSafe<any[]>(IPC_CHANNELS.MODEL_GET_CATEGORIES),
    /** 导入本地模型文件（用户离线补模型，后端弹 dialog 选文件） */
    importFile: (modelId: string) =>
      invokeSafe<any>(IPC_CHANNELS.MODEL_IMPORT_FILE, modelId),
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
