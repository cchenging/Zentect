// 📁 路径: src/main/controllers/SettingsController.ts
import { IpcRouter } from '../core/IpcRouter';
import { SettingsService } from '../services/SettingsService';
import { IPC_CHANNELS } from '../../shared/utils/IpcConstants';
import { AppError, ErrorCode } from '../../shared/utils/AppError';

/** 设置域扩展 IPC 频道常量（后续合并到 IpcConstants.ts） */
const SETTINGS_IPC_CHANNELS = {
  SETTINGS_GET_ALL: 'settings:getAll',
  SETTINGS_GET_BY_KEYS: 'settings:getByKeys',
  SETTINGS_RESET_ALL: 'settings:resetAll',
  SETTINGS_VALIDATE_PATH: 'settings:validatePath',
} as const;

export class SettingsController {
  private settingsService = new SettingsService();

  /** 注册所有设置相关 IPC 处理器 */
  public register() {
    // 获取所有设置
    IpcRouter.handle(SETTINGS_IPC_CHANNELS.SETTINGS_GET_ALL, async () => {
      return this.settingsService.getAll();
    });

    // 批量获取指定键的设置
    IpcRouter.handle(SETTINGS_IPC_CHANNELS.SETTINGS_GET_BY_KEYS, async (_, keys: string[]) => {
      if (!keys || !Array.isArray(keys) || keys.length === 0) {
        throw new AppError(ErrorCode.FS_PATH_INVALID, '键名列表不能为空');
      }
      return this.settingsService.getByKeys(keys);
    });

    // 重置所有设置为默认值
    IpcRouter.handle(SETTINGS_IPC_CHANNELS.SETTINGS_RESET_ALL, async () => {
      return this.settingsService.resetAll();
    });

    // 验证路径有效性
    IpcRouter.handle(SETTINGS_IPC_CHANNELS.SETTINGS_VALIDATE_PATH, async (_, dirPath: string) => {
      if (!dirPath) {
        throw new AppError(ErrorCode.FS_PATH_INVALID, '路径参数不能为空');
      }
      return await this.settingsService.validatePath(dirPath);
    });

    // 获取单个设置（复用已有 IPC 频道）
    IpcRouter.handle(IPC_CHANNELS.SETTINGS_GET, async (_, key: string) => {
      if (!key) return null;
      return this.settingsService.getByKey(key);
    });

    // 设置单个键值（复用已有 IPC 频道）
    IpcRouter.handle(IPC_CHANNELS.SETTINGS_SET, async (_, key: string, value: string) => {
      if (!key) {
        throw new AppError(ErrorCode.FS_PATH_INVALID, '设置键名不能为空');
      }
      this.settingsService.setSetting(key, value);
      return true;
    });
  }
}
