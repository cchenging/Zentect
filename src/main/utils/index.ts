import { app, shell, BrowserWindow, ipcMain } from 'electron';
import { join } from 'path';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import icon from '../../resources/icon.png?asset';

// 基建服务
import { PathManager } from './pathManager';
import { DBManager } from '../database/db';
import { AIDaemon } from '../core/AIDaemon';
import { JobScheduler } from '../core/JobScheduler';
import { AppLogger } from '../core/AppLogger';

/**
 * 创建主窗口
 */
function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 768,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' };
  });

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  // 1. 初始化基建
  PathManager.initialize();
  DBManager.getInstance();

  electronApp.setAppUserModelId('com.electron');
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  // 2. 通用基础路由
  ipcMain.on('ping', () => AppLogger.info('System', 'pong'));
  
  // 3. 挂载所有业务控制器 (已迁移至 AppBootstrap.registerControllers)
  // MediaController / ExportController 不再在此处注册

  // 4. 点火底层物理引擎
  AIDaemon.getInstance().start();
  JobScheduler.getInstance().start();

  // 5. 创建主窗口
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// 规范销毁流程，严防僵尸进程
app.on('will-quit', () => {
  JobScheduler.getInstance().stop();
  AIDaemon.getInstance().stop();
});
