// 📁 路径: src/main/database/repositories/ModelRepository.ts
import { SQLiteConnection } from '../core/SQLiteConnection';

/**
 * 本地模型数据访问层
 * 负责对 local_models 表的 CRUD 操作
 */
export class ModelRepository {
  private get db() { return SQLiteConnection.getInstance().getDB(); }

  /**
   * 获取所有模型列表
   * @returns 模型记录数组
   */
  public findAll() {
    return this.db.prepare(`
      SELECT id, name, type, description, version, size_bytes, status,
             download_path, remote_url, md5_checksum, downloaded_at,
             created_at, updated_at
      FROM local_models
      ORDER BY created_at DESC
    `).all();
  }

  /**
   * 按 ID 查找模型
   * @param id 模型唯一标识
   * @returns 模型记录或 undefined
   */
  public findById(id: string) {
    return this.db.prepare(`
      SELECT id, name, type, description, version, size_bytes, status,
             download_path, remote_url, md5_checksum, downloaded_at,
             created_at, updated_at
      FROM local_models
      WHERE id = @id
    `).get({ id });
  }

  /**
   * 按类型查找模型
   * @param type 模型类型（如 asr, tts, llm 等）
   * @returns 匹配的模型记录数组
   */
  public findByType(type: string) {
    return this.db.prepare(`
      SELECT id, name, type, description, version, size_bytes, status,
             download_path, remote_url, md5_checksum, downloaded_at,
             created_at, updated_at
      FROM local_models
      WHERE type = @type
      ORDER BY created_at DESC
    `).all({ type });
  }

  /**
   * 插入模型记录
   * @param model 模型数据对象
   * @returns 写入后的安全模型记录
   */
  public insert(model: any) {
    const now = new Date().toISOString();
    const safeModel = {
      id: model.id,
      name: model.name,
      type: model.type,
      description: model.description || null,
      version: model.version || null,
      size_bytes: model.size_bytes || 0,
      status: model.status || 'not_downloaded',
      download_path: model.download_path || null,
      remote_url: model.remote_url || null,
      md5_checksum: model.md5_checksum || null,
      downloaded_at: model.downloaded_at || null,
      created_at: model.created_at || now,
      updated_at: model.updated_at || now,
    };

    this.db.prepare(`
      INSERT INTO local_models (id, name, type, description, version, size_bytes,
        status, download_path, remote_url, md5_checksum, downloaded_at, created_at, updated_at)
      VALUES (@id, @name, @type, @description, @version, @size_bytes,
        @status, @download_path, @remote_url, @md5_checksum, @downloaded_at, @created_at, @updated_at)
    `).run(safeModel);

    return safeModel;
  }

  /**
   * 更新模型状态
   * @param id 模型 ID
   * @param status 新状态值
   */
  public updateStatus(id: string, status: string) {
    this.db.prepare(`
      UPDATE local_models SET status = @status, updated_at = datetime('now', 'localtime')
      WHERE id = @id
    `).run({ id, status });
  }

  /**
   * 更新模型版本
   * @param id 模型 ID
   * @param version 新版本号
   */
  public updateVersion(id: string, version: string) {
    this.db.prepare(`
      UPDATE local_models SET version = @version, updated_at = datetime('now', 'localtime')
      WHERE id = @id
    `).run({ id, version });
  }

  /**
   * 更新模型下载路径
   * @param id 模型 ID
   * @param downloadPath 下载路径
   */
  public updateDownloadPath(id: string, downloadPath: string) {
    this.db.prepare(`
      UPDATE local_models SET download_path = @downloadPath, updated_at = datetime('now', 'localtime')
      WHERE id = @id
    `).run({ id, downloadPath });
  }

  /**
   * 更新模型全部字段
   * @param model 包含完整字段的模型对象
   */
  public updateAll(model: any) {
    this.db.prepare(`
      UPDATE local_models SET
        name = @name,
        type = @type,
        description = @description,
        version = @version,
        size_bytes = @size_bytes,
        status = @status,
        download_path = @download_path,
        remote_url = @remote_url,
        md5_checksum = @md5_checksum,
        downloaded_at = @downloaded_at,
        updated_at = datetime('now', 'localtime')
      WHERE id = @id
    `).run({
      id: model.id,
      name: model.name,
      type: model.type,
      description: model.description || null,
      version: model.version || null,
      size_bytes: model.size_bytes || 0,
      status: model.status,
      download_path: model.download_path || null,
      remote_url: model.remote_url || null,
      md5_checksum: model.md5_checksum || null,
      downloaded_at: model.downloaded_at || null,
    });
  }

  /**
   * 删除模型记录
   * @param id 模型 ID
   */
  public deleteById(id: string) {
    this.db.prepare(`
      DELETE FROM local_models WHERE id = @id
    `).run({ id });
  }
}

/**
 * 管线模型配置数据访问层
 * 负责对 pipeline_model_config 表的 CRUD 操作
 */
export class PipelineModelConfigRepository {
  private get db() { return SQLiteConnection.getInstance().getDB(); }

  /**
   * 查找项目的所有管线模型配置
   * @param projectId 项目 ID
   * @returns 配置记录数组
   */
  public findByProjectId(projectId: string) {
    return this.db.prepare(`
      SELECT id, project_id, node_type, provider, model_name,
             custom_base_url, config_json, created_at, updated_at
      FROM pipeline_model_config
      WHERE project_id = @projectId
      ORDER BY node_type
    `).all({ projectId });
  }

  /**
   * 查找项目中特定节点类型的配置
   * @param projectId 项目 ID
   * @param nodeType 节点类型
   * @returns 配置记录或 undefined
   */
  public findByProjectAndNodeType(projectId: string, nodeType: string) {
    return this.db.prepare(`
      SELECT id, project_id, node_type, provider, model_name,
             custom_base_url, config_json, created_at, updated_at
      FROM pipeline_model_config
      WHERE project_id = @projectId AND node_type = @nodeType
    `).get({ projectId, nodeType });
  }

  /**
   * 插入或更新配置（upsert）
   * @param config 配置数据对象
   * @returns 写入后的安全配置记录
   */
  public upsert(config: any) {
    const now = new Date().toISOString();
    const safeConfig = {
      id: config.id || `${config.project_id}_${config.node_type}`,
      project_id: config.project_id,
      node_type: config.node_type,
      provider: config.provider,
      model_name: config.model_name,
      custom_base_url: config.custom_base_url || null,
      config_json: config.config_json || null,
      created_at: config.created_at || now,
      updated_at: now,
    };

    this.db.prepare(`
      INSERT INTO pipeline_model_config (id, project_id, node_type, provider, model_name,
        custom_base_url, config_json, created_at, updated_at)
      VALUES (@id, @project_id, @node_type, @provider, @model_name,
        @custom_base_url, @config_json, @created_at, @updated_at)
      ON CONFLICT(project_id, node_type) DO UPDATE SET
        provider = @provider,
        model_name = @model_name,
        custom_base_url = @custom_base_url,
        config_json = @config_json,
        updated_at = @updated_at
    `).run(safeConfig);

    return safeConfig;
  }

  /**
   * 删除项目的所有管线模型配置
   * @param projectId 项目 ID
   */
  public deleteByProject(projectId: string) {
    this.db.prepare(`
      DELETE FROM pipeline_model_config WHERE project_id = @projectId
    `).run({ projectId });
  }
}
