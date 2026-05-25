// 📁 路径：src/main/controllers/SystemController.ts
import { dialog, BrowserWindow } from 'electron';
import { IpcRouter } from '../core/IpcRouter';
import { SystemService } from '../services/SystemService';
import { IPC_CHANNELS } from '../../shared/utils/IpcConstants';
import { AppError, ErrorCode } from '../../shared/utils/AppError';
import { ALL_MEDIA_EXTENSIONS } from '../../shared/locales/dictionary';
import { SettingsRepository } from '../database/repositories/SettingsRepository';

export class SystemController {
  private systemService: SystemService;

  constructor() {
    this.systemService = new SystemService();
  }

  public register() {
    const repo = new SettingsRepository();

    // --- 系统设置获取 ---
    IpcRouter.handle(IPC_CHANNELS.SYSTEM_GET_SETTINGS, async () => {
      return repo.getAllSettings();
    });

    IpcRouter.handle(IPC_CHANNELS.SYSTEM_SAVE_SETTINGS, async (_, payload: Record<string, string>) => {
      const cleanPayload = { ...payload };
      delete cleanPayload['success'];
      delete cleanPayload['data'];
      delete cleanPayload['error'];
      repo.saveSettings(cleanPayload);
      return true;
    });

    // 💥 致命修复 1：接收平铺参数 key, defaultVal
    IpcRouter.handle(IPC_CHANNELS.SYSTEM_SETTING_GET, async (_, key: string, defaultVal?: any) => {
      if (!key) return null;
      return repo.get(key, defaultVal ?? null);
    });

    // 💥 致命修复 2：接收平铺参数 key, value
    IpcRouter.handle(IPC_CHANNELS.SYSTEM_SETTING_SET, async (_, key: string, value: any) => {
      if (!key) return false;
      repo.saveSettings({ [key]: value });
      return true;
    });

    // --- 系统路径与弹窗 ---
    IpcRouter.handle(IPC_CHANNELS.SYSTEM_GET_PATHS, async () => {
      return this.systemService.getPaths();
    });

    IpcRouter.handle(IPC_CHANNELS.SYSTEM_OPEN_DIR, async () => {
      const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openDirectory'] });
      if (canceled || filePaths.length === 0) return null;
      return filePaths[0];
    });

    IpcRouter.handle(IPC_CHANNELS.SYSTEM_OPEN_MEDIA, async (event) => {
      const win: BrowserWindow | null = BrowserWindow.fromWebContents(event.sender);
      const { canceled, filePaths } = await dialog.showOpenDialog(win as BrowserWindow, {
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Media Files', extensions: [...ALL_MEDIA_EXTENSIONS] }]
      });
      if (canceled) return [];
      return filePaths;
    });

    // --- 窗口控制 ---
    IpcRouter.handle(IPC_CHANNELS.SYSTEM_RESIZE, async (_, width: number, height: number) => {
      const win = BrowserWindow.getFocusedWindow();
      if (win && width && height) {
        win.setMinimumSize(1024, 720);
        win.setSize(width, height, true);
        win.center();
        return true;
      }
      return false;
    });

    IpcRouter.handle(IPC_CHANNELS.SYSTEM_MINIMIZE, async () => {
      BrowserWindow.getFocusedWindow()?.minimize();
      return true;
    });

    IpcRouter.handle(IPC_CHANNELS.SYSTEM_MAXIMIZE, async () => {
      const win = BrowserWindow.getFocusedWindow();
      if (win?.isMaximized()) win.unmaximize();
      else win?.maximize();
      return true;
    });

    IpcRouter.handle(IPC_CHANNELS.SYSTEM_CLOSE, async () => {
      BrowserWindow.getFocusedWindow()?.close();
      return true;
    });

    // --- 兼容旧通道 ---
    IpcRouter.handle(IPC_CHANNELS.SYSTEM_MIGRATE, async (_, oldPath: string, newPath: string) => {
      try {
        return await this.systemService.migrateProjects(oldPath, newPath);
      } catch (e: any) {
        throw new AppError(ErrorCode.FS_WRITE_ERROR, e.message);
      }
    });

    // V1.0: 在文件管理器中打开路径
    IpcRouter.handle(IPC_CHANNELS.SYSTEM_OPEN_PATH, async (_, filePath: string) => {
      if (!filePath) return false;
      const { shell } = require('electron');
      shell.openPath(filePath);
      return true;
    });
  }
}
