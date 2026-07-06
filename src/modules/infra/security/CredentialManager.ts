import { encryptData, decryptData } from '../../main/utils/crypto';
import { SENSITIVE_CONFIG_KEYS, isSensitiveConfig } from '../../shared/config/keys';
import { AppLogger } from '../logger/AppLogger';
import { LOG_TAGS } from '../logger/LogConstants';

export class CredentialManager {
  private static instance: CredentialManager;

  private constructor() {}

  static getInstance(): CredentialManager {
    if (!CredentialManager.instance) {
      CredentialManager.instance = new CredentialManager();
    }
    return CredentialManager.instance;
  }

  encrypt(value: string): string {
    if (!value || value.trim() === '') return value;
    try {
      return encryptData(value);
    } catch (err) {
      AppLogger.error(LOG_TAGS.SYSTEM, '加密凭据失败', err);
      throw err;
    }
  }

  decrypt(encrypted: string): string {
    if (!encrypted || encrypted.trim() === '') return encrypted;
    try {
      const result = decryptData(encrypted);
      if (!result || result.trim() === '' || result === encrypted) {
        if (encrypted.startsWith('v1:') || encrypted.startsWith('v2:')) {
          AppLogger.warn(LOG_TAGS.SYSTEM, '凭据解密未产生有效结果，返回原密文（调用方应降级处理）');
        }
        return encrypted;
      }
      return result;
    } catch (err) {
      AppLogger.error(LOG_TAGS.SYSTEM, '解密凭据失败', err);
      return encrypted;
    }
  }

  isSensitive(key: string): boolean {
    return isSensitiveConfig(key);
  }

  getSensitiveKeys(): string[] {
    return [...SENSITIVE_CONFIG_KEYS];
  }

  mask(value: string, visibleChars = 4): string {
    if (!value || value.length <= visibleChars * 2) return '****';
    return `${value.slice(0, visibleChars)}****${value.slice(-visibleChars)}`;
  }

  validateApiKey(key: string, prefix?: string): { valid: boolean; message: string } {
    if (!key || key.trim() === '') {
      return { valid: false, message: 'API Key 不能为空' };
    }
    if (prefix && !key.startsWith(prefix)) {
      return { valid: false, message: `API Key 应以 "${prefix}" 开头` };
    }
    if (key.length < 8) {
      return { valid: false, message: 'API Key 长度不足，请检查' };
    }
    return { valid: true, message: '' };
  }
}
