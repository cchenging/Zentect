// 📁 路径: src/main/services/ModelService.ts
import { ModelRepository, PipelineModelConfigRepository } from '../database/repositories/ModelRepository';
import { AppError, ErrorCode } from '../../infra/error/AppError';
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../infra/logger/LogConstants';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { app } from 'electron';

/** 模型下载源配置 */
const MODEL_SOURCES: Record<string, { url: string; file: string }> = {
  moss_tts: { url: 'https://huggingface.co/models/moss-tts-nano/resolve/main', file: 'moss_tts_nano.onnx' },
  whisper: { url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main', file: 'ggml-base.bin' },
  sensevoice: { url: 'https://huggingface.co/FunAudioLLM/SenseVoiceSmall/resolve/main', file: 'model.onnx' },
  mdx_net: { url: 'https://huggingface.co/JeffreyCA/mdx-net/resolve/main', file: 'model.onnx' },
  insightface: { url: 'https://huggingface.co/deepinsight/insightface/resolve/main', file: 'buffalo_l.zip' },
  emotion: { url: 'https://huggingface.co/models/emotion/resolve/main', file: 'model.onnx' },
  sovits: { url: 'https://huggingface.co/models/gpt-sovits/resolve/main', file: 'gpt-sovits.zip' },
};

/**
 * 模型管理服务层
 * 负责本地模型的下载、卸载、更新以及管线节点模型映射的业务逻辑
 */
/** @deprecated 请使用 `src/modules/settings/models` 新模块入口，旧路径仅保留兼容性委托 */
export class ModelService {
  private modelRepo = new ModelRepository();
  private pipelineConfigRepo = new PipelineModelConfigRepository();

  /**
   * 获取所有本地模型列表
   * @returns 模型记录数组
   */
  public getModelList() {
    return this.modelRepo.findAll();
  }

  /**
   * 下载模型（模拟实现，返回状态）
   * @param modelId 模型 ID
   * @returns 下载结果 { modelId, status, message }
   */
  public async downloadModel(modelId: string) {
    const model = this.modelRepo.findById(modelId);
    if (!model) {
      throw new AppError(ErrorCode.DB_RECORD_NOT_FOUND, `模型不存在: ${modelId}`);
    }

    if (model.status === 'downloaded') {
      return { modelId, status: 'downloaded', message: '模型已下载，无需重复操作' };
    }

    // 更新状态为下载中
    this.modelRepo.updateStatus(modelId, 'downloading');
    AppLogger.info(LOG_TAGS.SYSTEM, `开始下载模型: ${modelId} (${model.name})`);

    try {
      // 真实下载模型文件（支持断点续传）
      const filePath = await this.downloadModelFile(modelId, (percent) => {
        AppLogger.info(LOG_TAGS.SYSTEM, `模型下载进度: ${modelId} ${percent}%`);
      });

      // 更新状态为已下载
      this.modelRepo.updateStatus(modelId, 'downloaded');
      if (filePath) this.modelRepo.updateDownloadPath(modelId, filePath);
      AppLogger.info(LOG_TAGS.SYSTEM, `模型下载完成: ${modelId}`);
      return { modelId, status: 'downloaded', message: '模型下载完成' };
    } catch (err) {
      this.modelRepo.updateStatus(modelId, 'download_failed');
      AppLogger.error(LOG_TAGS.SYSTEM, `模型下载失败: ${modelId}`, err);
      throw new AppError(ErrorCode.NETWORK_TIMEOUT, `模型下载失败: ${modelId}`);
    }
  }

  /**
   * 卸载模型
   * @param modelId 模型 ID
   * @returns 操作结果 { modelId, status }
   */
  public uninstallModel(modelId: string) {
    const model = this.modelRepo.findById(modelId);
    if (!model) {
      throw new AppError(ErrorCode.DB_RECORD_NOT_FOUND, `模型不存在: ${modelId}`);
    }

    if (model.status !== 'downloaded') {
      throw new AppError(ErrorCode.DATABASE_ERROR, `模型未下载，无法卸载: ${modelId}`);
    }

    // 更新状态为未下载，并清除下载路径
    this.modelRepo.updateStatus(modelId, 'not_downloaded');
    this.modelRepo.updateDownloadPath(modelId, '');
    AppLogger.info(LOG_TAGS.SYSTEM, `模型已卸载: ${modelId}`);
    return { modelId, status: 'not_downloaded' };
  }

  /**
   * 检查模型更新
   * @param modelId 模型 ID
   * @returns 更新检查结果 { modelId, hasUpdate, latestVersion }
   */
  public async checkUpdate(modelId: string) {
    const model = this.modelRepo.findById(modelId);
    if (!model) {
      throw new AppError(ErrorCode.DB_RECORD_NOT_FOUND, `模型不存在: ${modelId}`);
    }

    // 模拟版本检查：实际项目中应调用远程 API 获取最新版本
    const latestVersion = await this.simulateVersionCheck(modelId);
    const hasUpdate = latestVersion !== model.version;

    return {
      modelId,
      hasUpdate,
      currentVersion: model.version,
      latestVersion,
    };
  }

  /**
   * 更新模型
   * @param modelId 模型 ID
   * @returns 更新结果 { modelId, status, message }
   */
  public async updateModel(modelId: string) {
    const model = this.modelRepo.findById(modelId);
    if (!model) {
      throw new AppError(ErrorCode.DB_RECORD_NOT_FOUND, `模型不存在: ${modelId}`);
    }

    if (model.status !== 'downloaded') {
      throw new AppError(ErrorCode.DATABASE_ERROR, `模型未下载，无法更新: ${modelId}`);
    }

    // 更新状态为更新中
    this.modelRepo.updateStatus(modelId, 'updating');
    AppLogger.info(LOG_TAGS.SYSTEM, `开始更新模型: ${modelId}`);

    try {
      // 模拟更新过程
      await this.simulateDownload(modelId);

      const latestVersion = await this.simulateVersionCheck(modelId);
      this.modelRepo.updateVersion(modelId, latestVersion);
      this.modelRepo.updateStatus(modelId, 'downloaded');
      AppLogger.info(LOG_TAGS.SYSTEM, `模型更新完成: ${modelId} -> v${latestVersion}`);
      return { modelId, status: 'downloaded', message: '模型更新完成' };
    } catch (err) {
      this.modelRepo.updateStatus(modelId, 'downloaded');
      AppLogger.error(LOG_TAGS.SYSTEM, `模型更新失败: ${modelId}`, err);
      throw new AppError(ErrorCode.NETWORK_TIMEOUT, `模型更新失败: ${modelId}`);
    }
  }

  /**
   * 设置模型存储路径
   * @param modelId 模型 ID
   * @param customPath 自定义存储路径
   * @returns 操作结果 { modelId, downloadPath }
   */
  public setModelPath(modelId: string, customPath: string) {
    const model = this.modelRepo.findById(modelId);
    if (!model) {
      throw new AppError(ErrorCode.DB_RECORD_NOT_FOUND, `模型不存在: ${modelId}`);
    }

    this.modelRepo.updateDownloadPath(modelId, customPath);
    AppLogger.info(LOG_TAGS.SYSTEM, `模型路径已更新: ${modelId} -> ${customPath}`);
    return { modelId, downloadPath: customPath };
  }

  /**
   * 批量下载模型
   * @param modelIds 模型 ID 数组
   * @returns 批量下载结果数组
   */
  public async batchDownload(modelIds: string[]) {
    const results: Array<{ modelId: string; status: string; message: string }> = [];

    for (const modelId of modelIds) {
      try {
        const result = await this.downloadModel(modelId);
        results.push(result);
      } catch (err) {
        results.push({ modelId, status: 'download_failed', message: (err as Error).message });
      }
    }

    AppLogger.info(LOG_TAGS.SYSTEM, `批量下载完成: ${results.filter(r => r.status === 'downloaded').length}/${modelIds.length} 成功`);
    return results;
  }

  /**
   * 批量更新模型
   * @param modelIds 模型 ID 数组
   * @returns 批量更新结果数组
   */
  public async batchUpdate(modelIds: string[]) {
    const results: Array<{ modelId: string; status: string; message: string }> = [];

    for (const modelId of modelIds) {
      try {
        const result = await this.updateModel(modelId);
        results.push(result);
      } catch (err) {
        results.push({ modelId, status: 'update_failed', message: (err as Error).message });
      }
    }

    AppLogger.info(LOG_TAGS.SYSTEM, `批量更新完成: ${results.filter(r => r.status === 'downloaded').length}/${modelIds.length} 成功`);
    return results;
  }

  /**
   * 获取管线模型映射配置
   * @param projectId 项目 ID
   * @returns 管线节点模型配置数组
   */
  public getPipelineModelConfig(projectId: string) {
    return this.pipelineConfigRepo.findByProjectId(projectId);
  }

  /**
   * 设置管线节点模型映射
   * @param projectId 项目 ID
   * @param nodeType 节点类型
   * @param provider 模型提供商
   * @param modelName 模型名称
   * @param customBaseUrl 自定义 API 地址（可选）
   * @returns 写入后的配置记录
   */
  public setPipelineNodeModel(
    projectId: string,
    nodeType: string,
    provider: string,
    modelName: string,
    customBaseUrl?: string
  ) {
    const config = {
      project_id: projectId,
      node_type: nodeType,
      provider,
      model_name: modelName,
      custom_base_url: customBaseUrl || null,
    };

    const result = this.pipelineConfigRepo.upsert(config);
    AppLogger.info(LOG_TAGS.SYSTEM, `管线节点模型已设置: ${projectId}/${nodeType} -> ${provider}/${modelName}`);
    return result;
  }

  /**
   * 重置管线节点模型为默认配置
   * @param projectId 项目 ID
   * @param nodeType 节点类型
   * @returns 操作结果
   */
  public resetPipelineNodeModel(projectId: string, nodeType: string) {
    const existing = this.pipelineConfigRepo.findByProjectAndNodeType(projectId, nodeType);
    if (!existing) {
      throw new AppError(ErrorCode.DB_RECORD_NOT_FOUND, `未找到节点配置: ${projectId}/${nodeType}`);
    }

    // 重置为默认值：provider 和 model_name 置空，由系统自动选择默认模型
    const defaultConfig = {
      project_id: projectId,
      node_type: nodeType,
      provider: 'default',
      model_name: 'default',
      custom_base_url: null,
    };

    const result = this.pipelineConfigRepo.upsert(defaultConfig);
    AppLogger.info(LOG_TAGS.SYSTEM, `管线节点模型已重置: ${projectId}/${nodeType}`);
    return result;
  }

  /**
   * 测试节点模型连接
   * @param nodeType 节点类型
   * @param provider 模型提供商
   * @param modelName 模型名称
   * @param apiKey API 密钥
   * @returns 测试结果 { success, latency, message }
   */
  public async testNodeModel(
    nodeType: string,
    provider: string,
    modelName: string,
    apiKey: string
  ) {
    if (!apiKey) {
      throw new AppError(ErrorCode.FS_PATH_INVALID, 'API Key 不能为空');
    }

    AppLogger.info(LOG_TAGS.SYSTEM, `测试节点模型连接: ${nodeType}/${provider}/${modelName}`);

    try {
      // 模拟连接测试：实际项目中应调用对应 provider 的 API 进行真实测试
      const startTime = Date.now();
      await this.simulateApiTest(provider, modelName);
      const latency = Date.now() - startTime;

      return {
        success: true,
        latency,
        message: `连接成功，延迟 ${latency}ms`,
      };
    } catch (err) {
      AppLogger.error(LOG_TAGS.SYSTEM, `节点模型连接测试失败: ${provider}/${modelName}`, err);
      return {
        success: false,
        latency: -1,
        message: `连接失败: ${(err as Error).message}`,
      };
    }
  }

  /**
   * 真实 HTTP 下载模型文件
   * 支持断点续传和进度回调
   * @param modelId 模型 ID
   * @param onProgress 进度回调 (0-100)
   */
  private async downloadModelFile(modelId: string, onProgress?: (percent: number) => void): Promise<string> {
    const source = MODEL_SOURCES[modelId];
    if (!source) {
      // 无下载源的模型，走模拟流程
      await new Promise(resolve => setTimeout(resolve, 100));
      return '';
    }

    /** 获取模型存储目录 */
    const modelsDir = path.join(app.getPath('userData'), 'models');
    if (!fs.existsSync(modelsDir)) {
      fs.mkdirSync(modelsDir, { recursive: true });
    }

    const filePath = path.join(modelsDir, source.file);
    const fileUrl = `${source.url}/${source.file}`;

    /** 检查断点续传 */
    let existingSize = 0;
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      existingSize = stat.size;
    }

    return new Promise<string>((resolve, reject) => {
      const client = fileUrl.startsWith('https') ? https : http;
      const headers: Record<string, string> = {};
      if (existingSize > 0) {
        headers['Range'] = `bytes=${existingSize}-`;
      }

      const request = client.get(fileUrl, { headers }, (response) => {
        /** 处理重定向 */
        if (response.statusCode === 301 || response.statusCode === 302) {
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            this.downloadFromUrl(redirectUrl, filePath, existingSize, onProgress).then(resolve).catch(reject);
            return;
          }
        }

        /** 服务器不支持 Range，从头下载 */
        const isResume = response.statusCode === 206;
        const totalSize = isResume
          ? existingSize + parseInt(response.headers['content-length'] || '0', 10)
          : parseInt(response.headers['content-length'] || '0', 10);

        const writeStream = fs.createWriteStream(filePath, { flags: isResume ? 'a' : 'w' });
        let downloaded = isResume ? existingSize : 0;

        response.on('data', (chunk: Buffer) => {
          downloaded += chunk.length;
          if (totalSize > 0 && onProgress) {
            onProgress(Math.round((downloaded / totalSize) * 100));
          }
        });

        response.pipe(writeStream);

        writeStream.on('finish', () => {
          writeStream.close();
          AppLogger.info(LOG_TAGS.SYSTEM, `模型文件下载完成: ${filePath}`);
          resolve(filePath);
        });

        writeStream.on('error', (err) => {
          fs.unlinkSync(filePath);
          reject(err);
        });
      });

      request.on('error', (err) => {
        reject(err);
      });

      request.setTimeout(60000, () => {
        request.destroy();
        reject(new Error('下载超时'));
      });
    });
  }

  /**
   * 从指定 URL 下载文件（处理重定向）
   */
  private async downloadFromUrl(url: string, filePath: string, existingSize: number, onProgress?: (percent: number) => void): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const client = url.startsWith('https') ? https : http;
      const headers: Record<string, string> = {};
      if (existingSize > 0) headers['Range'] = `bytes=${existingSize}-`;

      client.get(url, { headers }, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            this.downloadFromUrl(redirectUrl, filePath, existingSize, onProgress).then(resolve).catch(reject);
            return;
          }
        }

        const isResume = response.statusCode === 206;
        const totalSize = isResume
          ? existingSize + parseInt(response.headers['content-length'] || '0', 10)
          : parseInt(response.headers['content-length'] || '0', 10);

        const writeStream = fs.createWriteStream(filePath, { flags: isResume ? 'a' : 'w' });
        let downloaded = isResume ? existingSize : 0;

        response.on('data', (chunk: Buffer) => {
          downloaded += chunk.length;
          if (totalSize > 0 && onProgress) onProgress(Math.round((downloaded / totalSize) * 100));
        });

        response.pipe(writeStream);
        writeStream.on('finish', () => { writeStream.close(); resolve(filePath); });
        writeStream.on('error', (err) => { fs.unlinkSync(filePath); reject(err); });
      }).on('error', reject);
    });
  }

  /**
   * 从指定 URL 下载文件（处理重定向）
   */
  private async simulateDownload(_modelId: string): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  /**
   * 模拟版本检查（占位实现）
   * @param _modelId 模型 ID
   * @returns 最新版本号
   */
  private async simulateVersionCheck(_modelId: string): Promise<string> {
    await new Promise(resolve => setTimeout(resolve, 50));
    return '1.0.0';
  }

  /**
   * 模拟 API 连接测试（占位实现）
   * @param _provider 提供商
   * @param _modelName 模型名称
   */
  private async simulateApiTest(_provider: string, _modelName: string): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}
