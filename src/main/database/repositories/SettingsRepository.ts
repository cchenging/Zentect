// 📁 路径：src/main/database/repositories/SettingsRepository.ts
import { SQLiteConnection } from '../core/SQLiteConnection';
import { SETTINGS_SQL } from '../queries/SystemQueries';
import { CredentialManager } from '@modules/infra/security/CredentialManager';
import { CredentialDecryptError, CREDENTIAL_PURPOSE, looksEncryptedValue } from '../../../shared/utils/credentialFormat';
import { isSensitiveConfig } from '../../../shared/config/keys';
import { AppLogger } from '@modules/infra/logger/AppLogger';
import { LOG_TAGS } from '@modules/infra/logger/LogConstants';
import {
  isV3WriteReady,
  planCredentialMigration,
  type CredentialMigrationReport,
} from '@modules/infra/security/CredentialMigrator';

/** @deprecated 请使用 `src/modules/settings/general` 新模块入口，旧路径仅保留兼容性委托 */
export class SettingsRepository {
  private credentialManager = CredentialManager.getInstance();

  private get db() { return SQLiteConnection.getInstance().getDB(); }

  /** 安全解密（ADR-004 §4.4 **G2：密文守卫 + 失败可感知**）
   *
   *  形态判定统一交给 shared SSOT（与 ApiProfileRepository / UI 同一份实现，禁止本地正则漂移）：
   *  - 不像密文 ⇒ 原样放行（大量普通设置项走此路径，不做解密尝试）
   *  - `ok`      ⇒ 返回明文
   *  - `missing` ⇒ 返回原值（空值语义不变）
   *  - `decrypt_failed` ⇒ **抛 `CredentialDecryptError`**（fail-closed）
   *
   *  为什么必须抛：旧实现「解不开 ⇒ 降级返回空串」，空串会被上层当「未配置」继续发请求
   *  ——2026-09-25 事故正是密文被当 Bearer 外发 ⇒ 401 ⇒ 连打 665 帧 ⇒ 429 封禁。
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

    let val: any = this.safeDecrypt(key, row.value);

    try {
      if (typeof val === 'string' && (val.startsWith('[') || val.startsWith('{'))) {
        val = JSON.parse(val);
      }
    } catch { /* 非 JSON 字符串保持原样 */ }

    // 🔥 关键修复：布尔字符串转布尔
    //   存库值为 'true'/'false' 字符串时，旧逻辑不解析（非 [/{ 开头），
    //   返回 truthy 的 'false' 字符串。导致 settings.get<boolean>('enableGPU', false)
    //   被判为 true → AiRuntimeManager 误传 --device cuda（AMD 无 CUDA 且 DML 极慢）。
    if (typeof val === 'string') {
      const lower = val.trim().toLowerCase();
      if (lower === 'true') val = true;
      else if (lower === 'false') val = false;
    }

    return val as T;
  }

  public getAllSettings(): Record<string, any> {
    const rows = this.db.prepare(SETTINGS_SQL.GET_ALL).all() as { key: string; value: string }[];
    const settings: Record<string, any> = {};
    /** G2：坏凭据键名（解密失败），单键失败不能炸掉整页设置 */
    const badKeys: string[] = [];

    rows.forEach(row => {
      let val: any;
      try {
        val = this.safeDecrypt(row.key, row.value);
      } catch (err) {
        if (!(err instanceof CredentialDecryptError)) throw err;
        // 置空而非回显密文（G4），失败由下方 error 级日志显式暴露
        val = '';
        badKeys.push(row.key);
      }
      try {
        if (typeof val === 'string' && (val.startsWith('[') || val.startsWith('{'))) {
          val = JSON.parse(val);
        }
      } catch { /* 非 JSON 字符串保持原样 */ }
      settings[row.key] = val;
    });

    if (badKeys.length > 0) {
      AppLogger.error(LOG_TAGS.SYSTEM,
        `设置读取：${badKeys.length} 个凭据解密失败已置空（${badKeys.join(', ')}）——` +
        '疑似跨 Electron 版本旧数据或密钥不可用，请到 设置 → AI 重新填写');
    }

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

        // 🔧 空串是「显式清空」的合法语义（清空 API Key、日志目录留空=回退默认位置），必须落库。
        //   此前用 `if (valToSave.trim() === '') continue;` 跳过空值，是为了兜底旧版 saveConfig
        //   把整份 Schema 逐键全量写回（含大量未填写字段的空值）时会误清已有配置；
        //   该全量写回已废弃，现由 useSettingsManager 的防抖即时落盘按「用户实际改动的键」写入，
        //   兜底不再需要，且它会让「清空」操作静默失效。

        // 仅对敏感 key 进行加密；v3 通道不可用时**抛错**（fail-closed），
        // 绝不降级存明文 —— 明文落库等同于 ADR-004 R4 被拒方案，且用户无感
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
   * 与 `ApiProfileRepository.migrateCredentialsToV3` 同口径：单事务 + 逐行 compare-and-swap
   * （`WHERE key = ? AND value = 读到时的原值`），一条 UPDATE 完成改写、绝不先删后写；
   * 回写未命中/抛错 ⇒ 整事务回滚 ⇒ 原值全部保留。解不开的行保持原值（不迁移半成品）。
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
        if (!row.value) continue;

        // G2：用 CredentialResult 判定，而非「返回值是否等于原值」的模糊比较
        //   ok / missing ⇒ 非失效数据，跳过；decrypt_failed ⇒ 无法解密，清空并登记
        const result = this.credentialManager.decrypt(row.value, CREDENTIAL_PURPOSE.settings(row.key));
        if (result.status !== 'decrypt_failed') continue;

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
