// — 路径：src/main/index.ts
// Windows 中文乱码修复：在所有 import 之前强制设置控制台 UTF-8 编码
if (process.platform === 'win32') {
  try { require('child_process').execSync('chcp 65001', { stdio: 'ignore' }); } catch {}
  // 强制 Node.js 进程输出编码为 UTF-8
  if (process.stdout) { try { (process.stdout as any).setEncoding('utf8'); } catch {} }
  if (process.stderr) { try { (process.stderr as any).setEncoding('utf8'); } catch {} }
}

import { app, shell, BrowserWindow, ipcMain, protocol, screen, safeStorage, session, net } from 'electron'
import path from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import fs from 'fs'
import { pathToFileURL } from 'url'

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
import { CrashReporter } from './core/CrashReporter'
import { TelemetryOptInGate } from './core/TelemetryOptInGate'
import { UsageStatsCollector } from './core/UsageStatsCollector'
import { IPC_CHANNELS } from '../shared/utils/IpcConstants'
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
      // 并行启动 MOSS TTS 本地语音合成
      AIDaemon.getInstance().startTTS()
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
    new SystemController().register();
try {
      new ApiProfileController().register();
      migrateOldApiConfig();
    } catch (e) {
      console.warn('ApiProfile init failed (non-fatal):', e);
    }
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

  // — 魔法引擎：拦截所有 magic:// 请求，动态解析为物理文件
  // 架构：使用 Electron 官方推荐的 net.fetch + pathToFileURL 方案
  // 优势：自动支持 Range 请求、流式传输、正确的 MIME 类型，无需手工处理
  const sesh = session.defaultSession;
  sesh.protocol.handle('magic', async (request) => {
    try {
      // 1. 解析 URL（standard=true 时，Chromium 按 RFC 3986 解析）
      // URL 格式：magic://local/G%3A/%E8%A7%86%E9%A2%91/test.mp4
      // URL 格式：magic://proj_xxx/thumbnails/media_xxx.jpg（host 为项目 ID）
      const urlObj = new URL(request.url);
      const encodedPath = urlObj.pathname;

      // 2. 解码路径
      let decodedPath: string;
      try {
        decodedPath = decodeURIComponent(encodedPath);
      } catch {
        return new Response('Invalid URL encoding', { status: 400 });
      }
      if (decodedPath.startsWith('/')) decodedPath = decodedPath.slice(1);

      // 2.5 如果 host 是项目 ID（非 local），将 host 拼接到路径前
      const host = urlObj.host;
      if (host && host !== 'local' && !decodedPath.startsWith(host + '/')) {
        decodedPath = host + '/' + decodedPath;
      }

      // 3. 路径安全校验
      const projectsRoot = PathManager.getProjectsRootPath();
      /** 所有产物统一存放在项目目录下，cacheRoot 仅保留兼容旧数据 */
      const cacheRoot = PathManager.getCacheRootPath?.() || path.join(projectsRoot, '..', 'zentect-cache');
      const dataRoot = PathManager.getUserDataPath();
      const homeDir = app.getPath('home');
      let resolvedPath: string;

      if (/^[A-Za-z]:[\\/]/.test(decodedPath)) {
        resolvedPath = path.resolve(decodedPath.replace(/\//g, '\\'));
        const allowedRoots = [
          path.resolve(dataRoot), path.resolve(projectsRoot), path.resolve(cacheRoot), path.resolve(homeDir),
          path.join(homeDir, 'Videos'), path.join(homeDir, 'Music'),
          path.join(homeDir, 'Pictures'), path.join(homeDir, 'Desktop'), path.join(homeDir, 'Downloads'),
        ].filter(Boolean);
        const systemDrive = (process.env.SystemDrive || 'C:').toLowerCase();
        const driveLetter = resolvedPath.substring(0, 2).toLowerCase();
        const isAllowed = allowedRoots.some(root =>
          resolvedPath.toLowerCase().startsWith(root.toLowerCase() + path.sep)
        ) || (driveLetter !== systemDrive && /^[a-z]:[\\]/i.test(resolvedPath));
        if (!isAllowed) {
          AppLogger.warn(LOG_TAGS.SYSTEM, `[magic://] 路径越权拒绝: ${resolvedPath}`);
          return new Response('Forbidden', { status: 403 });
        }
      } else if (decodedPath.startsWith('/')) {
        resolvedPath = path.resolve(decodedPath);
        const allowedRoots = [path.resolve(projectsRoot), path.resolve(cacheRoot), path.resolve(homeDir)].filter(Boolean);
        const isAllowed = allowedRoots.some(root =>
          resolvedPath.toLowerCase().startsWith(root.toLowerCase() + path.sep)
        );
        if (!isAllowed) return new Response('Forbidden', { status: 403 });
      } else {
        const slashIdx = decodedPath.indexOf('/');
        if (slashIdx === -1) return new Response('Missing projectId', { status: 400 });
        const projectId = decodedPath.substring(0, slashIdx);
        const relativePath = decodedPath.substring(slashIdx + 1);
        if (projectId.includes('..') || relativePath.includes('..')) return new Response('Forbidden', { status: 403 });
        resolvedPath = path.resolve(path.join(projectsRoot, projectId, relativePath));
        const resolvedRoot = path.resolve(projectsRoot);
        if (!resolvedPath.startsWith(resolvedRoot + path.sep) && resolvedPath !== resolvedRoot) {
          return new Response('Forbidden', { status: 403 });
        }
      }

      // 4. 非原生格式：FFmpeg 边转边播
      const ext = path.extname(resolvedPath).toLowerCase();
      const NON_NATIVE_VIDEO_EXTS = ['.mkv', '.avi', '.mov', '.wmv', '.flv', '.ts', '.rmvb', '.rm', '.3gp', '.vob'];
      if (NON_NATIVE_VIDEO_EXTS.includes(ext)) {
        const ffmpegExe = PathManager.getBinPath(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
        if (ffmpegExe && fs.existsSync(ffmpegExe)) {
          try {
            const ffmpegArgs = [
              '-i', resolvedPath, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
              '-c:a', 'aac', '-b:a', '128k',
              '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', '-pipe:1'
            ];
            AppLogger.info(LOG_TAGS.SYSTEM, `[magic://] FFmpeg 流式转码: ${resolvedPath}`);
            const ffmpegProc = require('child_process').spawn(ffmpegExe, ffmpegArgs, { windowsHide: true });
            let procKilled = false;
            const webStream = new ReadableStream({
              start(ctrl) {
                ffmpegProc.stdout.on('data', (chunk: Buffer) => { if (!procKilled) ctrl.enqueue(new Uint8Array(chunk)); });
                ffmpegProc.stdout.on('end', () => { ctrl.close(); });
                ffmpegProc.stdout.on('error', (err: Error) => { ctrl.error(err); });
              },
              cancel() { procKilled = true; if (!ffmpegProc.killed) ffmpegProc.kill('SIGTERM'); },
            });
            ffmpegProc.on('error', () => {});
            ffmpegProc.on('close', (code: number) => {
              if (code !== 0 && code !== null) AppLogger.warn(LOG_TAGS.SYSTEM, `[magic://] FFmpeg 转码退出: code=${code}`);
            });
            return new Response(webStream as any, {
              headers: { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'none', 'Cache-Control': 'no-cache' },
            });
          } catch (transcodeErr) {
            AppLogger.warn(LOG_TAGS.SYSTEM, `[magic://] FFmpeg 转码异常`, transcodeErr);
          }
        }
      }

      // 5. 原生格式：手工处理 Range 请求（net.fetch 不支持 Range，必须手工实现）
      const stat = await fs.promises.stat(resolvedPath);
      if (!stat.isFile()) return new Response('Not a file', { status: 400 });

      const MIME_TYPES: Record<string, string> = {
        '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogg': 'video/ogg',
        '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.aac': 'audio/aac',
        '.flac': 'audio/flac', '.m4a': 'audio/mp4',
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
        '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
        '.bmp': 'image/bmp', '.ico': 'image/x-icon',
      };
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      // 5.1 Range 请求处理（视频播放必须支持，否则 Chromium 无法 seek/缓冲）
      const rangeHeader = request.headers.get('range');
      if (rangeHeader) {
        const parts = rangeHeader.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;

        if (start >= stat.size || start < 0 || end > stat.size - 1 || start > end) {
          return new Response('Range Not Satisfiable', { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
        }

        const chunkSize = end - start + 1;
        const nodeStream = fs.createReadStream(resolvedPath, { start, end, highWaterMark: 256 * 1024 });
        const webStream = new ReadableStream({
          start(ctrl) {
            nodeStream.on('data', (chunk: Buffer) => { ctrl.enqueue(new Uint8Array(chunk)); });
            nodeStream.on('end', () => { ctrl.close(); });
            nodeStream.on('error', (err) => { ctrl.error(err); });
          },
          cancel() { nodeStream.destroy(); },
        });

        return new Response(webStream, {
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

      // 5.2 完整文件请求（非视频或首次加载）
      const fsStream = fs.createReadStream(resolvedPath, { highWaterMark: 256 * 1024 });
      const webStream = new ReadableStream({
        start(ctrl) {
          fsStream.on('data', (chunk: Buffer) => { ctrl.enqueue(new Uint8Array(chunk)); });
          fsStream.on('end', () => { ctrl.close(); });
          fsStream.on('error', (err) => { ctrl.error(err); });
        },
        cancel() { fsStream.destroy(); },
      });

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
      AppLogger.warn(LOG_TAGS.SYSTEM, `[magic://] 处理异常: ${err?.message}`);
      return new Response('Internal error', { status: 500 });
    }
  })
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
          nodeStream.on('data', (chunk: Buffer) => { ctrl.enqueue(new Uint8Array(chunk)); });
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
