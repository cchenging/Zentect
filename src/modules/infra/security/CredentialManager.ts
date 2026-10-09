import { encryptData, decryptData } from '../../../main/utils/crypto';
import { SENSITIVE_CONFIG_KEYS, isSensitiveConfig } from '../../../shared/config/keys';
import { classifyCredential, type CredentialResult } from '../../../shared/utils/credentialFormat';
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

  /**
   * 加密凭据
   *
   * @param purpose v3 AAD 的 purpose（ADR-004 §4.2，如 "api_profiles.api_key" / "settings:<key>"）。
   *   **传入即走 v3 信封加密**；不传则保持历史行为（v2 → v1），故未接线的调用方线上零变化。
   *   v3 写入路径必须带 purpose（缺 AAD 会让密文可被跨字段搬运），由 `encryptData` 结构性保证。
   */
  encrypt(value: string, purpose?: string): string {
    if (!value || value.trim() === '') return value;
    try {
      return encryptData(value, purpose);
    } catch (err) {
      AppLogger.error(LOG_TAGS.SYSTEM, '加密凭据失败', err);
      throw err;
    }
  }

  /**
   * 解密凭据（ADR-004 §4.4 **G1：解密失败绝不放行**）
   *
   * 返回判别联合 `CredentialResult`，**失败时不返回任何字符串**：
   * 旧实现「解不出就把密文原样返回」曾让密文被当 Bearer 外发（401 → 连打 429 封禁），
   * 故此处改为归类为 `missing` / `decrypt_failed`。调用方**禁止** `if (!value)` 式模糊判断，
   * 必须显式分支处置（未配置 ≠ 配了但解不开）。
   *
   * @param purpose 读 v3 密文时必填且必须与写入时一致（AAD 参与认证）；读 v1/v2 旧格式无需。
   */
  decrypt(encrypted: string, purpose?: string): CredentialResult {
    if (!encrypted || encrypted.trim() === '') return { status: 'missing' };

    // decryptData 在 v1/v2/v3 失败时**原样返回密文**（不抛错），故此处 catch 只为兜住解析异常；
    // 两条失败路径最终都由 classifyCredential 统一归到 decrypt_failed。
    let decrypted = '';
    try {
      decrypted = decryptData(encrypted, purpose);
    } catch (err) {
      AppLogger.warn(LOG_TAGS.SYSTEM, '凭据解密抛出异常', err);
    }

    const result = classifyCredential(encrypted, decrypted);
    if (result.status === 'decrypt_failed') {
      AppLogger.error(LOG_TAGS.SYSTEM,
        `凭据解密失败（reason=${result.reason}）：疑似跨 Electron 版本旧数据或密钥不可用，` +
        '已按 fail-closed 处理，绝不外发密文');
    }
    return result;
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
