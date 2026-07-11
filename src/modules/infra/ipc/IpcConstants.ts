// 📁 路径: src/shared/utils/IpcConstants.ts
// 💥 统一管理：全站 IPC 通信频道唯一真相源 (SSOT)

export const IPC_CHANNELS = {
  // --- 系统与通用 ---
  SYSTEM_GET_PATHS: 'system:getPaths',
  SYSTEM_RESIZE: 'system:resize-window',
  SYSTEM_CLOSE: 'window-close',
  SYSTEM_MINIMIZE: 'window-minimize',
  SYSTEM_MAXIMIZE: 'window-maximize',
  SYSTEM_SETTING_GET: 'settings:get',
  SYSTEM_SETTING_SET: 'settings:set',
  SYSTEM_OPEN_DIR: 'dialog:openDirectory',
  SYSTEM_OPEN_MEDIA: 'dialog:openMedia',

  // --- 窗口控制 (main process native window buttons) ---
  WINDOW_SWITCH_VIEW: 'switch-view',
  WINDOW_MINIMIZE: 'window-minimize',
  WINDOW_MAXIMIZE: 'window-maximize',
  WINDOW_CLOSE: 'window-close',
  APP_READY: 'app-is-ready',

  // --- 媒体管理 ---
  MEDIA_IMPORT: 'media:import',
  MEDIA_UPDATE: 'media:update',
  MEDIA_PROCESS: 'media:process',
  MEDIA_EXTRACT_FRAMES: 'media:extractFrames',
  MEDIA_CANCEL: 'media:cancelProcess',
  MEDIA_DELETE: 'media:delete',
  MEDIA_GET_BY_PROJECT: 'media:getByProject',

  // --- 管线引擎 ---
  ENGINE_RUN_PIPELINE: 'engine:run-pipeline',
  ENGINE_RUN_V1_PIPELINE: 'engine:run-v1-pipeline',
  ENGINE_PIPELINE_PROGRESS: 'engine:pipeline-progress',
  ENGINE_ABORT_PIPELINE: 'engine:abort-pipeline',
  ENGINE_PREFLIGHT: 'engine:preflight',
  ENGINE_REQUIRE_USER_ACTION: 'engine:require-user-action',
  ENGINE_RESUME_PIPELINE: 'engine:resume-pipeline',
  PIPELINE_RUN: 'pipeline:run',           // legacy alias
  PIPELINE_STOP: 'pipeline:stop',         // legacy alias
  PIPELINE_PROBE_CACHE: 'pipeline:probe-cache',
  PIPELINE_PROBE_RECOVERY: 'pipeline:probe-recovery',
  PIPELINE_RECOVERY_CONTINUE: 'pipeline:recovery-continue',
  PIPELINE_RECOVERY_ABANDON: 'pipeline:recovery-abandon',

  // --- 项目域 ---
  PROJECT_GET_BY_ID: 'project:get-by-id',
  PROJECT_LOAD_DATA: 'project:load-data',
  PROJECT_SAVE_DATA: 'project:save-data',
  PROJECT_CREATE: 'project:create',
  PROJECT_GET_RECENT: 'project:getRecent',
  PROJECT_GET_LIST: 'project:getList',
  PROJECT_DELETE: 'project:delete',
  PROJECT_RENAME: 'project:rename',
  PROJECT_DUPLICATE: 'project:duplicate',
  PROJECT_INSTANTIATE: 'project:instantiate',
  PROJECT_SAVE_CANVAS: 'project:save-canvas',
  PROJECT_UPDATE_SCRIPT_DELTA: 'project:update-script-delta',
  PROJECT_EXPORT: 'project:export',

  // --- 草稿自动保存 ---
  DRAFT_SHADOW_SAVE: 'draft:shadow-save',
  DRAFT_SHADOW_FLUSH: 'draft:shadow-flush',
  DRAFT_SYNC_TO_MAIN: 'draft:sync-to-main',

  // --- 系统与设置域 ---
  SETTINGS_GET: 'settings:get',                // alias of SYSTEM_SETTING_GET
  SETTINGS_SET: 'settings:set',                // alias of SYSTEM_SETTING_SET
  SYSTEM_GET_SETTINGS: 'system:getSettings',
  SYSTEM_SAVE_SETTINGS: 'system:saveSettings',
  SYSTEM_TEST_LLM: 'system:testLLM',
  SYSTEM_MIGRATE: 'system:migrateProjects',
  SYSTEM_LOG: 'system:log',

  // --- 任务调度域 ---
  TASK_GET_ALL: 'task:getAll',
  TASK_GET_ACTIVE: 'jobs:getActiveTasks',
  TASK_CANCEL: 'jobs:cancel',
  GET_NODE_OUTPUT: 'task:get-node-output',

  // --- AI 算力域 ---
  AI_TEST_NETWORK: 'ai:testNetwork',
  AI_TEST_TTS: 'ai:testTTS',
  AI_CHAT: 'ai:chat',
  AI_CHAT_STREAM: 'ai:chat-stream',
  AI_SCRIPT_PROGRESS: 'ai:script-progress',
  AI_GET_HISTORY: 'ai:get-history',
  AI_GENERATE_TTS: 'ai:generateTTS',
  AI_RUN_SINGLE_TTS: 'ai:runSingleTTS',
  AI_RUN_GLOBAL_TTS: 'ai:runGlobalTTS',
  AI_VISION_SINGLE: 'ai:visionSingle',
  AI_EMOTION_SINGLE: 'ai:emotionSingle',
  AI_GENERATE_SCRIPT: 'ai:generateAiScript',
  AI_STREAM_TEXT: 'ai:streamText',
  AI_SEARCH_SEMANTICS: 'ai:searchSemantics',
  AI_CHAT_REQUEST: 'ai:chatRequest',
  AI_SEARCH_BROLL: 'ai:searchBroll',
  AI_ISOLATE_VOCALS: 'ai:isolateVocals',
  AI_EXTRACT_FRAMES: 'ai:extractFrames',

  // --- AI 智能体流式域 ---
  AGENT_CHAT_INVOKE: 'agent:chatInvoke',
  AGENT_STREAM_START: 'agent:streamStart',
  AGENT_STREAM_CHUNK: 'agent:streamChunk',
  AGENT_TOOL_CALL: 'agent:toolCall',
  AGENT_STREAM_DONE: 'agent:streamDone',
  AGENT_STREAM_ERROR: 'agent:streamError',
  AGENT_GET_HISTORY: 'agent:getHistory',
  AGENT_MARK_EXECUTED: 'agent:markExecuted',

  // --- 导出域 ---
  EXPORT_VIDEO: 'export:video',
  EXPORT_JIANYING: 'export:jianying',          // legacy
  EXPORT_LOCAL_VIDEO: 'export:video',          // alias of EXPORT_VIDEO
  EXPORT_MP4_RENDER: 'export:mp4Render',       // V1.2 FFmpeg 渲染
  EXPORT_PUBLISH_PACKAGE: 'export:publishPackage', // V1.2 发布素材包
  EXPORT_SUBTITLE: 'export:subtitle',             // 字幕文件导出 (SRT/ASS)
  EXPORT_TXT: 'export:txt',                       // 文案 TXT 导出
  EXPORT_PROGRESS: 'export:progress',

  // --- 后端向前端的主动推送 ---
  EVENT_TASK_PROGRESS: 'task:progress',
  EVENT_TASK_COMPLETED: 'task:completed',
  EVENT_APP_NOTIFY: 'app:notify',
  EVENT_EXTRACTION_SUCCESS: 'event:extraction-success',
  EVENT_MEDIA_UPDATED: 'event:media-updated',
  EVENT_NODE_STATE_CHANGE: 'event:node-state-change',

  // 💥 断层3+4修复：管线错误与流式安全数据推送通道
  EVENT_PIPELINE_ERROR: 'event:pipeline-error',
  EVENT_STREAM_SAFE_CHUNK: 'event:stream-safe-chunk',
  // 故事板卡片精准流式推送通道
  EVENT_STREAM_TO_SHOT_CARD: 'event:stream-to-shot-card',

  // V1.0: 文件系统
  SYSTEM_OPEN_PATH: 'system:open-path',
  SYSTEM_OPEN_FILE: 'dialog:openFile',
  SYSTEM_READ_FILE: 'system:readFile',

  // --- V1.1 工作流持久化 ---
  WORKFLOW_SAVE: 'workflow:save',
  WORKFLOW_LOAD: 'workflow:load',
  ENGINE_RUN_DAG_WORKFLOW: 'engine:run-dag-workflow',

  // --- V1.1 Pipeline 参数 ---
  PIPELINE_UPDATE_PARAMS: 'pipeline:updateParams',

  // --- V1.1 License 校验 ---
  LICENSE_VALIDATE: 'license:validate',
  LICENSE_STATUS: 'license:status',

  // --- V1.1 角色音色管理 ---
  ROLE_LIST: 'role:list',
  ROLE_UPDATE_VOICE: 'role:updateVoice',
  VOICE_PREVIEW: 'voice:preview',
  VOICE_LIST_BY_ENGINE: 'voice:listByEngine',

  // --- 反馈与通知总成 (Phase 8) ---
  FEEDBACK_TOAST: 'feedback:toast',
  FEEDBACK_MODAL: 'feedback:modal',
  FEEDBACK_INLINE: 'feedback:inline',
  FEEDBACK_GET: 'feedback:get',
  FEEDBACK_CLEAR: 'feedback:clear',

  // --- 用户体系域 ---
  USER_REGISTER: 'user:register',
  USER_LOGIN: 'user:login',
  USER_LOGOUT: 'user:logout',
  USER_GET_PROFILE: 'user:getProfile',
  USER_UPDATE_PROFILE: 'user:updateProfile',
  USER_CHANGE_PASSWORD: 'user:changePassword',
  USER_CHECK_SESSION: 'user:checkSession',
  USER_ACTIVATE_VIP: 'user:activateVip',
  USER_GET_VIP_INFO: 'user:getVipInfo',

  // --- 模型管理域 ---
  MODEL_GET_LIST: 'model:getList',
  MODEL_DOWNLOAD: 'model:download',
  MODEL_DOWNLOAD_PROGRESS: 'model:downloadProgress',
  MODEL_UNINSTALL: 'model:uninstall',
  MODEL_CHECK_UPDATE: 'model:checkUpdate',
  MODEL_UPDATE: 'model:update',
  MODEL_SET_PATH: 'model:setPath',
  MODEL_BATCH_DOWNLOAD: 'model:batchDownload',
  MODEL_BATCH_UPDATE: 'model:batchUpdate',

  // --- 管线模型映射域 ---
  PIPELINE_GET_NODE_MODEL_CONFIG: 'pipeline:getNodeModelConfig',
  PIPELINE_SET_NODE_MODEL: 'pipeline:setNodeModel',
  PIPELINE_RESET_NODE_MODEL: 'pipeline:resetNodeModel',
  PIPELINE_TEST_NODE_MODEL: 'pipeline:testNodeModel',

  // --- 设置扩展域 ---
  SETTINGS_GET_ALL: 'settings:getAll',
  SETTINGS_GET_BY_KEYS: 'settings:getByKeys',
  SETTINGS_RESET_ALL: 'settings:resetAll',
  SETTINGS_VALIDATE_PATH: 'settings:validatePath',

  // --- V1.2 批量队列与出片 ---
  BATCH_QUEUE_ADD: 'batch:queueAdd',            // 批量添加渲染任务
  BATCH_QUEUE_START: 'batch:queueStart',        // 启动队列引擎
  BATCH_QUEUE_STATUS: 'batch:queueStatus',      // 查询队列状态
  BATCH_QUEUE_PAUSE: 'batch:queuePause',        // 暂停队列
  BATCH_QUEUE_REMOVE: 'batch:queueRemove',      // 移除单个任务
  BATCH_QUEUE_REORDER: 'batch:queueReorder',    // 重排任务顺序
  BATCH_QUEUE_RETRY: 'batch:queueRetry',        // 失败重试
  BATCH_PROGRESS: 'batch:progress',             // 推送队列进度

  // --- API Profiles (多 API 配置) ---
  API_PROFILE_GET_ALL: 'apiProfile:getAll',
  API_PROFILE_GET_BY_PROVIDER: 'apiProfile:getByProvider',
  API_PROFILE_CREATE: 'apiProfile:create',
  API_PROFILE_UPDATE: 'apiProfile:update',
  API_PROFILE_DELETE: 'apiProfile:delete',
  API_PROFILE_ACTIVATE: 'apiProfile:activate',
  BINDING_GET_ALL: 'profileBinding:getAll',
  BINDING_GET_BY_TASK: 'profileBinding:getByTask',
  BINDING_UPSERT: 'profileBinding:upsert',
} as const;
