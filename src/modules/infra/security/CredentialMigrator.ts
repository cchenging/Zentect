// 📁 路径：src/modules/infra/security/CredentialMigrator.ts
// ADR-004 §4.3 ② / §5 P2：v1/v2 静默迁移到 v3（信封加密）
//
// 规则（评审升为验收项，实现不得偏离）：
//   - 读到 v1/v2 且**能解出**明文 ⇒ 以 v3 写回同一字段；解不出 ⇒ **保持原值**（绝不迁移半成品）
//   - 已是 v3 ⇒ 不动（幂等，T10）
//   - 写回必须是一条 UPDATE（**严禁先删旧值再写新值**），且调用方须在同一事务内 commit；
//     回写失败 ⇒ 事务回滚、原值仍在、抛错上报
//
// ⚠️ purpose 必须与读路径一致（`api_profiles.api_key` / `settings:<key>`），否则 v3 密文
//    AAD 校验会失败 —— 即「迁移成功但读不回来」。故本模块只产出 v3 字符串，**不碰数据库**，
//    落库语句由各仓储提供（各表 SQL 形态不同，SQL 不进安全层）。

import { decryptData, encryptData, isV3Enabled } from '../../../main/utils/crypto';
import { KeyStore } from './KeyStore';
import { looksEncryptedValue } from '../../../shared/utils/credentialFormat';

/** 单条凭据的迁移计划 */
export type MigrationPlan =
  | { action: 'skip'; reason: 'empty' | 'plaintext' | 'already_v3' | 'no_v3_channel' | 'undecryptable' }
  | { action: 'migrate'; v3: string };

/** 迁移结果汇总（供启动日志；`undecryptable` 由读路径的 fail-closed 告警另行暴露） */
export interface CredentialMigrationReport {
  /** 成功改写为 v3 的条数 */
  migrated: number;
  /** 无需迁移的条数（空值 / 非密文 / 已是 v3） */
  skipped: number;
  /** 解不开的条数（保持原值；典型为跨 Electron 版本的失效密文） */
  undecryptable: number;
}

/**
 * v3 写入通道是否就绪：开关 on 且 DEK 可取
 *
 * 未就绪时**整批跳过**（迁移是机会性动作：No DEK 就保持 v1/v2 原样，读路径依旧可用），
 * 绝不因为迁移把用户数据写坏或让启动失败。
 */
export function isV3WriteReady(): boolean {
  if (!isV3Enabled()) return false;
  return KeyStore.getInstance().getDek() !== null;
}

/**
 * 规划单条凭据的迁移（纯判定，不落库）
 *
 * @param raw 库内原值
 * @param purpose v3 AAD 的 purpose —— 必须与该字段读路径所用的完全相同
 */
export function planCredentialMigration(raw: string | null | undefined, purpose: string): MigrationPlan {
  if (!raw || raw.trim() === '') return { action: 'skip', reason: 'empty' };
  // 非密文（明文旧数据 / 普通设置项）不迁移：再加密一次会改变语义
  if (!looksEncryptedValue(raw)) return { action: 'skip', reason: 'plaintext' };
  // 已是 v3 ⇒ 幂等跳过（T10：不产生新密文）
  if (raw.startsWith('v3:')) return { action: 'skip', reason: 'already_v3' };

  if (!isV3Enabled() || !KeyStore.getInstance().getDek()) return { action: 'skip', reason: 'no_v3_channel' };

  // v1/v2 无 AAD，purpose 只为兼容签名；解不开 ⇒ 原样返回密文
  let plain: string;
  try {
    plain = decryptData(raw, purpose);
  } catch {
    return { action: 'skip', reason: 'undecryptable' };
  }
  if (!plain || plain === raw || looksEncryptedValue(plain)) {
    return { action: 'skip', reason: 'undecryptable' };
  }

  const v3 = encryptData(plain, purpose);
  if (!v3.startsWith('v3:')) return { action: 'skip', reason: 'no_v3_channel' };
  return { action: 'migrate', v3 };
}

