/**
 * 凭据管理器接口 —— infra/security 模块的公共契约
 */
import type { CredentialResult } from '../../../shared/utils/credentialFormat';

export interface ICredentialManager {
  encrypt(value: string): string;
  /** ADR-004 G1：失败时**不返回字符串**，返回判别联合供调用方显式分支处置 */
  decrypt(encrypted: string): CredentialResult;
  isSensitive(key: string): boolean;
  getSensitiveKeys(): string[];
  mask(value: string, visibleChars?: number): string;
  validateApiKey(key: string, prefix?: string): { valid: boolean; message: string };
}
