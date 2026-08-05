import os from 'os';
import { ComputeResourceManager } from '../core/ComputeResourceManager';
import { AIDaemon } from '../core/AIDaemon';
import { SQLiteConnection } from '../database/core/SQLiteConnection';
import { PathManager } from '../utils/pathManager';
import { SettingsRepository } from '../database/repositories/SettingsRepository';
import { ApiProfileRepository } from '../database/repositories/ApiProfileRepository';
import fs from 'fs';
import { execFileSync } from 'child_process';

/**
 * AI 运行时包状态（单个 pip 包）
 */
interface RuntimePkgStatus {
  name: string;           // 包名（torch）
  displayName: string;    // 显示名（PyTorch）
  installed: boolean;
  version: string | null; // 已安装版本，未装为 null
  /** 使用方列表（如 ['Demucs', 'SenseVoice', 'CLIP']） */
  usedBy: string[];
}

/**
 * LLM 通道状态
 */
interface LLMChannelStatus {
  id: string;             // deepseek/qwen/doubao/tencent/proxy/openai
  displayName: string;    // DeepSeek / 通义千问 / ...
  configured: boolean;    // 是否已配置 API Key
  /** 是否为当前默认通道 */
  isDefault: boolean;
}

/**
 * TTS 引擎状态
 */
interface TTSEngineStatus {
  id: string;             // edge/doubao
  displayName: string;    // Edge TTS / 豆包 TTS / ...
  available: boolean;     // 是否可用（已配置或内置）
  /** 是否为当前默认引擎 */
  isDefault: boolean;
  /** 是否为内置（无需配置） */
  builtin: boolean;
}

interface HealthReport {
  timestamp: number
  uptime: number
  platform: string
  hostname: string
  cpu: { model: string; cores: number; percent: number }
  memory: { totalMB: number; freeMB: number; percent: number }
  disk: { freeGB: number; totalGB: number } | null
  process: { pid: number; uptimeS: number; memoryMB: number }
  services: { db: boolean; aiDaemon: boolean; ffmpeg: boolean }
  sqliteVersion: string
  pathsWritable: { projects: boolean; exports: boolean; models: boolean }
  paths: Record<string, string>
  // 🔧 V6 新增字段
  /** FFmpeg 详情：版本 + 路径 */
  ffmpegInfo: { version: string | null; path: string | null; available: boolean }
  /** Python 运行环境详情：版本 + 路径 + 状态 */
  pythonInfo: { version: string | null; path: string | null; ready: boolean }
  /** 数据库详情：路径 + 大小 */
  databaseInfo: { path: string; sizeBytes: number; sizeMB: number }
  /** AI 运行时包列表（torch/torchaudio/demucs/funasr/transformers/tokenizers） */
  runtimePkgs: RuntimePkgStatus[]
  /** LLM 通道列表 */
  llmChannels: LLMChannelStatus[]
  /** TTS 引擎列表 */
  ttsEngines: TTSEngineStatus[]
}

export class HealthService {
  private startTime = Date.now()
  private resourceManager = ComputeResourceManager.getInstance()
  private settings = new SettingsRepository()

  /** 收集完整健康报告
   *  🔧 V6：改为 async，因新增字段需调用 ai_daemon HTTP 接口（getPythonInfo/getRuntimePkgs）
   */
  async collect(): Promise<HealthReport> {
    const snap = this.resourceManager.snapshot()
    const procMem = process.memoryUsage()

    // 🔧 V6：并行调用所有异步探测（ffmpeg/python/runtimePkgs）
    const [ffmpegInfo, pythonInfo, runtimePkgs] = await Promise.all([
      Promise.resolve(this.getFFmpegInfo()),
      this.getPythonInfo(),
      this.getRuntimePkgs(),
    ])

    return {
      timestamp: snap.timestamp,
      uptime: Date.now() - this.startTime,
      platform: `${os.platform()} ${os.arch()} ${os.release()}`,
      hostname: os.hostname(),
      cpu: {
        model: os.cpus()[0]?.model || 'Unknown',
        cores: os.cpus().length,
        percent: snap.cpuPercent
      },
      memory: {
        totalMB: snap.totalMemMB,
        freeMB: snap.freeMemMB,
        percent: Math.round((1 - snap.freeMemMB / snap.totalMemMB) * 100)
      },
      disk: this.getDiskInfo(),
      process: {
        pid: process.pid,
        uptimeS: Math.round(process.uptime()),
        memoryMB: Math.round(procMem.rss / (1024 * 1024))
      },
      services: this.checkServices(),
      sqliteVersion: this.getSqliteVersion(),
      pathsWritable: {
        projects: this.checkPathWritable(PathManager.getProjectsPath()),
        exports: this.checkPathWritable(PathManager.getExportRootPath()),
        models: this.checkPathWritable(PathManager.getModelsPath()),
      },
      paths: {
        userData: PathManager.getUserDataPath(),
        projects: PathManager.getProjectsPath(),
        exports: PathManager.getExportRootPath(),
        models: PathManager.getModelsPath(),
        logs: PathManager.getLogsPath()
      },
      // 🔧 V6 新增字段（已并行获取）
      ffmpegInfo,
      pythonInfo,
      databaseInfo: this.getDatabaseInfo(),
      runtimePkgs,
      llmChannels: this.getLLMChannels(),
      ttsEngines: this.getTTSEngines(),
    }
  }

  /** 简要冒烟检查：核心服务是否存活 */
  smokeTest(): { passed: boolean; checks: { name: string; ok: boolean; detail: string }[] } {
    const checks = [
      {
        name: '数据库连接',
        ok: this.checkDatabase(),
        detail: this.checkDatabase() ? 'SQLite 读写正常' : '数据库连接异常'
      },
      {
        name: 'FFmpeg',
        ok: this.checkFFmpeg(),
        detail: this.checkFFmpeg() ? 'FFmpeg 就绪' : 'FFmpeg 缺失'
      },
      {
        name: 'AI 守护进程',
        ok: this.checkAiDaemon(),
        detail: this.checkAiDaemon() ? 'Python Daemon 存活' : 'Python Daemon 离线',
      },
      {
        name: 'CPU 负载',
        ok: this.resourceManager.snapshot().cpuPercent < 90,
        detail: `CPU ${this.resourceManager.snapshot().cpuPercent}%`
      },
      {
        name: '可用内存',
        ok: this.resourceManager.snapshot().freeMemMB > 256,
        detail: `空闲 ${this.resourceManager.snapshot().freeMemMB}MB`
      }
    ]

    return {
      passed: checks.every((c) => c.ok),
      checks
    }
  }

  /** 获取 SQLite 版本号 */
  private getSqliteVersion(): string {
    try {
      const db = SQLiteConnection.getInstance().getDB()
      const row = db.pragma('sqlite_version') as Array<{ sqlite_version: string }>
      return row[0]?.sqlite_version || 'unknown'
    } catch {
      return 'unknown'
    }
  }

  /** 检测路径可写性 */
  private checkPathWritable(dirPath: string): boolean {
    try {
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true })
      }
      const testFile = `${dirPath}/.health_write_test_${Date.now()}`
      fs.writeFileSync(testFile, 'ok', { flag: 'w' })
      fs.unlinkSync(testFile)
      return true
    } catch {
      return false
    }
  }

  private checkDatabase(): boolean {
    try {
      const db = SQLiteConnection.getInstance().getDB()
      const result = db.prepare('SELECT 1 as ok').get() as { ok: number } | undefined
      return result?.ok === 1
    } catch {
      return false
    }
  }

  private checkFFmpeg(): boolean {
    const ffmpegPath = PathManager.getBinPath(
      process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
    )
    return fs.existsSync(ffmpegPath)
  }

  private checkAiDaemon(): boolean {
    try {
      return AIDaemon.getInstance().isOnline();
    } catch {
      return false;
    }
  }

  private checkServices(): { db: boolean; aiDaemon: boolean; ffmpeg: boolean } {
    return {
      db: this.checkDatabase(),
      aiDaemon: this.checkAiDaemon(),
      ffmpeg: this.checkFFmpeg(),
    };
  }

  private getDiskInfo(): { freeGB: number; totalGB: number } | null {
    try {
      const projectPath = PathManager.getProjectsPath()
      const stat = fs.statfsSync ? fs.statfsSync(projectPath) : null
      if (stat) {
        return {
          freeGB: Math.round(((stat.bsize * stat.bfree) / 1024 ** 3) * 100) / 100,
          totalGB: Math.round(((stat.bsize * stat.blocks) / 1024 ** 3) * 100) / 100
        }
      }
    } catch {
      /* 非 POSIX 系统跳过 */
    }
    return null
  }

  /**
   * 🔧 V6 新增：获取 FFmpeg 详情（版本 + 路径）
   *   执行 `ffmpeg -version` 解析第一行的版本号
   */
  private getFFmpegInfo(): { version: string | null; path: string | null; available: boolean } {
    const ffmpegPath = PathManager.getBinPath(
      process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
    )
    if (!fs.existsSync(ffmpegPath)) {
      return { version: null, path: null, available: false }
    }
    let version: string | null = null
    try {
      const output = execFileSync(ffmpegPath, ['-version'], {
        encoding: 'utf-8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'ignore']
      })
      // 解析 "ffmpeg version 6.0-full_build ..."
      const match = output.match(/ffmpeg version\s+([^\s]+)/)
      version = match ? match[1] : null
    } catch {
      // ffmpeg 可执行但 -version 失败，视为可用但版本未知
      version = null
    }
    return { version, path: ffmpegPath, available: true }
  }

  /**
   * 🔧 V6 新增：获取 Python 运行环境详情（版本 + 路径 + 状态）
   *   通过 ai_daemon /api/check_deps 获取 python_executable
   *   通过执行 `python --version` 获取版本
   */
  private async getPythonInfo(): Promise<{ version: string | null; path: string | null; ready: boolean }> {
    try {
      const daemon = AIDaemon.getInstance()
      if (!daemon.isOnline()) {
        return { version: null, path: null, ready: false }
      }
      const port = daemon.getPort()
      const { HttpClient } = await import('../core/HttpClient')
      // 🔧 修复 TS2554：HttpClient.get 静态方法只接受 url，超时由内部默认 60s 控制
      const res = await HttpClient.get(`http://127.0.0.1:${port}/api/check_deps`)
      const pythonPath = res?.python_executable || null
      const ready = !!pythonPath
      let version: string | null = null
      if (pythonPath && fs.existsSync(pythonPath)) {
        try {
          const output = execFileSync(pythonPath, ['--version'], {
            encoding: 'utf-8',
            timeout: 3000,
            stdio: ['pipe', 'pipe', 'ignore']
          })
          const match = output.match(/Python\s+([^\s]+)/)
          version = match ? match[1] : null
        } catch {
          version = null
        }
      }
      return { version, path: pythonPath, ready }
    } catch {
      return { version: null, path: null, ready: false }
    }
  }

  /**
   * 🔧 V6 新增：获取数据库详情（路径 + 大小）
   */
  private getDatabaseInfo(): { path: string; sizeBytes: number; sizeMB: number } {
    const dbPath = PathManager.getDatabasePath()
    let sizeBytes = 0
    try {
      if (fs.existsSync(dbPath)) {
        sizeBytes = fs.statSync(dbPath).size
      }
    } catch { /* 忽略 */ }
    return {
      path: dbPath,
      sizeBytes,
      sizeMB: Math.round((sizeBytes / (1024 * 1024)) * 100) / 100
    }
  }

  /**
   * 🔧 V6 新增：获取 AI 运行时包列表（torch/torchaudio/demucs/funasr/transformers/tokenizers/kokoro 等）
   *   从 ai_daemon /api/check_deps 拉取 deps 字段，附加 usedBy 标注
   */
  private async getRuntimePkgs(): Promise<RuntimePkgStatus[]> {
    // 包名 → 使用方映射（与 ai_daemon modules.shared_by 对齐）
    const pkgUsedBy: Record<string, string[]> = {
      torch: ['Demucs', 'SenseVoice', 'CLIP'],
      torchaudio: ['Demucs'],
      demucs: ['Demucs'],
      funasr: ['SenseVoice'],
      transformers: ['CLIP'],
      tokenizers: ['CLIP'],
      kokoro: ['Kokoro TTS'],
      misaki: ['Kokoro TTS'],
      soundfile: ['Kokoro TTS', '音频分析'],
    }
    const pkgDisplayName: Record<string, string> = {
      torch: 'PyTorch',
      torchaudio: 'Torchaudio',
      demucs: 'Demucs',
      funasr: 'FunASR',
      transformers: 'Transformers',
      tokenizers: 'Tokenizers',
      kokoro: 'Kokoro',
      misaki: 'Misaki',
      soundfile: 'SoundFile',
    }

    const buildOffline = () => Object.keys(pkgUsedBy).map(name => ({
      name,
      displayName: pkgDisplayName[name] || name,
      installed: false,
      version: null,
      usedBy: pkgUsedBy[name],
    }))

    try {
      const daemon = AIDaemon.getInstance()
      if (!daemon.isOnline()) {
        return buildOffline()
      }
      const port = daemon.getPort()
      const { HttpClient } = await import('../core/HttpClient')
      // 🔧 修复 TS2554：HttpClient.get 静态方法只接受 url，超时由内部默认 60s 控制
      const res = await HttpClient.get(`http://127.0.0.1:${port}/api/check_deps`)
      const deps = res?.deps || {}

      return Object.keys(pkgUsedBy).map(name => {
        const depInfo = deps[name] || {}
        return {
          name,
          displayName: pkgDisplayName[name] || name,
          installed: !!depInfo.installed,
          version: depInfo.version || null,
          usedBy: pkgUsedBy[name],
        }
      })
    } catch {
      return buildOffline()
    }
  }

  /**
   * 🔧 V6 新增：获取 LLM 通道状态列表（6 个通道）
   *   读 settings 检测 API Key 是否配置
   */
  private getLLMChannels(): LLMChannelStatus[] {
    // 通道 ID → 显示名 + settings key
    const channels: Array<{ id: string; displayName: string; key: string }> = [
      { id: 'deepseek', displayName: 'DeepSeek', key: 'deepseekKey' },
      { id: 'qwen', displayName: '通义千问', key: 'qwenKey' },
      { id: 'doubao', displayName: '豆包', key: 'doubaoKey' },
      { id: 'tencent', displayName: '腾讯混元', key: 'hunyuanKey' },
      { id: 'proxy', displayName: '中转代理', key: 'proxyKey' },
      { id: 'openai', displayName: 'OpenAI 兼容', key: 'openaiKey' },
    ]

    // 当前默认通道（从 ApiProfileRepository.getActive 获取）
    let defaultProvider = 'proxy'
    try {
      const activeProfile = ApiProfileRepository.getActive('proxy')
      if (activeProfile?.apiKey) {
        defaultProvider = 'proxy'
      }
    } catch { /* 忽略 */ }
    const settingsDefault = this.settings.get<string>('llmDefaultProvider', 'proxy')
    defaultProvider = settingsDefault || defaultProvider

    return channels.map(ch => {
      const apiKey = this.settings.get<string>(ch.key, '')
      // proxy 通道需要 baseURL + apiKey 都配置
      const configured = ch.id === 'proxy'
        ? !!(apiKey && this.settings.get<string>('proxyBaseUrl', ''))
        : !!(apiKey && apiKey.trim())
      return {
        id: ch.id,
        displayName: ch.displayName,
        configured,
        isDefault: ch.id === defaultProvider,
      }
    })
  }

  /**
   * 🔧 V6 新增：获取 TTS 引擎状态列表（2 个引擎）
   *   读 settings 检测配置
   */
  private getTTSEngines(): TTSEngineStatus[] {
    const currentDefault = this.settings.get<string>('ttsProvider', 'edge')

    const engines: Array<{
      id: string; displayName: string; builtin: boolean; check: () => boolean
    }> = [
      { id: 'edge', displayName: 'Edge TTS', builtin: true, check: () => true },
      {
        id: 'doubao',
        displayName: '豆包 TTS',
        builtin: false,
        check: () => !!(this.settings.get<string>('doubaoTtsAppId', '') &&
                       this.settings.get<string>('doubaoTtsToken', ''))
      },
    ]

    return engines.map(e => ({
      id: e.id,
      displayName: e.displayName,
      available: e.check(),
      isDefault: e.id === currentDefault,
      builtin: e.builtin,
    }))
  }

  /**
   * 🔧 V8 新增：触发 pip install 安装缺失依赖
   * fire-and-forget：POST /api/install_dep 立即返回 task_id，进度通过订阅 SSE 流获取
   * @param packages 待安装的 pip 包名列表（如 ['demucs', 'transformers']）
   * @returns { task_id, status } 启动结果
   */
  async installDep(packages: string[]): Promise<{ task_id: string; status: string } | null> {
    try {
      const daemon = AIDaemon.getInstance()
      if (!daemon.isOnline()) {
        throw new Error('AI 运行时离线，无法安装依赖')
      }
      const port = daemon.getPort()
      const { HttpClient } = await import('../core/HttpClient')
      // 🔧 修复 TS2353：HttpClient.post 第三参数只支持 { signal? }，不支持 timeout
      const res = await HttpClient.post(
        `http://127.0.0.1:${port}/api/install_dep`,
        { packages }
      )
      return res
    } catch (e: any) {
      throw new Error(`触发安装失败: ${e.message}`)
    }
  }

  /**
   * 🚀 阶段 3 新增：查询 GPU/CUDA 状态
   * 调用 ai_daemon /api/gpu/status 端点，返回 torch 版本、显卡型号、CUDA 可用性等
   * @returns GpuStatus 对象，AI 运行时离线时返回 null
   */
  async getGpuStatus(): Promise<GpuStatus | null> {
    try {
      const daemon = AIDaemon.getInstance()
      if (!daemon.isOnline()) return null
      const port = daemon.getPort()
      // 用 fetch 直接调用，加 5 秒超时（HttpClient.get 不支持 timeout 参数）
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 5000)
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/gpu/status`, {
          signal: controller.signal
        })
        if (!res.ok) return null
        return await res.json() as GpuStatus
      } finally {
        clearTimeout(timeoutId)
      }
    } catch (e: any) {
      // GPU 状态查询失败不抛异常，返回 null 让前端降级显示
      console.warn('[HealthService] getGpuStatus 失败:', e.message)
      return null
    }
  }

  /**
   * 🚀 阶段 3 新增：触发 CUDA 版 torch 安装
   * 调用 ai_daemon POST /api/gpu/install_cuda，立即返回 task_id
   * 安装流程：卸载 CPU 版 → 装 cu121 版 → 验证 → 失败自动回滚 CPU 版
   * @returns { task_id, status } 启动结果
   */
  async installCudaTorch(): Promise<{ task_id: string; status: string } | null> {
    try {
      const daemon = AIDaemon.getInstance()
      if (!daemon.isOnline()) {
        throw new Error('AI 运行时离线，无法安装 CUDA 版 torch')
      }
      const port = daemon.getPort()
      const { HttpClient } = await import('../core/HttpClient')
      const res = await HttpClient.post(
        `http://127.0.0.1:${port}/api/gpu/install_cuda`,
        {}
      )
      return res
    } catch (e: any) {
      throw new Error(`触发 CUDA 安装失败: ${e.message}`)
    }
  }

  /**
   * 🚀 阶段 3 新增：订阅 CUDA 版 torch 安装进度 SSE 流
   * @param taskId installCudaTorch 返回的 task_id
   * @param onProgress 进度回调
   * @param signal 取消信号
   */
  async subscribeGpuInstallProgress(
    taskId: string,
    onProgress: (progress: GpuInstallProgress) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const port = AIDaemon.getInstance()?.getPort() || 34567
    const url = `http://127.0.0.1:${port}/api/gpu/install_stream/${taskId}`

    try {
      const res = await fetch(url, { signal })
      if (!res.ok || !res.body) {
        onProgress({
          status: 'error', percent: 0, message: `SSE 连接失败: HTTP ${res.status}`,
          current_step: null, error: `HTTP ${res.status}`
        })
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        if (signal?.aborted) break
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const progress = JSON.parse(line.slice(6)) as GpuInstallProgress
            onProgress(progress)
            if (progress.status === 'done' || progress.status === 'error') return
          } catch {
            // 单行解析失败跳过
          }
        }
      }
    } catch (e: any) {
      if (e.name === 'AbortError') return
      onProgress({
        status: 'error', percent: 0, message: e.message,
        current_step: null, error: e.message
      })
    }
  }

  /**
   * 🔧 V8 新增：订阅安装进度 SSE 流
   * 调用方传入 onProgress 回调，流结束或异常时回调 done=true
   * @param taskId  install_dep 返回的 task_id
   * @param onProgress 进度回调 (progress 对象)
   * @param signal 取消信号
   */
  async subscribeInstallProgress(
    taskId: string,
    onProgress: (progress: InstallProgress) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const port = AIDaemon.getInstance()?.getPort() || 34567
    const url = `http://127.0.0.1:${port}/api/install_dep/stream/${taskId}`

    try {
      const res = await fetch(url, { signal })
      if (!res.ok || !res.body) {
        onProgress({ status: 'error', error: `SSE 连接失败: HTTP ${res.status}`, percent: 0, message: '', total: 0, installed: [], current: null })
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        if (signal?.aborted) break
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const progress = JSON.parse(line.slice(6)) as InstallProgress
            onProgress(progress)
            if (progress.status === 'done' || progress.status === 'error') return
          } catch {
            // 单行解析失败跳过
          }
        }
      }
    } catch (e: any) {
      if (e.name === 'AbortError') return
      onProgress({ status: 'error', error: e.message, percent: 0, message: '', total: 0, installed: [], current: null })
    }
  }
}

/**
 * 🔧 V8 新增：pip install 进度 payload（与 ai_daemon _install_progress 对齐）
 */
export interface InstallProgress {
  status: 'pending' | 'downloading' | 'installing' | 'done' | 'error'
  total: number
  installed: string[]
  current: string | null
  percent: number
  message: string
  error: string | null
}

/**
 * 🚀 阶段 3 新增：GPU/CUDA 状态信息（与 ai_daemon._detect_gpu_info 对齐）
 */
export interface GpuStatus {
  cuda_available: boolean           // torch.cuda.is_available() 结果
  device_count: number              // 可见 GPU 数量
  devices: Array<{ name: string; vram_mb: number }>  // GPU 设备列表
  torch_version: string             // torch 版本（如 "2.7.0+cpu" / "2.7.0+cu121"）
  is_cuda_torch: boolean            // 当前 torch 是否为 CUDA 版
  cuda_version: string | null       // CUDA 运行时版本
  needs_cuda_install: boolean       // 是否需要安装 CUDA 版（有 NVIDIA GPU + 当前为 CPU 版）
}

/**
 * 🚀 阶段 3 新增：CUDA 版 torch 安装进度（与 ai_daemon._gpu_install_progress 对齐）
 */
export interface GpuInstallProgress {
  status: 'pending' | 'uninstalling' | 'installing' | 'done' | 'error' | 'rollback'
  percent: number
  message: string
  current_step: 'uninstall_cpu' | 'install_cuda' | 'verify' | 'rollback' | null
  error: string | null
}
