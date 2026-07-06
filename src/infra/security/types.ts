/**
 * 凭据管理器接口 —— infra/security 模块的公共契约
 */
export interface ICredentialManager {
  encrypt(value: string): string;
  decrypt(encrypted: string): string;
  isSensitive(key: string): boolean;
  getSensitiveKeys(): string[];
  mask(value: string, visibleChars?: number): string;
  validateApiKey(key: string, prefix?: string): { valid: boolean; message: string };
}
