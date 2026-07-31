/// <reference types="vite/client" />

/**
 * Preload 暴露的 IPC API 类型声明
 * 对应 src/preload/index.ts 中 contextBridge.exposeInMainWorld('api', api) 的结构
 */
interface WindowApi {
  ipc: {
    invoke: (channel: string, ...args: any[]) => Promise<any>;
    send: (channel: string, ...args: any[]) => void;
    on: (channel: string, callback: (...args: any[]) => void) => void;
    removeListener: (channel: string, callback: (...args: any[]) => void) => void;
    removeAllListeners: (channel: string) => void;
  };
  system: {
    getSetting: (key: string, defaultVal?: any) => Promise<any>;
    setSetting: (key: string, value: any) => Promise<any>;
    getPaths: () => Promise<{ projects: string; exports: string }>;
    migrateProjects: (oldPath: string, newPath: string) => Promise<any>;
    openDirectory: () => Promise<string | null>;
    openMediaDialog: () => Promise<string[]>;
    switchView: (viewName: string) => void;
    minimize: () => void;
    maximize: () => void;
    close: () => void;
    appIsReady: () => void;
    log: (payload: any) => void;
  };
  ai: {
    streamText: (payload: any) => void;
    // 🔧 修复：连接测试实际调用 ai.testNetwork（preload 已暴露），非 testAIConnection
    testNetwork: (type: string, config: any) => Promise<string>;
    // 拉取账户可用模型列表（OpenAI 兼容 /models 接口），返回 IpcResponse<string[]>
    fetchModels: (config: { provider?: string; apiKey: string; baseURL: string }) => Promise<string[]>;
    generateTTS: (text: string, roleId: string) => Promise<any>;
    testTTS: (provider: string) => Promise<any>;
    visionSingle: (data: any) => Promise<any>;
    emotionSingle: (data: any) => Promise<any>;
    generateAiScript: (data: any) => Promise<any>;
    runSingleTTS: (projectId: string, shot: any) => Promise<any>;
    runGlobalTTS: (projectId: string, shots: any[]) => Promise<any>;
  };
  events: {
    onTaskProgress: (handler: (...args: any[]) => void) => void;
    onTaskCompleted: (handler: (...args: any[]) => void) => void;
    onAppNotify: (handler: (...args: any[]) => void) => void;
    onExtractionSuccess: (handler: (payload: any) => void) => void;
    onMediaUpdated: (handler: (payload: any) => void) => void;
    removeAll: () => void;
  };
  invoke: (channel: string, ...args: any[]) => Promise<any>;  profileBinding: {
    getAll: () => Promise<any[]>;
    getByTask: (taskType: string) => Promise<any>;
    upsert: (taskType: string, profileId: string | null, modelName: string) => Promise<void>;
    // 🔧 修复 Bug3：清理指定 Profile 的所有绑定
    clearByProfileId: (profileId: string) => Promise<number>;
    // 初始化配置：清理所有无效绑定，返回删除行数
    cleanupInvalid: () => Promise<number>;
  };
  apiProfile: {
    getAll: () => Promise<any[]>;
    getByProvider: (provider: string) => Promise<any[]>;
    create: (profile: any) => Promise<any>;
    update: (id: string, patch: any) => Promise<boolean>;
    delete: (id: string) => Promise<boolean>;
    activate: (id: string, provider: string) => Promise<boolean>;
    // 🔧 修复类型缺失：toggleEnabled 已在 preload 实现但类型未声明
    toggleEnabled: (id: string, enabled: boolean) => Promise<boolean>;
  };  versions: NodeJS.ProcessVersions;
}

interface Window {
  api: WindowApi;
  // 🔧 修复 TS2551：renderer/src/api/index.ts 使用 window.electron 访问 ipcRenderer
  electron?: {
    ipcRenderer: {
      on: (channel: string, callback: (...args: any[]) => void) => void;
      removeListener: (channel: string, callback: (...args: any[]) => void) => void;
      removeAllListeners: (channel: string) => void;
      send: (channel: string, ...args: any[]) => void;
      invoke: (channel: string, ...args: any[]) => Promise<any>;
    };
  };
}
