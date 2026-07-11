// 📁 路径: src/main/controllers/ModelController.ts
import { BrowserWindow } from 'electron';
import { IpcRouter } from '../core/IpcRouter';
import { ModelService } from '../services/ModelService';
import { AppError, ErrorCode } from '../../modules/infra/error/AppError';
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../modules/infra/logger/LogConstants';

/**
 * 模型管理 IPC 频道常量
 */
const MODEL_CHANNELS = {
  /** 获取所有本地模型列表 */
  GET_LIST: 'model:getList',
  /** 下载模型 */
  DOWNLOAD: 'model:download',
  /** 下载进度推送 */
  DOWNLOAD_PROGRESS: 'model:downloadProgress',
  /** 卸载模型 */
  UNINSTALL: 'model:uninstall',
  /** 检查模型更新 */
  CHECK_UPDATE: 'model:checkUpdate',
  /** 更新模型 */
  UPDATE: 'model:update',
  /** 设置模型存储路径 */
  SET_PATH: 'model:setPath',
  /** 批量下载 */
  BATCH_DOWNLOAD: 'model:batchDownload',
  /** 批量更新 */
  BATCH_UPDATE: 'model:batchUpdate',
} as const;

/**
 * 管线模型配置 IPC 频道常量
 */
const PIPELINE_CHANNELS = {
  /** 获取管线节点模型映射 */
  GET_NODE_MODEL_CONFIG: 'pipeline:getNodeModelConfig',
  /** 设置某节点的模型映射 */
  SET_NODE_MODEL: 'pipeline:setNodeModel',
  /** 重置为默认模型 */
  RESET_NODE_MODEL: 'pipeline:resetNodeModel',
  /** 测试节点模型连接 */
  TEST_NODE_MODEL: 'pipeline:testNodeModel',
} as const;

/**
 * 模型管理控制器
 * 负责注册模型管理相关的 IPC 处理器
 */
export class ModelController {
  private modelService = new ModelService();

  /**
   * 注册所有模型管理相关的 IPC 处理器
   */
  public register() {
    this.registerModelChannels();
    this.registerPipelineChannels();
  }

  /**
   * 注册模型管理 IPC 频道
   */
  private registerModelChannels() {
    // 获取所有本地模型列表
    IpcRouter.handle(MODEL_CHANNELS.GET_LIST, async () => {
      return this.modelService.getModelList();
    });

    // 下载模型
    IpcRouter.handle(MODEL_CHANNELS.DOWNLOAD, async (_, modelId: string) => {
      if (!modelId) {
        throw new AppError(ErrorCode.FS_PATH_INVALID, '模型 ID 不能为空');
      }

      // 启动下载后，通过进度频道推送状态
      const result = await this.modelService.downloadModel(modelId);
      this.sendDownloadProgress(modelId, result.status, 100);
      return result;
    });

    // 卸载模型
    IpcRouter.handle(MODEL_CHANNELS.UNINSTALL, async (_, modelId: string) => {
      if (!modelId) {
        throw new AppError(ErrorCode.FS_PATH_INVALID, '模型 ID 不能为空');
      }
      return this.modelService.uninstallModel(modelId);
    });

    // 检查模型更新
    IpcRouter.handle(MODEL_CHANNELS.CHECK_UPDATE, async (_, modelId: string) => {
      if (!modelId) {
        throw new AppError(ErrorCode.FS_PATH_INVALID, '模型 ID 不能为空');
      }
      return await this.modelService.checkUpdate(modelId);
    });

    // 更新模型
    IpcRouter.handle(MODEL_CHANNELS.UPDATE, async (_, modelId: string) => {
      if (!modelId) {
        throw new AppError(ErrorCode.FS_PATH_INVALID, '模型 ID 不能为空');
      }
      return await this.modelService.updateModel(modelId);
    });

    // 设置模型存储路径
    IpcRouter.handle(MODEL_CHANNELS.SET_PATH, async (_, modelId: string, customPath: string) => {
      if (!modelId || !customPath) {
        throw new AppError(ErrorCode.FS_PATH_INVALID, '模型 ID 和路径不能为空');
      }
      return this.modelService.setModelPath(modelId, customPath);
    });

    // 批量下载
    IpcRouter.handle(MODEL_CHANNELS.BATCH_DOWNLOAD, async (_, modelIds: string[]) => {
      if (!Array.isArray(modelIds) || modelIds.length === 0) {
        throw new AppError(ErrorCode.FS_PATH_INVALID, '模型 ID 列表不能为空');
      }
      return await this.modelService.batchDownload(modelIds);
    });

    // 批量更新
    IpcRouter.handle(MODEL_CHANNELS.BATCH_UPDATE, async (_, modelIds: string[]) => {
      if (!Array.isArray(modelIds) || modelIds.length === 0) {
        throw new AppError(ErrorCode.FS_PATH_INVALID, '模型 ID 列表不能为空');
      }
      return await this.modelService.batchUpdate(modelIds);
    });
  }

  /**
   * 注册管线模型配置 IPC 频道
   */
  private registerPipelineChannels() {
    // 获取管线节点模型映射
    IpcRouter.handle(PIPELINE_CHANNELS.GET_NODE_MODEL_CONFIG, async (_, projectId: string) => {
      if (!projectId) {
        throw new AppError(ErrorCode.FS_PATH_INVALID, '项目 ID 不能为空');
      }
      return this.modelService.getPipelineModelConfig(projectId);
    });

    // 设置某节点的模型映射
    IpcRouter.handle(
      PIPELINE_CHANNELS.SET_NODE_MODEL,
      async (_, projectId: string, nodeType: string, provider: string, modelName: string, customBaseUrl?: string) => {
        if (!projectId || !nodeType || !provider || !modelName) {
          throw new AppError(ErrorCode.FS_PATH_INVALID, '项目 ID、节点类型、提供商和模型名称不能为空');
        }
        return this.modelService.setPipelineNodeModel(projectId, nodeType, provider, modelName, customBaseUrl);
      }
    );

    // 重置为默认模型
    IpcRouter.handle(PIPELINE_CHANNELS.RESET_NODE_MODEL, async (_, projectId: string, nodeType: string) => {
      if (!projectId || !nodeType) {
        throw new AppError(ErrorCode.FS_PATH_INVALID, '项目 ID 和节点类型不能为空');
      }
      return this.modelService.resetPipelineNodeModel(projectId, nodeType);
    });

    // 测试节点模型连接
    IpcRouter.handle(
      PIPELINE_CHANNELS.TEST_NODE_MODEL,
      async (_, nodeType: string, provider: string, modelName: string, apiKey: string) => {
        if (!nodeType || !provider || !modelName || !apiKey) {
          throw new AppError(ErrorCode.FS_PATH_INVALID, '节点类型、提供商、模型名称和 API Key 不能为空');
        }
        return await this.modelService.testNodeModel(nodeType, provider, modelName, apiKey);
      }
    );
  }

  /**
   * 通过 BrowserWindow 向渲染进程推送下载进度
   * @param modelId 模型 ID
   * @param status 当前状态
   * @param progress 进度百分比
   */
  private sendDownloadProgress(modelId: string, status: string, progress: number) {
    try {
      const win = BrowserWindow.getAllWindows()[0];
      if (win && !win.isDestroyed()) {
        win.webContents.send(MODEL_CHANNELS.DOWNLOAD_PROGRESS, { modelId, status, progress });
      }
    } catch (err) {
      AppLogger.warn(LOG_TAGS.SYSTEM, `推送下载进度失败: ${(err as Error).message}`);
    }
  }
}
