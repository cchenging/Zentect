import { ElectronAPI } from '@electron-toolkit/preload'
import { IPCInvokeChannels, IPCEventChannels } from '../shared/types'

// 💥 工业级类型体操：把宽松的 ipcRenderer 扭曲成绝对严格的守卫
export interface StrictlyTypedIpcRenderer {
  // 拦截 invoke：频道名 K 必须在法典里，参数必须完全吻合，返回值也会被自动推导！
  invoke<K extends keyof IPCInvokeChannels>(
    channel: K,
    ...args: Parameters<IPCInvokeChannels[K]>
  ): ReturnType<IPCInvokeChannels[K]>;

  // 拦截 on：前端监听的事件名和返回的 data 格式，必须完全吻合！
  on<K extends keyof IPCEventChannels>(
    channel: K,
    listener: (event: Electron.IpcRendererEvent, ...args: Parameters<IPCEventChannels[K]>) => void
  ): this;

  send(channel: string, ...args: any[]): void;
  removeAllListeners(channel: string): this;
}

declare global {
  interface Window {
    // 将重铸后的严苛守卫，覆盖掉原有的 any 守卫
    electron: Omit<ElectronAPI, 'ipcRenderer'> & {
      ipcRenderer: StrictlyTypedIpcRenderer;
    }
    // api 类型在 src/renderer/src/env.d.ts 中声明
  }
}
