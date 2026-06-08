import { LicenseValidator, LicensePayload } from '../core/LicenseValidator';
import { SettingsRepository } from '../database/repositories/SettingsRepository';
import { AppLogger } from '../core/AppLogger';
import { LOG_TAGS } from '../../shared/utils/LogConstants';

export interface LicenseStatus {
  activated: boolean;
  expired: boolean;
  expiresAt: string | null;
  features: string[];
}

/** V1.1 License 服务 — 验证、保存、状态查询 */
export class LicenseService {
  private static readonly LICENSE_KEY_STORE = 'license.activatedKey';
  private static readonly LICENSE_PAYLOAD_STORE = 'license.payload';

  private validator = new LicenseValidator();
  private settingsRepo = new SettingsRepository();

  /** 验证并激活 License Key */
  activate(licenseKey: string): { success: true; payload: LicensePayload } | { success: false; error: string } {
    const result = this.validator.validate(licenseKey.trim());

    if (!result.valid) {
      AppLogger.warn(LOG_TAGS.SYSTEM, `License 验证失败: ${result.error}`);
      return { success: false, error: result.error };
    }

    this.settingsRepo.saveSettings({
      [LicenseService.LICENSE_KEY_STORE]: licenseKey.trim(),
      [LicenseService.LICENSE_PAYLOAD_STORE]: JSON.stringify(result.payload),
    });

    AppLogger.info(LOG_TAGS.SYSTEM, `License 激活成功: v${result.payload.version}, 过期: ${result.payload.expireAt}`);
    return { success: true, payload: result.payload };
  }

  /** 查询当前 License 状态 */
  getStatus(): LicenseStatus {
    try {
      const licenseKey = this.settingsRepo.get<string>(LicenseService.LICENSE_KEY_STORE, '');
      if (!licenseKey) {
        return { activated: false, expired: false, expiresAt: null, features: [] };
      }

      const result = this.validator.validate(licenseKey);
      if (!result.valid) {
        return { activated: true, expired: true, expiresAt: null, features: [] };
      }

      return {
        activated: true,
        expired: new Date(result.payload.expireAt) < new Date(),
        expiresAt: result.payload.expireAt,
        features: result.payload.features || [],
      };
    } catch {
      return { activated: false, expired: false, expiresAt: null, features: [] };
    }
  }

  /** 启动时校验 License 有效性 */
  validateOnStartup(): void {
    const status = this.getStatus();
    if (!status.activated) {
      AppLogger.info(LOG_TAGS.BOOTSTRAP, '未激活 License，运行在基础模式');
      return;
    }
    if (status.expired) {
      AppLogger.warn(LOG_TAGS.BOOTSTRAP, 'License 已过期，部分功能受限');
      return;
    }
    AppLogger.info(LOG_TAGS.BOOTSTRAP, `License 有效: ${status.expiresAt}, 特性: ${status.features.join(', ')}`);
  }
}
