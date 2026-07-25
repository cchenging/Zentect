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
  id: string;             // edge/doubao/fish/sovits/moss
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
      return AIDaemon.getInstance().isTTSReady();
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
      const res = await HttpClient.get(`http://127.0.0.1:${port}/api/check_deps`, { timeout: 5000 })
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
   * 🔧 V6 新增：获取 AI 运行时包列表（torch/torchaudio/demucs/funasr/transformers/tokenizers）
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
    }
    const pkgDisplayName: Record<string, string> = {
      torch: 'PyTorch',
      torchaudio: 'Torchaudio',
      demucs: 'Demucs',
      funasr: 'FunASR',
      transformers: 'Transformers',
      tokenizers: 'Tokenizers',
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
      const res = await HttpClient.get(`http://127.0.0.1:${port}/api/check_deps`, { timeout: 5000 })
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
   * 🔧 V6 新增：获取 TTS 引擎状态列表（5 个引擎）
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
      {
        id: 'fish',
        displayName: 'Fish Speech',
        builtin: false,
        check: () => !!this.settings.get<string>('fishKey', '')
      },
      {
        id: 'sovits',
        displayName: 'SoVITS',
        builtin: false,
        check: () => !!this.settings.get<string>('sovitsUrl', '')
      },
      {
        id: 'moss',
        displayName: 'Moss',
        builtin: false,
        check: () => !!(this.settings.get<string>('mossUrl', '') &&
                       this.settings.get<string>('mossModelDir', ''))
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
}
