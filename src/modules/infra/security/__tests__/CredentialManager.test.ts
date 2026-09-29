// 📁 路径: src/modules/infra/security/__tests__/CredentialManager.test.ts
// 🔧 ADR-004 G1 回归锁定：解密失败绝不放行
//
// 背景：旧 `decrypt` 在解不开时**原样返回密文**，上层 `if (!key)` 判不出「未配置」与
//   「配了但解不开」的差别 ⇒ 密文被当 Bearer 外发（401 → 665 帧连打 → 429 封禁）。
//   现改为判别联合 CredentialResult，失败路径**不返回任何字符串**。
//
// 测试环境说明：vitest 全局 electron mock 的 safeStorage 无 `isEncryptionAvailable`
//   ⇒ encryptData 回落 v1（scrypt + AES-256-GCM，跨 profile 稳定），而 v2 密文必解不开。

import { describe, it, expect, beforeEach } from 'vitest';
import { CredentialManager } from '../CredentialManager';

const BROKEN_V2 = 'v2:djEwLX1wIk8VkYEFIw0Dhu5Dy5W8MpZDK6k6xjCa65u2vt+w2DhNTQ8';
const LEGACY_HEX = 'aabbccdd:11223344:ffeeddcc';

describe('CredentialManager.decrypt — G1 解密失败绝不放行', () => {
  let mgr: CredentialManager;

  beforeEach(() => {
    mgr = CredentialManager.getInstance();
  });

  it('空值 / 空白 ⇒ missing（未配置，与「解不开」必须区分）', () => {
    expect(mgr.decrypt('')).toEqual({ status: 'missing' });
    expect(mgr.decrypt('   ')).toEqual({ status: 'missing' });
  });

  it('明文旧数据 ⇒ ok 且原样返回', () => {
    expect(mgr.decrypt('sk-legacy-plaintext-123'))
      .toEqual({ status: 'ok', value: 'sk-legacy-plaintext-123' });
  });

  it('可解密的密文 ⇒ ok 且返回明文（加密/解密往返）', () => {
    const cipher = mgr.encrypt('sk-roundtrip-1234567890');
    expect(cipher).toMatch(/^v[12]:/);

    expect(mgr.decrypt(cipher)).toEqual({ status: 'ok', value: 'sk-roundtrip-1234567890' });
  });

  it('解不开的 v2 密文 ⇒ decrypt_failed，且绝不返回任何字符串（事故形态）', () => {
    const result = mgr.decrypt(BROKEN_V2);

    expect(result).toEqual({ status: 'decrypt_failed', reason: 'key_mismatch' });
    expect(JSON.stringify(result)).not.toContain('v2:djEw');   // 密文不得出现在结果里
  });

  it('解不开的旧版三段 hex 密文 ⇒ 同样 decrypt_failed', () => {
    expect(mgr.decrypt(LEGACY_HEX)).toEqual({ status: 'decrypt_failed', reason: 'key_mismatch' });
  });

  it('encrypt 不把空值变成密文（读回即 missing，不产生假失败）', () => {
    expect(mgr.encrypt('')).toBe('');
    expect(mgr.decrypt(mgr.encrypt('   '))).toEqual({ status: 'missing' });
  });
});