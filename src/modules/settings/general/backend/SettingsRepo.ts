// 📁 路径：src/modules/settings/general/backend/SettingsRepo.ts
// 设置数据仓库：直接引用 infra 层，不依赖 @deprecated 旧模块

import { SQLiteConnection } from '../../../infra/database/SQLiteConnection';
import { CredentialManager } from '../../../infra/security/CredentialManager';
import { isSensitiveConfig } from '../../../../shared/config/keys';
import { AppLogger } from '../../../infra/logger/AppLogger';
import { LOG_TAGS } from '../../../infra/logger/LogConstants';

// SQL 模板 — 沿用旧模块中的查询语句
const SETTINGS_SQL = {
  GET_BY_KEY: 'SELECT value FROM settings WHERE key = @key',
  GET_ALL: 'SELECT key, value FROM settings',
  UPSERT: 'INSERT INTO settings (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
};

export class SettingsRepo {
  private credentialManager = CredentialManager.getInstance();

  private get db() { return SQLiteConnection.getInstance().getDB(); }

  /** 加密值前缀检测 */
  private static ENCRYPTED_PREFIXES = ['v1:', 'v2:'];

  /** 判断值是否看起来像加密格式 */
  private looksEncrypted(val: string): boolean {
    if (SettingsRepo.ENCRYPTED_PREFIXES.some(p => val.startsWith(p))) return true;
    const parts = val.split(':');
    return parts.length === 3 && parts.every(p => /^[0-9a-f]+$/i.test(p));
  }

  /** 安全解密 */
  private safeDecrypt(key: string, val: any): any {
    if (typeof val !== 'string' || val.trim().length === 0) return val;

    if (!isSensitiveConfig(key) && !this.looksEncrypted(val)) return val;

    try {
      const decrypted = this.credentialManager.decrypt(val);
      if (decrypted && decrypted !== val) return decrypted;
    } catch {
      /* CredentialManager.decrypt 内部已做降级处理 */
    }

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

    const result: Record<string, any> = {};
    rows.forEach(row => {
      let val = this.safeDecrypt(row.key, row.value);
      try {
        if (typeof val === 'string' && (val.startsWith('[') || val.startsWith('{'))) {
          val = JSON.parse(val);
        }
      } catch { /* 非 JSON 字符串保持原样 */ }
      result[row.key] = val;
    });

    return result;
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

  /** 迁移：检测并清理无法解密的旧格式加密数据 */
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
