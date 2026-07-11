// 📁 路径: src/main/services/SettingsService.ts
import fs from 'fs/promises';
import { SettingsRepository } from '../database/repositories/SettingsRepository';
import { AppError, ErrorCode } from '../../modules/infra/error/AppError';
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../modules/infra/logger/LogConstants';

/** 默认设置值字典 */
const DEFAULT_SETTINGS: Record<string, string> = {
  projectStoragePath: '',
  videoExportPath: '',
  jianyingDraftPath: '',
  theme: 'dark',
  language: 'zh-CN',
  gpuAcceleration: 'true',
  autoSaveInterval: '30000',
  autoLogin: 'false',
};

/** @deprecated 请使用 `src/modules/settings/general` 新模块入口，旧路径仅保留兼容性委托 */
export class SettingsService {
  private repo = new SettingsRepository();

  /** 获取所有设置，缺失的键用默认值补齐 */
  public getAll(): Record<string, string> {
    const stored = this.repo.getAllSettings() as Record<string, string>;
    const result: Record<string, string> = { ...DEFAULT_SETTINGS };

    // 用数据库中实际存储的值覆盖默认值
    for (const [key, val] of Object.entries(stored)) {
      if (val !== undefined && val !== null && String(val).trim() !== '') {
        result[key] = String(val);
      }
    }

    return result;
  }

  /** 批量获取指定键的设置值 */
  public getByKeys(keys: string[]): Record<string, string> {
    const all = this.getAll();
    const result: Record<string, string> = {};
    for (const key of keys) {
      result[key] = all[key] ?? DEFAULT_SETTINGS[key] ?? '';
    }
    return result;
  }

  /** 获取单个设置值 */
  public getByKey(key: string): string {
    const val = this.repo.get<string>(key, '');
    if (val !== undefined && val !== null && String(val).trim() !== '') {
      return String(val);
    }
    return DEFAULT_SETTINGS[key] ?? '';
  }

  /** 设置单个键值 */
  public setSetting(key: string, value: string): void {
    if (!key || key.trim() === '') {
      throw new AppError(ErrorCode.FS_PATH_INVALID, '设置键名不能为空');
    }
    this.repo.saveSettings({ [key]: value });
    AppLogger.info(LOG_TAGS.SYSTEM, `设置已更新: ${key}`);
  }

  /** 批量设置多个键值 */
  public setSettings(settings: Record<string, string>): void {
    if (!settings || Object.keys(settings).length === 0) {
      throw new AppError(ErrorCode.FS_PATH_INVALID, '设置内容不能为空');
    }
    this.repo.saveSettings(settings);
    AppLogger.info(LOG_TAGS.SYSTEM, `批量设置已更新: ${Object.keys(settings).join(', ')}`);
  }

  /** 重置所有设置为默认值 */
  public resetAll(): Record<string, string> {
    this.repo.saveSettings(DEFAULT_SETTINGS);
    AppLogger.info(LOG_TAGS.SYSTEM, '所有设置已重置为默认值');
    return { ...DEFAULT_SETTINGS };
  }

  /** 验证路径有效性：检查存在性、可写性、可用空间 */
  public async validatePath(dirPath: string): Promise<{
    exists: boolean;
    writable: boolean;
    freeSpaceMB: number;
  }> {
    if (!dirPath || dirPath.trim() === '') {
      throw new AppError(ErrorCode.FS_PATH_INVALID, '路径不能为空');
    }

    const result = { exists: false, writable: false, freeSpaceMB: 0 };

    // 检查路径是否存在
    try {
      await fs.access(dirPath, fs.constants.F_OK);
      result.exists = true;
    } catch {
      AppLogger.warn(LOG_TAGS.SYSTEM, `路径不存在: ${dirPath}`);
      return result;
    }

    // 检查路径是否可写
    try {
      await fs.access(dirPath, fs.constants.W_OK);
      result.writable = true;
    } catch {
      AppLogger.warn(LOG_TAGS.SYSTEM, `路径不可写: ${dirPath}`);
    }

    // 获取可用磁盘空间
    try {
      const stat = await fs.statfs(dirPath);
      // statfs.bavail 是普通用户可用块数，statfs.bsize 是块大小
      result.freeSpaceMB = Math.round((stat.bavail * stat.bsize) / (1024 * 1024));
    } catch (e) {
      AppLogger.warn(LOG_TAGS.SYSTEM, `无法获取磁盘空间信息: ${dirPath}`, e);
    }

    return result;
  }

  /** 获取当前主题设置 */
  public getTheme(): string {
    return this.getByKey('theme');
  }

  /** 设置主题 */
  public setTheme(theme: string): void {
    if (!theme || theme.trim() === '') {
      throw new AppError(ErrorCode.FS_PATH_INVALID, '主题值不能为空');
    }
    this.setSetting('theme', theme);
  }

  /** 获取当前语言设置 */
  public getLanguage(): string {
    return this.getByKey('language');
  }

  /** 设置语言 */
  public setLanguage(lang: string): void {
    if (!lang || lang.trim() === '') {
      throw new AppError(ErrorCode.FS_PATH_INVALID, '语言值不能为空');
    }
    this.setSetting('language', lang);
  }
}
