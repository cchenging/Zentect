// 📁 路径：src/modules/settings/general/backend/SettingsRepo.ts
// 设置数据仓库：直接引用 infra 层，不依赖 @deprecated 旧模块

import { SQLiteConnection } from '@modules/infra/database/SQLiteConnection';
import { CredentialManager } from '@modules/infra/security/CredentialManager';
import { isSensitiveConfig } from '../../../../shared/config/keys';
import { CredentialDecryptError, looksEncryptedValue } from '../../../../shared/utils/credentialFormat';
import { AppLogger } from '@modules/infra/logger/AppLogger';
import { LOG_TAGS } from '@modules/infra/logger/LogConstants';

// SQL 模板 — 沿用旧模块中的查询语句
const SETTINGS_SQL = {
  GET_BY_KEY: 'SELECT value FROM settings WHERE key = @key',
  GET_ALL: 'SELECT key, value FROM settings',
  UPSERT: 'INSERT INTO settings (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
};

export class SettingsRepo {
  private credentialManager = CredentialManager.getInstance();

  private get db() { return SQLiteConnection.getInstance().getDB(); }

  /** 安全解密（ADR-004 §4.4 **G2：密文守卫 + 失败可感知**）
   *
   *  与 `main/database/repositories/SettingsRepository` 同口径（形态判定走 shared SSOT）：
   *  - 不像密文 ⇒ 原样放行（普通设置项不做解密尝试）
   *  - `ok` / `missing` ⇒ 明文 / 原值
   *  - `decrypt_failed` ⇒ **抛 `CredentialDecryptError`**（fail-closed，绝不返回空串让上层当「未配置」）
   */
  private safeDecrypt(key: string, val: any): any {
    if (typeof val !== 'string' || val.trim().length === 0) return val;
    if (!looksEncryptedValue(val)) return val;

    const result = this.credentialManager.decrypt(val);
    if (result.status === 'ok') return result.value;
    if (result.status === 'missing') return val;
    throw new CredentialDecryptError(result.reason, key);
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
    /** G2：坏凭据键名，单个键解密失败不能炸掉整页设置读取 */
    const badKeys: string[] = [];

    rows.forEach(row => {
      let val: any;
      try {
        val = this.safeDecrypt(row.key, row.value);
      } catch (err) {
        if (!(err instanceof CredentialDecryptError)) throw err;
        val = '';   // 置空而非回显密文（G4）
        badKeys.push(row.key);
      }
      try {
        if (typeof val === 'string' && (val.startsWith('[') || val.startsWith('{'))) {
          val = JSON.parse(val);
        }
      } catch { /* 非 JSON 字符串保持原样 */ }
      result[row.key] = val;
    });

    if (badKeys.length > 0) {
      AppLogger.error(LOG_TAGS.SYSTEM,
        `设置读取：${badKeys.length} 个凭据解密失败已置空（${badKeys.join(', ')}）——` +
        '疑似跨 Electron 版本旧数据或密钥不可用，请到 设置 → AI 重新填写');
    }

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
        if (!row.value) continue;

        // G2：按 CredentialResult 判定（ok / missing 跳过，decrypt_failed 才清空）
        const result = this.credentialManager.decrypt(row.value);
        if (result.status !== 'decrypt_failed') continue;

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
