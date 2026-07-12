// 📁 路径：src/preload/index.ts
import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../modules/infra/ipc/IpcConstants';

// =========================================================================
// 💥 绝对防线：隔离 C++ 引擎与 JS 的类型转换崩溃！
// =========================================================================
const safeInvoke = (channel: string | undefined, ...args: any[]) => {
  if (!channel) {
    console.error(`🚨 [Preload Invoke 拦截] 试图呼叫空信道 (undefined)，可能由于常量缓存未清空！`);
    return Promise.reject(new Error('IPC Channel is undefined'));
  }
  return ipcRenderer.invoke(channel, ...args);
};

const safeSend = (channel: string | undefined, ...args: any[]) => {
  if (!channel) {
    console.error(`🚨 [Preload Send 拦截] 试图发送空信道 (undefined)!`);
    return;
  }
  ipcRenderer.send(channel, ...args);
};

const safeOn = (channel: string | undefined, callback: (...args: any[]) => void) => {
  if (!channel) {
    console.error(`🚨 [Preload On 拦截] 试图监听空信道 (undefined)!`);
    return;
  }
  ipcRenderer.on(channel, callback);
};

const safeRemoveAllListeners = (channel: string | undefined) => {
  if (!channel) {
    console.error(`🚨 [Preload Remove 拦截] 试图移除空信道 (undefined)! 拦截成功，防止了白屏崩溃。`);
    return;
  }
  ipcRenderer.removeAllListeners(channel);
};
// =========================================================================

const api = {
  project: {
    getById: (id: string) => safeInvoke(IPC_CHANNELS.PROJECT_GET_BY_ID, id),
    loadData: (id: string) => safeInvoke(IPC_CHANNELS.PROJECT_LOAD_DATA, id),
    saveData: (id: string, data: any) => safeInvoke(IPC_CHANNELS.PROJECT_SAVE_DATA, id, data),
    getRecent: () => safeInvoke(IPC_CHANNELS.PROJECT_GET_RECENT),
    getList: () => safeInvoke(IPC_CHANNELS.PROJECT_GET_LIST),
    create: (payload?: { name?: string, type?: string }) => safeInvoke(IPC_CHANNELS.PROJECT_CREATE, payload),
    delete: (id: string) => safeInvoke(IPC_CHANNELS.PROJECT_DELETE, id),
    rename: (id: string, newName: string) => safeInvoke(IPC_CHANNELS.PROJECT_RENAME, id, newName),
    duplicate: (id: string) => safeInvoke(IPC_CHANNELS.PROJECT_DUPLICATE, id),
  },
  media: {
    import: (projectId: string, files: string[]) => safeInvoke(IPC_CHANNELS.MEDIA_IMPORT, projectId, files),
    process: (projectId: string, activeMedia: any, config: any) => safeInvoke(IPC_CHANNELS.MEDIA_PROCESS, projectId, activeMedia, config),
    cancelProcess: (mediaId: string) => safeInvoke(IPC_CHANNELS.MEDIA_CANCEL, mediaId),
    delete: (projectId: string, mediaId: string) => safeInvoke(IPC_CHANNELS.MEDIA_DELETE, projectId, mediaId),
  },
  system: {
    getSetting: (key: string, defaultVal?: any) => safeInvoke(IPC_CHANNELS.SETTINGS_GET, key, defaultVal),
    setSetting: (key: string, value: any) => safeInvoke(IPC_CHANNELS.SETTINGS_SET, key, value),
    getPaths: () => safeInvoke(IPC_CHANNELS.SYSTEM_GET_PATHS),
    migrateProjects: (oldPath: string, newPath: string) => safeInvoke(IPC_CHANNELS.SYSTEM_MIGRATE, oldPath, newPath),
    openDirectory: () => safeInvoke(IPC_CHANNELS.SYSTEM_OPEN_DIR),
    openMediaDialog: () => safeInvoke(IPC_CHANNELS.SYSTEM_OPEN_MEDIA),
    switchView: (viewName: string) => safeSend(IPC_CHANNELS.WINDOW_SWITCH_VIEW, viewName),
    minimize: () => safeSend(IPC_CHANNELS.WINDOW_MINIMIZE),
    maximize: () => safeSend(IPC_CHANNELS.WINDOW_MAXIMIZE),
    close: () => safeSend(IPC_CHANNELS.WINDOW_CLOSE),
    appIsReady: () => safeSend(IPC_CHANNELS.APP_READY),
    log: (payload: any) => safeSend(IPC_CHANNELS.SYSTEM_LOG, payload),
  },
  tasks: {
    getAll: (projectId: string) => safeInvoke(IPC_CHANNELS.TASK_GET_ALL, projectId),
    getActive: (projectId: string) => safeInvoke(IPC_CHANNELS.TASK_GET_ACTIVE, projectId),
    cancel: (taskId: string) => safeInvoke(IPC_CHANNELS.TASK_CANCEL, taskId),
  },
  ai: {
    generateTTS: (text: string, roleId: string) => safeInvoke(IPC_CHANNELS.AI_GENERATE_TTS, text, roleId),
    testNetwork: (type: string, config: any) => safeInvoke(IPC_CHANNELS.AI_TEST_NETWORK, type, config),
    testTTS: (provider: string) => safeInvoke(IPC_CHANNELS.AI_TEST_TTS, provider),
    runSingleTTS: (projectId: string, shot: any) => safeInvoke(IPC_CHANNELS.AI_RUN_SINGLE_TTS, projectId, shot),
    runGlobalTTS: (projectId: string, shots: any[]) => safeInvoke(IPC_CHANNELS.AI_RUN_GLOBAL_TTS, projectId, shots),
    visionSingle: (data: any) => safeInvoke(IPC_CHANNELS.AI_VISION_SINGLE, data),
    emotionSingle: (data: any) => safeInvoke(IPC_CHANNELS.AI_EMOTION_SINGLE, data),
    generateAiScript: (data: any) => safeInvoke(IPC_CHANNELS.AI_GENERATE_SCRIPT, data),
    streamText: (payload: any) => safeSend(IPC_CHANNELS.AI_STREAM_TEXT, payload),
  },
  export: {
    jianying: (payload: any) => safeInvoke(IPC_CHANNELS.EXPORT_JIANYING, payload),
    localVideo: (payload: any) => safeInvoke(IPC_CHANNELS.EXPORT_LOCAL_VIDEO, payload)
  },
  
  // 💥 完全重写事件机制：引入安全防御
  events: {
    onTaskProgress: (callback: (...args: any[]) => void) => {
      safeOn(IPC_CHANNELS.EVENT_TASK_PROGRESS, (_event, ...args) => callback(...args));
    },
    onTaskCompleted: (callback: (...args: any[]) => void) => {
      safeOn(IPC_CHANNELS.EVENT_TASK_COMPLETED, (_event, ...args) => callback(...args));
    },
    onAppNotify: (callback: (...args: any[]) => void) => {
      safeOn(IPC_CHANNELS.EVENT_APP_NOTIFY, (_event, ...args) => callback(...args));
    },
    onExtractionSuccess: (callback: (payload: any) => void) => {
      safeOn(IPC_CHANNELS.EVENT_EXTRACTION_SUCCESS, (_event, payload) => callback(payload));
    },
    onMediaUpdated: (callback: (payload: any) => void) => {
      safeOn(IPC_CHANNELS.EVENT_MEDIA_UPDATED, (_event, payload) => callback(payload));
    },
    removeAll: () => {
      safeRemoveAllListeners(IPC_CHANNELS.EVENT_TASK_PROGRESS);
      safeRemoveAllListeners(IPC_CHANNELS.EVENT_TASK_COMPLETED);
      safeRemoveAllListeners(IPC_CHANNELS.EVENT_APP_NOTIFY);
      safeRemoveAllListeners(IPC_CHANNELS.EVENT_EXTRACTION_SUCCESS);
      safeRemoveAllListeners(IPC_CHANNELS.EVENT_MEDIA_UPDATED);
    }
  },
  
  invoke: (channel: string, ...args: any[]) => safeInvoke(channel, ...args),
  
  invokeAgentChat: (payload: any) => safeInvoke(IPC_CHANNELS.AGENT_CHAT_INVOKE, payload),
  getAgentHistory: (projectId: string) => safeInvoke(IPC_CHANNELS.AGENT_GET_HISTORY, projectId),
  markAgentActionExecuted: (msgId: string) => safeInvoke(IPC_CHANNELS.AGENT_MARK_EXECUTED, msgId),
  
  onAgentStreamStart: (callback: () => void) => safeOn(IPC_CHANNELS.AGENT_STREAM_START, () => callback()),
  onAgentStreamChunk: (callback: (chunk: string) => void) => safeOn(IPC_CHANNELS.AGENT_STREAM_CHUNK, (_event, chunk) => callback(chunk)),
  onAgentToolCall: (callback: (toolAction: any) => void) => safeOn(IPC_CHANNELS.AGENT_TOOL_CALL, (_event, action) => callback(action)),
  onAgentStreamDone: (callback: () => void) => safeOn(IPC_CHANNELS.AGENT_STREAM_DONE, () => callback()),
  onAgentStreamError: (callback: (errorMsg: string) => void) => safeOn(IPC_CHANNELS.AGENT_STREAM_ERROR, (_event, error) => callback(error)),
  
  removeAllAgentListeners: () => {
    safeRemoveAllListeners(IPC_CHANNELS.AGENT_STREAM_START);
    safeRemoveAllListeners(IPC_CHANNELS.AGENT_STREAM_CHUNK);
    safeRemoveAllListeners(IPC_CHANNELS.AGENT_TOOL_CALL);
    safeRemoveAllListeners(IPC_CHANNELS.AGENT_STREAM_DONE);
    safeRemoveAllListeners(IPC_CHANNELS.AGENT_STREAM_ERROR);
  },

  ipc: {
    invoke: safeInvoke,
    send: safeSend,
    on: safeOn,
    removeListener: (channel: string | undefined, callback: (...args: any[]) => void) => {
      if (!channel) return;
      ipcRenderer.removeListener(channel, callback);
    },
    removeAllListeners: safeRemoveAllListeners,
  },

  profileBinding: {
    getAll: () => safeInvoke(IPC_CHANNELS.BINDING_GET_ALL),
    getByTask: (taskType: string) => safeInvoke(IPC_CHANNELS.BINDING_GET_BY_TASK, taskType),
    upsert: (taskType: string, profileId: string | null, modelName: string) => safeInvoke(IPC_CHANNELS.BINDING_UPSERT, taskType, profileId, modelName),
  },
  apiProfile: {
    getAll: () => safeInvoke(IPC_CHANNELS.API_PROFILE_GET_ALL),
    getByProvider: (provider: string) => safeInvoke(IPC_CHANNELS.API_PROFILE_GET_BY_PROVIDER, provider),
    create: (profile: any) => safeInvoke(IPC_CHANNELS.API_PROFILE_CREATE, profile),
    update: (id: string, patch: any) => safeInvoke(IPC_CHANNELS.API_PROFILE_UPDATE, id, patch),
    delete: (id: string) => safeInvoke(IPC_CHANNELS.API_PROFILE_DELETE, id),
    activate: (id: string, provider: string) => safeInvoke(IPC_CHANNELS.API_PROFILE_ACTIVATE, id, provider),
  },
  versions: process.versions,
}

// 通过 contextBridge 暴露类型安全的 API 给渲染进程
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api);
  } catch (error) { console.error(error) }
} else {
  // 非 contextIsolated 模式的降级路径
  (window as unknown as Record<string, unknown>).api = api;
}
