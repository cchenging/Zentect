import { SQLiteConnection } from '../core/SQLiteConnection';
import { encryptData, decryptData } from '../../utils/crypto';
import { v4 as uuidv4 } from 'uuid';

export interface ApiProfile {
  id: string;
  name: string;
  provider: string;
  apiKey: string;
  baseUrl: string;
  models: string[];
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

function rowToProfile(row: RawRow): ApiProfile {
  return {
    id: row.id, name: row.name, provider: row.provider,
    apiKey: row.api_key ? decryptData(row.api_key) : '',
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

/** @deprecated 请使用 `src/modules/settings/ai-config` 新模块入口，旧路径仅保留兼容性委托 */
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
    const db = SQLiteConnection.getInstance().getDB();
    const id = uuidv4();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO api_profiles (id, name, provider, api_key, base_url, models, is_active, sort_order, extra_config, alias, enabled, is_preset, preset_type, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, profile.name, profile.provider,
      profile.apiKey ? encryptData(profile.apiKey) : null,
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
    if (patch.apiKey !== undefined) { sets.push('api_key = ?'); vals.push(patch.apiKey ? encryptData(patch.apiKey) : null); }
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
}