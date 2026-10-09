// 📁 路径：src/modules/settings/general/backend/SettingsRepo.ts
// 设置数据仓库：直接引用 infra 层，不依赖 @deprecated 旧模块

import { SQLiteConnection } from '@modules/infra/database/SQLiteConnection';
import { CredentialManager } from '@modules/infra/security/CredentialManager';
import { isSensitiveConfig } from '../../../../shared/config/keys';
import { CredentialDecryptError, CREDENTIAL_PURPOSE, looksEncryptedValue } from '../../../../shared/utils/credentialFormat';
import { AppLogger } from '@modules/infra/logger/AppLogger';
import { LOG_TAGS } from '@modules/infra/logger/LogConstants';
import {
  isV3WriteReady,
  planCredentialMigration,
  type CredentialMigrationReport,
} from '@modules/infra/security/CredentialMigrator';

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

    const result = this.credentialManager.decrypt(val, CREDENTIAL_PURPOSE.settings(key));
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

        // 敏感项走 v3（purpose=settings:<key>）；v3 通道不可用时**抛错**（fail-closed），绝不存明文
        if (isSensitiveConfig(key)) {
          valToSave = this.credentialManager.encrypt(valToSave, CREDENTIAL_PURPOSE.settings(key));
        }

        stmt.run({ key, value: valToSave });
      }
    });
    transaction(settings);
  }

  /**
   * ADR-004 §4.3 ②（P2）：settings 表 v1/v2 静默迁移到 v3
   *
   * 与 `main/database/repositories/SettingsRepository.migrateCredentialsToV3` 同口径
   * （两份仓储互为镜像，口径必须一致）：单事务 + 逐行 compare-and-swap、一条 UPDATE 完成改写、
   * 回写未命中/抛错 ⇒ 整事务回滚 ⇒ 原值全部保留；解不开的行保持原值。
   */
  public migrateCredentialsToV3(): CredentialMigrationReport {
    const rows = this.db.prepare(SETTINGS_SQL.GET_ALL).all() as { key: string; value: string }[];

    const report: CredentialMigrationReport = { migrated: 0, skipped: 0, undecryptable: 0 };
    if (rows.length === 0) return report;

    if (!isV3WriteReady()) {
      AppLogger.warn(LOG_TAGS.BOOTSTRAP,
        '凭据迁移：v3 通道未就绪（开关关闭或 DEK 不可用），本次跳过 settings 的 v1/v2 → v3 迁移（原值保持可读）');
      report.skipped = rows.length;
      return report;
    }

    const updateStmt = this.db.prepare('UPDATE settings SET value = @v3 WHERE key = @key AND value = @old');
    const transaction = this.db.transaction(() => {
      for (const row of rows) {
        const plan = planCredentialMigration(row.value, CREDENTIAL_PURPOSE.settings(row.key));
        if (plan.action !== 'migrate') {
          if (plan.reason === 'undecryptable') report.undecryptable++;
          else report.skipped++;
          continue;
        }
        const res = updateStmt.run({ v3: plan.v3, key: row.key, old: row.value });
        if (res.changes !== 1) {
          throw new Error(`settings[${row.key}] 迁移回写未命中（原值已被并发修改）：事务回滚，原值保留`);
        }
        report.migrated++;
      }
    });
    transaction();

    return report;
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
        const result = this.credentialManager.decrypt(row.value, CREDENTIAL_PURPOSE.settings(row.key));
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
