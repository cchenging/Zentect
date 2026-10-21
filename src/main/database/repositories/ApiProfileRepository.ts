import { SQLiteConnection } from '../core/SQLiteConnection';
import { encryptData, decryptData } from '../../utils/crypto';
import { v4 as uuidv4 } from 'uuid';
import { AppLogger } from '../../core/AppLogger';
import { LOG_TAGS } from '../../../modules/infra/logger/LogConstants';
import {
  CREDENTIAL_PURPOSE,
  classifyCredential,
  looksEncryptedValue,
  type CredentialResult,
  type CredentialStatus,
} from '../../../shared/utils/credentialFormat';
import {
  isV3WriteReady,
  planCredentialMigration,
  type CredentialMigrationReport,
} from '../../../modules/infra/security/CredentialMigrator';

/** v3 AAD 的 purpose（ADR-004 §4.2）：读写两路必须用同一个，否则 v3 密文读不回来 */
const PURPOSE = CREDENTIAL_PURPOSE.apiProfileApiKey;

/**
 * 模型条目（存储选型 A）：`api_profiles.models` 列存 `[{ name, checked }]` JSON
 * - `checked` 仅代表「是否勾选」标记位，不决定是否落库
 * - 兼容旧数据：历史 `string[]` 在读取处按「已勾选」归一化，无需 SQL 迁移
 */
export interface ProfileModelRef {
  name: string;
  checked: boolean;
}

export interface ApiProfile {
  id: string;
  name: string;
  provider: string;
  /**
   * 解密后的明文 Key；**解密失败时恒为空串**（不返回密文，ADR-004 G2/G4）
   * 是否「配置了但解不开」请看 `apiKeyStatus`
   */
  apiKey: string;
  /** 凭据读取状态（ok / missing / decrypt_failed）——供 UI 区分「未配置」与「已失效」 */
  apiKeyStatus?: CredentialStatus;
  baseUrl: string;
  models: ProfileModelRef[];
  isActive: boolean;
  sortOrder: number;
  extraConfig?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  alias?: string | null;
  enabled?: number;
  isPreset?: number;
  presetType?: string | null;
}

interface RawRow {
  id: string; name: string; provider: string; api_key: string | null;
  base_url: string | null; models: string | null; is_active: number;
  sort_order: number; extra_config: string | null;
  created_at: string; updated_at: string;
  alias: string | null; enabled: number; is_preset: number; preset_type: string | null;
}

/**
 * 读取一条凭据并归类状态（ADR-004 G2）
 *
 * ⚠️ 绝不让密文穿过这里：解不开就归类为 `decrypt_failed`，由调用方决定如何告警。
 * 历史教训：`decryptData` 在 v2 解密失败时会**原样返回密文**，旧代码直接把它塞进
 * `apiKey` ⇒ 密文被当 Bearer 发给供应商（401 → 连打触发 429 封禁），同时被回显到设置页，
 * 用户一旦保存即「密文再加密」不可逆。
 */
function readCredential(raw: string | null): CredentialResult {
  if (!raw) return { status: 'missing' };
  try {
    return classifyCredential(raw, decryptData(raw, PURPOSE));
  } catch {
    // 解析阶段抛错（格式损坏）⇒ 同样按解不开处理，绝不回退成密文
    return { status: 'decrypt_failed', reason: 'corrupted' };
  }
}

/**
 * 拒绝密文形态的写入（ADR-004 G4）
 *
 * 后端是**硬边界**：即使前端漏挡，也不允许把 `v1:/v2:/v3:` 或三段 hex 当明文再加密一次
 * ——那会导致原密文被双重加密、永久不可恢复。
 */
function assertPlaintextApiKey(value: string): void {
  if (looksEncryptedValue(value)) {
    throw new Error(
      '拒绝保存密文形态的 API Key：检测到 v1:/v2:/v3: 或三段 hex 格式。' +
      '请填写明文 Key —— 对密文再次加密不可逆。'
    );
  }
}

function rowToProfile(row: RawRow): ApiProfile {
  const credential = readCredential(row.api_key);
  return {
    id: row.id, name: row.name, provider: row.provider,
    apiKey: credential.status === 'ok' ? credential.value : '',
    apiKeyStatus: credential.status,
    baseUrl: row.base_url || '',
    models: row.models ? JSON.parse(row.models) : [],
    isActive: row.is_active === 1,
    sortOrder: row.sort_order,
    extraConfig: row.extra_config ? JSON.parse(row.extra_config) : undefined,
    createdAt: row.created_at, updatedAt: row.updated_at,
    /** 🔧 修复：映射 Migration 024 新增字段，否则 alias/enabled 在前端永远为 undefined */
    alias: row.alias || undefined,
    enabled: row.enabled ?? 1,
    isPreset: row.is_preset,  // 保持 number 类型，与接口定义一致（前端用 === 1 判断）
    presetType: row.preset_type || undefined,
  };
}

/**
 * ⚠️ 本文件是**活跃路径**（虽然沿用 @deprecated 标记）：`ApiProfileController`（IPC 全链路）、
 * `HealthService`、`LLMFactory`、`ProviderManager` 都直接导入它，且直接调 `encryptData/decryptData`。
 *
 * 曾写入的「请使用 `src/modules/settings/ai-config` 新模块入口」是**过期指引**：那个入口全仓
 * 零导入方（死叉），已于 2026-09-25 清理删除。改那个文件等于没改 —— 见 ADR-004 §7 路径纠偏表。
 */
export class ApiProfileRepository {
  static getAll(): ApiProfile[] {
    const db = SQLiteConnection.getInstance().getDB();
    const rows = db.prepare('SELECT * FROM api_profiles ORDER BY sort_order, created_at DESC, id DESC').all() as RawRow[];
    return rows.map(rowToProfile);
  }

  static getByProvider(provider: string): ApiProfile[] {
    const db = SQLiteConnection.getInstance().getDB();
    const rows = db.prepare('SELECT * FROM api_profiles WHERE provider = ? ORDER BY sort_order').all(provider) as RawRow[];
    return rows.map(rowToProfile);
  }

  static getActive(provider: string): ApiProfile | null {
    const db = SQLiteConnection.getInstance().getDB();
    const row = db.prepare('SELECT * FROM api_profiles WHERE provider = ? AND is_active = 1 LIMIT 1').get(provider) as RawRow | undefined;
    return row ? rowToProfile(row) : null;
  }

  static create(profile: Omit<ApiProfile, 'id' | 'createdAt' | 'updatedAt'>): ApiProfile {
    if (profile.apiKey) assertPlaintextApiKey(profile.apiKey);
    const db = SQLiteConnection.getInstance().getDB();
    const id = uuidv4();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO api_profiles (id, name, provider, api_key, base_url, models, is_active, sort_order, extra_config, alias, enabled, is_preset, preset_type, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, profile.name, profile.provider,
      profile.apiKey ? encryptData(profile.apiKey, PURPOSE) : null,
      profile.baseUrl || null,
      JSON.stringify(profile.models || []),
      profile.isActive ? 1 : 0, profile.sortOrder || 0,
      profile.extraConfig ? JSON.stringify(profile.extraConfig) : null,
      profile.alias || null,
      profile.enabled ?? 1,
      profile.isPreset ?? 0,
      profile.presetType || null,
      now, now
    );
    return this.getByProvider(profile.provider).find(p => p.id === id)!;
  }

  static update(id: string, patch: Partial<ApiProfile>): boolean {
    const db = SQLiteConnection.getInstance().getDB();
    const sets: string[] = []; const vals: any[] = [];
    if (patch.name !== undefined) { sets.push('name = ?'); vals.push(patch.name); }
    if (patch.apiKey !== undefined) {
      if (patch.apiKey) assertPlaintextApiKey(patch.apiKey);
      sets.push('api_key = ?'); vals.push(patch.apiKey ? encryptData(patch.apiKey, PURPOSE) : null);
    }
    if (patch.baseUrl !== undefined) { sets.push('base_url = ?'); vals.push(patch.baseUrl); }
    if (patch.models !== undefined) { sets.push('models = ?'); vals.push(JSON.stringify(patch.models)); }
    if (patch.isActive !== undefined) { sets.push('is_active = ?'); vals.push(patch.isActive ? 1 : 0); }
    if (patch.sortOrder !== undefined) { sets.push('sort_order = ?'); vals.push(patch.sortOrder); }
    if (patch.alias !== undefined) { sets.push('alias = ?'); vals.push(patch.alias); }
    if (patch.enabled !== undefined) { sets.push('enabled = ?'); vals.push(patch.enabled); }
    if (patch.isPreset !== undefined) { sets.push('is_preset = ?'); vals.push(patch.isPreset); }
    if (patch.presetType !== undefined) { sets.push('preset_type = ?'); vals.push(patch.presetType); }
    sets.push('updated_at = ?'); vals.push(new Date().toISOString());
    vals.push(id);
    db.prepare(`UPDATE api_profiles SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return true;
  }

  static delete(id: string): boolean {
    const db = SQLiteConnection.getInstance().getDB();
    return db.prepare('DELETE FROM api_profiles WHERE id = ?').run(id).changes > 0;
  }

  static activate(id: string, provider: string): boolean {
    const db = SQLiteConnection.getInstance().getDB();
    const tx = db.transaction(() => {
      db.prepare('UPDATE api_profiles SET is_active = 0 WHERE provider = ?').run(provider);
      db.prepare('UPDATE api_profiles SET is_active = 1 WHERE id = ?').run(id);
    });
    tx();
    return true;
  }

  static toggleEnabled(id: string, enabled: boolean): boolean {
    const db = SQLiteConnection.getInstance().getDB();
    db.prepare('UPDATE api_profiles SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, new Date().toISOString(), id);
    return true;
  }

  /**
   * ADR-004 §4.3 ②（P2）：v1/v2 静默迁移到 v3
   *
   * 单事务 + 逐行 compare-and-swap（`WHERE api_key = 读到时的原值`）：
   * - **一条 UPDATE 完成改写**，绝不「先删旧值再写新值」（评审验收项）
   * - 行在事务外被改过（`changes !== 1`）⇒ 抛错 ⇒ 整事务回滚 ⇒ 原值全部保留
   * - 解不开的行保持原值（不迁移半成品），由读路径的 fail-closed 统一告警
   */
  static migrateCredentialsToV3(): CredentialMigrationReport {
    const db = SQLiteConnection.getInstance().getDB();
    const rows = db
      .prepare('SELECT id, api_key FROM api_profiles WHERE api_key IS NOT NULL')
      .all() as { id: string; api_key: string }[];

    const report: CredentialMigrationReport = { migrated: 0, skipped: 0, undecryptable: 0 };
    if (rows.length === 0) return report;

    if (!isV3WriteReady()) {
      AppLogger.warn(LOG_TAGS.BOOTSTRAP,
        '凭据迁移：v3 通道未就绪（开关关闭或 DEK 不可用），本次跳过 v1/v2 → v3 迁移（原值保持可读）');
      report.skipped = rows.length;
      return report;
    }

    const updateStmt = db.prepare('UPDATE api_profiles SET api_key = @v3 WHERE id = @id AND api_key = @old');
    const tx = db.transaction(() => {
      for (const row of rows) {
        const plan = planCredentialMigration(row.api_key, PURPOSE);
        if (plan.action !== 'migrate') {
          if (plan.reason === 'undecryptable') report.undecryptable++;
          else report.skipped++;
          continue;
        }
        const res = updateStmt.run({ v3: plan.v3, id: row.id, old: row.api_key });
        if (res.changes !== 1) {
          throw new Error(`api_profiles[${row.id}] 迁移回写未命中（原值已被并发修改）：事务回滚，原值保留`);
        }
        report.migrated++;
      }
    });
    tx();

    return report;
  }
}