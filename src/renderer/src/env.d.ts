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
  };
  events: {
    onTaskProgress: (handler: (...args: any[]) => void) => void;
    onTaskCompleted: (handler: (...args: any[]) => void) => void;
    onAppNotify: (handler: (...args: any[]) => void) => void;
    onExtractionSuccess: (handler: (payload: any) => void) => void;
    onMediaUpdated: (handler: (payload: any) => void) => void;
    removeAll: () => void;
  };
  invoke: (channel: string, ...args: any[]) => Promise<any>;
  apiProfile: {
    getAll: () => Promise<any[]>;
    getByProvider: (provider: string) => Promise<any[]>;
    create: (profile: any) => Promise<any>;
    update: (id: string, patch: any) => Promise<boolean>;
    delete: (id: string) => Promise<boolean>;
    activate: (id: string, provider: string) => Promise<boolean>;
  };  versions: NodeJS.ProcessVersions;
}

interface Window {
  api: WindowApi;
}
