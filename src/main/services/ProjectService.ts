// 📁 路径: src/main/services/ProjectService.ts
import fs from 'fs/promises';
import path from 'path';
import { ProjectRepository } from '../database/repositories/ProjectRepository';
import { TaskRepository } from '../database/repositories/TaskRepository';
import { PathManager } from '../utils/pathManager';
import { Validator } from '../../shared/utils/Validator';
import { AppError, ErrorCode } from '../../shared/utils/AppError';
import { SQLiteConnection } from '../database/core/SQLiteConnection';
import * as fsSync from 'fs';

export class ProjectService {
  private repo = new ProjectRepository();
  private taskRepo = new TaskRepository();

  private readonly HYDRATE_FIELDS = ['coverPath', 'cover', 'audioPath', 'avatar', 'vocalsPath', 'bgmPath'];
  private readonly HYDRATE_ARRAY_FIELDS = ['contextFrames'];

  // 💥 内部工具 1：生成绝对安全的系统级 ID
  private generateSafeId(prefix: string = 'proj'): string {
    // 格式: proj_时间戳_随机6位 (例如: proj_1713700000_a8b2c9)
    return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }

  // 💥 内部工具 2：生成规定格式的日期名称 (YY年M月D日)
  private getFormattedDateName(): string {
    const date = new Date();
    const yy = String(date.getFullYear()).slice(-2);
    const m = date.getMonth() + 1;
    const d = date.getDate();
    return `${yy}年${m}月${d}日`;
  }

  // 💥 内部工具 3：数据库查重与自动后缀分配（可排除当前项目自身）
  private generateUniqueName(baseName: string, excludeProjectId?: string): string {
    const db = SQLiteConnection.getInstance().getDB();
    
    // 模糊查询所有以 baseName 开头的项目名
    const rows = db.prepare(`SELECT id, name FROM projects WHERE name LIKE ? AND is_deleted = 0`).all(`${baseName}%`) as {id: string; name: string}[];
    const existingNames = new Set(
      rows.filter(r => r.id !== excludeProjectId).map(r => r.name)
    );

    // 如果原名没有被占用，直接返回
    if (!existingNames.has(baseName)) {
      return baseName;
    }

    // 循环探测 (1), (2), (3) ...
    let counter = 1;
    let newName = `${baseName}(${counter})`;
    while (existingNames.has(newName)) {
      counter++;
      newName = `${baseName}(${counter})`;
    }
    return newName;
  }

  public hydratePaths(data: any, projectId: string) {
    if (!data) return data;
    const prefix = `magic://${projectId}/`;
    const transform = (val: any) => {
      if (typeof val === 'string' && !val.startsWith('http') && !val.startsWith('magic://') && !path.isAbsolute(val)) {
          if (val.includes('/') || val.includes('\\')) return `${prefix}${val.replace(/\\/g, '/')}`;
      }
      return val;
    };
    const processItem = (item: any) => {
        if (!item) return;
        this.HYDRATE_FIELDS.forEach(field => { if (item[field]) item[field] = transform(item[field]); });
        this.HYDRATE_ARRAY_FIELDS.forEach(field => { if (Array.isArray(item[field])) item[field] = item[field].map(transform); });
    };
    if (data.mediaItems) data.mediaItems.forEach(processItem);
    if (data.roles) data.roles.forEach(processItem);
    if (data.shots) data.shots.forEach(processItem);
    if (data.aiShots) data.aiShots.forEach(processItem);
    return data;
  }

  public dehydratePaths(data: any, projectId: string) {
    if (!data) return data;
    const prefix = `magic://${projectId}/`;
    const transform = (val: any) => {
      if (typeof val === 'string' && val.startsWith(prefix)) return val.replace(prefix, '');
      return val;
    };
    const processItem = (item: any) => {
        if (!item) return;
        this.HYDRATE_FIELDS.forEach(field => { if (item[field]) item[field] = transform(item[field]); });
        this.HYDRATE_ARRAY_FIELDS.forEach(field => { if (Array.isArray(item[field])) item[field] = item[field].map(transform); });
    };
    if (data.mediaItems) data.mediaItems.forEach(processItem);
    if (data.roles) data.roles.forEach(processItem);
    if (data.shots) data.shots.forEach(processItem);
    if (data.aiShots) data.aiShots.forEach(processItem);
    return data;
  }

  public loadData(id: string) { 
    const rawData = this.repo.loadFullProjectData(id); 
    return this.hydratePaths(rawData, id);
  }

  public saveData(id: string, data: any) { 
    const cleanData = this.dehydratePaths(data, id);
    this.repo.saveFullProjectData(id, cleanData); 
    return true; 
  }

  public getList() { return this.repo.findAll().map(p => ({ ...p })); }
  public getRecent() { return this.repo.findAll().slice(0, 5).map(p => ({ ...p })); }

  /**
   * 🚀 重构后的核心创建逻辑：接管 ID 与命名权
   * @param payload 创建参数 { name?: string, type?: string }
   * @returns 项目数据对象
   */
  public async createProject(payload: { name?: string, type?: string }) {
    // 1. 生成物理安全的 ID
    const safeId = this.generateSafeId('proj');

    // 2. 决定最终的 UI 显示名称（所有情况都走查重）
    let finalName = payload.name?.trim();
    if (!finalName || finalName === '未命名' || finalName === '未命名项目' || finalName.includes('未命名工作流')) {
      finalName = this.getFormattedDateName();
    }
    // 无论是默认日期名还是用户自定义名，统一走查重逻辑
    finalName = this.generateUniqueName(finalName);

    // 3. 计算物理路径并创建文件夹
    const projectPath = PathManager.getProjectDir(safeId);
    if (!fsSync.existsSync(projectPath)) {
      fsSync.mkdirSync(projectPath, { recursive: true });
    }
    // 注册目录映射缓存
    PathManager.setProjectDir(safeId, projectPath);

    // 💥 剥离数据库操作，只声明业务数据
    const projectData = {
      id: safeId,             // ✅ 物理主键：绝对没有中文和空格
      name: finalName,        // ✅ UI显示名：给用户看的，爱怎么改怎么改
      type: payload.type || 'workflow',
      path: projectPath       // 👈 补回 path，防止 SQLite 报 NOT NULL 或前端旧代码报错
      // 注意：不再写死 create_time，交给 Repo 去打钢印
    };

    // 💥 通过仓储层安全写入
    const insertedRecord = this.repo.insert(projectData);

    return insertedRecord;
  }

  /**
   * @deprecated 保留向后兼容，内部调用新的 createProject
   */
  public async createProjectLegacy(name: string = '未命名项目'): Promise<string> {
    const result = await this.createProject({ name, type: 'video' });
    return result.id;
  }

  public async deleteProject(id: string): Promise<void> {
    // 先获取真实物理目录（可能在改名后不再是 {root}/{id}）
    const realDir = PathManager.getProjectDir(id);
    this.repo.delete(id);
    PathManager.clearProjectDirCache(id);
    try {
      await fs.rm(realDir, { recursive: true, force: true });
    } catch (e) {
      // 目录不存在，跳过
    }
  }

  // 💥 改名时：查重自动后缀 + 物理目录跟随改名 + DB path + 缓存全同步
  public async renameProject(id: string, newName: string): Promise<void> { 
    const val = Validator.validateProjectName(newName);
    if (!val.valid) throw new AppError(val.errorKey as ErrorCode);

    // 查重 + 自动后缀（排除自身，避免改名时误判冲突）
    const resolvedName = this.generateUniqueName(newName, id);

    // 获取当前真实物理目录
    const oldDir = PathManager.getProjectDir(id);
    const newDir = path.join(PathManager.getProjectsRootPath(), resolvedName);

    // 物理目录改名
    if (oldDir !== newDir) {
        try {
            if (fsSync.existsSync(oldDir)) {
                await fs.rename(oldDir, newDir);
            }
        } catch (e) {
            // 目录不存在或其他错误，跳过物理改名（可能是空项目）
            // 但仍更新 DB 和缓存中的路径
        }
    }

    // 同步更新 DB 的 name 和 path
    this.repo.updateNameAndPath(id, resolvedName, newDir);
    // 更新 PathManager 内存缓存
    PathManager.setProjectDir(id, newDir);
  }

  public getById(id: string) { return this.repo.findById(id); }
  public replaceAiShots(id: string, shots: any[]) { this.repo.replaceAiShots(id, shots); return true; }
  public updateShotFeatures(id: string, features: any) { this.repo.updateShotFeatures(id, features); return true; }
  public getAllTasks(projectId: string) { return this.taskRepo.getTasksByProject(projectId); }
  
  public async duplicateProject(id: string) {
    const oldProject = this.repo.findById(id);
    if (!oldProject) {
      throw new Error('Project not found');
    }
    
    const suffix = `_copy_${Date.now()}`;
    const newId = `${id}${suffix}`;
    const newName = this.generateUniqueName(`${oldProject.name}_副本`);
    
    // 使用 getProjectDir 获取源项目真实路径（可能已改名）
    const oldPath = PathManager.getProjectDir(id);
    const newPath = PathManager.getProjectDir(newId);
    
    if (fsSync.existsSync(oldPath)) {
      fsSync.cpSync(oldPath, newPath, { recursive: true });
    }
    PathManager.setProjectDir(newId, newPath);
    
    this.repo.duplicate(id, newId, newName, suffix, oldProject, newPath);
    
    return { success: true, projectId: newId, name: newName };
  }

  /**
   * 🚀 模板实例化逻辑同样适用此规则
   * @param templateId 模板 ID
   * @returns 实例化结果 { success, projectId, name }
   */
  public async instantiateTemplate(_templateId: string) {
     // 直接复用上面的新建逻辑生成基础底座，保证命名规范统一
     // 不传 name，让后端自动使用日期命名规则
     const projectData = await this.createProject({ type: 'workflow' });
     
     // TODO: 接下来执行克隆模板 Nodes 和 Edges 的代码
     
     return { success: true, projectId: projectData.id, name: projectData.name };
  }
}
