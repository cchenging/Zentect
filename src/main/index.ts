// — 路径：src/main/index.ts
// Windows 中文乱码修复：在所有 import 之前强制设置控制台 UTF-8 编码
if (process.platform === 'win32') {
  try { require('child_process').execSync('chcp 65001', { stdio: 'ignore' }); } catch {}
  // 强制 Node.js 进程输出编码为 UTF-8
  if (process.stdout) { try { (process.stdout as any).setEncoding('utf8'); } catch {} }
  if (process.stderr) { try { (process.stderr as any).setEncoding('utf8'); } catch {} }
}

import { app, shell, BrowserWindow, ipcMain, protocol, screen, safeStorage, session } from 'electron'
import path from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import fs from 'fs'

// — 引入核心基建
import { PathManager } from './utils/pathManager'
import { handleMagicProtocol } from './protocols/magic'
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
import { LOG_TAGS } from '../modules/infra/logger/LogConstants'

// — 引入所有规范化控制器
import { ProjectController } from './controllers/ProjectController'
import { SystemController } from './controllers/SystemController'
import { MediaController } from './controllers/MediaController'
import { AIController } from './controllers/AIController'
import { ExportController } from './controllers/ExportController'
import { EngineController } from './controllers/EngineController'
import { UserController } from './controllers/UserController'
import { ModelController } from './controllers/ModelController'
import { ApiProfileController } from './controllers/ApiProfileController'
import { migrateOldApiConfig } from './database/migrations/migrateApiProfiles'
import { SettingsController } from './controllers/SettingsController'
import { SettingsRepository } from './database/repositories/SettingsRepository'
import { CrashReporter } from './core/CrashReporter'
import { TelemetryOptInGate } from './core/TelemetryOptInGate'
import { UsageStatsCollector } from './core/UsageStatsCollector'
import { IPC_CHANNELS } from '../modules/infra/ipc/IpcConstants'
import { runCli } from './cli/index'

// — 注册自定义协议的特权与流媒体播放权限
// standard=true：Chromium 按 RFC 3986 解析 URL，host 部分用于传递项目 ID
// URL 格式：magic://{host}/{encoded_path}，其中 host 为项目 ID 或 "local"
// Windows 绝对路径通过 URL pathname 传递，如 magic://local/G%3A/video/test.mp4
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'magic',
    privileges: {
      standard: true,      // 标准协议：支持 Range 请求、流式视频播放
      secure: true,        // 标记为安全协议
      supportFetchAPI: true,
      stream: true,        // 允许视频 <video> 标签流式播放
      bypassCSP: true,
      corsEnabled: true
    }
  }
]);

// — 启用 Chromium HEVC (H.265) 硬件解码支持
// 大量 MP4 文件使用 HEVC 编码，Chromium 默认不开启，需显式启用
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');
// — 启用 GPU 加速视频解码
app.commandLine.appendSwitch('enable-features', 'VaapiVideoDecoder,VaapiVideoEncoder');
// — 允许不安全的本地 HTTP 资源（开发模式）
app.commandLine.appendSwitch('allow-insecure-localhost', 'true');
// — 禁用 GPU 着色器磁盘缓存，避免缓存目录权限问题导致启动卡顿
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
// — 禁用磁盘缓存目录写入，避免 EBADF/权限问题导致 HTTP 响应卡住
app.commandLine.appendSwitch('disable-disk-cache');

let currentView = 'home'
let homeSize = { width: 1280, height: 800 }
let editorSize: { width: number, height: number } | null = null

/**
 * — 工业级规范：AppBootstrap (应用生命周期中央司令部)
 * 绝对控制软件的启动顺序与安全停机
 */
class AppBootstrap {
  private static mainWindow: BrowserWindow | null = null

  // ==========================================
  // — 1. 点火序列 (窗口前置 + 服务并行启动)
  // ==========================================
  static async ignite() {
    /** ⏱️ 启动耗时诊断：记录每步相对起始时间，定位真实瓶颈 */
    const t0 = performance.now();
    const stepTimes: { name: string; ms: number }[] = [];
    const mark = (name: string) => {
      const ms = Math.round(performance.now() - t0);
      stepTimes.push({ name, ms });
      return ms;
    };

    AppLogger.info(LOG_TAGS.BOOTSTRAP, '— 开始执行主引擎点火序列...')

    try {
      // 步骤 1: 初始化物理路径寻址中枢 (最优先，否则后面全崩)
      PathManager.initialize()
      AppLogger.info(LOG_TAGS.BOOTSTRAP, `— 1/10 寻址中枢初始化完成 (${mark('PathManager')}ms)`)

      // ⚡⚡ 性能优化（极致前置）：窗口在第 2 步就创建！
      //    之前的序列把 createWindow 放在步骤 5，导致数据库迁移、IPC 注册
      //    全部串行阻塞窗口显示。现在窗口立即显示，让用户第一时间看到 UI，
      //    后续数据库/IPC/服务全部并行启动。
      //    注意：createWindow 内部会 loadURL 触发 vite 编译（dev），
      //    编译期间 index.html 的 "Zentect 引擎点火中…" 占位符会先显示，
      //    给用户即时反馈。IPC 路由在前端首次调用前注册即可。
      this.createWindow()
      AppLogger.info(LOG_TAGS.BOOTSTRAP, `— 2/10 UI 窗口已极致前置创建（用户可见） (${mark('createWindow')}ms)`)

      // ⚡⚡ 性能优化：后续初始化全部并行，不再阻塞窗口
      //    - 数据库迁移 (SQLiteConnection)
      //    - IPC 路由注册 (registerControllers)
      //    - 反馈总线 (initFeedbackBus)
      //    - AI 运行时 / 崩溃报告 / 任务调度器
      await Promise.all([
        // 2. 数据库引擎挂载 (含迁移) + 旧 API 配置迁移
        (async () => {
          try {
            SQLiteConnection.getInstance().getDB();
            // 🔧 启动性能修复：将 migrateStaleEncryptedData 延迟到数据库就绪后 2 秒执行，
            //   避免 SQLite 同步大事务阻塞启动关键路径。migrateStaleEncryptedData 会
            //   遍历 settings 表逐条解密，在 WAL 模式下独占写锁，导致后续所有
            //   DB 读写（项目列表加载、配置读取）被挂起等待。
            //   延迟 2 秒确保窗口已显示、前端已渲染后再执行。
            setTimeout(() => {
              try {
                const staleKeys = new SettingsRepository().migrateStaleEncryptedData();
                if (staleKeys.length > 0) {
                  AppLogger.info(LOG_TAGS.BOOTSTRAP,
                    `— 旧加密数据迁移完成，已清理 ${staleKeys.length} 个失效设置`);
                }
              } catch (e) {
                AppLogger.warn(LOG_TAGS.BOOTSTRAP, '旧加密数据迁移失败（非致命）', e as Error);
              }
            }, 2000);
            // 🔧 migrateOldApiConfig 依赖数据库，必须在 DB 就绪后执行
            try {
              migrateOldApiConfig();
            } catch (e) {
              AppLogger.warn(LOG_TAGS.BOOTSTRAP, '旧 API 配置迁移失败（非致命）', e as Error);
            }
            AppLogger.info(LOG_TAGS.BOOTSTRAP, `— 3/10 数据库引擎挂载完成 (${mark('SQLite+Migrations')}ms)`);
          } catch (e) {
            AppLogger.error(LOG_TAGS.BOOTSTRAP, '数据库引擎挂载失败', e as Error);
          }
        })(),
        // 4. IPC 路由注册
        (async () => {
          try {
            this.registerControllers();
            AppLogger.info(LOG_TAGS.BOOTSTRAP, `— 4/10 IPC 路由网关注册完成 (${mark('IPC')}ms)`);
          } catch (e) {
            AppLogger.error(LOG_TAGS.BOOTSTRAP, 'IPC 路由注册失败', e as Error);
          }
        })(),
        // 5. 反馈总线
        (async () => {
          try {
            this.initFeedbackBus();
            AppLogger.info(LOG_TAGS.BOOTSTRAP, `— 5/10 反馈总线就绪 (${mark('FeedbackBus')}ms)`);
          } catch (e) {
            AppLogger.warn(LOG_TAGS.BOOTSTRAP, '反馈总线初始化失败（非致命）', e as Error);
          }
        })(),
        // 6. AI 运行时唤醒 (AiRuntimeManager 接管, AIDaemon 为 facade)
        (async () => {
          try {
            AiRuntimeManager.getInstance();
            AIDaemon.getInstance().start();
            AIDaemon.getInstance().startTTS();
            AppLogger.info(LOG_TAGS.BOOTSTRAP, `— 6/10 AI 运行时已拉起 (${mark('AiRuntime')}ms)`);
          } catch (e) {
            AppLogger.warn(LOG_TAGS.BOOTSTRAP, 'AI 运行时启动失败（非致命）', e as Error);
          }
        })(),
        // 7. M4.0 运行时服务启动 (崩溃/遥测/统计)
        (async () => {
          try {
            CrashReporter.getInstance().init();
            TelemetryOptInGate.getInstance();
            UsageStatsCollector.getInstance().init();
            AppLogger.info(LOG_TAGS.BOOTSTRAP, `— 7/10 运行时服务就绪 (${mark('CrashReporter')}ms)`);
          } catch (e) {
            AppLogger.warn(LOG_TAGS.BOOTSTRAP, '运行时服务启动失败（非致命）', e as Error);
          }
        })(),
        // 8-9. 任务调度 + 计算资源预热
        (async () => {
          try {
            JobScheduler.getInstance().recoverZombieJobs();
            JobScheduler.getInstance().start();
            ComputeResourceManager.getInstance();
            AppLogger.info(LOG_TAGS.BOOTSTRAP, `— 8/10 任务调度器与计算资源管理器就绪 (${mark('JobScheduler')}ms)`);
          } catch (e) {
            AppLogger.warn(LOG_TAGS.BOOTSTRAP, '任务调度器启动失败（非致命）', e as Error);
          }
        })(),
      ]);

      AppLogger.info(LOG_TAGS.BOOTSTRAP, `— 10/10 Zentect 启动成功！总耗时 ${mark('TOTAL')}ms`)
      // ⏱️ 输出耗时汇总表，便于定位真实瓶颈
      AppLogger.info(LOG_TAGS.BOOTSTRAP, `⏱️ 启动耗时汇总: ${stepTimes.map(s => `${s.name}=${s.ms}ms`).join(' | ')}`)

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
    new SystemController().register();
    new ApiProfileController().register();
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
      minHeight: 750,
      center: true,
      show: false,
      title: 'Zentect',
      backgroundColor: '#16161a',
      frame: false,
      titleBarStyle: 'hidden',
      autoHideMenuBar: true,
      icon: icon,
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        sandbox: true,
        webSecurity: true,
        contextIsolation: true,
        nodeIntegration: false,
        // 🔧 修复启动卡顿：禁用磁盘缓存，避免 EBADF/权限问题导致 HTTP 响应卡住
        cache: false
      }
    })

    // 防御性编程：万一前端崩溃没发信号，保底超时后强制显影
    // 🔧 修复黑屏：dev 模式 vite 首次编译需 2-3 分钟，任何保底超时都会导致黑屏
    //   - dev 模式：立即显示窗口，让用户看到 vite loading 页面而非黑屏
    //   - prod 模式：保持 3 秒保底（打包产物已编译，挂载应在 1 秒内完成）
    if (is.dev) {
      this.mainWindow.show()
    }
    const fallbackMs = is.dev ? 120000 : 3000
    const fallbackTimer = setTimeout(() => {
      if (this.mainWindow && !this.mainWindow.isVisible()) {
        AppLogger.warn(LOG_TAGS.BOOTSTRAP, `前端握手超时(${fallbackMs}ms)，强制显影窗口`)
        this.mainWindow.show()
      }
    }, fallbackMs)

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

    // 🔍 启动诊断：监听渲染进程所有关键事件，定位前端卡顿
    this.mainWindow.webContents.on('did-start-loading', () => {
      AppLogger.info(LOG_TAGS.BOOTSTRAP, '[诊断] webContents did-start-loading')
    })
    this.mainWindow.webContents.on('dom-ready', () => {
      AppLogger.info(LOG_TAGS.BOOTSTRAP, '[诊断] webContents dom-ready')
    })
    this.mainWindow.webContents.on('did-stop-loading', () => {
      AppLogger.info(LOG_TAGS.BOOTSTRAP, '[诊断] webContents did-stop-loading')
    })
    this.mainWindow.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
      AppLogger.error(LOG_TAGS.BOOTSTRAP, `[诊断] webContents did-fail-load | code=${errorCode} desc=${errorDescription} url=${validatedURL}`)
    })
    this.mainWindow.webContents.on('render-process-gone', (_e, details) => {
      AppLogger.error(LOG_TAGS.BOOTSTRAP, `[诊断] render-process-gone | reason=${details.reason} exitCode=${details.exitCode}`)
    })
    this.mainWindow.webContents.on('unresponsive', () => {
      AppLogger.error(LOG_TAGS.BOOTSTRAP, '[诊断] 渲染进程无响应 (unresponsive)')
    })
    this.mainWindow.webContents.on('responsive', () => {
      AppLogger.info(LOG_TAGS.BOOTSTRAP, '[诊断] 渲染进程恢复响应 (responsive)')
    })
    // 🔍 转发所有 console 消息到主进程日志，定位前端执行点
    this.mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      const levelStr = ['LOG', 'WARN', 'ERROR'][level] || `L${level}`
      AppLogger.info(LOG_TAGS.BOOTSTRAP, `[前端console][${levelStr}] ${message} | src=${sourceId}:${line}`)
    })

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      this.mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
      // 🔍 启动诊断：dev 模式打开 DevTools，查看渲染进程网络请求和 console
      this.mainWindow.webContents.openDevTools({ mode: 'detach' })
    } else {
      this.mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
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
        win.setMinimumSize(1280, 750)
        if (!isMaximized) {
          win.setBounds({ width: homeSize.width, height: homeSize.height }, true)
          win.center()
        }
      } else if (targetView === 'editor') {
        // — 按照你的代码宪法：编辑器最小宽度 1180
        win.setMinimumSize(1280, 750)
        
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

      // 步骤 5: 基础设施层收尾 — 静默清理磁盘冷资产碎片
      import('./utils/CacheGarbageCollector').then(({ CacheGarbageCollector }) => {
        CacheGarbageCollector.runSilentGC();
      }).catch(() => {});

      // 步骤 6: 安全关闭数据库读写句柄
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

  // — 注册 magic:// 协议处理器（实现见 ./protocols/magic.ts）
  session.defaultSession.protocol.handle('magic', handleMagicProtocol);
  protocol.handle('atom', async (request) => {
    try {
      // 提取路径（与 magic:// 相同的解析逻辑）
      let rawPath = request.url;
      if (rawPath.startsWith('atom://')) {
        rawPath = rawPath.slice('atom://'.length);
      } else if (rawPath.startsWith('atom:')) {
        rawPath = rawPath.slice('atom:'.length);
      }
      while (rawPath.startsWith('/')) { rawPath = rawPath.slice(1); }
      try { rawPath = decodeURIComponent(rawPath); } catch {}

      const filePath = path.resolve(rawPath);

      // 安全校验：与 magic:// 相同的白名单策略
      const projectsRoot = PathManager.getProjectsRootPath();
      const cacheRoot = PathManager.getCacheRootPath?.() || path.join(projectsRoot, '..', 'zentect-cache');
      const homeDir = app.getPath('home');
      const allowedRoots = [
        path.resolve(projectsRoot),
        path.resolve(cacheRoot),
        path.resolve(homeDir),
        path.join(homeDir, 'Videos'),
        path.join(homeDir, 'Music'),
        path.join(homeDir, 'Pictures'),
        path.join(homeDir, 'Desktop'),
        path.join(homeDir, 'Downloads'),
      ].filter(Boolean);
      const systemDrive = (process.env.SystemDrive || 'C:').toLowerCase();
      const driveLetter = filePath.substring(0, 2).toLowerCase();
      const isAllowed = allowedRoots.some(root =>
        filePath.toLowerCase().startsWith(root.toLowerCase() + path.sep)
      ) || (driveLetter !== systemDrive && /^[a-z]:[\\]/i.test(filePath));
      if (!isAllowed) {
        AppLogger.warn(LOG_TAGS.SYSTEM, `[atom://] 路径越权拒绝: ${filePath}`);
        return new Response('Forbidden', { status: 403 });
      }

      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) return new Response('Not a file', { status: 400 });

      const ext = path.extname(filePath).toLowerCase();
      const MIME: Record<string, string> = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
        '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
      };

      // 手工 ReadableStream 包装，避免 Readable.toWeb 兼容问题
      const nodeStream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
      const webStream = new ReadableStream({
        start(ctrl) {
          nodeStream.on('data', (chunk: string | Buffer) => { ctrl.enqueue(new Uint8Array(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)); });
          nodeStream.on('end', () => { ctrl.close(); });
          nodeStream.on('error', (err) => { ctrl.error(err); });
        },
        cancel() { nodeStream.destroy(); },
      });

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
