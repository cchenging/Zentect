// 📁 路径：src/main/database/repositories/SettingsRepository.ts
import { SQLiteConnection } from '../core/SQLiteConnection';
import { SETTINGS_SQL } from '../queries/SystemQueries';
import { CredentialManager } from '@modules/infra/security/CredentialManager';
import { isSensitiveConfig } from '../../../shared/config/keys';
import { AppLogger } from '@modules/infra/logger/AppLogger';
import { LOG_TAGS } from '@modules/infra/logger/LogConstants';

/** @deprecated 请使用 `src/modules/settings/general` 新模块入口，旧路径仅保留兼容性委托 */
export class SettingsRepository {
  private credentialManager = CredentialManager.getInstance();

  private get db() { return SQLiteConnection.getInstance().getDB(); }

  /** 加密值前缀检测 */
  private static ENCRYPTED_PREFIXES = ['v1:', 'v2:'];

  /** 判断值是否看起来像加密格式
   *
   *  支持以下格式：
   *  - v1:... / v2:...  (当前版本前缀格式)
   *  - xxx:yyy:zzz      (旧版无前缀 AES-256-GCM: iv:authTag:ciphertext)
   */
  private looksEncrypted(val: string): boolean {
    if (SettingsRepository.ENCRYPTED_PREFIXES.some(p => val.startsWith(p))) return true;
    // 兼容旧版无前缀 AES-256-GCM 格式（三段 hex 以冒号分隔）
    const parts = val.split(':');
    return parts.length === 3 && parts.every(p => /^[0-9a-f]+$/i.test(p));
  }

  /** 安全解密
   *
   *  保护逻辑（三层保险）：
   *  1. key 在敏感列表 → 主动解密
   *  2. 值本身以 v1:/v2: 开头（即使 key 不在敏感列表）→ 主动尝试解密
   *     —— 兼容旧版代码误加密 / 手动导入的加密数据
   *  3. 解密失败（返回原样密文）→ 降级返回空字符串，防止 v2:密文 泄露到前端 UI
   *
   *  CredentialManager.decrypt 内置降级，解密失败返回原值。
   */
  private safeDecrypt(key: string, val: any): any {
    if (typeof val !== 'string' || val.trim().length === 0) return val;

    // 跳过：既不是敏感 key，值也不像加密格式
    if (!isSensitiveConfig(key) && !this.looksEncrypted(val)) return val;

    try {
      const decrypted = this.credentialManager.decrypt(val);
      // 解密成功：返回值与原值不同
      if (decrypted && decrypted !== val) return decrypted;
    } catch {
      /* CredentialManager.decrypt 内部已做降级处理 */
    }

    // 值看起来是加密格式，但解密失败 → 可能是跨版本旧数据
    if (this.looksEncrypted(val)) {
      AppLogger.warn(LOG_TAGS.SYSTEM,
        `设置 [${key}] 包含无法解密的旧格式数据（跨 Electron 版本），已降级返回空值`);
      return '';
    }

    return val;
  }

  public get<T>(key: string, defaultValue: T): T {
    const row = this.db.prepare(SETTINGS_SQL.GET_BY_KEY).get({ key }) as { value: string } | undefined;
    if (!row) return defaultValue;

    let val = this.safeDecrypt(key, row.value);

    try {
      if (typeof val === 'string' && (val.startsWith('[') || val.startsWith('{'))) {
        val = JSON.parse(val);
      }
    } catch { /* 非 JSON 字符串保持原样 */ }

    return val as T;
  }

  public getAllSettings(): Record<string, any> {
    const rows = this.db.prepare(SETTINGS_SQL.GET_ALL).all() as { key: string; value: string }[];
    const settings: Record<string, any> = {};

    rows.forEach(row => {
      let val = this.safeDecrypt(row.key, row.value);
      try {
        if (typeof val === 'string' && (val.startsWith('[') || val.startsWith('{'))) {
          val = JSON.parse(val);
        }
      } catch { /* 非 JSON 字符串保持原样 */ }
      settings[row.key] = val;
    });

    return settings;
  }

  public saveSettings(settings: Record<string, any>): void {
    const stmt = this.db.prepare(SETTINGS_SQL.UPSERT);
    const transaction = this.db.transaction((settingsObj: Record<string, any>) => {
      for (const [key, value] of Object.entries(settingsObj)) {
        if (value === undefined || value === null) continue;

        let valToSave = (Array.isArray(value) || typeof value === 'object')
          ? JSON.stringify(value)
          : String(value);

        if (valToSave.trim() === '') continue;

        // 仅对敏感 key 进行加密
        if (isSensitiveConfig(key)) {
          try {
            valToSave = this.credentialManager.encrypt(valToSave);
          } catch { /* 加密失败时存明文（降级） */ }
        }

        stmt.run({ key, value: valToSave });
      }
    });
    transaction(settings);
  }

  /**
   * 迁移：检测并清理无法解密的旧格式加密数据
   *
   * 适用场景：
   * - Electron 大版本升级后 safeStorage 不再兼容旧加密数据
   * - v1 legacy 加密数据因 OS 用户名变更等原因无法解密
   *
   * @returns 被清理的设置键名列表（用于日志/通知用户重新配置）
   */
  public migrateStaleEncryptedData(): string[] {
    const rows = this.db.prepare(SETTINGS_SQL.GET_ALL).all() as { key: string; value: string }[];
    const staleKeys: string[] = [];
    const clearStmt = this.db.prepare(SETTINGS_SQL.UPSERT);

    const transaction = this.db.transaction(() => {
      for (const row of rows) {
        if (!this.looksEncrypted(row.value)) continue;

        try {
          const decrypted = this.credentialManager.decrypt(row.value);
          if (decrypted && decrypted !== row.value) continue;
        } catch { /* 解密失败，确认为失效数据 */ }

        // 无法解密 → 清空该值
        clearStmt.run({ key: row.key, value: '' });
        staleKeys.push(row.key);
        AppLogger.warn(LOG_TAGS.BOOTSTRAP,
          `数据迁移：清除失效加密设置 [${row.key}]（跨版本数据不兼容）`);
      }
    });

    transaction();

    if (staleKeys.length > 0) {
      AppLogger.info(LOG_TAGS.BOOTSTRAP,
        `数据迁移完成：共清除 ${staleKeys.length} 个失效加密设置: ${staleKeys.join(', ')}`);
    }

    return staleKeys;
  }
}
