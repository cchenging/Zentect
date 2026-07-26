// 📁 路径: src/main/utils/pathManager.ts
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../modules/infra/logger/LogConstants';
import { SettingsRepository } from '../database/repositories/SettingsRepository';
import { SQLiteConnection } from '../database/core/SQLiteConnection';

export class PathManager {
  private static dataRootPath: string;
  private static settingsRepo: SettingsRepository | null = null;

  /** 项目 ID → 真实物理目录路径的映射缓存 */
  private static projectDirCache = new Map<string, string>();

  public static initialize() {
    const projectRoot = app.isPackaged ? path.dirname(app.getPath('exe')) : process.cwd();
    let targetDataPath = path.join(projectRoot, 'data'); 

    try {
      if (!fs.existsSync(targetDataPath)) fs.mkdirSync(targetDataPath, { recursive: true });
      const testFile = path.join(targetDataPath, '.permission_test');
      fs.writeFileSync(testFile, 'test');
      fs.unlinkSync(testFile); 
    } catch (error) {
      targetDataPath = path.join(app.getPath('userData'), 'magic-one-data-fallback');
      if (!fs.existsSync(targetDataPath)) fs.mkdirSync(targetDataPath, { recursive: true });
    }

    this.dataRootPath = targetDataPath;

    const coreDirs = ['database', 'projects', 'exports', 'logs', 'tts_output'];
    for (const dir of coreDirs) {
      const fullPath = path.join(this.dataRootPath, dir);
      if (!fs.existsSync(fullPath)) fs.mkdirSync(fullPath, { recursive: true });
    }

    // 💥 终极注入：跨端环境保护墙！
    this.injectArsenalEnvironment();
  }

  /**
   * 💥 将兵器库路径强行注入当前 Node 与 Python 进程的上下文！
   */
  private static injectArsenalEnvironment() {
    const binDir = path.join(this.getResourcesPath(), 'bin', this.getPlatformDir());
    const modelsDir = path.join(this.getResourcesPath(), 'models');
    
    // 1. 注入 PATH：让底层的跨语言调用瞬间找到身边的 dll/dylib！
    process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;
    
    // 2. 注入模型库指针：Python 脚本可以直接读取 os.environ.get('MAGIC_MODELS_DIR')
    process.env.MAGIC_MODELS_DIR = modelsDir;
    
    AppLogger.info(LOG_TAGS.SYSTEM, `✅ 兵器库已挂载: PATH 注入 [${this.getPlatformDir()}], 模型指向 [${modelsDir}]`);
  }

  // =====================================================================
  // 💥 兵器库寻址雷达 (Arsenal Radar)
  // =====================================================================
  
  public static getResourcesPath(): string {
    return app.isPackaged ? process.resourcesPath : path.join(process.cwd(), 'resources');
  }

  /**
   * 获取便携 Python 环境（ai-env）的根目录路径
   * 发版内置，路径形态：resources/ai-env/
   */
  public static getAiEnvPath(): string {
    return path.join(this.getResourcesPath(), 'ai-env');
  }

  /**
   * 获取便携 Python 解释器路径
   *
   * 兼容两种 ai-env 目录结构：
   *  - embeddable Python（推荐，发版内置）: resources/ai-env/python.exe
   *    特点：解压即用，无 Scripts 子目录，python.exe 直接在 ai-env 根目录
   *  - venv 风格（开发期/历史兼容）: resources/ai-env/Scripts/python.exe
   *    特点：通过 `python -m venv` 创建，python.exe 在 Scripts 子目录下
   *
   * macOS/Linux 仍走 venv 风格路径：resources/ai-env/bin/python
   * 若都不存在则返回 null，调用方需降级到系统 Python
   */
  public static getAiEnvPythonPath(): string | null {
    const aiEnvPath = this.getAiEnvPath();
    // 候选路径数组：按优先级顺序检查，第一个命中即返回
    const candidates: string[] = process.platform === 'win32'
      ? [
          path.join(aiEnvPath, 'python.exe'),              // embeddable Python（首选）
          path.join(aiEnvPath, 'Scripts', 'python.exe'),   // venv 风格（兼容旧版）
        ]
      : [path.join(aiEnvPath, 'bin', 'python')];           // macOS/Linux venv
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  public static getPlatformDir(): string {
    return process.platform === 'win32' ? 'win' : (process.platform === 'darwin' ? 'mac' : 'linux');
  }

  public static getExeName(baseName: string): string {
    return process.platform === 'win32' ? `${baseName}.exe` : baseName;
  }

  public static getBinPath(binName: string): string {
    return path.join(this.getResourcesPath(), 'bin', this.getPlatformDir(), binName);
  }

  public static getModelPath(category: string, modelName: string): string {
    return path.join(this.getResourcesPath(), 'models', category, modelName);
  }

  public static getScriptPath(scriptName: string): string {
    return path.join(this.getResourcesPath(), 'scripts', scriptName);
  }

  private static getSettings() {
    if (!this.settingsRepo) this.settingsRepo = new SettingsRepository();
    return this.settingsRepo;
  }

  public static getResourceScriptPath(scriptName: string): string {
    const rootPath = app.isPackaged ? process.resourcesPath : path.join(process.cwd(), 'resources');
    return path.join(rootPath, scriptName);
  }

  public static getDatabasePath(): string { return path.join(this.dataRootPath, 'database', 'database.sqlite'); }
  
  public static getProjectsPath(): string {
    try {
      const customPath = this.getSettings().get<string>('projectPath', '');
      if (customPath && fs.existsSync(customPath)) return customPath;
    } catch(e) {}
    const dir = path.join(this.dataRootPath, 'projects');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  
  public static getProjectsRootPath(): string { return this.getProjectsPath(); }
  
  // 💥 全新设计：项目的独立沙盒体系！
  public static getProjectMediaDir(projectId: string): string {
    const dir = path.join(this.getProjectDir(projectId), 'media');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  // 项目专属缩略图目录 (存放素材封面、项目主封面)
  public static getProjectThumbnailsDir(projectId: string): string {
    const dir = path.join(this.getProjectDir(projectId), 'thumbnails');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  // 项目专属副产物目录 (Frames, Audio, Faces, Whisper, Transcoded)
  public static getProjectExtractionsDir(projectId: string, subType: 'frames' | 'faces' | 'audio' | 'whisper' | 'transcoded'): string {
    const dir = path.join(this.getProjectDir(projectId), 'extractions', subType);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  public static getLogsPath(): string { return path.join(this.dataRootPath, 'logs'); }

  /** TTS 音频输出统一目录（试听 + 合成共用） */
  public static getTTSOutputDir(): string {
    const dir = path.join(this.dataRootPath, 'tts_output');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  public static getUserDataPath(): string { return this.dataRootPath; }
  
  public static getScriptsPath(): string {
    const rootPath = app.isPackaged ? process.resourcesPath : process.cwd();
    return path.join(rootPath, 'resources', 'scripts');
  }
  
  public static getModelsPath(): string {
    const rootPath = app.isPackaged ? process.resourcesPath : process.cwd();
    return path.join(rootPath, 'resources', 'models');
  }

  // 🔧 修复 TS2339：新增 getCacheRootPath（index.ts/magic.ts 调用但原代码缺失）
  /** 全局缓存根目录（区别于项目级 extractions） */
  public static getCacheRootPath(): string {
    const dir = path.join(this.dataRootPath, 'zentect-cache');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  public static getExportRootPath(): string {
    try {
      const customPath = this.getSettings().get<string>('exportPath', '');
      if (customPath && fs.existsSync(customPath)) return customPath;
    } catch(e) {}
    const dir = path.join(this.dataRootPath, 'exports');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  
  public static getProjectExportDir(projectId: string): string {
    const dir = path.join(this.getExportRootPath(), projectId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  
  // ==========================================
  // 💥 架构 A 核心：获取工程专属的物理隔离文件夹
  // 例如：F:\Tools\Zentect\data\projects\我的视频
  // 支持项目改名后目录跟随显示名变化
  // ==========================================
  static getProjectDir(projectId: string): string {
    if (!projectId) throw new Error("获取项目目录失败：未提供 projectId");

    const realDir = this.resolveProjectDir(projectId);
    if (!fs.existsSync(realDir)) fs.mkdirSync(realDir, { recursive: true });
    return realDir;
  }

  /**
   * 解析项目的真实物理目录路径（不自动创建目录）
   * 查找优先级：内存缓存 → DB path 字段 → 默认 {root}/{id}
   */
  private static resolveProjectDir(projectId: string): string {
    // 1. 内存缓存（改名后立即生效，无需重启）
    const cached = this.projectDirCache.get(projectId);
    if (cached && fs.existsSync(cached)) return cached;

    // 2. 惰性从 DB 加载（重启后首次调用时）
    try {
      const db = SQLiteConnection.getInstance().getDB();
      const row = db.prepare("SELECT path FROM projects WHERE id = ? AND is_deleted = 0").get(projectId) as any;
      if (row?.path && fs.existsSync(row.path)) {
        this.projectDirCache.set(projectId, row.path);
        return row.path;
      }
    } catch {
      // DB 未就绪或 projects 表不存在，降级
    }

    // 3. 默认降级：{projectsRoot}/{id}
    return path.join(this.getProjectsRootPath(), projectId);
  }

  /**
   * 更新项目 ID → 物理目录的映射缓存
   * 供 ProjectService 在创建/改名时调用
   */
  static setProjectDir(projectId: string, dir: string): void {
    this.projectDirCache.set(projectId, dir);
  }

  /**
   * 清除指定项目的目录缓存（删除项目时调用）
   */
  static clearProjectDirCache(projectId: string): void {
    this.projectDirCache.delete(projectId);
  }

  // 👇 ============ 新增增量代码开始 ============ 👇

  /**
   * 💥 工业级 L2 缓存基建：获取节点专属基础目录 (用于垃圾回收)
   * 路径形态：项目根目录/nodes/节点ID/资产分类/
   */
  public static getNodeBaseDir(projectId: string, nodeId: string, assetType: 'frames' | 'audio' | 'whisper'): string {
    const dir = path.join(this.getProjectDir(projectId), 'nodes', nodeId, assetType);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * 💥 工业级 L2 缓存基建：获取特定状态哈希的专属沙箱抽屉 (用于物理存储)
   * 路径形态：项目根目录/nodes/节点ID/资产分类/哈希指纹/
   */
  public static getNodeL2CacheDir(projectId: string, nodeId: string, assetType: 'frames' | 'audio' | 'whisper', stateHash: string): string {
    const dir = path.join(this.getNodeBaseDir(projectId, nodeId, assetType), stateHash);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  // 👆 ============ 新增增量代码结束 ============ 👆

  /**
   * 确保目录存在，不存在则递归创建
   */
  public static ensureDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }
}
