// — 路径：src/main/index.ts
// Windows 中文乱码修复：在所有 import 之前强制设置控制台 UTF-8 编码
if (process.platform === 'win32') {
  try { require('child_process').execSync('chcp 65001', { stdio: 'ignore' }); } catch {}
}

import { app, shell, BrowserWindow, ipcMain, protocol, screen, safeStorage } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import fs from 'fs'
import { Readable } from 'stream'

// — 引入核心基建
import { PathManager } from './utils/pathManager'
import { SQLiteConnection } from './database/core/SQLiteConnection'
import { AIDaemon } from './core/AIDaemon'
import { AiRuntimeManager } from './core/AiRuntimeManager'
import { ProcessSupervisor } from './core/ProcessSupervisor'
import { ComputeResourceManager } from './core/ComputeResourceManager'
import { JobScheduler } from './core/JobScheduler'
import { ProcessManager } from './utils/processManager'
import { AppLogger } from './core/AppLogger'
import { FeedbackBus } from './core/FeedbackBus'
import { MainNotifier } from './core/MainNotifier'
import { LOG_TAGS } from '../shared/utils/LogConstants'

// — 引入所有规范化控制器
import { ProjectController } from './controllers/ProjectController'
import { SystemController } from './controllers/SystemController'
import { MediaController } from './controllers/MediaController'
import { AIController } from './controllers/AIController'
import { ExportController } from './controllers/ExportController'
import { EngineController } from './controllers/EngineController'
import { UserController } from './controllers/UserController'
import { ModelController } from './controllers/ModelController'
import { SettingsController } from './controllers/SettingsController'
import { SettingsRepository } from './database/repositories/SettingsRepository'
// import { LicenseService } from './services/LicenseService'
import { CrashReporter } from './core/CrashReporter'
import { TelemetryOptInGate } from './core/TelemetryOptInGate'
import { UsageStatsCollector } from './core/UsageStatsCollector'
import { IPC_CHANNELS } from '../shared/utils/IpcConstants'
import { runCli } from './cli/index'

// — 修复 3：在 app 生命周期最顶端，注册自定义协议的特权与流媒体播放权限
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'magic',
    privileges: {
      standard: true,      // 标记为标准协议（支持相对路径解析）
      secure: true,        // 标记为安全协议（等同于 https）
      supportFetchAPI: true,
      stream: true,        // — 允许视频 <video> 标签正常缓冲播放
      bypassCSP: true      // 绕过内容安全策略
    }
  }
]);

let currentView = 'home'
let homeSize = { width: 1440, height: 900 }
let editorSize: { width: number, height: number } | null = null

/**
 * — 工业级规范：AppBootstrap (应用生命周期中央司令部)
 * 绝对控制软件的启动顺序与安全停机
 */
class AppBootstrap {
  private static mainWindow: BrowserWindow | null = null

  // ==========================================
  // — 1. 点火序列 (严格单向启动)
  // ==========================================
  static async ignite() {
    AppLogger.info(LOG_TAGS.BOOTSTRAP, '— 开始执行主引擎点火序列...')

    try {
      // 步骤 1: 初始化物理路径寻址中枢 (最优先，否则后面全崩)
      PathManager.initialize()
      AppLogger.info(LOG_TAGS.BOOTSTRAP, '— 1/10 寻址中枢初始化完成')

      // 步骤 2: 挂载本地 SQLite 数据库引擎
      SQLiteConnection.getInstance().getDB()
      AppLogger.info(LOG_TAGS.BOOTSTRAP, '— 2/10 数据库引擎挂载完成')

      // 步骤 2.5: 迁移清理跨 Electron 版本的失效加密数据
      const staleKeys = new SettingsRepository().migrateStaleEncryptedData();
      if (staleKeys.length > 0) {
        AppLogger.info(LOG_TAGS.BOOTSTRAP,
          `— 2.5/10 旧加密数据迁移完成，已清理 ${staleKeys.length} 个失效设置`);
      }

      // 步骤 2.6: License 启动校验（已迁移至 VIP 激活码体系，此处仅保留兼容日志）
      AppLogger.info(LOG_TAGS.BOOTSTRAP, '— 2.6/10 License 校验已迁移至 VIP 激活码体系');

      // 检查 safeStorage 系统可用性与平台兼容性

      // 步骤 3: 注册所有 IPC 路由防腐层
      this.registerControllers()
      AppLogger.info(LOG_TAGS.BOOTSTRAP, '— 3/10 IPC 路由网关注册完成')

      // 步骤 4: 初始化全局反馈总线 (Feedback → Renderer)
      this.initFeedbackBus();
      AppLogger.info(LOG_TAGS.BOOTSTRAP, '— 4/10 反馈总线就绪')

      // 步骤 5: 唤醒 AI 运行时 (AiRuntimeManager接管, AIDaemon为facade)
      AiRuntimeManager.getInstance();
      AIDaemon.getInstance().start()
      AppLogger.info(LOG_TAGS.BOOTSTRAP, '— 5/10 AI 运行时已拉起')

      // 步骤 6: M4.0 运行时服务启动 (崩溃/遥测/统计)
      CrashReporter.getInstance().init();
      TelemetryOptInGate.getInstance();
      UsageStatsCollector.getInstance().init();
      AppLogger.info(LOG_TAGS.BOOTSTRAP, '— 6/10 运行时服务就绪')

      // 步骤 7: 清理僵尸任务
      JobScheduler.getInstance().recoverZombieJobs()
      AppLogger.info(LOG_TAGS.BOOTSTRAP, '— 7/10 僵尸任务清洗完毕')

      // 步骤 8: 启动任务调度器
      JobScheduler.getInstance().start()
      AppLogger.info(LOG_TAGS.BOOTSTRAP, '— 8/10 任务调度器启动')

      // 步骤 9: 预热计算资源管理器 (Pipeline执行前水位检查)
      ComputeResourceManager.getInstance();
      AppLogger.info(LOG_TAGS.BOOTSTRAP, '— 9/10 计算资源管理器就绪')

      // 步骤 10: 启动渲染主窗口
      this.createWindow()
      AppLogger.info(LOG_TAGS.BOOTSTRAP, '— 10/10 UI 渲染引擎点火完成。Zentect 启动成功！')

    } catch (error) {
      AppLogger.error(LOG_TAGS.BOOTSTRAP, '❌ 致命错误：点火序列中断，应用启动失败！', error)
      this.gracefulShutdown()
      app.exit(1)
    }
  }

  // ==========================================
  // 🔌 2. 路由网关统一挂载
  // ==========================================
  private static registerControllers() {
    new SystemController().register()
    new ProjectController().register()
    new MediaController().register()
    new AIController().register()
    new ExportController().register()
    EngineController.register()
    new UserController().register()
    new ModelController().register()
    new SettingsController().register()
  }

  // ==========================================
  // 🖥️ 3. UI 窗口生命周期
  // ==========================================
  private static createWindow(): void {
    this.mainWindow = new BrowserWindow({
      width: homeSize.width,
      height: homeSize.height,
      minWidth: 1280,
      minHeight: 800,
      center: true,
      show: false,
      title: 'Zentect',
      backgroundColor: '#16161a',
      frame: false,
      titleBarStyle: 'hidden',
      autoHideMenuBar: true,
      icon: icon,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        webSecurity: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })

    // 防御性编程：万一前端崩溃没发信号，保底 3 秒后强制显影
    const fallbackTimer = setTimeout(() => {
      if (this.mainWindow && !this.mainWindow.isVisible()) {
        AppLogger.warn(LOG_TAGS.BOOTSTRAP, '前端握手超时，强制显影窗口')
        this.mainWindow.show()
      }
    }, 3000)

    // 接收到前端 App.tsx 发来的点火完成信号，瞬间揭开黑幕！
    ipcMain.once(IPC_CHANNELS.APP_READY, () => {
      clearTimeout(fallbackTimer)
      if (this.mainWindow && !this.mainWindow.isVisible()) {
        this.mainWindow.show()
        this.mainWindow.focus() // 抢占系统焦点
      }
    })

    this.mainWindow.webContents.setWindowOpenHandler((details) => {
      shell.openExternal(details.url)
      return { action: 'deny' }
    })

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      this.mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    } else {
      this.mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
    }

    // — 统一管理：原生窗口按钮事件（仅限主窗口控制）
    ipcMain.on(IPC_CHANNELS.WINDOW_MINIMIZE, () => this.mainWindow?.minimize())
    ipcMain.on(IPC_CHANNELS.WINDOW_MAXIMIZE, () => {
      const win = this.mainWindow
      if (win?.isMaximized()) win?.unmaximize()
      else win?.maximize()
    })
    ipcMain.on(IPC_CHANNELS.WINDOW_CLOSE, () => this.mainWindow?.close())

    // 完美复原动态窗口尺寸记忆逻辑
    ipcMain.on(IPC_CHANNELS.WINDOW_SWITCH_VIEW, (event, targetView) => {
      if (currentView === targetView) return
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return

      const isMaximized = win.isMaximized()
      const workArea = screen.getPrimaryDisplay().workAreaSize // — 获取当前屏幕实际可用区域

      // 保存旧视图尺寸（仅在非最大化时）
      if (!isMaximized) {
        const [w, h] = win.getSize()
        if (currentView === 'home') homeSize = { width: w, height: h }
        else if (currentView === 'editor') editorSize = { width: w, height: h }
      }

      currentView = targetView

      if (targetView === 'home') {
        win.setMinimumSize(972, 648)
        if (!isMaximized) {
          win.setBounds({ width: homeSize.width, height: homeSize.height }, true)
          win.center()
        }
      } else if (targetView === 'editor') {
        // — 按照你的代码宪法：编辑器最小宽度 1180
        win.setMinimumSize(1180, 720)
        
        if (!isMaximized) {
          // — 标准化检测：如果 stored 数据（editorSize）不存在、或宽度小于 1180、或高度小于 720
          // 则初始化为标准 HD 尺寸 (1280x720)，这是剪映等主流软件的黄金起始尺寸
          const isInvalidSize = !editorSize || editorSize.width < 1180 || editorSize.height < 720
          
          if (isInvalidSize) {
            editorSize = { 
              width: Math.min(1280, workArea.width), 
              height: Math.min(720, workArea.height) 
            }
            win.setSize(editorSize.width, editorSize.height, true)
            win.center()
          } else {
            win.setSize(editorSize!.width, editorSize!.height, true)
          }
        }
      }
    })
  }

  // ==========================================
  // — 4. 优雅降级与物理抹杀序列
  // ==========================================
  static gracefulShutdown() {
    AppLogger.info(LOG_TAGS.BOOTSTRAP, '— 接收到停机指令，开始执行优雅降级...')
    try {
      // 步骤 1: 停止任务调度器
      JobScheduler.getInstance().stop()

      // 步骤 2: 排水数据库写入队列 (确保未写入的数据落盘)
      import('./pipeline/DatabaseWriteQueue').then(({ DatabaseWriteQueue }) => {
        DatabaseWriteQueue.getInstance().flush();
      }).catch(() => {});

      // 步骤 3: 通过 ProcessSupervisor 物理抹杀所有受拖管子进程
      ProcessSupervisor.getInstance().shutdown()

      // 步骤 4: 停止 AIDaemon facade (兜底)
      AIDaemon.getInstance().stop()

      // 步骤 5: 安全关闭数据库读写句柄
      const db = SQLiteConnection.getInstance().getDB()
      if (db) db.close()

      AppLogger.info(LOG_TAGS.BOOTSTRAP, '— 资源释放完毕，安全准许退出。')
    } catch (e) {
      AppLogger.error(LOG_TAGS.BOOTSTRAP, '❌ 优雅降级发生异常，强制退出', e)
    }
  }

  /**
   * 初始化全局反馈总线，建立主进程 → 渲染进程的 IPC 反馈通道
   */
  private static async initFeedbackBus(): Promise<void> {
    const feedbackBus = FeedbackBus.getInstance();

    feedbackBus.subscribe((event) => {
      switch (event.type) {
        case 'toast':
          MainNotifier.notify(IPC_CHANNELS.FEEDBACK_TOAST, event);
          break;
        case 'modal':
          MainNotifier.notify(IPC_CHANNELS.FEEDBACK_MODAL, event);
          break;
        case 'inline':
          MainNotifier.notify(IPC_CHANNELS.FEEDBACK_INLINE, event);
          break;
      }
    });

    ipcMain.handle(IPC_CHANNELS.FEEDBACK_GET, () => {
      return feedbackBus.getHistory();
    });
    ipcMain.handle(IPC_CHANNELS.FEEDBACK_CLEAR, () => {
      feedbackBus.clearHistory();
      return true;
    });
  }
}

// — 致命修复：捕获所有主进程的野鸡崩溃，强制落入日志！
process.on('uncaughtException', (error) => {
  AppLogger.fatal('SystemCore', `Uncaught Exception: ${error.message}`, error)
})

process.on('unhandledRejection', (reason: any) => {
  AppLogger.fatal('SystemCore', `Unhandled Rejection: ${reason?.message || reason}`, reason)
})

// =====================================================================
// Electron 原生生命周期接管区
// =====================================================================
app.whenReady().then(async () => {
  AppLogger.info(LOG_TAGS.SYSTEM, '=== Zentect 核心引擎启动 ===')

  // V1.1: safeStorage 可用性诊断 — 影响所有 API Key 加解密
  try {
    const ssAvailable = safeStorage.isEncryptionAvailable();
    AppLogger.info(LOG_TAGS.BOOTSTRAP, `safeStorage 可用: ${ssAvailable} | 平台: ${process.platform}`);
  } catch { AppLogger.warn(LOG_TAGS.BOOTSTRAP, 'safeStorage 状态检测异常'); }

  // — 魔法引擎：拦截所有 magic:// 请求，动态解析为物理文件！
  // 工业级架构：Node.js 流转 Web ReadableStream + Range 请求支持 + 路径安全沙盒
  protocol.handle('magic', async (request) => {
    try {
      // 1. 解码 URL
      const encodedPath = request.url.replace(/^magic:\/\//i, '');
      let decodedPath: string;
      try {
        decodedPath = decodeURIComponent(encodedPath);
      } catch {
        return new Response('Invalid URL encoding', { status: 400 });
      }

      // 2. 解析路径
      const projectsRoot = PathManager.getProjectsRootPath();
      let resolvedPath: string;

      if (/^[A-Za-z]:[\\/]/.test(decodedPath)) {
        // Windows 绝对路径（兼容旧数据）
        resolvedPath = decodedPath.replace(/\//g, '\\');
      } else {
        // 相对路径：{projectId}/relative/path
        const slashIdx = decodedPath.indexOf('/');
        if (slashIdx === -1) return new Response('Missing projectId', { status: 400 });

        const projectId = decodedPath.substring(0, slashIdx);
        const relativePath = decodedPath.substring(slashIdx + 1);

        // 安全校验：路径穿越
        if (projectId.includes('..') || relativePath.includes('..')) {
          return new Response('Forbidden', { status: 403 });
        }

        resolvedPath = join(projectsRoot, projectId, relativePath);
      }

      // 3. 安全校验：越权访问
      const pathModule = require('path');
      resolvedPath = pathModule.resolve(resolvedPath);
      const resolvedRoot = pathModule.resolve(projectsRoot);
      if (!resolvedPath.startsWith(resolvedRoot + pathModule.sep) && resolvedPath !== resolvedRoot) {
        return new Response('Forbidden', { status: 403 });
      }

      // 4. 异步获取文件信息
      const stat = await fs.promises.stat(resolvedPath);
      if (!stat.isFile()) return new Response('Not a file', { status: 400 });

      // 5. Content-Type 映射
      const ext = pathModule.extname(resolvedPath).toLowerCase();
      const MIME_TYPES: Record<string, string> = {
        '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogg': 'video/ogg',
        '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.oga': 'audio/ogg',
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
        '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
      };
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      // 6. Range 请求处理（视频/音频拖动进度条）
      const rangeHeader = request.headers.get('range');
      if (rangeHeader) {
        const parts = rangeHeader.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;

        if (start >= stat.size || start < 0 || end > stat.size - 1 || start > end) {
          return new Response('Range Not Satisfiable', { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
        }

        const chunkSize = end - start + 1;
        const nodeStream = fs.createReadStream(resolvedPath, { start, end });
        const webStream = Readable.toWeb(nodeStream) as ReadableStream;

        return new Response(webStream as any, {
          status: 206,
          headers: {
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize.toString(),
            'Content-Type': contentType,
            'Cache-Control': 'no-cache',
          },
        });
      }

      // 7. 完整文件流式传输
      const nodeStream = fs.createReadStream(resolvedPath, { highWaterMark: 64 * 1024 });
      const webStream = Readable.toWeb(nodeStream) as ReadableStream;

      return new Response(webStream as any, {
        headers: {
          'Content-Type': contentType,
          'Content-Length': stat.size.toString(),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
    } catch (err: any) {
      if (err.code === 'ENOENT') return new Response('Not found', { status: 404 });
      if (err.code === 'EACCES') return new Response('Forbidden', { status: 403 });
      AppLogger.warn(LOG_TAGS.SYSTEM, '[magic://] 文件未找到', { path: request.url });
      return new Response('Internal error', { status: 500 });
    }
  })

  // — atom 协议：用于加载本地图片（与 magic:// 使用相同的流式架构）
  protocol.handle('atom', async (request) => {
    try {
      let filePath = request.url.replace('atom://', '');
      try { filePath = decodeURIComponent(filePath); } catch {}

      const pathModule = require('path');
      filePath = pathModule.resolve(filePath);
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) return new Response('Not a file', { status: 400 });

      const ext = pathModule.extname(filePath).toLowerCase();
      const MIME: Record<string, string> = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
        '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
      };

      const nodeStream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
      const webStream = Readable.toWeb(nodeStream) as ReadableStream;

      return new Response(webStream as any, {
        headers: {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Content-Length': stat.size.toString(),
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
    } catch (err: any) {
      if (err.code === 'ENOENT') return new Response('Not found', { status: 404 });
      return new Response('Internal error', { status: 500 });
    }
  })

  // — 桥接前端发来的跨进程日志，让所有日志写入同一个物理文件！
  ipcMain.on(IPC_CHANNELS.SYSTEM_LOG, (_, { level, tag, message, meta }) => {
    const safeTag = tag || 'RENDER_FE';
    switch (level) {
      case 'info': AppLogger.info(safeTag, message, meta); break;
      case 'warn': AppLogger.warn(safeTag, message, meta); break;
      case 'error': AppLogger.error(safeTag, message, meta); break;
      case 'debug': AppLogger.debug(safeTag, message, meta); break;
      default: AppLogger.info(safeTag, message, meta); break; // 兜底
    }
  })

  electronApp.setAppUserModelId('com.magic.one')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // ========== V1.2: CLI 分支 — 无界面模式 ==========
  const cliArgs = process.argv.slice(1)
  const isCli = cliArgs.some(arg => ['run', 'queue', 'config'].includes(arg))
  if (isCli) {
    PathManager.initialize()
    SQLiteConnection.getInstance().getDB()
    const skillArgs = cliArgs.filter(a =>
      !a.includes('node_modules') && !a.includes('.exe') && !a.endsWith('.js') && !a.endsWith('.ts')
    )
    await runCli(skillArgs)
    return
  }

  // — 将应用控制权正式移交给中央司令部
  AppBootstrap.ignite()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) AppBootstrap.ignite()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    ProcessManager.killAll()
    app.quit()
  }
})

// — 拦截所有退出的前夜，强制执行物理清理
app.on('before-quit', () => {
  AppBootstrap.gracefulShutdown()
})

app.on('will-quit', () => {
  // gracefulShutdown 已经在 before-quit 中调用
})
