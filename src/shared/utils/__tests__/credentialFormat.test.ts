// 📁 路径: src/shared/utils/__tests__/credentialFormat.test.ts
// 🔧 ADR-004 G2/G4 回归锁定：密文形态判定 + 解密结果归类
//
// 背景：`decryptData` 在 v2 解密失败时**原样返回密文**（历史实现），旧代码直接把返回值当明文
//   塞进 `apiKey` ⇒ 密文被当 Bearer 外发（401 → 连打触发 429）＋ 被回显到设置页，
//   用户一保存即「密文再加密」不可逆。
// 本模块是主进程仓储与渲染进程 UI 的**同一份**判定实现（避免各处正则漂移）。

import { describe, it, expect } from 'vitest';
import {
  ENCRYPTED_PREFIXES,
  looksEncryptedValue,
  classifyCredential,
} from '../credentialFormat';

describe('looksEncryptedValue — 密文形态判定（sanity check）', () => {
  it('识别三种前缀格式（v3 为 ADR-004 预留）', () => {
    expect(ENCRYPTED_PREFIXES).toEqual(['v1:', 'v2:', 'v3:']);
    expect(looksEncryptedValue('v1:aabb:ccdd:eeff')).toBe(true);
    expect(looksEncryptedValue('v2:djEwLX1wIk8VkYEFIw0Dhu5Dy5W8MpZDK6k6xjCa65u2vt+w2DhNTQ8')).toBe(true);
    expect(looksEncryptedValue('v3:01:AAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBB:CCCC')).toBe(true);
  });

  it('识别旧版无前缀三段 hex 格式', () => {
    expect(looksEncryptedValue('aabbccdd:11223344:ffeeddcc')).toBe(true);
  });

  it('真实明文 Key 一律不误判', () => {
    // 各大供应商真实形态：含 `-`、`_`、`.`，长度长，均非「三段纯 hex」
    expect(looksEncryptedValue('sk-proj-abc123XYZ_456-def789')).toBe(false);
    expect(looksEncryptedValue('sk-1234567890abcdef1234567890abcdef')).toBe(false);
    expect(looksEncryptedValue('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc-_123')).toBe(false);
    expect(looksEncryptedValue('abc:def')).toBe(false);            // 仅两段
    expect(looksEncryptedValue('abc:def:ghi')).toBe(false);        // 三段但非 hex
    expect(looksEncryptedValue('zzzz:1111:2222')).toBe(false);     // 三段含非 hex
  });

  it('已知误判边界：三段纯 hex 字符串会被当成密文（历史格式无法区分，风险可忽略）', () => {
    // 旧版无前缀格式就是 `iv:authTag:ciphertext` 三段 hex，故 `a:b:c` 这类形态必然被判为密文。
    // 真实 Key 都含 `-`/`_`/`.` 且为长串，不会命中；此断言把该边界显式记录下来，
    // 避免日后有人误以为判定「绝对精确」而据此放宽守卫。
    expect(looksEncryptedValue('a:b:c')).toBe(true);
  });

  it('空值 / 空串不算密文', () => {
    expect(looksEncryptedValue('')).toBe(false);
    expect(looksEncryptedValue(undefined as unknown as string)).toBe(false);
  });
});

describe('classifyCredential — 解密结果归类（G2 同口径）', () => {
  it('空原值 ⇒ missing（从未配置，与「解不开」必须区分）', () => {
    expect(classifyCredential('', '')).toEqual({ status: 'missing' });
    expect(classifyCredential('   ', '   ')).toEqual({ status: 'missing' });
  });

  it('原值不像密文 ⇒ ok 且原样返回（明文旧数据）', () => {
    expect(classifyCredential('sk-real-key-1234', 'sk-real-key-1234'))
      .toEqual({ status: 'ok', value: 'sk-real-key-1234' });
  });

  it('原值是密文且解出明文 ⇒ ok', () => {
    expect(classifyCredential('v2:CIPHER', 'sk-decrypted-key'))
      .toEqual({ status: 'ok', value: 'sk-decrypted-key' });
  });

  it('原值是密文但解不出来 ⇒ decrypt_failed（绝不回退成密文）', () => {
    // 今天这次事故的精确形态：decryptData 解不开时原样返回密文
    expect(classifyCredential('v2:CIPHER', 'v2:CIPHER'))
      .toEqual({ status: 'decrypt_failed', reason: 'key_mismatch' });
    // 解出空串也算失败
    expect(classifyCredential('v2:CIPHER', ''))
      .toEqual({ status: 'decrypt_failed', reason: 'key_mismatch' });
    // 解出来还像密文（双重加密的后果）同样算失败
    expect(classifyCredential('v2:CIPHER', 'v2:INNER'))
      .toEqual({ status: 'decrypt_failed', reason: 'key_mismatch' });
  });

  it('解不开的旧版三段 hex 同样归类失败', () => {
    const legacy = 'aabbccdd:11223344:ffeeddcc';
    expect(classifyCredential(legacy, legacy))
      .toEqual({ status: 'decrypt_failed', reason: 'key_mismatch' });
  });
});